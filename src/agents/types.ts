import type { AgentChunk, AgentId, AgentStatus } from '../types.js';

export interface SendOptions {
  /** AbortSignal to cancel an in-flight request. */
  signal?: AbortSignal;
  /** Working directory for the agent's tool execution. */
  cwd?: string;
}

export interface Agent {
  readonly id: AgentId;
  status(): Promise<AgentStatus>;
  send(prompt: string, opts?: SendOptions): AsyncIterable<AgentChunk>;
  cancel(): Promise<void>;
}
