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

  it('onFloorChange fires for single-agent dispatch', async () => {
    const claude = fakeAgent('claude', [
      { type: 'text', text: 'hi' },
      { type: 'done' },
    ]);
    const codex = fakeAgent('codex', []);
    const gemini = fakeAgent('gemini', []);
    const router = new MessageRouter({ claude, codex, gemini });

    const events: (AgentId | null)[] = [];
    router.onFloorChange((h) => events.push(h));

    for await (const _ of router.handle('@claude hi')) { /* drain */ }

    expect(events).toEqual(['claude', null]);
  });

  it('onFloorChange fires once per agent during @all dispatch', async () => {
    const claude = fakeAgent('claude', [{ type: 'done' }]);
    const codex = fakeAgent('codex', [{ type: 'done' }]);
    const gemini = fakeAgent('gemini', [{ type: 'done' }]);
    const router = new MessageRouter({ claude, codex, gemini });

    const events: (AgentId | null)[] = [];
    router.onFloorChange((h) => events.push(h));

    for await (const _ of router.handle('@all hi')) { /* drain */ }

    expect(events).toEqual([
      'claude', null,
      'codex', null,
      'gemini', null,
    ]);
  });

  it('onStatusChange fires when an agents status check returns a new value', async () => {
    const claude = fakeAgent('claude', []);
    const codex = fakeAgent('codex', []);
    const gemini = fakeAgent('gemini', []);
    const router = new MessageRouter({ claude, codex, gemini });

    const events: { agentId: AgentId; status: string }[] = [];
    router.onStatusChange((agentId, status) => events.push({ agentId, status }));

    router.notifyStatusChange('codex', 'unauthenticated');
    router.notifyStatusChange('codex', 'unauthenticated'); // duplicate, should not fire

    expect(events).toEqual([
      { agentId: 'codex', status: 'unauthenticated' },
    ]);
  });

  it('cancelAll drains queue so queued agents emit dispatch-end without dispatch-start', async () => {
    let claudeStarted = false;
    let geminiStarted = false;
    const claude: Agent = {
      id: 'claude',
      status: vi.fn().mockResolvedValue('ready'),
      cancel: vi.fn().mockResolvedValue(undefined),
      send: (() => {
        claudeStarted = true;
        // Block forever — simulates an agent we'll cancel mid-dispatch.
        return (async function* () {
          await new Promise(() => { /* never resolves */ });
        })();
      }) as Agent['send'],
    };
    const codex = fakeAgent('codex', [{ type: 'done' }]);
    const gemini: Agent = {
      id: 'gemini',
      status: vi.fn().mockResolvedValue('ready'),
      cancel: vi.fn().mockResolvedValue(undefined),
      send: (() => {
        geminiStarted = true;
        return (async function* () {
          yield { type: 'done' } as AgentChunk;
        })();
      }) as Agent['send'],
    };

    const router = new MessageRouter({ claude, codex, gemini });

    // Run handle in the background; we'll cancel it mid-dispatch.
    const events: any[] = [];
    const drainTask = (async () => {
      for await (const ev of router.handle('@all hello')) events.push(ev);
    })();

    // Wait a tick for the dispatch to start on Claude.
    await new Promise((r) => setTimeout(r, 10));
    expect(claudeStarted).toBe(true);

    // Cancel: drain queue + abort active.
    await router.cancelAll();

    await drainTask;

    // Codex and Gemini should NOT have started.
    // (Because they were queued behind Claude when cancelAll fired.)
    expect(geminiStarted).toBe(false);
  });

  it('with facilitator: yields facilitator-decision then dispatches to chosen agent', async () => {
    const claude = fakeAgent('claude', [
      { type: 'text', text: 'pick' }, { type: 'done' },
    ]);
    const codex = fakeAgent('codex', []);
    const gemini = fakeAgent('gemini', []);
    const facilitator = vi.fn().mockResolvedValue({ agent: 'claude', reason: 'code review' });

    const router = new MessageRouter({ claude, codex, gemini }, facilitator);

    const events: any[] = [];
    for await (const ev of router.handle('please review this')) events.push(ev);

    expect(facilitator).toHaveBeenCalledWith('please review this', expect.any(Object));
    expect(events[0]).toEqual({ kind: 'facilitator-decision', agentId: 'claude', reason: 'code review' });
    expect(events).toContainEqual({ kind: 'dispatch-start', agentId: 'claude' });
  });

  it('with facilitator returning error: yields routing-needed', async () => {
    const claude = fakeAgent('claude', []);
    const codex = fakeAgent('codex', []);
    const gemini = fakeAgent('gemini', []);
    const facilitator = vi.fn().mockResolvedValue({ error: 'Routing unavailable; please prefix with @' });
    const router = new MessageRouter({ claude, codex, gemini }, facilitator);

    const events: any[] = [];
    for await (const ev of router.handle('hello')) events.push(ev);

    expect(events).toEqual([
      { kind: 'routing-needed', text: 'Routing unavailable; please prefix with @' },
    ]);
  });

  it('without facilitator: yields routing-needed (Plan 2a behavior)', async () => {
    const claude = fakeAgent('claude', []);
    const codex = fakeAgent('codex', []);
    const gemini = fakeAgent('gemini', []);
    const router = new MessageRouter({ claude, codex, gemini });

    const events: any[] = [];
    for await (const ev of router.handle('hello')) events.push(ev);
    expect(events[0]).toMatchObject({ kind: 'routing-needed' });
  });

  it('facilitator only called when no @mention', async () => {
    const claude = fakeAgent('claude', [{ type: 'done' }]);
    const codex = fakeAgent('codex', []);
    const gemini = fakeAgent('gemini', []);
    const facilitator = vi.fn().mockResolvedValue({ agent: 'gemini', reason: 'x' });
    const router = new MessageRouter({ claude, codex, gemini }, facilitator);

    for await (const _ of router.handle('@claude hi')) { /* drain */ }
    expect(facilitator).not.toHaveBeenCalled();
  });

  it('watchdog: cancels active agent and yields error+done after configured ms', async () => {
    vi.useFakeTimers();
    try {
      const cancelSpy = vi.fn().mockResolvedValue(undefined);
      const claude: Agent = {
        id: 'claude',
        status: vi.fn().mockResolvedValue('ready'),
        cancel: cancelSpy,
        send: (() => {
          // Generator that hangs forever.
          return (async function* () {
            await new Promise(() => { /* never resolves */ });
          })();
        }) as Agent['send'],
      };
      const codex = fakeAgent('codex', []);
      const gemini = fakeAgent('gemini', []);

      const router = new MessageRouter({ claude, codex, gemini }, undefined, { watchdogMs: 5000 });

      const events: any[] = [];
      const task = (async () => {
        for await (const ev of router.handle('@claude hi')) events.push(ev);
      })();

      // Let the dispatch start.
      await Promise.resolve();
      await Promise.resolve();

      // Advance past the watchdog timeout.
      vi.advanceTimersByTime(5000);
      await Promise.resolve();

      // Cancel was called by watchdog.
      expect(cancelSpy).toHaveBeenCalled();

      // Allow the cancellation to propagate.
      vi.advanceTimersByTime(100);
      await task;

      // We should see an error chunk from the watchdog.
      const errorChunk = events.find(
        (e) => e.kind === 'chunk' && e.chunk.type === 'error' && /watchdog|5 minutes|seconds/i.test(e.chunk.message)
      );
      expect(errorChunk).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
