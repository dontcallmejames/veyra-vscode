import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ulid } from './ulid.js';
import { cspNonce } from './cspNonce.js';
import { checkClaude, checkCodex, checkGemini, clearStatusCache } from './statusChecks.js';
import { VeyraSessionService } from './veyraService.js';
import { createVeyraSessionService, refreshVeyraSessionOptions } from './veyraRuntime.js';
import type {
  FromExtension, FromWebview, Settings, SystemMessage,
} from './shared/protocol.js';
import type { AgentId, AgentStatus } from './types.js';
import type { AgentRegistry } from './messageRouter.js';
import type { FileBadgesController } from './fileBadges.js';
import type { VeyraDispatchEvent } from './veyraService.js';

export class ChatPanel {
  private static current: ChatPanel | undefined;
  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private service: VeyraSessionService;
  private extensionUri: vscode.Uri;
  private onboardingPromptsStarted = false;

  static async show(
    context: vscode.ExtensionContext,
    agentsOverride?: AgentRegistry,
    badgeController?: FileBadgesController,
    serviceOverride?: VeyraSessionService,
    badgeControllerProvider?: () => FileBadgesController | undefined,
  ): Promise<void> {
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal();
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showErrorMessage('Veyra requires an open workspace folder.');
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'veyra',
      'Veyra',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
      }
    );
    const activeBadgeController = badgeControllerProvider
      ? badgeControllerProvider()
      : fileBadgesEnabled() ? badgeController : undefined;
    const service = serviceOverride ?? createVeyraSessionService(folder.uri.fsPath, activeBadgeController, agentsOverride);
    ChatPanel.current = new ChatPanel(panel, context, folder.uri.fsPath, service, badgeController, badgeControllerProvider);
    await ChatPanel.current.initialize();
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private context: vscode.ExtensionContext,
    private workspacePath: string,
    service: VeyraSessionService,
    private badgeController?: FileBadgesController,
    private badgeControllerProvider?: () => FileBadgesController | undefined,
  ) {
    this.panel = panel;
    this.extensionUri = context.extensionUri;
    this.service = service;

    this.panel.webview.html = this.renderHtml();
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((m: FromWebview) => this.handleFromWebview(m)),
    );
  }

  private async initialize(): Promise<void> {
    const session = await this.service.loadSession();
    const status: Record<AgentId, AgentStatus> = {
      claude: await checkClaude(),
      codex: await checkCodex(),
      gemini: await checkGemini(),
    };
    const settings = this.readSettings();
    const veyraMdPresent = fs.existsSync(path.join(this.workspacePath, 'veyra.md'));
    this.send({ kind: 'init', session, status, settings, veyraMdPresent });

    this.disposables.push(
      { dispose: this.service.onFloorChange((holder) => this.send({ kind: 'floor-changed', holder })) },
      { dispose: this.service.onStatusChange((agentId, s) => this.send({ kind: 'status-changed', agentId, status: s })) },
      {
        dispose: this.service.onWriteError((err) => {
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
      },
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('veyra')) {
          refreshVeyraSessionOptions(this.service, this.workspacePath, this.currentBadgeController());
          this.send({ kind: 'settings-changed', settings: this.readSettings() });
        }
      }),
    );

    const rulesWatcher = vscode.workspace.createFileSystemWatcher('**/veyra.md', false, true, false);
    const onRulesChange = () => {
      const present = fs.existsSync(path.join(this.workspacePath, 'veyra.md'));
      this.send({ kind: 'veyra-md-changed', present });
    };
    rulesWatcher.onDidCreate(onRulesChange);
    rulesWatcher.onDidDelete(onRulesChange);
    this.disposables.push(rulesWatcher);

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
          // ChatPanel already subscribes to onStatusChange and forwards to webview.
          this.service.notifyStatusChange(id, fresh[id]);
        }
      } catch {
        // ignore individual recheck failures
      }
      if (!recheckCancelled) {
        recheckHandle = setTimeout(tick, recheckIntervalMs);
      }
    };
    recheckHandle = setTimeout(tick, recheckIntervalMs);
    this.disposables.push({
      dispose: () => {
        recheckCancelled = true;
        if (recheckHandle) clearTimeout(recheckHandle);
      },
    });
  }

  private send(msg: FromExtension): void {
    this.panel.webview.postMessage(msg);
  }

  private currentBadgeController(): FileBadgesController | undefined {
    if (this.badgeControllerProvider) {
      return this.badgeControllerProvider();
    }
    return fileBadgesEnabled() ? this.badgeController : undefined;
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
        await this.service.cancelAll();
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
          this.service.notifyStatusChange(id, fresh[id]);
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
    const workspaceRoot = path.resolve(this.workspacePath);
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
    if (this.service.isFirstSession()) {
      this.startOnboardingPrompts();
    }

    await this.service.dispatch(
      {
        text,
        source: 'panel',
        cwd: this.workspacePath,
      },
      (event) => this.handleDispatchEvent(event),
    );
  }

  private startOnboardingPrompts(): void {
    if (this.onboardingPromptsStarted) return;
    this.onboardingPromptsStarted = true;
    void (async () => {
      await this.maybeShowGitignorePrompt(this.workspacePath);
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
    if (this.context.workspaceState.get(stateKey)) return;

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
      await this.context.workspaceState.update(stateKey, true);
    }
  }

  private async maybeShowVeyraMdTip(): Promise<void> {
    const stateKey = 'veyra.veyraMdTipShown';
    if (this.context.workspaceState.get(stateKey)) return;
    if (fs.existsSync(path.join(this.workspacePath, 'veyra.md'))) return;

    const choice = await vscode.window.showInformationMessage(
      'Tip: create veyra.md at the workspace root to pin per-project instructions for all agents.',
      'Create now',
      "Don't show again",
    );
    if (choice === 'Create now') {
      const filePath = path.join(this.workspacePath, 'veyra.md');
      const seed = '# veyra.md\n\nWorkspace rules pinned to all agent prompts. Free-form Markdown.\n';
      fs.writeFileSync(filePath, seed, 'utf8');
      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc);
      await this.context.workspaceState.update(stateKey, true);
    } else if (choice === "Don't show again") {
      await this.context.workspaceState.update(stateKey, true);
    }
  }

  private async maybeShowCommitHookPrompt(): Promise<void> {
    const stateKey = 'veyra.commitHookPromptDismissed';
    if (this.context.workspaceState.get(stateKey)) return;
    if (!fs.existsSync(path.join(this.workspacePath, '.git'))) return;

    const choice = await vscode.window.showInformationMessage(
      'Install commit hook to tag commits made by agents? Adds .git/hooks/prepare-commit-msg. Removable via "Veyra: Uninstall commit hook".',
      'Install',
      'Not now',
      "Don't ask again",
    );
    if (choice === 'Install') {
      await vscode.commands.executeCommand('veyra.installCommitHook');
      await this.context.workspaceState.update(stateKey, true);
    } else if (choice === "Don't ask again") {
      await this.context.workspaceState.update(stateKey, true);
    }
  }

  private renderHtml(): string {
    const htmlPath = path.join(this.extensionUri.fsPath, 'dist', 'index.html');
    const jsUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js')
    );
    const nonce = cspNonce();
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html
      .replace(/{{NONCE}}/g, nonce)
      .replace(/{{CSP_SOURCE}}/g, this.panel.webview.cspSource)
      .replace(/{{WEBVIEW_JS_URI}}/g, jsUri.toString());
    return html;
  }

  dispose(): void {
    this.service.flush().catch(() => { /* best-effort */ });
    ChatPanel.current = undefined;
    this.disposables.forEach((d) => d.dispose());
    this.panel.dispose();
  }
}

function fileBadgesEnabled(): boolean {
  return vscode.workspace.getConfiguration('veyra').get<boolean>('fileBadges.enabled', true);
}
