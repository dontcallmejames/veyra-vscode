import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { GeminiAgent } from '../../src/agents/gemini.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn().mockReturnValue('/fake/npm/root\n'),
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

  it('exposes id "gemini"', () => {
    expect(new GeminiAgent().id).toBe('gemini');
  });
});
