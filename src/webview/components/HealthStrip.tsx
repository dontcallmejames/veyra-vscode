import { h } from 'preact';
import type { AgentId, AgentStatus } from '../../types.js';
import type { FromWebview } from '../../shared/protocol.js';

export function HealthStrip({ status, send }: { status: Record<AgentId, AgentStatus>; send: (m: FromWebview) => void }) {
  return <div class="health-strip">{JSON.stringify(status)}</div>;
}
