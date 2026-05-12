import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ulid } from './ulid.js';
import { cspNonce } from './cspNonce.js';
import { checkClaude, checkCodex, checkGemini, clearStatusCache } from './statusChecks.js';
import { refreshVeyraSessionOptions } from './veyraRuntime.js';
import type {
  FromExtension, FromWebview, Settings, SystemMessage,
} from './shared/protocol.js';
import type { AgentId, AgentStatus } from './types.js';
import type { FileBadgesController } from './fileBadges.js';
import type { VeyraDispatchEvent, VeyraSessionService } from './veyraService.js';
import { localVeyraResponseForPrompt } from './localVeyraPrompt.js';

export interface VeyraWebviewControllerOptions {
  context: vscode.ExtensionContext;
  workspacePath: string;
  extensionUri: vscode.Uri;
  service: VeyraSessionService;
  badgeController?: FileBadgesController;
  badgeControllerProvider?: () => FileBadgesController | undefined;
}

export interface VeyraWebviewHost {
  webview: vscode.Webview;
  send(message: FromExtension): Thenable<boolean> | boolean;
  onDidDispose(listener: () => void): vscode.Disposable;
}

export class VeyraWebviewController {
  private disposables: vscode.Disposable[] = [];
  private onboardingPromptsStarted = false;
  private host: VeyraWebviewHost | undefined;
  private disposed = false;

  constructor(private readonly options: VeyraWebviewControllerOptions) {}

  async attach(host: VeyraWebviewHost): Promise<void> {
    this.host = host;
    host.webview.html = this.renderHtml(host.webview);
    this.track(host.onDidDispose(() => this.dispose()));
    this.track(host.webview.onDidReceiveMessage((message: FromWebview) => this.handleFromWebview(message)));
    await this.initialize();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.service.flush().catch(() => { /* best-effort */ });
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.host = undefined;
  }

  private track<T extends vscode.Disposable>(disposable: T): T {
    if (this.disposed) {
      disposable.dispose();
    } else {
      this.disposables.push(disposable);
    }
    return disposable;
  }

