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

  it('does not dispatch a directly mentioned agent when its backend is unavailable', async () => {
    const claude = fakeAgent('claude', []);
    const codex = fakeAgent('codex', [{ type: 'done' }]);
    const gemini = fakeAgent('gemini', []);
    vi.mocked(codex.status).mockResolvedValue('unauthenticated');
    const sendSpy = vi.spyOn(codex, 'send');

    const router = new MessageRouter({ claude, codex, gemini });

    const events: any[] = [];
    for await (const ev of router.handle('@codex implement this')) events.push(ev);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(events).toEqual([
      { kind: 'routing-needed', text: 'Codex is unauthenticated. Run `codex login`. If `codex` is missing, install it with `npm install -g @openai/codex`. You can also run Gambit: Show setup guide.' },
    ]);
  });

  it('gives concrete Gemini setup guidance when the direct backend is not installed', async () => {
    const claude = fakeAgent('claude', []);
    const codex = fakeAgent('codex', []);
    const gemini = fakeAgent('gemini', [{ type: 'done' }]);
    vi.mocked(gemini.status).mockResolvedValue('not-installed');
    const sendSpy = vi.spyOn(gemini, 'send');

    const router = new MessageRouter({ claude, codex, gemini });

    const events: any[] = [];
    for await (const ev of router.handle('@gemini review this')) events.push(ev);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(events).toEqual([
      { kind: 'routing-needed', text: 'Gemini is not installed. Install it with `npm install -g @google/gemini-cli`, then run `gemini` once to sign in. You can also run Gambit: Configure Codex/Gemini CLI paths or Gambit: Show setup guide.' },
    ]);
  });

  it('gives concrete Codex setup guidance when the direct backend is not installed', async () => {
    const claude = fakeAgent('claude', []);
    const codex = fakeAgent('codex', [{ type: 'done' }]);
    const gemini = fakeAgent('gemini', []);
    vi.mocked(codex.status).mockResolvedValue('not-installed');
    const sendSpy = vi.spyOn(codex, 'send');

    const router = new MessageRouter({ claude, codex, gemini });

    const events: any[] = [];
    for await (const ev of router.handle('@codex implement this')) events.push(ev);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(events).toEqual([
      { kind: 'routing-needed', text: 'Codex is not installed. Install it with `npm install -g @openai/codex`, then run `codex login`. You can also run Gambit: Configure Codex/Gemini CLI paths or Gambit: Show setup guide.' },
    ]);
  });

  it('gives filesystem guidance when a direct Codex backend is inaccessible', async () => {
    const claude = fakeAgent('claude', []);
    const codex = fakeAgent('codex', [{ type: 'done' }]);
    const gemini = fakeAgent('gemini', []);
    vi.mocked(codex.status).mockResolvedValue('inaccessible');
    const sendSpy = vi.spyOn(codex, 'send');

    const router = new MessageRouter({ claude, codex, gemini });

    const events: any[] = [];
    for await (const ev of router.handle('@codex implement this')) events.push(ev);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(events).toEqual([
      { kind: 'routing-needed', text: 'Codex files are inaccessible. Check filesystem permissions, rerun outside the current sandbox, or set GAMBIT_CODEX_CLI_PATH / gambit.codexCliPath to the Codex JS bundle, native executable, or Windows npm shim. You can also run Gambit: Configure Codex/Gemini CLI paths, Gambit: Show setup guide, or Gambit: Show live validation guide.' },
    ]);
  });

  it('gives CLI override guidance when a direct Codex backend is misconfigured', async () => {
    const claude = fakeAgent('claude', []);
    const codex = fakeAgent('codex', [{ type: 'done' }]);
    const gemini = fakeAgent('gemini', []);
    vi.mocked(codex.status).mockResolvedValue('misconfigured');
    const sendSpy = vi.spyOn(codex, 'send');

    const router = new MessageRouter({ claude, codex, gemini });

    const events: any[] = [];
    for await (const ev of router.handle('@codex implement this')) events.push(ev);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(events).toEqual([
      { kind: 'routing-needed', text: 'Codex CLI path is misconfigured. Set GAMBIT_CODEX_CLI_PATH / gambit.codexCliPath to codex.js, codex.exe, or codex. You can also run Gambit: Configure Codex/Gemini CLI paths or Gambit: Show setup guide.' },
    ]);
  });

  it('gives Node setup guidance when a direct Codex backend needs Node for a JS bundle', async () => {
    const claude = fakeAgent('claude', []);
    const codex = fakeAgent('codex', [{ type: 'done' }]);
    const gemini = fakeAgent('gemini', []);
    vi.mocked(codex.status).mockResolvedValue('node-missing');
    const sendSpy = vi.spyOn(codex, 'send');

    const router = new MessageRouter({ claude, codex, gemini });

    const events: any[] = [];
    for await (const ev of router.handle('@codex implement this')) events.push(ev);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(events).toEqual([
      { kind: 'routing-needed', text: 'Codex needs Node.js on PATH to launch a JS bundle. Install Node.js, or set GAMBIT_CODEX_CLI_PATH / gambit.codexCliPath to a native codex executable. You can also run Gambit: Configure Codex/Gemini CLI paths or Gambit: Show setup guide.' },
    ]);
  });

  it('gives filesystem guidance when a direct Gemini backend is inaccessible', async () => {
    const claude = fakeAgent('claude', []);
    const codex = fakeAgent('codex', []);
    const gemini = fakeAgent('gemini', [{ type: 'done' }]);
    vi.mocked(gemini.status).mockResolvedValue('inaccessible');
    const sendSpy = vi.spyOn(gemini, 'send');

    const router = new MessageRouter({ claude, codex, gemini });

    const events: any[] = [];
    for await (const ev of router.handle('@gemini review this')) events.push(ev);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(events).toEqual([
      { kind: 'routing-needed', text: 'Gemini files are inaccessible. Check filesystem permissions, rerun outside the current sandbox, or set GAMBIT_GEMINI_CLI_PATH / gambit.geminiCliPath to the Gemini JS bundle, native executable, or Windows npm shim. You can also run Gambit: Configure Codex/Gemini CLI paths, Gambit: Show setup guide, or Gambit: Show live validation guide.' },
    ]);
  });

  it('gives CLI override guidance when a direct Gemini backend is misconfigured', async () => {
    const claude = fakeAgent('claude', []);
    const codex = fakeAgent('codex', []);
    const gemini = fakeAgent('gemini', [{ type: 'done' }]);
    vi.mocked(gemini.status).mockResolvedValue('misconfigured');
    const sendSpy = vi.spyOn(gemini, 'send');

    const router = new MessageRouter({ claude, codex, gemini });

    const events: any[] = [];
    for await (const ev of router.handle('@gemini review this')) events.push(ev);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(events).toEqual([
      { kind: 'routing-needed', text: 'Gemini CLI path is misconfigured. Set GAMBIT_GEMINI_CLI_PATH / gambit.geminiCliPath to gemini.js, gemini.exe, or gemini. You can also run Gambit: Configure Codex/Gemini CLI paths or Gambit: Show setup guide.' },
    ]);
  });

  it('gives Node setup guidance when a direct Gemini backend needs Node for a JS bundle', async () => {
    const claude = fakeAgent('claude', []);
    const codex = fakeAgent('codex', []);
    const gemini = fakeAgent('gemini', [{ type: 'done' }]);
    vi.mocked(gemini.status).mockResolvedValue('node-missing');
    const sendSpy = vi.spyOn(gemini, 'send');

    const router = new MessageRouter({ claude, codex, gemini });

    const events: any[] = [];
    for await (const ev of router.handle('@gemini review this')) events.push(ev);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(events).toEqual([
      { kind: 'routing-needed', text: 'Gemini needs Node.js on PATH to launch a JS bundle. Install Node.js, or set GAMBIT_GEMINI_CLI_PATH / gambit.geminiCliPath to a native gemini executable. You can also run Gambit: Configure Codex/Gemini CLI paths or Gambit: Show setup guide.' },
    ]);
  });

  it('gives filesystem guidance when a direct Claude backend is inaccessible', async () => {
    const claude = fakeAgent('claude', [{ type: 'done' }]);
    const codex = fakeAgent('codex', []);
    const gemini = fakeAgent('gemini', []);
    vi.mocked(claude.status).mockResolvedValue('inaccessible');
    const sendSpy = vi.spyOn(claude, 'send');

    const router = new MessageRouter({ claude, codex, gemini });

    const events: any[] = [];
    for await (const ev of router.handle('@claude review this')) events.push(ev);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(events).toEqual([
      { kind: 'routing-needed', text: 'Claude files are inaccessible. Check filesystem permissions or rerun outside the current sandbox. You can also run Gambit: Show setup guide.' },
    ]);
  });

  it('does not dispatch a directly mentioned agent when its backend is busy', async () => {
    const claude = fakeAgent('claude', []);
    const codex = fakeAgent('codex', [{ type: 'done' }]);
    const gemini = fakeAgent('gemini', []);
    vi.mocked(codex.status).mockResolvedValue('busy');
    const sendSpy = vi.spyOn(codex, 'send');

    const router = new MessageRouter({ claude, codex, gemini });

    const events: any[] = [];
    for await (const ev of router.handle('@codex implement this')) events.push(ev);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(events).toEqual([
      { kind: 'routing-needed', text: 'Codex is busy; wait for the current dispatch or cancel it before sending more work.' },
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

  it('cancelAll: each target gets its own AC; aborting one does not cascade to siblings', async () => {
    let claudeStartedSend = false;
    let codexStartedSend = false;
    const claude: Agent = {
      id: 'claude',
      status: vi.fn().mockResolvedValue('ready'),
      cancel: vi.fn().mockResolvedValue(undefined),
      send: (() => {
        claudeStartedSend = true;
        return (async function* () {
          await new Promise(() => { /* hangs forever */ });
        })();
      }) as Agent['send'],
    };
    const codex: Agent = {
      id: 'codex',
      status: vi.fn().mockResolvedValue('ready'),
      cancel: vi.fn().mockResolvedValue(undefined),
      send: (() => {
        codexStartedSend = true;
        return (async function* () {
          yield { type: 'text', text: 'codex reply' } as AgentChunk;
          yield { type: 'done' } as AgentChunk;
        })();
      }) as Agent['send'],
    };
    const gemini = fakeAgent('gemini', [{ type: 'done' }]);

    const router = new MessageRouter({ claude, codex, gemini });

    const events: any[] = [];
    const task = (async () => {
      for await (const ev of router.handle('@all hello')) events.push(ev);
    })();

    await new Promise((r) => setTimeout(r, 10));
    expect(claudeStartedSend).toBe(true);

    await router.cancelAll();
    await task;

    // Claude was actively dispatching — its drain handles dispatch-end.
    // Codex and Gemini were queued — drainQueue prevents them from getting
    // a real handle, so their send() is never invoked.
    expect(codexStartedSend).toBe(false);
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

    expect(facilitator).toHaveBeenCalledWith('please review this', expect.any(Object), undefined);
    expect(events[0]).toEqual({ kind: 'facilitator-decision', agentId: 'claude', reason: 'code review' });
    expect(events).toContainEqual({ kind: 'dispatch-start', agentId: 'claude' });
  });

  it('with facilitator: refreshes agent statuses before routing', async () => {
    const claude = fakeAgent('claude', [{ type: 'done' }]);
    const codex = fakeAgent('codex', []);
    const gemini = fakeAgent('gemini', []);
    vi.mocked(claude.status).mockResolvedValue('ready');
    vi.mocked(codex.status).mockResolvedValue('unauthenticated');
    vi.mocked(gemini.status).mockResolvedValue('not-installed');
    const facilitator = vi.fn().mockResolvedValue({ agent: 'claude', reason: 'only available' });

    const router = new MessageRouter({ claude, codex, gemini }, facilitator);

    for await (const _ of router.handle('please choose')) { /* drain */ }

    expect(claude.status).toHaveBeenCalledTimes(1);
    expect(codex.status).toHaveBeenCalledTimes(1);
    expect(gemini.status).toHaveBeenCalledTimes(1);
    expect(facilitator).toHaveBeenCalledWith(
      'please choose',
      {
        claude: 'ready',
        codex: 'unauthenticated',
        gemini: 'not-installed',
      },
      undefined,
    );
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

  it('with facilitator selecting an unavailable agent: does not dispatch that agent', async () => {
    const claude = fakeAgent('claude', []);
    const codex = fakeAgent('codex', [{ type: 'done' }]);
    const gemini = fakeAgent('gemini', []);
    vi.mocked(codex.status).mockResolvedValue('unauthenticated');
    const sendSpy = vi.spyOn(codex, 'send');
    const facilitator = vi.fn().mockResolvedValue({ agent: 'codex', reason: 'stale decision' });
    const router = new MessageRouter({ claude, codex, gemini }, facilitator);

    const events: any[] = [];
    for await (const ev of router.handle('please implement this')) events.push(ev);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(events).toEqual([
      { kind: 'facilitator-decision', agentId: 'codex', reason: 'stale decision' },
      { kind: 'routing-needed', text: 'Codex is unauthenticated. Run `codex login`. If `codex` is missing, install it with `npm install -g @openai/codex`. You can also run Gambit: Show setup guide.' },
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
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }

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

describe('per-target prompt composition (v2)', () => {
  it('calls composePromptForTarget once per target before agent.send', async () => {
    const calls: Array<{ id: AgentId; prompt: string }> = [];
    const make = (id: AgentId): Agent => ({
      id,
      status: vi.fn().mockResolvedValue('ready'),
      cancel: vi.fn().mockResolvedValue(undefined),
      async *send(prompt: string) {
        calls.push({ id, prompt });
        yield { type: 'text', text: `from-${id}` };
        yield { type: 'done' };
      },
    });

    const agents = { claude: make('claude'), codex: make('codex'), gemini: make('gemini') };
    const router = new MessageRouter(agents);

    const composer = vi.fn((targetId: AgentId, baseText: string) => `[${targetId}-prompt] ${baseText}`);

    for await (const _ of router.handle('@all hi', { composePromptForTarget: composer })) {
      // drain
    }

    expect(composer).toHaveBeenCalledTimes(3);
    expect(composer).toHaveBeenCalledWith('claude', 'hi');
    expect(composer).toHaveBeenCalledWith('codex', 'hi');
    expect(composer).toHaveBeenCalledWith('gemini', 'hi');
    expect(calls.find((c) => c.id === 'claude')?.prompt).toBe('[claude-prompt] hi');
    expect(calls.find((c) => c.id === 'codex')?.prompt).toBe('[codex-prompt] hi');
    expect(calls.find((c) => c.id === 'gemini')?.prompt).toBe('[gemini-prompt] hi');
  });

  it('forwards sharedContext to facilitator', async () => {
    const facilitator = vi.fn(async (_text: string, _avail: any, _ctx?: string) => ({
      agent: 'claude' as AgentId,
      reason: 'r',
    }));

    const agents = {
      claude: fakeAgent('claude', [{ type: 'done' }]),
      codex: fakeAgent('codex', [{ type: 'done' }]),
      gemini: fakeAgent('gemini', [{ type: 'done' }]),
    };
    const router = new MessageRouter(agents, facilitator as any);

    for await (const _ of router.handle('plain text', {
      composePromptForTarget: (_id, t) => t,
      sharedContextForFacilitator: '[Conversation so far]\nuser: prior\n[/Conversation so far]',
    })) {
      // drain
    }

    expect(facilitator).toHaveBeenCalledWith(
      'plain text',
      expect.any(Object),
      '[Conversation so far]\nuser: prior\n[/Conversation so far]',
    );
  });
});
