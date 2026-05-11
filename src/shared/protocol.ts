import type { AgentChunk, AgentId, AgentStatus } from '../types.js';

export type FileChangeKind = 'created' | 'edited' | 'deleted';

export type FileChange = {
  path: string;
  changeKind: FileChangeKind;
};

export type ChangeSetStatus = 'pending' | 'accepted' | 'rejected' | 'stale';

export type DispatchChangeSetSummary = {
  id: string;
  agentId: AgentId;
  messageId: string;
  timestamp: number;
  readOnly: boolean;
  status: ChangeSetStatus;
  fileCount: number;
  files: FileChange[];
};

export type CheckpointStatus = 'available' | 'rolled-back' | 'stale' | 'pruned';
export type CheckpointSource = 'automatic' | 'manual';

export type CheckpointSummary = {
  id: string;
  timestamp: number;
  source: CheckpointSource;
  label: string;
  promptSummary: string;
  status: CheckpointStatus;
  fileCount: number;
  agentId?: AgentId;
  messageId?: string;
  workflow?: string;
};

export type RollbackCheckpointPreview = {
  checkpointId: string;
  status: 'ready' | 'stale';
  files: FileChange[];
  staleFiles: string[];
};

export type RollbackCheckpointResult = {
  checkpointId: string;
  status: 'rolled-back' | 'stale';
  staleFiles: string[];
  restoredFiles: string[];
};

// === Persisted message types ===

export type ToolEvent =
  | { kind: 'call'; name: string; input: unknown; timestamp: number }
  | { kind: 'result'; name: string; output: unknown; timestamp: number };

export type AttachedFile = {
  path: string;     // workspace-relative or absolute as resolved at send time
  lines: number;
  truncated: boolean;
};

export type UserMessage = {
  id: string;
  role: 'user';
  text: string;
  timestamp: number;
  mentions?: AgentId[];
  attachedFiles?: AttachedFile[];
};

export type AgentMessage = {
  id: string;
  role: 'agent';
  agentId: AgentId;
  text: string;
  toolEvents: ToolEvent[];
  editedFiles?: string[];
  fileChanges?: FileChange[];
  timestamp: number;
  status: 'complete' | 'cancelled' | 'errored';
  error?: string;
};

export type SystemMessage = {
  id: string;
  role: 'system';
  kind: 'routing-needed' | 'error' | 'facilitator-decision' | 'edit-conflict' | 'file-edited' | 'change-set' | 'checkpoint';
  text: string;
  timestamp: number;
  agentId?: AgentId;     // present when a system notice is associated with a specific agent
  reason?: string;       // present only when kind === 'facilitator-decision' (separate from `text` for richer rendering)
  filePath?: string;     // present when kind === 'file-edited' or kind === 'edit-conflict'
  changeKind?: FileChangeKind;
  changeSet?: DispatchChangeSetSummary;
  checkpoint?: CheckpointSummary;
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
  | { kind: 'init'; session: Session; status: Record<AgentId, AgentStatus>; settings: Settings; veyraMdPresent: boolean }
  | { kind: 'veyra-md-changed'; present: boolean }
  | { kind: 'message-started'; id: string; agentId: AgentId; timestamp: number }
  | { kind: 'message-chunk'; id: string; chunk: AgentChunk }
  | { kind: 'message-finalized'; message: AgentMessage }
  | { kind: 'system-message'; message: SystemMessage }
  | { kind: 'floor-changed'; holder: AgentId | null }
  | { kind: 'status-changed'; agentId: AgentId; status: AgentStatus }
  | { kind: 'settings-changed'; settings: Settings }
  | { kind: 'user-message-appended'; message: UserMessage }
  | { kind: 'file-edited'; path: string; agentId: AgentId; timestamp: number; changeKind?: FileChangeKind };

export type FromWebview =
  | { kind: 'send'; text: string }
  | { kind: 'cancel' }
  | { kind: 'reload-status' }
  | { kind: 'configure-cli-paths' }
  | { kind: 'show-setup-guide' }
  | { kind: 'show-live-validation-guide' }
  | { kind: 'open-external'; url: string }
  | { kind: 'open-workspace-file'; relativePath: string }
  | { kind: 'open-change-set-diff'; changeSetId: string; filePath?: string }
  | { kind: 'accept-change-set'; changeSetId: string }
  | { kind: 'reject-change-set'; changeSetId: string }
  | { kind: 'create-checkpoint'; label?: string }
  | { kind: 'rollback-latest-checkpoint' };
