import { h } from 'preact';
import type { ToolEvent, Settings } from '../../shared/protocol.js';

interface Props {
  event: ToolEvent;
  renderStyle: Settings['toolCallRenderStyle'];
}

export function ToolCallCard({ event, renderStyle }: Props) {
  if (renderStyle === 'hidden') return null;
  return <div class="tool-card compact"><div class="tool-card-head">{event.kind} {event.name}</div></div>;
}
