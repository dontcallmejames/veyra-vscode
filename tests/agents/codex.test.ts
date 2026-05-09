import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { CodexAgent } from '../../src/agents/codex.js';

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({ get: (_k: string, dflt: unknown) => dflt })),
  },
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn().mockReturnValue('/fake/npm/root\n'),
}));

vi.mock('node:fs', () => ({
  accessSync: vi.fn(),
  existsSync: vi.fn(() => true),
}));

import { spawn } from 'node:child_process';
const mockedSpawn = spawn as unknown as ReturnType<typeof vi.fn>;

function fakeProcess(stdoutChunks: string[], exitCode = 0) {
  const proc: any = new EventEmitter();
  proc.stdout = Readable.from(stdoutChunks);
  proc.stderr = Readable.from([]);
  proc.stdinText = '';
  proc.stdin = new Writable({
    write(chunk, _encoding, callback) {
      proc.stdinText += String(chunk);
      callback();
    },
  });
  proc.kill = vi.fn();
  setImmediate(() => proc.emit('close', exitCode));
  return proc;
}

function fakeProcessError(message: string) {
  const proc: any = new EventEmitter();
  proc.stdout = Readable.from([]);
  proc.stderr = Readable.from([]);
  proc.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  proc.kill = vi.fn();
  setImmediate(() => {
    proc.emit('error', new Error(message));
    proc.emit('close', null);
  });
  return proc;
}

