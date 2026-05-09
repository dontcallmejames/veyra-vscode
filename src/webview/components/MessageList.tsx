import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { UserBubble } from './UserBubble.js';
import { AgentBubble } from './AgentBubble.js';
import { SystemNotice } from './SystemNotice.js';
import type { FromWebview, Session, InProgressMessage, Settings, SessionMessage } from '../../shared/protocol.js';

interface Props {
  session: Session;
  inProgress: Map<string, InProgressMessage>;
  settings: Settings;
  send: (message: FromWebview) => void;
}

type PersistedItem = { kind: 'persisted'; message: SessionMessage; ts: number };
type InProgressItem = { kind: 'in-progress'; message: InProgressMessage; ts: number };
type ListItem = PersistedItem | InProgressItem;

export function MessageList({ session, inProgress, settings, send }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session.messages.length, inProgress.size]);

  // Merge persisted history + in-progress, ordered by timestamp
  const items: ListItem[] = [
    ...session.messages.map((m): PersistedItem => ({ kind: 'persisted', message: m, ts: m.timestamp })),
    ...Array.from(inProgress.values()).map((m): InProgressItem => ({ kind: 'in-progress', message: m, ts: m.timestamp })),
  ].sort((a, b) => a.ts - b.ts);

  return (
    <div class="message-list" ref={listRef}>
      {items.map((item) => {
        if (item.kind === 'in-progress') {
          return <AgentBubble key={item.message.id} message={item.message} streaming={true} settings={settings} send={send} />;
        }
        const m = item.message;
        if (m.role === 'user') return <UserBubble key={m.id} message={m} />;
        if (m.role === 'agent') return <AgentBubble key={m.id} message={m} streaming={false} settings={settings} send={send} />;
        if (m.role === 'system') return <SystemNotice key={m.id} message={m} send={send} />;
      })}
    </div>
  );
}
