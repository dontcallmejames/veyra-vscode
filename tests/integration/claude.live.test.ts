import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({ get: (_k: string, dflt: unknown) => dflt })),
  },
}));

import { ClaudeAgent } from '../../src/agents/claude.js';

describe('ClaudeAgent — LIVE', () => {
  it('responds to a minimal prompt', async () => {
    const agent = new ClaudeAgent();
    const chunks = [];
    for await (const c of agent.send('Reply with just the word "ok".')) {
      chunks.push(c);
    }
    const text = chunks
      .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
      .map((c) => c.text)
      .join('');
    expect(text.toLowerCase()).toContain('ok');
    expect(chunks.at(-1)).toEqual({ type: 'done' });
  }, 60_000);
});
