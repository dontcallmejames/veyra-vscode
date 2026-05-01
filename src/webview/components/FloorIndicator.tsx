import { h } from 'preact';
import type { AgentId } from '../../types.js';

export function FloorIndicator({ holder }: { holder: AgentId | null }) {
  if (holder === null) {
    return <div class="floor-bar" style="opacity:0.55"><span>Idle</span></div>;
  }
  return (
    <div class="floor-bar">
      <span class="pulse-dot"></span>
      <span><strong>{holder}</strong> has the floor…</span>
    </div>
  );
}
