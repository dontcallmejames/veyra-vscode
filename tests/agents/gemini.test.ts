import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { GeminiAgent } from '../../src/agents/gemini.js';

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

describe('GeminiAgent', () => {
  it('parses Gemini stream-json events into AgentChunks', async () => {
    // Real Gemini event shape from spike A4 (CLI invoked with -o stream-json):
    // init -> message(user echo) -> message(assistant, delta:true) -> result
    mockedSpawn.mockReturnValueOnce(
      fakeProcess([
        '{"type":"init"}\n',
        '{"type":"message","role":"user","content":"hi"}\n',
        '{"type":"message","role":"assistant","content":"ok","delta":true}\n',
        '{"type":"result","status":"success"}\n',
      ])
    );

    const agent = new GeminiAgent();
    const chunks = [];
    for await (const c of agent.send('hi')) chunks.push(c);

    expect(chunks).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'done' },
    ]);
  });

  it('parses tool_use event into a tool-call chunk for badge firing', async () => {
    // Real Gemini tool_use event shape from gemini-KXTGCWBT.js source analysis:
    //   { type: "tool_use", timestamp, tool_name, tool_id, parameters }
    // Emitted when the model requests a tool call. The parameters field is the
    // input object; for write_file it carries file_path which getEditedPath uses.
    mockedSpawn.mockReturnValueOnce(
      fakeProcess([
        '{"type":"init","timestamp":"2026-05-07T00:00:00Z","session_id":"s1","model":"gemini-3"}\n',
        '{"type":"message","role":"user","content":"write a file"}\n',
        '{"type":"tool_use","timestamp":"2026-05-07T00:00:01Z","tool_name":"write_file","tool_id":"call_abc","parameters":{"file_path":"/abs/scratch_spike.txt","content":"hello"}}\n',
        '{"type":"tool_result","timestamp":"2026-05-07T00:00:02Z","tool_id":"call_abc","status":"success","output":"Wrote 5 bytes"}\n',
        '{"type":"message","role":"assistant","content":"Done.","delta":true}\n',
        '{"type":"result","timestamp":"2026-05-07T00:00:03Z","status":"success","stats":{}}\n',
      ])
    );

    const agent = new GeminiAgent();
    const chunks = [];
    for await (const c of agent.send('write a file')) chunks.push(c);

    expect(chunks).toContainEqual({
      type: 'tool-call',
      name: 'write_file',
      input: { file_path: '/abs/scratch_spike.txt', content: 'hello' },
    });
    expect(chunks).toContainEqual({
      type: 'tool-result',
      name: 'write_file',
      output: 'Wrote 5 bytes',
    });
    expect(chunks).toContainEqual({ type: 'text', text: 'Done.' });
    expect(chunks.at(-1)).toEqual({ type: 'done' });
  });

  it('resolves tool_result name via tool_id → tool_name map', async () => {
    // tool_result events carry only tool_id; the parser tracks tool_id → tool_name
    // from the preceding tool_use event so the tool-result chunk gets a friendly name.
    mockedSpawn.mockReturnValueOnce(
      fakeProcess([
        '{"type":"tool_use","tool_name":"replace","tool_id":"call_xyz","parameters":{"file_path":"/abs/foo.ts"}}\n',
        '{"type":"tool_result","tool_id":"call_xyz","status":"success","output":"replaced"}\n',
        '{"type":"result","status":"success"}\n',
      ])
    );

    const agent = new GeminiAgent();
    const chunks = [];
    for await (const c of agent.send('edit file')) chunks.push(c);

    const toolResult = chunks.find((c) => c.type === 'tool-result');
    expect(toolResult).toEqual({ type: 'tool-result', name: 'replace', output: 'replaced' });
  });

  it('emits an error chunk on non-zero exit', async () => {
    mockedSpawn.mockReturnValueOnce(fakeProcess([], 2));

    const agent = new GeminiAgent();
    const chunks = [];
    for await (const c of agent.send('hi')) chunks.push(c);

    expect(chunks).toContainEqual({
      type: 'error',
      message: expect.stringContaining('exit code 2'),
    });
  });

  it('emits an error chunk when the Gemini process cannot be spawned', async () => {
    mockedSpawn.mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });

    const agent = new GeminiAgent();
    const chunks = [];
    for await (const c of agent.send('hi')) chunks.push(c);

    expect(chunks).toEqual([
      { type: 'error', message: 'Unable to start Gemini CLI: spawn failed' },
      { type: 'done' },
    ]);
  });

  it('emits an error chunk when the Gemini process emits an async startup error', async () => {
    mockedSpawn.mockReturnValueOnce(fakeProcessError('ENOENT gemini'));

    const agent = new GeminiAgent();
    const chunks = [];
    for await (const c of agent.send('hi')) chunks.push(c);

    expect(chunks).toEqual([
      { type: 'error', message: 'Gemini process error: ENOENT gemini' },
      { type: 'done' },
    ]);
  });

  it('omits auto-edit approval args for read-only sends', async () => {
    mockedSpawn.mockReturnValueOnce(fakeProcess(['{"type":"result","status":"success"}\n']));

    const agent = new GeminiAgent();
    for await (const _chunk of agent.send('review only', { readOnly: true } as any)) {
      // drain
    }

    const args = mockedSpawn.mock.calls.at(-1)?.[1] as string[];
    expect(args).toContain('-o');
    expect(args).not.toContain('--approval-mode');
    expect(args).not.toContain('auto_edit');
  });

  it('passes prompts over stdin instead of argv to avoid command-line length limits', async () => {
    const proc = fakeProcess(['{"type":"result","status":"success"}\n']);
    mockedSpawn.mockReturnValueOnce(proc);
    const prompt = `review this shared context\n${'x'.repeat(40_000)}`;

    const agent = new GeminiAgent();
    for await (const _chunk of agent.send(prompt, { readOnly: true } as any)) {
      // drain
    }

    const args = mockedSpawn.mock.calls.at(-1)?.[1] as string[];
    const options = mockedSpawn.mock.calls.at(-1)?.[2] as { stdio: string[] };
    expect(args).not.toContain('-p');
    expect(args).not.toContain(prompt);
    expect(options.stdio[0]).toBe('pipe');
    expect(proc.stdinText).toBe(prompt);
  });

  it('exposes id "gemini"', () => {
    expect(new GeminiAgent().id).toBe('gemini');
  });
});