describe('CodexAgent', () => {
  it('parses Codex JSONL events into AgentChunks', async () => {
    // Real Codex event shape from spike A3: thread.started -> turn.started ->
    // item.completed (with item.type === 'agent_message') -> turn.completed.
    mockedSpawn.mockReturnValueOnce(
      fakeProcess([
        '{"type":"thread.started","thread_id":"abc"}\n',
        '{"type":"turn.started"}\n',
        '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n',
        '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n',
      ])
    );

    const agent = new CodexAgent();
    const chunks = [];
    for await (const c of agent.send('hi')) chunks.push(c);

    expect(chunks).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'done' },
    ]);
  });

  it('parses file_change item into tool-call chunks for badge firing', async () => {
    // Codex file_change event shape from codex-rs/exec source analysis:
    // item.completed with item.type === 'file_change' carries a changes array
    // with { path, kind } entries. Each path is surfaced as an 'apply_patch'
    // tool-call so getEditedPath can resolve the badge target.
    mockedSpawn.mockReturnValueOnce(
      fakeProcess([
        '{"type":"thread.started","thread_id":"abc"}\n',
        '{"type":"turn.started"}\n',
        '{"type":"item.completed","item":{"id":"item_0","type":"file_change","changes":[{"path":"/abs/scratch_spike.txt","kind":"Add"}],"status":"Completed"}}\n',
        '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n',
        '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":5}}\n',
      ])
    );

    const agent = new CodexAgent();
    const chunks = [];
    for await (const c of agent.send('Create a file')) chunks.push(c);

    expect(chunks).toContainEqual({
      type: 'tool-call',
      name: 'apply_patch',
      input: { path: '/abs/scratch_spike.txt' },
    });
    expect(chunks).toContainEqual({ type: 'text', text: 'done' });
    expect(chunks.at(-1)).toEqual({ type: 'done' });
  });

  it('parses command_execution item into tool-call + tool-result chunks', async () => {
    // command_execution event shape from codex-rs/exec source:
    // surfaced as tool-call with name 'shell'; badge skipped (not in CODEX_WRITE_TOOLS).
    mockedSpawn.mockReturnValueOnce(
      fakeProcess([
        '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"echo hello","aggregated_output":"hello\\n","exit_code":0,"status":"Completed"}}\n',
        '{"type":"turn.completed","usage":{}}\n',
      ])
    );

    const agent = new CodexAgent();
    const chunks = [];
    for await (const c of agent.send('run echo')) chunks.push(c);

    expect(chunks).toContainEqual({
      type: 'tool-call',
      name: 'shell',
      input: { command: 'echo hello' },
    });
    expect(chunks).toContainEqual({
      type: 'tool-result',
      name: 'shell',
      output: 'hello\n',
    });
  });

  it('parses mcp_tool_call item with write tool into tool-call chunk', async () => {
    // mcp_tool_call event shape from codex-rs/exec source:
    // tool name maps directly; if it matches CODEX_WRITE_TOOLS then badge fires.
    mockedSpawn.mockReturnValueOnce(
      fakeProcess([
        '{"type":"item.completed","item":{"id":"item_0","type":"mcp_tool_call","server":"filesystem","tool":"write_file","status":"Completed","arguments":{"path":"/abs/out.txt","content":"hi"},"result":{"content":"wrote 2 bytes","structured_content":null},"error":null}}\n',
        '{"type":"turn.completed","usage":{}}\n',
      ])
    );

    const agent = new CodexAgent();
    const chunks = [];
    for await (const c of agent.send('write file')) chunks.push(c);

    expect(chunks).toContainEqual({
      type: 'tool-call',
      name: 'write_file',
      input: { path: '/abs/out.txt', content: 'hi' },
    });
    expect(chunks).toContainEqual({
      type: 'tool-result',
      name: 'write_file',
      output: { content: 'wrote 2 bytes', structured_content: null },
    });
  });

  it('emits an error chunk on non-zero exit', async () => {
    mockedSpawn.mockReturnValueOnce(fakeProcess([], 1));

    const agent = new CodexAgent();
    const chunks = [];
    for await (const c of agent.send('hi')) chunks.push(c);

    expect(chunks).toContainEqual({
      type: 'error',
      message: expect.stringContaining('exit code 1'),
    });
    expect(chunks.at(-1)).toEqual({ type: 'done' });
  });

  it('emits an error chunk when the Codex process cannot be spawned', async () => {
    mockedSpawn.mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });

    const agent = new CodexAgent();
    const chunks = [];
    for await (const c of agent.send('hi')) chunks.push(c);

    expect(chunks).toEqual([
      { type: 'error', message: 'Unable to start Codex CLI: spawn failed' },
      { type: 'done' },
    ]);
  });

  it('emits an error chunk when the Codex process emits an async startup error', async () => {
    mockedSpawn.mockReturnValueOnce(fakeProcessError('ENOENT codex'));

    const agent = new CodexAgent();
    const chunks = [];
    for await (const c of agent.send('hi')) chunks.push(c);

    expect(chunks).toEqual([
      { type: 'error', message: 'Codex process error: ENOENT codex' },
      { type: 'done' },
    ]);
  });

  it('omits workspace-write sandbox args for read-only sends', async () => {
    mockedSpawn.mockReturnValueOnce(fakeProcess(['{"type":"turn.completed","usage":{}}\n']));

    const agent = new CodexAgent();
    for await (const _chunk of agent.send('review only', { readOnly: true } as any)) {
      // drain
    }

    const args = mockedSpawn.mock.calls.at(-1)?.[1] as string[];
    expect(args).toContain('exec');
    expect(args).not.toContain('--sandbox');
    expect(args).not.toContain('workspace-write');
  });

  it('passes prompts over stdin instead of argv to avoid command-line length limits', async () => {
    const proc = fakeProcess(['{"type":"turn.completed","usage":{}}\n']);
    mockedSpawn.mockReturnValueOnce(proc);
    const prompt = `review this shared context\n${'x'.repeat(40_000)}`;

    const agent = new CodexAgent();
    for await (const _chunk of agent.send(prompt, { readOnly: true } as any)) {
      // drain
    }

    const args = mockedSpawn.mock.calls.at(-1)?.[1] as string[];
    const options = mockedSpawn.mock.calls.at(-1)?.[2] as { stdio: string[] };
    expect(args).toContain('-');
    expect(args).not.toContain(prompt);
    expect(options.stdio[0]).toBe('pipe');
    expect(proc.stdinText).toBe(prompt);
  });

  it('exposes id "codex"', () => {
    expect(new CodexAgent().id).toBe('codex');
  });
});
