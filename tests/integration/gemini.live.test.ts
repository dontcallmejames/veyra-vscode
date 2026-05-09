import { describe, it, expect, vi } from 'vitest';
import { guardLiveModelPrompts } from './liveReadinessGuard.js';

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({ get: (_k: string, dflt: unknown) => dflt })),
  },
}));

import { GeminiAgent } from '../../src/agents/gemini.js';

const describeLive = process.env.GAMBIT_RUN_LIVE === '1' ? describe : describe.skip;

describeLive('GeminiAgent - LIVE', () => {
  guardLiveModelPrompts();

  it('responds to a minimal prompt', async () => {
    const agent = new GeminiAgent();
    const chunks = [];
    for await (const c of agent.send('Reply with just the word "ok".')) {
      chunks.push(c);
    }
    const text = chunks
      .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
      .map((c) => c.text)
      .join('');
    const errors = chunks
      .filter((c): c is Extract<typeof c, { type: 'error' }> => c.type === 'error')
      .map((c) => c.message)
      .join('\n');
    expect(errors).toBe('');
    expect(text.toLowerCase()).toContain('ok');
    expect(chunks.at(-1)).toEqual({ type: 'done' });
  }, 60_000);
});
