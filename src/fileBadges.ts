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
  claude: 'gambit.claudeColor',
  codex: 'gambit.codexColor',
  gemini: 'gambit.geminiColor',
};

const AGENT_BADGES: Record<AgentId, string> = {
  claude: 'C',
  codex: 'X',
  gemini: 'G',
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

const STATE_KEY = 'gambit.fileEdits';

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
    // Normalize to VS Code's platform-native fsPath form so it matches uri.fsPath
    // in provideFileDecoration. Without this, forward-slash paths from agents
    // never match VS Code's backslash-normalized URIs on Windows.
    const normalized = vscode.Uri.file(filePath).fsPath;
    const next = pruneStale(recordEdit(this.records, normalized, agentId, now), now);
    this.records = next;
    void this.context.workspaceState.update(STATE_KEY, next);
    this._onDidChange.fire(vscode.Uri.file(normalized));
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
      badge: AGENT_BADGES[record.agentId],
      tooltip,
      color: new vscode.ThemeColor(AGENT_COLORS[record.agentId]),
      propagate: false,
    };
  }
}
