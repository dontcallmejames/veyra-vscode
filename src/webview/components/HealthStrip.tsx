import { h } from 'preact';
import { useState } from 'preact/hooks';
import type { AgentId, AgentStatus } from '../../types.js';
import type { FromWebview } from '../../shared/protocol.js';

const FIX_INSTRUCTIONS: Record<AgentId, Record<Exclude<AgentStatus, 'ready' | 'busy'>, string>> = {
  claude: {
    'unauthenticated': 'Run `claude /login` in a terminal.',
    'not-installed': 'Install Claude Code: `npm i -g @anthropic-ai/claude-code` then run `claude /login`.',
  },
  codex: {
    'unauthenticated': 'Run `codex login` in a terminal.',
    'not-installed': 'Install Codex CLI: `npm i -g @openai/codex` then run `codex login`.',
  },
  gemini: {
    'unauthenticated': 'Run `gemini` in a terminal and complete the OAuth flow.',
    'not-installed': 'Install Gemini CLI: `npm i -g @google/gemini-cli` then run `gemini`.',
  },
};

interface Props {
  status: Record<AgentId, AgentStatus>;
  send: (msg: FromWebview) => void;
}

export function HealthStrip({ status, send }: Props) {
  const [popoverFor, setPopoverFor] = useState<AgentId | null>(null);

  const labels: Record<AgentId, string> = {
    claude: 'Claude',
    codex: 'GPT',
    gemini: 'Gemini',
  };

  const agents: AgentId[] = ['claude', 'codex', 'gemini'];

  return (
    <div class="health-strip">
      {agents.map((id) => {
        const s = status[id];
        const ok = s === 'ready' || s === 'busy';
        const classes = ['health-pill', ok ? 'ok' : 'error'];
        return (
          <div key={id} style="position:relative">
            <span
              class={classes.join(' ')}
              onClick={() => {
                if (!ok) {
                  setPopoverFor(popoverFor === id ? null : id);
                  send({ kind: 'reload-status' });
                }
              }}
            >
              {labels[id]} {ok ? '✓' : '✗'}
            </span>
            {popoverFor === id && !ok && (
              <div style="position:absolute;bottom:100%;left:0;background:var(--vscode-editorWidget-background);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:11px;width:240px;margin-bottom:4px;z-index:10">
                {FIX_INSTRUCTIONS[id][s as 'unauthenticated' | 'not-installed']}
                <div style="text-align:right;margin-top:6px">
                  <span style="cursor:pointer;color:var(--vscode-textLink-foreground)" onClick={() => setPopoverFor(null)}>Close</span>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
