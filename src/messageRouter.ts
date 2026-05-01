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

/**
 * Wraps an async iterable so it terminates when the AbortSignal fires.
 * The in-flight next() promise is abandoned (not cancelled) — acceptable for
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
  private activeAbortController: AbortController | null = null;
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
    this.activeAbortController?.abort();
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

  async *handle(input: string, opts: SendOptions = {}): AsyncIterable<RouterEvent> {
    const { targets, remainingText } = parseMentions(input);

    let dispatchTargets = targets;
    let promptText = remainingText;

    if (dispatchTargets.length === 0) {
      if (!this.facilitator) {
        yield { kind: 'routing-needed', text: remainingText || input };
        return;
      }
      const status: Record<AgentId, AgentStatus> = {
        claude: this.lastStatus.claude ?? 'ready',
        codex: this.lastStatus.codex ?? 'ready',
        gemini: this.lastStatus.gemini ?? 'ready',
      };
      const text = remainingText || input;
      const decision = await this.facilitator(text, status);
      if ('error' in decision) {
        yield { kind: 'routing-needed', text: decision.error };
        return;
      }
      yield { kind: 'facilitator-decision', agentId: decision.agent, reason: decision.reason };
      dispatchTargets = [decision.agent];
      promptText = text;
    }

    // Create an AbortController for this dispatch so cancelAll() can abort it.
    const ac = new AbortController();
    this.activeAbortController = ac;

    // Pre-acquire floor handles for all targets so they queue in the FloorManager.
    // drainQueue() can then cancel queued (not-yet-dispatched) agents.
    const handlePromises = dispatchTargets.map((id) => this.floor.acquire(id));

    for (let i = 0; i < dispatchTargets.length; i++) {
      const handle = await handlePromises[i];

      // A noop handle means this agent was drained by cancelAll(); skip it.
      if (handle.noop) {
        continue;
      }

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
        try {
          for await (const chunk of withAbort(agent.send(promptText, opts), ac.signal)) {
            yield { kind: 'chunk', agentId: targetId, chunk };
          }
          if (watchdogFired) {
            const minutes = (this.watchdogMs / 60_000).toFixed(0);
            const minutesText = minutes === '0' ? `${(this.watchdogMs / 1000).toFixed(0)} seconds` : `${minutes} minutes`;
            yield { kind: 'chunk', agentId: targetId, chunk: { type: 'error', message: `Watchdog: ${targetId} held the floor for over ${minutesText}; releasing.` } };
            yield { kind: 'chunk', agentId: targetId, chunk: { type: 'done' } };
          }
        } catch (err) {
          // Adapters MUST yield error+done chunks instead of throwing, but
          // defend against contract violations so the consumer sees a
          // single, consistent error path.
          const message = err instanceof Error ? err.message : String(err);
          yield { kind: 'chunk', agentId: targetId, chunk: { type: 'error', message } };
          yield { kind: 'chunk', agentId: targetId, chunk: { type: 'done' } };
        }
        yield { kind: 'dispatch-end', agentId: targetId };
      } finally {
        if (watchdog) clearTimeout(watchdog);
        handle.release();
      }
    }

    this.activeAbortController = null;
  }
}
