import { h } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { AgentMessage, FromWebview, InProgressMessage, Settings } from '../../shared/protocol.js';
import { ToolCallCard } from './ToolCallCard.js';

interface Props {
  message: AgentMessage | InProgressMessage;
  streaming: boolean;
  settings: Settings;
  send?: (message: FromWebview) => void;
}

const SPINNER_FRAMES: Record<string, string[]> = {
  claude: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  codex: ['⡀', '⡄', '⡆', '⡇', '⣇', '⣧', '⣷', '⣿', '⣾', '⣼', '⣸', '⣰', '⣠', '⣀'],
  gemini: ['⠁', '⠃', '⠇', '⠧', '⠷', '⠿', '⠾', '⠼', '⠸', '⠘', '⠈'],
};

const THINKING_VERBS: Record<string, string[]> = {
  claude: ['thinking', 'pondering', 'considering', 'weighing'],
  codex: ['compiling', 'parsing', 'processing', 'cooking'],
  gemini: ['researching', 'searching', 'looking up', 'digging'],
};

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function BrailleSpinner({ agentId }: { agentId: string }) {
  const frames = SPINNER_FRAMES[agentId] ?? SPINNER_FRAMES.claude;
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f + 1) % frames.length), 90);
    return () => clearInterval(t);
  }, [frames.length]);
  return <span class="braille-spinner">{frames[frame]}</span>;
}

export function EditedFilesRow({
  editedFiles,
  send,
}: {
  editedFiles: string[];
  send?: (message: FromWebview) => void;
}) {
  if (editedFiles.length === 0) return null;
  return (
    <div class="edited-files-row">
      <span class="edited-files-label">Edited</span>
      {editedFiles.map((file) => (
        <button
          key={file}
          type="button"
          class="file-chip edited-file-chip"
          onClick={() => send?.({ kind: 'open-workspace-file', relativePath: file })}
        >
          {file}
        </button>
      ))}
    </div>
  );
}

export function AgentBubble({ message, streaming, settings, send }: Props) {
  const status = 'status' in message ? message.status : null;
  const error = 'error' in message ? message.error : undefined;
  const editedFiles = 'editedFiles' in message ? message.editedFiles ?? [] : [];
  const isThinking = streaming && message.text === '' && message.toolEvents.length === 0;
  const verb = useMemo(
    () => pickRandom(THINKING_VERBS[message.agentId] ?? THINKING_VERBS.claude),
    [message.agentId],
  );
  const classes = ['bubble', 'agent', `agent-${message.agentId}`];
  if (streaming) classes.push('streaming');
  if (isThinking) classes.push('thinking');

  return (
    <div class={classes.join(' ')}>
      <div class="role" style="font-size:10px;text-transform:uppercase;opacity:0.6;margin-bottom:3px">
        {message.agentId}
      </div>
      {isThinking ? (
        <div class="thinking-line">{verb} <BrailleSpinner agentId={message.agentId} /></div>
      ) : (
        <div>{message.text}</div>
      )}
      {message.toolEvents.length > 0 && (
        <div>
          {message.toolEvents.map((e, i) => (
            <ToolCallCard key={i} event={e} renderStyle={settings.toolCallRenderStyle} />
          ))}
        </div>
      )}
      <EditedFilesRow editedFiles={editedFiles} send={send} />
      {status === 'cancelled' && <div style="font-style:italic;opacity:0.6;margin-top:4px">[Cancelled]</div>}
      {status === 'errored' && error && <div style="color:var(--error-color);margin-top:4px">{error}</div>}
    </div>
  );
}
