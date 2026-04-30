import { h } from 'preact';
import type { AgentMessage, InProgressMessage, Settings } from '../../shared/protocol.js';
import { ToolCallCard } from './ToolCallCard.js';

interface Props {
  message: AgentMessage | InProgressMessage;
  streaming: boolean;
  settings: Settings;
}

export function AgentBubble({ message, streaming, settings }: Props) {
  const status = 'status' in message ? message.status : null;
  const error = 'error' in message ? message.error : undefined;
  const classes = ['bubble', 'agent', `agent-${message.agentId}`];
  if (streaming) classes.push('streaming');

  return (
    <div class={classes.join(' ')}>
      <div class="role" style="font-size:10px;text-transform:uppercase;opacity:0.6;margin-bottom:3px">
        {message.agentId}
      </div>
      <div>{message.text}</div>
      {message.toolEvents.length > 0 && (
        <div>
          {message.toolEvents.map((e, i) => (
            <ToolCallCard key={i} event={e} renderStyle={settings.toolCallRenderStyle} />
          ))}
        </div>
      )}
      {status === 'cancelled' && <div style="font-style:italic;opacity:0.6;margin-top:4px">[Cancelled]</div>}
      {status === 'errored' && error && <div style="color:var(--error-color);margin-top:4px">{error}</div>}
    </div>
  );
}
