import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SentinelWriter } from '../src/commitHook.js';

const fsState = new Map<string, string>();

vi.mock('node:fs', () => ({
  existsSync: (p: string) => fsState.has(String(p)),
  writeFileSync: (p: string, content: string) => fsState.set(String(p), content),
  unlinkSync: (p: string) => { fsState.delete(String(p)); },
  mkdirSync: vi.fn(),
}));

beforeEach(() => {
  fsState.clear();
});

describe('SentinelWriter', () => {
  const ws = '/fake/ws';
  const sentinelPath = '/fake/ws/.vscode/agent-chat/active-dispatch';

  it('writes the agent id to the sentinel file on dispatchStart', () => {
    const w = new SentinelWriter(ws);
    w.dispatchStart('claude');
    expect(fsState.get(sentinelPath)).toBe('claude\n');
  });

  it('overwrites with the most recent agent on consecutive dispatchStart calls', () => {
    const w = new SentinelWriter(ws);
    w.dispatchStart('claude');
    w.dispatchStart('codex');
    expect(fsState.get(sentinelPath)).toBe('codex\n');
  });

  it('deletes the sentinel only when all dispatches end', () => {
    const w = new SentinelWriter(ws);
    w.dispatchStart('claude');
    w.dispatchStart('codex');
    w.dispatchEnd('claude');
    expect(fsState.has(sentinelPath)).toBe(true);
    w.dispatchEnd('codex');
    expect(fsState.has(sentinelPath)).toBe(false);
  });

  it('is a no-op when disabled', () => {
    const w = new SentinelWriter(ws, { enabled: false });
    w.dispatchStart('claude');
    expect(fsState.has(sentinelPath)).toBe(false);
  });

  it('handles dispatchEnd for an agent never started gracefully', () => {
    const w = new SentinelWriter(ws);
    w.dispatchEnd('claude');
    expect(fsState.has(sentinelPath)).toBe(false);
  });
});
