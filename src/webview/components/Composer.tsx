import { h } from 'preact';
import { useState, useRef, useEffect, useMemo } from 'preact/hooks';
import type { AgentId, AgentStatus } from '../../types.js';
import type { FromWebview } from '../../shared/protocol.js';
import { HealthStrip } from './HealthStrip.js';
import { MentionAutocomplete, MENTION_ITEMS } from './MentionAutocomplete.js';

interface Props {
  send: (msg: FromWebview) => void;
  floorHolder: AgentId | null;
  status: Record<AgentId, AgentStatus>;
  gambitMdPresent: boolean;
}

const AGENT_TOKENS = new Set(['@claude', '@gpt', '@codex', '@chatgpt', '@gemini', '@all']);

function detectFileMentions(text: string): string[] {
  const out: string[] = [];
  for (const t of text.split(/\s+/)) {
    if (!t.startsWith('@')) continue;
    if (AGENT_TOKENS.has(t.toLowerCase())) continue;
    const path = t.slice(1);
    if (path.includes('/') || path.includes('.')) out.push(path);
  }
  return out;
}

export function Composer({ send, floorHolder, status, gambitMdPresent }: Props) {
  const [text, setText] = useState('');
  const [autocomplete, setAutocomplete] = useState<{ open: boolean; filter: string; activeIndex: number }>({
    open: false, filter: '', activeIndex: 0,
  });
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const lastToken = text.split(/\s+/).at(-1) ?? '';
    if (lastToken.startsWith('@') && lastToken.length >= 1 && !lastToken.includes('/') && !lastToken.includes('.')) {
      setAutocomplete((a) => ({ ...a, open: true, filter: lastToken, activeIndex: 0 }));
    } else if (autocomplete.open) {
      setAutocomplete((a) => ({ ...a, open: false }));
    }
  }, [text]);

  const filePaths = useMemo(() => detectFileMentions(text), [text]);

  const handleSend = () => {
    if (!text.trim()) return;
    send({ kind: 'send', text });
    setText('');
  };

  const pickMention = (token: string) => {
    const tokens = text.split(/\s+/);
    tokens.pop();
    tokens.push(token + ' ');
    setText(tokens.join(' '));
    setAutocomplete((a) => ({ ...a, open: false }));
    textareaRef.current?.focus();
  };

  const filtered = MENTION_ITEMS.filter((i) =>
    i.token.toLowerCase().includes(autocomplete.filter.toLowerCase())
  );

  const handleKeyDown = (e: KeyboardEvent) => {
    if (autocomplete.open && filtered.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setAutocomplete((a) => ({ ...a, activeIndex: (a.activeIndex + 1) % filtered.length })); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setAutocomplete((a) => ({ ...a, activeIndex: (a.activeIndex - 1 + filtered.length) % filtered.length })); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); pickMention(filtered[autocomplete.activeIndex].token); return; }
      if (e.key === 'Escape') { e.preventDefault(); setAutocomplete((a) => ({ ...a, open: false })); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isFloorHeld = floorHolder !== null;

  return (
    <div class="composer">
      {autocomplete.open && (
        <MentionAutocomplete filter={autocomplete.filter} activeIndex={autocomplete.activeIndex} onPick={pickMention} />
      )}
      <textarea
        ref={textareaRef}
        value={text}
        placeholder="Type @ to mention an agent or @path/to/file to attach…"
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={handleKeyDown}
      />
      {filePaths.length > 0 && (
        <div class="file-chip-row">
          {filePaths.map((p) => (
            <span class="file-chip" key={p}>📎 {p}</span>
          ))}
        </div>
      )}
      <div class="composer-row">
        <HealthStrip status={status} send={send} gambitMdPresent={gambitMdPresent} />
        <div style="flex:1" />
        {isFloorHeld && (
          <button class="cancel" onClick={() => send({ kind: 'cancel' })}>Cancel</button>
        )}
        <button onClick={handleSend} disabled={!text.trim()}>Send</button>
      </div>
    </div>
  );
}
