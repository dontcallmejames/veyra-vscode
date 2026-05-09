import { parseFileMentions } from './fileMentions.js';
import { parseMentions } from './mentions.js';
import type { FileChange, Session, SessionMessage } from './shared/protocol.js';

export interface BuildSharedContextOptions {
  window: number;
}

export function buildSharedContext(session: Session, opts: BuildSharedContextOptions): string {
  const eligible = session.messages.filter(isEligible);
  if (eligible.length === 0) return '';

  const trimmed = eligible.length > opts.window;
  const slice = trimmed ? eligible.slice(eligible.length - opts.window) : eligible;

  const header = trimmed
    ? '[Conversation so far - earlier messages omitted]'
    : '[Conversation so far]';

  const lines = slice.map(formatMessage);
  return [header, ...lines, '[/Conversation so far]'].join('\n');
}

function isEligible(m: SessionMessage): boolean {
  if (m.role === 'user') return true;
  if (m.role === 'agent') return m.status === 'complete' || m.status === 'errored';
  return m.kind === 'edit-conflict' || (m.kind === 'error' && (Boolean(m.agentId) || Boolean(m.filePath)));
}

function formatMessage(m: SessionMessage): string {
  if (m.role === 'user') {
    const targets = m.mentions?.length ? ` -> ${m.mentions.join(', ')}` : '';
    const text = formatUserText(m);
    const lines = [formatLabeledText(`user${targets}`, text)];
    if (m.attachedFiles && m.attachedFiles.length > 0) {
      lines.push(`user attached files: ${m.attachedFiles.map(formatAttachedFile).join(', ')}`);
    }
    return lines.join('\n');
  }
  if (m.role === 'agent') {
    const lines = [formatLabeledText(m.agentId, m.text)];
    if (m.status === 'errored' && m.error) {
      lines.push(formatLabeledText(`${m.agentId} error`, m.error));
    }
    for (const summary of formatFileChangeSummaries(m)) {
      lines.push(`${m.agentId} ${summary}`);
    }
    return lines.join('\n');
  }
  return formatLabeledText(`system ${m.kind}`, m.text);
}

function formatUserText(m: Extract<SessionMessage, { role: 'user' }>): string {
  const routedText = m.mentions?.length ? parseMentions(m.text).remainingText : m.text;
  return parseFileMentions(routedText).remainingText;
}

function formatLabeledText(label: string, text: string): string {
  const [firstLine, ...continuationLines] = text.split(/\r?\n/);
  return [
    `${label}: ${firstLine}`,
    ...continuationLines.map((line) => `  ${line}`),
  ].join('\n');
}

function formatAttachedFile(file: { path: string; lines: number; truncated: boolean }): string {
  const lines = file.lines === 1 ? '1 line' : `${file.lines} lines`;
  const truncated = file.truncated ? ', truncated' : '';
  return `${file.path} (${lines}${truncated})`;
}

function formatFileChangeSummaries(m: Extract<SessionMessage, { role: 'agent' }>): string[] {
  if (m.fileChanges && m.fileChanges.length > 0) {
    const byKind = new Map<FileChange['changeKind'], string[]>();
    for (const change of m.fileChanges) {
      const paths = byKind.get(change.changeKind) ?? [];
      paths.push(change.path);
      byKind.set(change.changeKind, paths);
    }

    const lines: string[] = [];
    const creates = byKind.get('created');
    if (creates?.length) lines.push(`creates: ${creates.join(', ')}`);
    const edits = byKind.get('edited');
    if (edits?.length) lines.push(`edits: ${edits.join(', ')}`);
    const deletes = byKind.get('deleted');
    if (deletes?.length) lines.push(`deletes: ${deletes.join(', ')}`);
    return lines;
  }

  if (m.editedFiles && m.editedFiles.length > 0) {
    return [`edits: ${m.editedFiles.join(', ')}`];
  }

  return [];
}
