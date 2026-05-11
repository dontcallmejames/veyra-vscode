import { h } from 'preact';
import type { FromWebview, SystemMessage } from '../../shared/protocol.js';

export function SystemNotice({
  message,
  send,
}: {
  message: SystemMessage;
  send?: (message: FromWebview) => void;
}) {
  if (message.kind === 'facilitator-decision' && message.agentId && message.reason) {
    const agentLabels: Record<string, string> = {
      claude: 'Claude',
      codex: 'Codex',
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
  if (message.kind === 'edit-conflict') classes.push('edit-conflict');
  if (message.kind === 'file-edited') classes.push('file-edited');
  if (message.kind === 'change-set') classes.push('change-set');
  if (message.kind === 'checkpoint') classes.push('checkpoint');
  if (message.kind === 'change-set' && message.changeSet) {
    const changeSet = message.changeSet;
    return (
      <div class={classes.join(' ')}>
        <div>{message.text}</div>
        <div class="change-set-files">
          {changeSet.files.map((file) => (
            <div class="change-set-file" key={file.path}>
              <span class="change-set-file-path">{file.path}</span>
              <span class="change-set-file-kind">{file.changeKind}</span>
              <button
                type="button"
                class="file-edited-link"
                onClick={() => send?.({
                  kind: 'open-change-set-diff',
                  changeSetId: changeSet.id,
                  filePath: file.path,
                })}
              >
                Open diff
              </button>
            </div>
          ))}
        </div>
        {changeSet.status === 'pending' && (
          <div class="change-set-actions">
            <button
              type="button"
              class="file-edited-link"
              onClick={() => send?.({ kind: 'accept-change-set', changeSetId: changeSet.id })}
            >
              Accept
            </button>
            <button
              type="button"
              class="file-edited-link"
              onClick={() => send?.({ kind: 'reject-change-set', changeSetId: changeSet.id })}
            >
              Reject
            </button>
          </div>
        )}
      </div>
    );
  }
  if (message.kind === 'checkpoint' && message.checkpoint) {
    return (
      <div class={classes.join(' ')}>
        <div>{message.text}</div>
        <div class="checkpoint-meta">
          <span>{message.checkpoint.source}</span>
          <span>{message.checkpoint.status}</span>
          <span>{message.checkpoint.fileCount} {message.checkpoint.fileCount === 1 ? 'file' : 'files'}</span>
        </div>
      </div>
    );
  }
  if ((message.kind === 'file-edited' || message.kind === 'edit-conflict') && message.filePath) {
    const label = message.agentId === 'claude'
      ? 'Claude'
      : message.agentId === 'codex'
        ? 'Codex'
        : 'Gemini';
    const verb = message.changeKind === 'created'
      ? 'created'
      : message.changeKind === 'deleted'
        ? 'deleted'
        : 'edited';
    if (message.kind === 'edit-conflict') {
      return (
        <div class={classes.join(' ')}>
          <span>{label} {verb} </span>
          <button
            type="button"
            class="file-edited-link"
            onClick={() => send?.({ kind: 'open-workspace-file', relativePath: message.filePath! })}
          >
            {message.filePath}
          </button>
          <span>{message.text.slice(`${label} ${verb} ${message.filePath}`.length)}</span>
        </div>
      );
    }
    return (
      <div class={classes.join(' ')}>
        <span>{label} {verb} </span>
        <button
          type="button"
          class="file-edited-link"
          onClick={() => send?.({ kind: 'open-workspace-file', relativePath: message.filePath! })}
        >
          {message.filePath}
        </button>
      </div>
    );
  }
  if (message.kind === 'error' && message.filePath) {
    const filePath = message.filePath;
    const index = message.text.indexOf(filePath);
    const before = index >= 0 ? message.text.slice(0, index) : `${message.text} `;
    const after = index >= 0 ? message.text.slice(index + filePath.length) : '';
    return (
      <div class={classes.join(' ')}>
        <span>{before}</span>
        <button
          type="button"
          class="file-edited-link"
          onClick={() => send?.({ kind: 'open-workspace-file', relativePath: filePath })}
        >
          {filePath}
        </button>
        <span>{after}</span>
      </div>
    );
  }
  if (
    message.kind === 'routing-needed'
    && (
      message.text.includes('Veyra: Show setup guide')
      || message.text.includes('Veyra: Configure Codex/Gemini CLI paths')
      || message.text.includes('Veyra: Show live validation guide')
    )
  ) {
    return (
      <div class={classes.join(' ')}>
        <span>{message.text}</span>
        <div style="margin-top:6px">
          {message.text.includes('Veyra: Show setup guide') && (
            <button
              type="button"
              class="file-edited-link"
              title="Open setup guide"
              onClick={() => send?.({ kind: 'show-setup-guide' })}
            >
              Open setup guide
            </button>
          )}
          {message.text.includes('Veyra: Configure Codex/Gemini CLI paths') && (
            <button
              type="button"
              class="file-edited-link"
              title="Configure Codex and Gemini CLI paths"
              onClick={() => send?.({ kind: 'configure-cli-paths' })}
            >
              Configure CLI paths
            </button>
          )}
          {message.text.includes('Veyra: Show live validation guide') && (
            <button
              type="button"
              class="file-edited-link"
              title="Open live validation guide"
              onClick={() => send?.({ kind: 'show-live-validation-guide' })}
            >
              Open live validation guide
            </button>
          )}
        </div>
      </div>
    );
  }
  return <div class={classes.join(' ')}>{message.text}</div>;
}
