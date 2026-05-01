import type { AgentId } from './types.js';

export interface FloorHandle {
  release(): void;
  /** True when the handle was issued by drainQueue — callers should skip dispatch. */
  readonly noop?: boolean;
}

type Waiter = {
  agent: AgentId;
  resolve: (handle: FloorHandle) => void;
};

type ChangeListener = (holder: AgentId | null) => void;

export class FloorManager {
  private current: AgentId | null = null;
  private waiters: Waiter[] = [];
  private listeners = new Set<ChangeListener>();

  holder(): AgentId | null {
    return this.current;
  }

  queueLength(): number {
    return this.waiters.length;
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  acquire(agent: AgentId): Promise<FloorHandle> {
    return new Promise((resolve) => {
      if (this.current === null) {
        this.grant(agent, resolve);
      } else {
        this.waiters.push({ agent, resolve });
      }
    });
  }

  /**
   * Drop all queued waiters. Each pending acquire() resolves with a no-op
   * handle (release does not grant the floor to anyone) so callers don't
   * hang. Returns the list of agents that were waiting.
   */
  drainQueue(): AgentId[] {
    const drained = this.waiters.map((w) => w.agent);
    for (const w of this.waiters) {
      const noopHandle: FloorHandle = { noop: true, release: () => { /* no-op */ } };
      w.resolve(noopHandle);
    }
    this.waiters.length = 0;
    return drained;
  }

  private grant(agent: AgentId, resolve: (handle: FloorHandle) => void): void {
    this.current = agent;
    this.emit();
    let released = false;
    const handle: FloorHandle = {
      release: () => {
        if (released) return;
        released = true;
        this.current = null;
        this.emit();
        const next = this.waiters.shift();
        if (next) {
          this.grant(next.agent, next.resolve);
        }
      },
    };
    resolve(handle);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.current);
  }
}
