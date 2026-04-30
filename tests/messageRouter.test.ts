import { describe, it, expect, vi } from 'vitest';
import { MessageRouter } from '../src/messageRouter.js';
import type { Agent } from '../src/agents/types.js';
import type { AgentChunk, AgentId } from '../src/types.js';

function fakeAgent(id: AgentId, replyChunks: AgentChunk[]): Agent {
  return {
    id,
    status: vi.fn().mockResolvedValue('ready'),
    cancel: vi.fn().mockResolvedValue(undefined),
    async *send() {
      for (const c of replyChunks) yield c;
    },
  };
}

describe('MessageRouter', () => {
  it('dispatches to a single mentioned agent and forwards chunks tagged with agentId', async () => {
    const claude = fakeAgent('claude', [
      { type: 'text', text: 'hi from claude' },
      { type: 'done' },
    ]);
    const codex = fakeAgent('codex', []);
    const gemini = fakeAgent('gemini', []);

    const router = new MessageRouter({ claude, codex, gemini });

    const events: any[] = [];
    for await (const ev of router.handle('@claude hello')) events.push(ev);

    expect(events).toEqual([
      { kind: 'dispatch-start', agentId: 'claude' },
      { kind: 'chunk', agentId: 'claude', chunk: { type: 'text', text: 'hi from claude' } },
      { kind: 'chunk', agentId: 'claude', chunk: { type: 'done' } },
      { kind: 'dispatch-end', agentId: 'claude' },
    ]);
  });

  it('dispatches to multiple agents sequentially in @all order', async () => {
    const claude = fakeAgent('claude', [{ type: 'text', text: 'a' }, { type: 'done' }]);
    const codex = fakeAgent('codex', [{ type: 'text', text: 'b' }, { type: 'done' }]);
    const gemini = fakeAgent('gemini', [{ type: 'text', text: 'c' }, { type: 'done' }]);

    const router = new MessageRouter({ claude, codex, gemini });
    const order: AgentId[] = [];
    for await (const ev of router.handle('@all hi')) {
      if (ev.kind === 'dispatch-start') order.push(ev.agentId);
    }

    expect(order).toEqual(['claude', 'codex', 'gemini']);
  });

  it('emits a routing-needed event when no @mention is present', async () => {
    const claude = fakeAgent('claude', []);
    const codex = fakeAgent('codex', []);
    const gemini = fakeAgent('gemini', []);
    const router = new MessageRouter({ claude, codex, gemini });

    const events = [];
    for await (const ev of router.handle('plain text no mention')) events.push(ev);

    expect(events).toEqual([
      { kind: 'routing-needed', text: 'plain text no mention' },
    ]);
  });

  it('passes only the remainingText (mentions stripped) to the agent', async () => {
    const sendSpy = vi.fn();
    const claude: Agent = {
      id: 'claude',
      status: vi.fn().mockResolvedValue('ready'),
      cancel: vi.fn().mockResolvedValue(undefined),
      send: ((prompt: string) => {
        sendSpy(prompt);
        return (async function* () {
          yield { type: 'done' } as AgentChunk;
        })();
      }) as Agent['send'],
    };
    const codex = fakeAgent('codex', []);
    const gemini = fakeAgent('gemini', []);

    const router = new MessageRouter({ claude, codex, gemini });
    for await (const _ of router.handle('@claude review this')) { /* drain */ }

    expect(sendSpy).toHaveBeenCalledWith('review this');
  });
});
