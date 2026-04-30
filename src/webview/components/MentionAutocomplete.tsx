import { h } from 'preact';

const ITEMS = [
  { token: '@claude', desc: 'code reasoning' },
  { token: '@gpt', desc: 'execution & tests' },
  { token: '@gemini', desc: 'research' },
  { token: '@all', desc: 'broadcast to all three' },
];

interface Props {
  filter: string;
  activeIndex: number;
  onPick: (token: string) => void;
}

export function MentionAutocomplete({ filter, activeIndex, onPick }: Props) {
  const filtered = ITEMS.filter((i) => i.token.toLowerCase().includes(filter.toLowerCase()));
  if (filtered.length === 0) return null;
  return (
    <div class="mention-popover">
      {filtered.map((item, i) => (
        <div
          class={`mention-item ${i === activeIndex ? 'active' : ''}`}
          onMouseDown={(e) => { e.preventDefault(); onPick(item.token); }}
        >
          <span>{item.token}</span>
          <span style="opacity:0.6;font-size:11px;margin-left:6px">{item.desc}</span>
        </div>
      ))}
    </div>
  );
}

export const MENTION_ITEMS = ITEMS;
