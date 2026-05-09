import { parseMentions } from './mentions.js';
import { FloorManager } from './floor.js';
import type { Agent, SendOptions } from './agents/types.js';
import type { AgentChunk, AgentId, AgentStatus } from './types.js';
import type { FacilitatorFn } from './facilitator.js';

export interface AgentRegistry {
  claude: Agent;
  codex: Agent;
  gemini: Agent;
}

export interface RouterOptions {
  watchdogMs?: number;
}

export type RouterEvent =
  | { kind: 'dispatch-start'; agentId: AgentId }
  | { kind: 'chunk'; agentId: AgentId; chunk: AgentChunk }
  | { kind: 'dispatch-end'; agentId: AgentId }
  | { kind: 'routing-needed'; text: string }
  | { kind: 'facilitator-decision'; agentId: AgentId; reason: string };

type FloorListener = (holder: AgentId | null) => void;
type StatusListener = (agentId: AgentId, status: AgentStatus) => void;

const AGENT_IDS: AgentId[] = ['claude', 'codex', 'gemini'];

/**
 * Wraps an async iterable so it terminates when the AbortSignal fires.
 * The in-flight next() promise is abandoned (not cancelled) - acceptable for
 * generators that block indefinitely, as in tests.
 */
async function* withAbort<T>(source: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const iter = source[Symbol.asyncIterator]();
  const abortPromise = new Promise<IteratorReturnResult<undefined>>((resolve) => {
    if (signal.aborted) {
      resolve({ done: true, value: undefined });
    } else {
      signal.addEventListener('abort', () => resolve({ done: true, value: undefined }), { once: true });
    }
  });

  while (true) {
    const result = await Promise.race([iter.next(), abortPromise]);
    if (result.done) {
      // Fire-and-forget: iter.return() on a blocked async generator hangs if awaited.
      void iter.return?.();
      return;
    }
    yield result.value;
  }
}

export class MessageRouter {
  private floor = new FloorManager();
  private floorListeners = new Set<FloorListener>();
  private statusListeners = new Set<StatusListener>();
  private lastStatus: Partial<Record<AgentId, AgentStatus>> = {};
  private activeControllers: Set<AbortController> = new Set();
  private watchdogMs: number;

  constructor(
    private agents: AgentRegistry,
    private facilitator?: FacilitatorFn,
    options: RouterOptions = {},
  ) {
    this.watchdogMs = options.watchdogMs ?? 0;
    this.floor.onChange((holder) => {
      for (const l of this.floorListeners) l(holder);
    });
  }

  onFloorChange(listener: FloorListener): () => void {
    this.floorListeners.add(listener);
    return () => this.floorListeners.delete(listener);
  }

  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  async cancelAll(): Promise<void> {
    this.floor.drainQueue();
    for (const ac of this.activeControllers) {
      ac.abort();
    }
    await Promise.all([
      this.agents.claude.cancel(),
      this.agents.codex.cancel(),
      this.agents.gemini.cancel(),
    ]);
  }

  /** Called externally (by ChatPanel after running statusChecks) to broadcast a change. */
  notifyStatusChange(agentId: AgentId, status: AgentStatus): void {
    if (this.lastStatus[agentId] === status) return;
    this.lastStatus[agentId] = status;
    for (const l of this.statusListeners) l(agentId, status);
  }

