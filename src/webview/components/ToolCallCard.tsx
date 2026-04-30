import { h } from 'preact';
import { useState } from 'preact/hooks';
import type { ToolEvent, Settings } from '../../shared/protocol.js';

interface Props {
  event: ToolEvent;
  renderStyle: Settings['toolCallRenderStyle'];
}

export function ToolCallCard({ event, renderStyle }: Props) {
  const [expanded, setExpanded] = useState(false);
  if (renderStyle === 'hidden') return null;

  const verb = event.kind === 'call' ? '→' : '←';
  const summary = `${verb} ${event.name}`;
  const detail = event.kind === 'call' ? event.input : event.output;
  const detailStr = detail === undefined ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2));

  const classes = ['tool-card', renderStyle];
  if (expanded) classes.push('expanded');

  if (renderStyle === 'verbose') {
    return (
      <div class="tool-card verbose">
        <div class="tool-card-head"><span>{summary}</span></div>
        {detailStr && <div class="tool-card-body">{detailStr}</div>}
      </div>
    );
  }

  // compact mode
  return (
    <div class={classes.join(' ')}>
      <div class="tool-card-head" onClick={() => setExpanded(!expanded)}>
        <span>{summary}</span>
        <span style="opacity:0.5">{expanded ? '▾' : '▸'}</span>
      </div>
      {expanded && detailStr && <div class="tool-card-body">{detailStr}</div>}
    </div>
  );
}
