import { parseMentions } from './mentions.js';
import { FloorManager } from './floor.js';
import type { Agent, SendOptions } from './agents/types.js';
import type { AgentChunk, AgentId, AgentStatus } from './types.js';

export interface AgentRegistry {
  claude: Agent;
  codex: Agent;
  gemini: Agent;
}

export type RouterEvent =
  | { kind: 'dispatch-start'; agentId: AgentId }
  | { kind: 'chunk'; agentId: AgentId; chunk: AgentChunk }
  | { kind: 'dispatch-end'; agentId: AgentId }
  | { kind: 'routing-needed'; text: string };

type FloorListener = (holder: AgentId | null) => void;
type StatusListener = (agentId: AgentId, status: AgentStatus) => void;

export class MessageRouter {
  private floor = new FloorManager();
  private floorListeners = new Set<FloorListener>();
  private statusListeners = new Set<StatusListener>();
  private lastStatus: Partial<Record<AgentId, AgentStatus>> = {};

  constructor(private agents: AgentRegistry) {
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

    if (targets.length === 0) {
      yield { kind: 'routing-needed', text: remainingText || input };
      return;
    }

    for (const targetId of targets) {
      const handle = await this.floor.acquire(targetId);
      try {
        yield { kind: 'dispatch-start', agentId: targetId };
        const agent = this.agents[targetId];
        try {
          for await (const chunk of agent.send(remainingText, opts)) {
            yield { kind: 'chunk', agentId: targetId, chunk };
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
        handle.release();
      }
    }
  }
}
