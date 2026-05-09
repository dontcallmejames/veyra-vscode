import * as path from 'node:path';
import type { AgentId } from './types.js';
import type { FileChange, FileChangeKind, Session, SessionMessage } from './shared/protocol.js';

export function buildEditAwareness(session: Session, targetId: AgentId): string {
  const editedByPath = new Map<string, Set<AgentId>>();
  const changedByPath = new Map<string, Map<FileChangeKind, Set<AgentId>>>();
  let hasExplicitChangeKinds = false;

  for (const message of session.messages) {
    if (!isRelevantAgentMessage(message, targetId)) continue;
    if (message.fileChanges && message.fileChanges.length > 0) {
      hasExplicitChangeKinds = true;
      for (const change of message.fileChanges) {
        addChangedFile(changedByPath, change, message.agentId);
      }
    } else {
      for (const file of message.editedFiles) {
        const normalizedFile = normalizeSessionFilePath(file);
        const agents = editedByPath.get(normalizedFile) ?? new Set<AgentId>();
        agents.add(message.agentId);
        editedByPath.set(normalizedFile, agents);
      }
    }
  }

  if (editedByPath.size === 0 && changedByPath.size === 0) return '';

  if (hasExplicitChangeKinds) {
    const lines = [...changedByPath.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([file, byKind]) => {
        const lineItems: string[] = [];
        for (const kind of ['created', 'edited', 'deleted'] as FileChangeKind[]) {
          const agents = byKind.get(kind);
          if (agents?.size) {
            lineItems.push(`- ${file} ${kind} by ${[...agents].join(', ')}`);
          }
        }
        return lineItems;
      });

    for (const [file, agents] of editedByPath.entries()) {
      lines.push(`- ${file} edited by ${[...agents].join(', ')}`);
    }

    return [
      '[Edit coordination]',
      'Files changed by other agents in this session:',
      ...lines,
      'Before modifying these files, inspect current contents or confirm the file still exists, and preserve other agents\' changes.',
      '[/Edit coordination]',
    ].join('\n');
  }

  const lines = [...editedByPath.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, agents]) => `- ${file} (${[...agents].join(', ')})`);

  return [
    '[Edit coordination]',
    'Files edited by other agents in this session:',
    ...lines,
    'Before modifying these files, inspect current contents and preserve other agents\' changes.',
    '[/Edit coordination]',
  ].join('\n');
}

export function findPriorEditorsForFile(
  session: Session,
  targetId: AgentId,
  filePath: string,
): AgentId[] {
  const editors = new Set<AgentId>();
  const normalizedPath = normalizeSessionFilePath(filePath);
  for (const message of session.messages) {
    if (!isRelevantAgentMessage(message, targetId)) continue;
    const files = message.fileChanges && message.fileChanges.length > 0
      ? message.fileChanges.map((change) => change.path)
      : message.editedFiles;
    if (files.some((file) => normalizeSessionFilePath(file) === normalizedPath)) {
      editors.add(message.agentId);
    }
  }
  return [...editors];
}

export function normalizeSessionFilePath(filePath: string): string {
  const normalized = path.posix.normalize(filePath.replace(/\\/g, '/'));
  return normalized === '.' ? '' : normalized;
}

function isRelevantAgentMessage(
  message: SessionMessage,
  targetId: AgentId,
): message is Extract<SessionMessage, { role: 'agent' }> & { editedFiles: string[]; fileChanges?: FileChange[] } {
  return message.role === 'agent' &&
    message.agentId !== targetId &&
    Array.isArray(message.editedFiles) &&
    message.editedFiles.length > 0;
}

function addChangedFile(
  changedByPath: Map<string, Map<FileChangeKind, Set<AgentId>>>,
  change: FileChange,
  agentId: AgentId,
): void {
  const normalizedFile = normalizeSessionFilePath(change.path);
  const byKind = changedByPath.get(normalizedFile) ?? new Map<FileChangeKind, Set<AgentId>>();
  const agents = byKind.get(change.changeKind) ?? new Set<AgentId>();
  agents.add(agentId);
  byKind.set(change.changeKind, agents);
  changedByPath.set(normalizedFile, byKind);
}
