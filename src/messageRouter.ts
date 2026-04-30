import { parseMentions } from './mentions.js';
import { FloorManager } from './floor.js';
import type { Agent } from './agents/types.js';
import type { AgentChunk, AgentId } from './types.js';

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

export class MessageRouter {
  private floor = new FloorManager();

  constructor(private agents: AgentRegistry) {}

  async *handle(input: string): AsyncIterable<RouterEvent> {
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
          for await (const chunk of agent.send(remainingText)) {
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
