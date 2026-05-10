import { h } from 'preact';
import { useState } from 'preact/hooks';
import type { AgentId, AgentStatus } from '../../types.js';
import type { FromWebview } from '../../shared/protocol.js';

const FIX_INSTRUCTIONS: Record<AgentId, Record<Exclude<AgentStatus, 'ready' | 'busy'>, string>> = {
  claude: {
    'unauthenticated': 'Run `claude /login` in a terminal.',
    'not-installed': 'Install Claude Code, then run `claude /login`.',
    'inaccessible': 'Check filesystem permissions or rerun outside the current sandbox.',
    'misconfigured': 'Check Veyra CLI path settings.',
    'node-missing': 'Install Node.js on PATH so Veyra can launch Claude from VS Code.',
  },
  codex: {
    'unauthenticated': 'Run `codex login` in a terminal.',
    'not-installed': 'Install Codex CLI: `npm i -g @openai/codex` then run `codex login`.',
    'inaccessible': 'Check filesystem permissions, rerun outside the current sandbox, or set `VEYRA_CODEX_CLI_PATH` / `veyra.codexCliPath` to a JS bundle, native executable, or npm shim. Run Veyra: Show live validation guide before paid prompts.',
    'misconfigured': 'Set `VEYRA_CODEX_CLI_PATH` / `veyra.codexCliPath` to codex.js, codex.exe, or codex.',
    'node-missing': 'Install Node.js on PATH, or set `VEYRA_CODEX_CLI_PATH` / `veyra.codexCliPath` to a native codex executable.',
  },
  gemini: {
    'unauthenticated': 'Run `gemini` in a terminal and complete the OAuth flow.',
    'not-installed': 'Install Gemini CLI: `npm i -g @google/gemini-cli` then run `gemini`.',
    'inaccessible': 'Check filesystem permissions, rerun outside the current sandbox, or set `VEYRA_GEMINI_CLI_PATH` / `veyra.geminiCliPath` to a JS bundle, native executable, or npm shim. Run Veyra: Show live validation guide before paid prompts.',
    'misconfigured': 'Set `VEYRA_GEMINI_CLI_PATH` / `veyra.geminiCliPath` to gemini.js, gemini.exe, or gemini.',
    'node-missing': 'Install Node.js on PATH, or set `VEYRA_GEMINI_CLI_PATH` / `veyra.geminiCliPath` to a native gemini executable.',
  },
};

interface Props {
  status: Record<AgentId, AgentStatus>;
  send: (msg: FromWebview) => void;
  veyraMdPresent: boolean;
}

function offersLiveValidationGuide(agentId: AgentId, status: AgentStatus): boolean {
  return status === 'inaccessible' && (agentId === 'codex' || agentId === 'gemini');
}

function offersSetupGuide(status: AgentStatus): boolean {
  return status === 'unauthenticated'
    || status === 'not-installed'
    || status === 'node-missing'
    || status === 'inaccessible'
    || status === 'misconfigured';
}

function offersCliPathConfiguration(agentId: AgentId, status: AgentStatus): boolean {
  return (
    (status === 'inaccessible' || status === 'misconfigured' || status === 'node-missing')
    && (agentId === 'codex' || agentId === 'gemini')
  );
}

export function HealthStrip({ status, send, veyraMdPresent }: Props) {
  const [popoverFor, setPopoverFor] = useState<AgentId | null>(null);

  const labels: Record<AgentId, string> = {
    claude: 'Claude',
    codex: 'Codex',
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
                {FIX_INSTRUCTIONS[id][s as Exclude<AgentStatus, 'ready' | 'busy'>]}
                {offersSetupGuide(s) && (
                  <div style="margin-top:6px">
                    <button
                      type="button"
                      class="file-edited-link"
                      title="Open setup guide"
                      onClick={() => send({ kind: 'show-setup-guide' })}
                    >
                      Open setup guide
                    </button>
                  </div>
                )}
                {offersCliPathConfiguration(id, s) && (
                  <div style="margin-top:6px">
                    <button
                      type="button"
                      class="file-edited-link"
                      title="Configure Codex and Gemini CLI paths"
                      onClick={() => send({ kind: 'configure-cli-paths' })}
                    >
                      Configure CLI paths
                    </button>
                  </div>
                )}
                {offersLiveValidationGuide(id, s) && (
                  <div style="margin-top:6px">
                    <button
                      type="button"
                      class="file-edited-link"
                      title="Open live validation guide"
                      onClick={() => send({ kind: 'show-live-validation-guide' })}
                    >
                      Open live validation guide
                    </button>
                  </div>
                )}
                <div style="text-align:right;margin-top:6px">
                  <span style="cursor:pointer;color:var(--vscode-textLink-foreground)" onClick={() => setPopoverFor(null)}>Close</span>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {veyraMdPresent && (
        <span
          class="health-pill rules"
          title="veyra.md present - rules pinned to all agent prompts"
          onClick={() => send({ kind: 'open-workspace-file', relativePath: 'veyra.md' })}
        >
          📋 rules
        </span>
      )}
    </div>
  );
}
