import { h } from 'preact';
import type { SystemMessage } from '../../shared/protocol.js';

export function SystemNotice({ message }: { message: SystemMessage }) {
  if (message.kind === 'facilitator-decision' && message.agentId && message.reason) {
    const agentLabels: Record<string, string> = {
      claude: 'Claude',
      codex: 'ChatGPT',
      gemini: 'Gemini',
    };
    const label = agentLabels[message.agentId] ?? message.agentId;
    return (
      <div class="system-notice facilitator">
        <span>&rarr;</span>
        <span class="agent-name">{label}</span>
        <span style="opacity:0.5">·</span>
        <span class="reason">{message.reason}</span>
      </div>
    );
  }
  const classes = ['system-notice'];
  if (message.kind === 'error') classes.push('error');
  return <div class={classes.join(' ')}>{message.text}</div>;
}
