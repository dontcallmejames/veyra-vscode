import { h } from 'preact';
import { useState, useRef } from 'preact/hooks';
import type { AgentId, AgentStatus } from '../../types.js';
import type { FromWebview } from '../../shared/protocol.js';
import { HealthStrip } from './HealthStrip.js';

interface Props {
  send: (msg: FromWebview) => void;
  floorHolder: AgentId | null;
  status: Record<AgentId, AgentStatus>;
}

export function Composer({ send, floorHolder, status }: Props) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = () => {
    if (!text.trim()) return;
    send({ kind: 'send', text });
    setText('');
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isFloorHeld = floorHolder !== null;

  return (
    <div class="composer">
      <textarea
        ref={textareaRef}
        value={text}
        placeholder="Type @ to mention an agent..."
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={handleKeyDown}
      />
      <div class="composer-row">
        <HealthStrip status={status} send={send} />
        <div style="flex:1" />
        {isFloorHeld && (
          <button class="cancel" onClick={() => send({ kind: 'cancel' })}>Cancel</button>
        )}
        <button onClick={handleSend} disabled={!text.trim()}>Send</button>
      </div>
    </div>
  );
}
