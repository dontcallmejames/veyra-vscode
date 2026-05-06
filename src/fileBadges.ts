import * as vscode from 'vscode';
import type { AgentId } from './types.js';

export type FileEditRecord = {
  path: string;
  agentId: AgentId;
  editedAt: number;
  alsoBy: AgentId[];
};

const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

const AGENT_COLORS: Record<AgentId, string> = {
  claude: 'agentChat.claudeColor',
  codex: 'agentChat.codexColor',
  gemini: 'agentChat.geminiColor',
};

export function recordEdit(
  state: FileEditRecord[],
  filePath: string,
  agentId: AgentId,
  now: number,
): FileEditRecord[] {
  const next = state.map((r) => ({ ...r, alsoBy: [...r.alsoBy] }));
  const existing = next.find((r) => r.path === filePath);
  if (!existing) {
    next.push({ path: filePath, agentId, editedAt: now, alsoBy: [] });
    return next;
  }
  if (existing.agentId !== agentId) {
    if (!existing.alsoBy.includes(existing.agentId)) {
      existing.alsoBy = [...existing.alsoBy.filter((a) => a !== agentId), existing.agentId];
    }
  }
  existing.agentId = agentId;
  existing.editedAt = now;
  return next;
}

export function pruneStale(state: FileEditRecord[], now: number): FileEditRecord[] {
  return state.filter((r) => now - r.editedAt < TWENTY_FOUR_HOURS);
}

const STATE_KEY = 'agentChat.fileEdits';

export class FileBadgesController implements vscode.FileDecorationProvider {
  private records: FileEditRecord[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  constructor(private context: vscode.ExtensionContext) {
    const stored = context.workspaceState.get<FileEditRecord[]>(STATE_KEY) ?? [];
    this.records = pruneStale(stored, Date.now());
    if (this.records.length !== stored.length) {
      void context.workspaceState.update(STATE_KEY, this.records);
    }
  }

  registerEdit(filePath: string, agentId: AgentId): void {
    const now = Date.now();
    const next = pruneStale(recordEdit(this.records, filePath, agentId, now), now);
    this.records = next;
    void this.context.workspaceState.update(STATE_KEY, next);
    this._onDidChange.fire(vscode.Uri.file(filePath));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') return undefined;
    const record = this.records.find((r) => r.path === uri.fsPath);
    if (!record) return undefined;
    const minutesAgo = Math.floor((Date.now() - record.editedAt) / 60_000);
    const tooltip = record.alsoBy.length > 0
      ? `Last edited by ${record.agentId} ${minutesAgo}m ago (also: ${record.alsoBy.join(', ')})`
      : `Edited by ${record.agentId} ${minutesAgo}m ago`;
    return {
      badge: '●',
      tooltip,
      color: new vscode.ThemeColor(AGENT_COLORS[record.agentId]),
    };
  }
}
