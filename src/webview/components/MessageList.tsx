import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { UserBubble } from './UserBubble.js';
import { AgentBubble } from './AgentBubble.js';
import type { Session, InProgressMessage, Settings, SessionMessage } from '../../shared/protocol.js';

interface Props {
  session: Session;
  inProgress: Map<string, InProgressMessage>;
  settings: Settings;
}

type PersistedItem = { kind: 'persisted'; message: SessionMessage; ts: number };
type InProgressItem = { kind: 'in-progress'; message: InProgressMessage; ts: number };
type ListItem = PersistedItem | InProgressItem;

export function MessageList({ session, inProgress, settings }: Props) {
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
          return <AgentBubble key={item.message.id} message={item.message} streaming={true} settings={settings} />;
        }
        const m = item.message;
        if (m.role === 'user') return <UserBubble key={m.id} message={m} />;
        if (m.role === 'agent') return <AgentBubble key={m.id} message={m} streaming={false} settings={settings} />;
        // system messages - Task F3 component will replace this; for F1, render a simple div.
        return <div key={m.id} class={`system-notice ${m.kind === 'error' ? 'error' : ''}`}>{m.text}</div>;
      })}
    </div>
  );
}
