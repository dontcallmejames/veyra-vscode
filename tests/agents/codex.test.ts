import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { CodexAgent } from '../../src/agents/codex.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';
const mockedSpawn = spawn as unknown as ReturnType<typeof vi.fn>;

function fakeProcess(stdoutChunks: string[], exitCode = 0) {
  const proc: any = new EventEmitter();
  proc.stdout = Readable.from(stdoutChunks);
  proc.stderr = Readable.from([]);
  proc.kill = vi.fn();
  setImmediate(() => proc.emit('close', exitCode));
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

  it('exposes id "codex"', () => {
    expect(new CodexAgent().id).toBe('codex');
  });
});