  async *handle(
    input: string,
    opts: SendOptions & {
      composePromptForTarget?: (targetId: AgentId, baseText: string) => string;
      sharedContextForFacilitator?: string;
    } = {},
  ): AsyncIterable<RouterEvent> {
    const { targets, remainingText } = parseMentions(input);

    let dispatchTargets = targets;
    let promptText = remainingText;

    if (dispatchTargets.length === 0) {
      if (!this.facilitator) {
        yield { kind: 'routing-needed', text: remainingText || input };
        return;
      }
      const status = await this.refreshAgentStatuses();
      const text = remainingText || input;
      const decision = await this.facilitator(text, status, opts.sharedContextForFacilitator);
      if ('error' in decision) {
        yield { kind: 'routing-needed', text: decision.error };
        return;
      }
      yield { kind: 'facilitator-decision', agentId: decision.agent, reason: decision.reason };
      if (!canDispatch(status[decision.agent])) {
        yield { kind: 'routing-needed', text: unavailableAgentMessage(decision.agent, status[decision.agent]) };
        return;
      }
      dispatchTargets = [decision.agent];
      promptText = text;
    } else {
      const status = await this.refreshAgentStatuses();
      const unavailable = dispatchTargets.filter((id) => !canDispatch(status[id]));
      if (unavailable.length > 0) {
        yield {
          kind: 'routing-needed',
          text: unavailable.map((id) => unavailableAgentMessage(id, status[id])).join('\n'),
        };
        dispatchTargets = dispatchTargets.filter((id) => canDispatch(status[id]));
        if (dispatchTargets.length === 0) return;
      }
    }

    const handlePromises = dispatchTargets.map((id) => this.floor.acquire(id));

    for (let i = 0; i < dispatchTargets.length; i++) {
      const handle = await handlePromises[i];
      if (handle.noop) continue;

      const ac = new AbortController();
      this.activeControllers.add(ac);

      const targetId = dispatchTargets[i];
      let watchdogFired = false;
      const watchdog = this.watchdogMs > 0 ? setTimeout(() => {
        watchdogFired = true;
        ac.abort();
        this.agents[targetId].cancel().catch(() => { /* best-effort */ });
      }, this.watchdogMs) : null;

      try {
        yield { kind: 'dispatch-start', agentId: targetId };
        const agent = this.agents[targetId];
        // V2: rebuild prompt fresh for each target so later @all members see prior replies.
        const finalPrompt = opts.composePromptForTarget
          ? opts.composePromptForTarget(targetId, promptText)
          : promptText;
        try {
          for await (const chunk of withAbort(agent.send(finalPrompt, opts), ac.signal)) {
            yield { kind: 'chunk', agentId: targetId, chunk };
          }
          if (watchdogFired) {
            const minutes = (this.watchdogMs / 60_000).toFixed(0);
            const minutesText = minutes === '0' ? `${(this.watchdogMs / 1000).toFixed(0)} seconds` : `${minutes} minutes`;
            yield { kind: 'chunk', agentId: targetId, chunk: { type: 'error', message: `Watchdog: ${targetId} held the floor for over ${minutesText}; releasing.` } };
            yield { kind: 'chunk', agentId: targetId, chunk: { type: 'done' } };
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          yield { kind: 'chunk', agentId: targetId, chunk: { type: 'error', message } };
          yield { kind: 'chunk', agentId: targetId, chunk: { type: 'done' } };
        }
        yield { kind: 'dispatch-end', agentId: targetId };
      } finally {
        if (watchdog) clearTimeout(watchdog);
        this.activeControllers.delete(ac);
        handle.release();
      }
    }
  }

  private async refreshAgentStatuses(): Promise<Record<AgentId, AgentStatus>> {
    const entries = await Promise.all(AGENT_IDS.map(async (id): Promise<[AgentId, AgentStatus]> => {
      try {
        return [id, await this.agents[id].status()];
      } catch {
        return [id, this.lastStatus[id] ?? 'unauthenticated'];
      }
    }));

    const statuses = Object.fromEntries(entries) as Record<AgentId, AgentStatus>;
    for (const [id, status] of entries) {
      this.notifyStatusChange(id, status);
    }
    return statuses;
  }
}

function canDispatch(status: AgentStatus): boolean {
  return status === 'ready';
}

function unavailableAgentMessage(agentId: AgentId, status: AgentStatus): string {
  if (status === 'busy') {
    return `${agentLabel(agentId)} is busy; wait for the current dispatch or cancel it before sending more work.`;
  }
  return setupMessage(agentId, status);
}

function setupMessage(agentId: AgentId, status: AgentStatus): string {
  if (agentId === 'codex') {
    if (status === 'not-installed') {
      return 'Codex is not installed. Install it with `npm install -g @openai/codex`, then run `codex login`. You can also run Gambit: Configure Codex/Gemini CLI paths or Gambit: Show setup guide.';
    }
    if (status === 'inaccessible') {
      return 'Codex files are inaccessible. Check filesystem permissions, rerun outside the current sandbox, or set GAMBIT_CODEX_CLI_PATH / gambit.codexCliPath to the Codex JS bundle, native executable, or Windows npm shim. You can also run Gambit: Configure Codex/Gemini CLI paths, Gambit: Show setup guide, or Gambit: Show live validation guide.';
    }
    if (status === 'misconfigured') {
      return 'Codex CLI path is misconfigured. Set GAMBIT_CODEX_CLI_PATH / gambit.codexCliPath to codex.js, codex.exe, or codex. You can also run Gambit: Configure Codex/Gemini CLI paths or Gambit: Show setup guide.';
    }
    if (status === 'node-missing') {
      return 'Codex needs Node.js on PATH to launch a JS bundle. Install Node.js, or set GAMBIT_CODEX_CLI_PATH / gambit.codexCliPath to a native codex executable. You can also run Gambit: Configure Codex/Gemini CLI paths or Gambit: Show setup guide.';
    }
    return 'Codex is unauthenticated. Run `codex login`. If `codex` is missing, install it with `npm install -g @openai/codex`. You can also run Gambit: Show setup guide.';
  }

  if (agentId === 'gemini') {
    if (status === 'not-installed') {
      return 'Gemini is not installed. Install it with `npm install -g @google/gemini-cli`, then run `gemini` once to sign in. You can also run Gambit: Configure Codex/Gemini CLI paths or Gambit: Show setup guide.';
    }
    if (status === 'inaccessible') {
      return 'Gemini files are inaccessible. Check filesystem permissions, rerun outside the current sandbox, or set GAMBIT_GEMINI_CLI_PATH / gambit.geminiCliPath to the Gemini JS bundle, native executable, or Windows npm shim. You can also run Gambit: Configure Codex/Gemini CLI paths, Gambit: Show setup guide, or Gambit: Show live validation guide.';
    }
    if (status === 'misconfigured') {
      return 'Gemini CLI path is misconfigured. Set GAMBIT_GEMINI_CLI_PATH / gambit.geminiCliPath to gemini.js, gemini.exe, or gemini. You can also run Gambit: Configure Codex/Gemini CLI paths or Gambit: Show setup guide.';
    }
    if (status === 'node-missing') {
      return 'Gemini needs Node.js on PATH to launch a JS bundle. Install Node.js, or set GAMBIT_GEMINI_CLI_PATH / gambit.geminiCliPath to a native gemini executable. You can also run Gambit: Configure Codex/Gemini CLI paths or Gambit: Show setup guide.';
    }
    return 'Gemini is unauthenticated. Run `gemini` once to sign in. If `gemini` is missing, install it with `npm install -g @google/gemini-cli`. You can also run Gambit: Show setup guide.';
  }

  if (status === 'not-installed') {
    return 'Claude is not installed. Install Claude Code, then run `claude` to sign in. You can also run Gambit: Show setup guide.';
  }
  if (status === 'inaccessible') {
    return 'Claude files are inaccessible. Check filesystem permissions or rerun outside the current sandbox. You can also run Gambit: Show setup guide.';
  }
  if (status === 'node-missing') {
    return 'Claude needs Node.js on PATH when running inside VS Code. Install Node.js, then retry. You can also run Gambit: Show setup guide.';
  }
  return 'Claude is unauthenticated. Run `claude` to sign in. You can also run Gambit: Show setup guide.';
}

function agentLabel(agentId: AgentId): string {
  if (agentId === 'claude') return 'Claude';
  if (agentId === 'codex') return 'Codex';
  return 'Gemini';
}
