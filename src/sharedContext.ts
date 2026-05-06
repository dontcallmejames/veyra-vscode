import type { Session, SessionMessage } from './shared/protocol.js';

export interface BuildSharedContextOptions {
  window: number;
}

export function buildSharedContext(session: Session, opts: BuildSharedContextOptions): string {
  const eligible = session.messages.filter(isEligible);
  if (eligible.length === 0) return '';

  const trimmed = eligible.length > opts.window;
  const slice = trimmed ? eligible.slice(eligible.length - opts.window) : eligible;

  const header = trimmed
    ? '[Conversation so far — earlier messages omitted]'
    : '[Conversation so far]';

  const lines = slice.map(formatMessage);
  return [header, ...lines, '[/Conversation so far]'].join('\n');
}

function isEligible(m: SessionMessage): boolean {
  if (m.role === 'user') return true;
  if (m.role === 'agent') return m.status === 'complete' || m.status === 'errored';
  return false; // system messages excluded
}

function formatMessage(m: SessionMessage): string {
  if (m.role === 'user') return `user: ${m.text}`;
  if (m.role === 'agent') return `${m.agentId}: ${m.text}`;
  return ''; // unreachable; isEligible filtered this
}