  private async initialize(): Promise<void> {
    const session = await this.options.service.loadSession();
    const status: Record<AgentId, AgentStatus> = {
      claude: await checkClaude(),
      codex: await checkCodex(),
      gemini: await checkGemini(),
    };
    const settings = this.readSettings();
    const veyraMdPresent = fs.existsSync(path.join(this.options.workspacePath, 'veyra.md'));
    this.send({ kind: 'init', session, status, settings, veyraMdPresent });

    this.track({ dispose: this.options.service.onFloorChange((holder) => this.send({ kind: 'floor-changed', holder })) });
    this.track({ dispose: this.options.service.onStatusChange((agentId, s) => this.send({ kind: 'status-changed', agentId, status: s })) });
    this.track({
      dispose: this.options.service.onWriteError((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        const sys: SystemMessage = {
          id: ulid(),
          role: 'system',
          kind: 'error',
          text: `Couldn't save chat history: ${msg}`,
          timestamp: Date.now(),
        };
        // Post to webview directly without using appendSystem (which would
        // schedule another write and could loop on persistent failures).
        this.send({ kind: 'system-message', message: sys });
      }),
    });
    this.track(vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('veyra')) {
        refreshVeyraSessionOptions(
          this.options.service,
          this.options.workspacePath,
          this.currentBadgeController(),
        );
        this.send({ kind: 'settings-changed', settings: this.readSettings() });
      }
    }));

    const rulesWatcher = vscode.workspace.createFileSystemWatcher('**/veyra.md', false, true, false);
    const onRulesChange = () => {
      const present = fs.existsSync(path.join(this.options.workspacePath, 'veyra.md'));
      this.send({ kind: 'veyra-md-changed', present });
    };
    rulesWatcher.onDidCreate(onRulesChange);
    rulesWatcher.onDidDelete(onRulesChange);
    this.track(rulesWatcher);

    const recheckIntervalMs = 60_000;
    let recheckHandle: NodeJS.Timeout | null = null;
    let recheckCancelled = false;
    const tick = async () => {
      if (recheckCancelled) return;
      try {
        clearStatusCache();
        const fresh: Record<AgentId, AgentStatus> = {
          claude: await checkClaude(),
          codex: await checkCodex(),
          gemini: await checkGemini(),
        };
        if (recheckCancelled) return;
        for (const id of ['claude', 'codex', 'gemini'] as AgentId[]) {
          // notifyStatusChange dedupes; status-changed only fires when value differs.
          // The controller subscribes to onStatusChange and forwards to the webview.
          this.options.service.notifyStatusChange(id, fresh[id]);
        }
      } catch {
        // ignore individual recheck failures
      }
      if (!recheckCancelled) {
        recheckHandle = setTimeout(tick, recheckIntervalMs);
      }
    };
    recheckHandle = setTimeout(tick, recheckIntervalMs);
    this.track({
      dispose: () => {
        recheckCancelled = true;
        if (recheckHandle) clearTimeout(recheckHandle);
      },
    });
  }

  private send(msg: FromExtension): void {
    this.host?.send(msg);
  }

  private currentBadgeController(): FileBadgesController | undefined {
    if (this.options.badgeControllerProvider) {
      return this.options.badgeControllerProvider();
    }
    return fileBadgesEnabled() ? this.options.badgeController : undefined;
  }

  private readSettings(): Settings {
    const config = vscode.workspace.getConfiguration('veyra');
    return {
      toolCallRenderStyle: config.get<Settings['toolCallRenderStyle']>('toolCallRenderStyle', 'compact'),
    };
  }

  private async handleFromWebview(msg: FromWebview): Promise<void> {
    switch (msg.kind) {
      case 'send':
        await this.dispatchUserMessage(msg.text);
        break;
      case 'cancel':
        await this.options.service.cancelAll();
        break;
      case 'reload-status':
        clearStatusCache();
        const fresh: Record<AgentId, AgentStatus> = {
          claude: await checkClaude(),
          codex: await checkCodex(),
          gemini: await checkGemini(),
        };
        for (const id of ['claude', 'codex', 'gemini'] as AgentId[]) {
          this.send({ kind: 'status-changed', agentId: id, status: fresh[id] });
          this.options.service.notifyStatusChange(id, fresh[id]);
        }
        break;
      case 'show-live-validation-guide':
        await vscode.commands.executeCommand('veyra.showLiveValidationGuide');
        break;
      case 'show-setup-guide':
        await vscode.commands.executeCommand('veyra.showSetupGuide');
        break;
      case 'configure-cli-paths':
        await vscode.commands.executeCommand('veyra.configureCliPaths');
        break;
      case 'open-change-set-diff':
        await vscode.commands.executeCommand('veyra.openPendingChanges', msg.changeSetId, msg.filePath);
        break;
      case 'accept-change-set':
        await vscode.commands.executeCommand('veyra.acceptPendingChanges', msg.changeSetId);
        break;
      case 'reject-change-set':
        await vscode.commands.executeCommand('veyra.rejectPendingChanges', msg.changeSetId);
        break;
      case 'create-checkpoint':
        await vscode.commands.executeCommand('veyra.createCheckpoint', msg.label);
        break;
      case 'rollback-latest-checkpoint':
        await vscode.commands.executeCommand('veyra.rollbackLatestCheckpoint');
        break;
      case 'open-external':
        await this.openExternalUrl(msg.url);
        break;
      case 'open-workspace-file': {
        const filePath = this.resolveOpenWorkspaceFilePath(msg.relativePath);
        if (!filePath) {
          vscode.window.showWarningMessage(`Could not open ${msg.relativePath}`);
          break;
        }
        const fileUri = vscode.Uri.file(filePath);
        try {
          const doc = await vscode.workspace.openTextDocument(fileUri);
          await vscode.window.showTextDocument(doc);
        } catch {
          vscode.window.showWarningMessage(`Could not open ${msg.relativePath}`);
        }
        break;
      }
    }
  }

  private resolveOpenWorkspaceFilePath(filePath: string): string | null {
    const workspaceRoot = path.resolve(this.options.workspacePath);
    const resolved = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(workspaceRoot, filePath);
    const relative = path.relative(workspaceRoot, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return resolved;
  }

  private async openExternalUrl(rawUrl: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      vscode.window.showWarningMessage(`Could not open external URL: ${rawUrl}`);
      return;
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      vscode.window.showWarningMessage(`Could not open external URL: ${rawUrl}`);
      return;
    }

    await vscode.env.openExternal(vscode.Uri.parse(parsed.toString()));
  }

  private async dispatchUserMessage(text: string): Promise<void> {
    const localResponse = localVeyraResponseForPrompt(text);
    if (localResponse) {
      await this.options.service.respondLocally(
        text,
        localResponse,
        (event) => this.handleDispatchEvent(event),
      );
      return;
    }

    if (this.options.service.isFirstSession()) {
      this.startOnboardingPrompts();
    }

    await this.options.service.dispatch(
      {
        text,
        source: 'panel',
        cwd: this.options.workspacePath,
      },
      (event) => this.handleDispatchEvent(event),
    );
  }

  private startOnboardingPrompts(): void {
    if (this.onboardingPromptsStarted) return;
    this.onboardingPromptsStarted = true;
    void (async () => {
      await this.maybeShowGitignorePrompt(this.options.workspacePath);
      await this.maybeShowVeyraMdTip();
      await this.maybeShowCommitHookPrompt();
    })().catch((err) => {
      console.error('Veyra onboarding prompts failed:', err);
    });
  }

  private handleDispatchEvent(event: VeyraDispatchEvent): void {
    switch (event.kind) {
      case 'user-message':
        this.send({ kind: 'user-message-appended', message: event.message });
        break;
      case 'system-message':
        this.send({ kind: 'system-message', message: event.message });
        break;
      case 'dispatch-start':
        this.send({
          kind: 'message-started',
          id: event.messageId,
          agentId: event.agentId,
          timestamp: event.timestamp,
        });
        break;
      case 'chunk':
        this.send({ kind: 'message-chunk', id: event.messageId, chunk: event.chunk });
        break;
      case 'dispatch-end':
        this.send({ kind: 'message-finalized', message: event.message });
        break;
      case 'file-edited':
        this.send({
          kind: 'file-edited',
          path: event.path,
          agentId: event.agentId,
          timestamp: event.timestamp,
          changeKind: event.changeKind,
        });
        break;
    }
  }

  private async maybeShowGitignorePrompt(workspacePath: string): Promise<void> {
    const stateKey = 'veyra.gitignorePromptDismissed';
    if (this.options.context.workspaceState.get(stateKey)) return;

    const gitignorePath = path.join(workspacePath, '.gitignore');
    let gitignore = '';
    if (fs.existsSync(gitignorePath)) {
      gitignore = fs.readFileSync(gitignorePath, 'utf8');
    }
    const alreadyCovered =
      gitignore.split(/\r?\n/).some((line) => {
        const trimmed = line.trim();
        return trimmed === '.vscode/' ||
               trimmed === '.vscode/veyra/' ||
               trimmed === '.vscode/veyra';
      });
    if (alreadyCovered) return;

    const choice = await vscode.window.showInformationMessage(
      'Veyra stores session history in .vscode/veyra/. Add to .gitignore?',
      'Add to .gitignore',
      'Not now',
      "Don't ask again",
    );
    if (choice === 'Add to .gitignore') {
      const additionalLines = (gitignore.length > 0 && !gitignore.endsWith('\n') ? '\n' : '')
        + '\n# Veyra session history\n.vscode/veyra/\n';
      fs.appendFileSync(gitignorePath, additionalLines, 'utf8');
    } else if (choice === "Don't ask again") {
      await this.options.context.workspaceState.update(stateKey, true);
    }
  }

  private async maybeShowVeyraMdTip(): Promise<void> {
    const stateKey = 'veyra.veyraMdTipShown';
    if (this.options.context.workspaceState.get(stateKey)) return;
    if (fs.existsSync(path.join(this.options.workspacePath, 'veyra.md'))) return;

    const choice = await vscode.window.showInformationMessage(
      'Tip: create veyra.md at the workspace root to pin per-project instructions for all agents.',
      'Create now',
      "Don't show again",
    );
    if (choice === 'Create now') {
      const filePath = path.join(this.options.workspacePath, 'veyra.md');
      const seed = '# veyra.md\n\nWorkspace rules pinned to all agent prompts. Free-form Markdown.\n';
      fs.writeFileSync(filePath, seed, 'utf8');
      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc);
      await this.options.context.workspaceState.update(stateKey, true);
    } else if (choice === "Don't show again") {
      await this.options.context.workspaceState.update(stateKey, true);
    }
  }

  private async maybeShowCommitHookPrompt(): Promise<void> {
    const stateKey = 'veyra.commitHookPromptDismissed';
    if (this.options.context.workspaceState.get(stateKey)) return;
    if (!fs.existsSync(path.join(this.options.workspacePath, '.git'))) return;

    const choice = await vscode.window.showInformationMessage(
      'Install commit hook to tag commits made by agents? Adds .git/hooks/prepare-commit-msg. Removable via "Veyra: Uninstall commit hook".',
      'Install',
      'Not now',
      "Don't ask again",
    );
    if (choice === 'Install') {
      await vscode.commands.executeCommand('veyra.installCommitHook');
      await this.options.context.workspaceState.update(stateKey, true);
    } else if (choice === "Don't ask again") {
      await this.options.context.workspaceState.update(stateKey, true);
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const htmlPath = path.join(this.options.extensionUri.fsPath, 'dist', 'index.html');
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.options.extensionUri, 'dist', 'webview.js'),
    );
    const nonce = cspNonce();
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html
      .replace(/{{NONCE}}/g, nonce)
      .replace(/{{CSP_SOURCE}}/g, webview.cspSource)
      .replace(/{{WEBVIEW_JS_URI}}/g, jsUri.toString());
    return html;
  }
}

export function fileBadgesEnabled(): boolean {
  return vscode.workspace.getConfiguration('veyra').get<boolean>('fileBadges.enabled', true);
}
