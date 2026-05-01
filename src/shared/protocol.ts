import type { AgentChunk, AgentId, AgentStatus } from '../types.js';

// === Persisted message types ===

export type ToolEvent =
  | { kind: 'call'; name: string; input: unknown; timestamp: number }
  | { kind: 'result'; name: string; output: unknown; timestamp: number };

export type UserMessage = {
  id: string;
  role: 'user';
  text: string;
  timestamp: number;
  mentions?: AgentId[];
};

export type AgentMessage = {
  id: string;
  role: 'agent';
  agentId: AgentId;
  text: string;
  toolEvents: ToolEvent[];
  timestamp: number;
  status: 'complete' | 'cancelled' | 'errored';
  error?: string;
};

export type SystemMessage = {
  id: string;
  role: 'system';
  kind: 'routing-needed' | 'error';
  text: string;
  timestamp: number;
};

export type SessionMessage = UserMessage | AgentMessage | SystemMessage;

export type Session = {
  version: 1;
  messages: SessionMessage[];
};

// === Webview-only in-progress shape (not persisted) ===

export type InProgressMessage = {
  id: string;
  role: 'agent';
  agentId: AgentId;
  text: string;
  toolEvents: ToolEvent[];
  timestamp: number;
};

// === Settings ===

export type Settings = {
  toolCallRenderStyle: 'verbose' | 'compact' | 'hidden';
};

export const DEFAULT_SETTINGS: Settings = {
  toolCallRenderStyle: 'compact',
};

// === postMessage protocol ===

export type FromExtension =
  | { kind: 'init'; session: Session; status: Record<AgentId, AgentStatus>; settings: Settings }
  | { kind: 'message-started'; id: string; agentId: AgentId; timestamp: number }
  | { kind: 'message-chunk'; id: string; chunk: AgentChunk }
  | { kind: 'message-finalized'; message: AgentMessage }
  | { kind: 'system-message'; message: SystemMessage }
  | { kind: 'floor-changed'; holder: AgentId | null }
  | { kind: 'status-changed'; agentId: AgentId; status: AgentStatus }
  | { kind: 'settings-changed'; settings: Settings }
  | { kind: 'user-message-appended'; message: UserMessage };

export type FromWebview =
  | { kind: 'send'; text: string }
  | { kind: 'cancel' }
  | { kind: 'reload-status' }
  | { kind: 'open-external'; url: string };
