import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('ClaudeAgent CLI fallback', () => {
  afterEach(() => {
    vi.doUnmock('node:child_process');
    vi.doUnmock('@anthropic-ai/claude-agent-sdk');
    vi.doUnmock('vscode');
    vi.resetModules();
  });

  it('falls back to the installed Claude CLI when the packaged SDK is absent', async () => {
    const spawn = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: Readable;
        stderr: PassThrough;
        stdin: { end: ReturnType<typeof vi.fn> };
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = Readable.from([
        `${JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'cli hello' }] },
        })}\n`,
        `${JSON.stringify({ type: 'result', subtype: 'success' })}\n`,
      ]);
      child.stderr = new PassThrough();
      child.stdin = { end: vi.fn() };
      child.kill = vi.fn();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
    const execSync = vi.fn(() => 'C:\\Users\\jford\\.local\\bin\\claude.exe\r\n');

    vi.doMock('node:child_process', () => ({ spawn, execSync }));
    vi.doMock('vscode', () => ({
      workspace: {
        getConfiguration: vi.fn(() => ({ get: (_key: string, fallback: unknown) => fallback })),
      },
    }));

    const { ClaudeAgent } = await import('../../src/agents/claude.js');
    const agent = new ClaudeAgent({ loadSdkQuery: async () => {
      const error = new Error("Cannot find module '@anthropic-ai/claude-agent-sdk'") as NodeJS.ErrnoException;
      error.code = 'MODULE_NOT_FOUND';
      throw error;
    } });
    const chunks = [];

    for await (const chunk of agent.send('review this', { cwd: 'C:\\workspace', readOnly: true })) {
      chunks.push(chunk);
    }

    expect(spawn).toHaveBeenCalledWith(
      'C:\\Users\\jford\\.local\\bin\\claude.exe',
      ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'default'],
      { cwd: 'C:\\workspace', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    expect(spawn.mock.results[0]?.value.stdin.end).toHaveBeenCalledWith('review this');
    expect(chunks).toEqual([
      { type: 'text', text: 'cli hello' },
      { type: 'done' },
    ]);
  });

  it('falls back when dynamic import reports the packaged SDK as a missing package', async () => {
    const spawn = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: Readable;
        stderr: PassThrough;
        stdin: { end: ReturnType<typeof vi.fn> };
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = Readable.from([
        `${JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'cli hello' }] },
        })}\n`,
        `${JSON.stringify({ type: 'result', subtype: 'success' })}\n`,
      ]);
      child.stderr = new PassThrough();
      child.stdin = { end: vi.fn() };
      child.kill = vi.fn();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
    const execSync = vi.fn(() => 'C:\\Users\\jford\\.local\\bin\\claude.exe\r\n');

    vi.doMock('node:child_process', () => ({ spawn, execSync }));
    vi.doMock('vscode', () => ({
      workspace: {
        getConfiguration: vi.fn(() => ({ get: (_key: string, fallback: unknown) => fallback })),
      },
    }));

    const { ClaudeAgent } = await import('../../src/agents/claude.js');
    const agent = new ClaudeAgent({ loadSdkQuery: async () => {
      const error = new Error(
        "Cannot find package '@anthropic-ai/claude-agent-sdk' imported from C:\\Users\\jford\\.vscode\\extensions\\dontcallmejames.veyra-vscode-0.0.3\\dist\\extension.js",
      ) as NodeJS.ErrnoException;
      error.code = 'ERR_MODULE_NOT_FOUND';
      throw error;
    } });
    const chunks = [];

    for await (const chunk of agent.send('review this', { cwd: 'C:\\workspace', readOnly: true })) {
      chunks.push(chunk);
    }

    expect(spawn).toHaveBeenCalledWith(
      'C:\\Users\\jford\\.local\\bin\\claude.exe',
      ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'default'],
      { cwd: 'C:\\workspace', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    expect(chunks).toEqual([
      { type: 'text', text: 'cli hello' },
      { type: 'done' },
    ]);
  });
});
