import * as vscode from 'vscode';
import * as path from 'node:path';
import type { AgentId } from './types.js';
import type { FileChangeKind } from './shared/protocol.js';

export type FileEditRecord = {
  path: string;
  agentId: AgentId;
  editedAt: number;
  alsoBy: AgentId[];
  changeKind: FileChangeKind;
};

const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

const AGENT_COLORS: Record<AgentId, string> = {
  claude: 'veyra.claudeColor',
  codex: 'veyra.codexColor',
  gemini: 'veyra.geminiColor',
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
  changeKind: FileChangeKind = 'edited',
): FileEditRecord[] {
  const next = state.map((r) => ({ ...r, alsoBy: [...r.alsoBy], changeKind: r.changeKind ?? 'edited' }));
  const existing = next.find((r) => r.path === filePath);
  if (!existing) {
    next.push({ path: filePath, agentId, editedAt: now, alsoBy: [], changeKind });
    return next;
  }
  if (existing.agentId !== agentId) {
    if (!existing.alsoBy.includes(existing.agentId)) {
      existing.alsoBy = [...existing.alsoBy.filter((a) => a !== agentId), existing.agentId];
    }
  }
  existing.agentId = agentId;
  existing.editedAt = now;
  existing.changeKind = changeKind;
  return next;
}

export function pruneStale(state: FileEditRecord[], now: number): FileEditRecord[] {
  return state.filter((r) => now - r.editedAt < TWENTY_FOUR_HOURS);
}

const STATE_KEY = 'veyra.fileEdits';

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

  registerEdit(filePath: string, agentId: AgentId, changeKind: FileChangeKind = 'edited'): void {
    const now = Date.now();
    // Resolve relative paths (Gemini's `replace` tool emits "hello.ts", not an
    // absolute path) against the workspace root before normalizing. Without
    // this, Uri.file('hello.ts').fsPath produces '\hello.ts' on Windows and
    // never matches the real file URI in provideFileDecoration.
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const absolute = path.isAbsolute(filePath) || !ws ? filePath : path.join(ws, filePath);
    const normalized = vscode.Uri.file(absolute).fsPath;
    const next = pruneStale(recordEdit(this.records, normalized, agentId, now, changeKind), now);
    this.records = next;
    void this.context.workspaceState.update(STATE_KEY, next);
    this._onDidChange.fire(vscode.Uri.file(normalized));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') return undefined;
    const record = this.records.find((r) => r.path === uri.fsPath);
    if (!record) return undefined;
    const minutesAgo = Math.floor((Date.now() - record.editedAt) / 60_000);
    const verb = fileChangeVerb(record.changeKind ?? 'edited');
    const tooltip = record.alsoBy.length > 0
      ? `Last ${verb} by ${record.agentId} ${minutesAgo}m ago (also: ${record.alsoBy.join(', ')})`
      : `${capitalize(verb)} by ${record.agentId} ${minutesAgo}m ago`;
    return {
      badge: AGENT_BADGES[record.agentId],
      tooltip,
      color: new vscode.ThemeColor(AGENT_COLORS[record.agentId]),
      propagate: false,
    };
  }
}

function fileChangeVerb(changeKind: FileChangeKind): string {
  switch (changeKind) {
    case 'created':
      return 'created';
    case 'deleted':
      return 'deleted';
    case 'edited':
    default:
      return 'edited';
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
