import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ulid } from './ulid.js';
import { cspNonce } from './cspNonce.js';
import { MessageRouter } from './messageRouter.js';
import { chooseFacilitatorAgent } from './facilitator.js';
import { ClaudeAgent } from './agents/claude.js';
import { CodexAgent } from './agents/codex.js';
import { GeminiAgent } from './agents/gemini.js';
import { SessionStore } from './sessionStore.js';
import { checkClaude, checkCodex, checkGemini, clearStatusCache } from './statusChecks.js';
import { buildSharedContext } from './sharedContext.js';
import { readWorkspaceRules } from './workspaceRules.js';
import { parseFileMentions, embedFiles } from './fileMentions.js';
import { composePrompt } from './composePrompt.js';
import type {
  FromExtension, FromWebview, Settings, AgentMessage, UserMessage, SystemMessage,
} from './shared/protocol.js';
import type { AgentId, AgentStatus } from './types.js';
import type { AgentRegistry } from './messageRouter.js';
import type { FileBadgesController } from './fileBadges.js';
import { getEditedPath as getClaudeEditedPath } from './agents/claude.js';
import { getEditedPath as getCodexEditedPath } from './agents/codex.js';
import { getEditedPath as getGeminiEditedPath } from './agents/gemini.js';

function getEditedPathForAgent(agentId: AgentId, toolName: string, input: unknown): string | null {
  if (agentId === 'claude') return getClaudeEditedPath(toolName, input);
  if (agentId === 'codex') return getCodexEditedPath(toolName, input);
  if (agentId === 'gemini') return getGeminiEditedPath(toolName, input);
  return null;
}

export class ChatPanel {
  private static current: ChatPanel | undefined;
  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private router: MessageRouter;
  private store: SessionStore;
  private extensionUri: vscode.Uri;
  private currentDispatchInProgress: Map<AgentId, { cancelled?: boolean }> | null = null;
  private hangSec: number = 60;

  static async show(
    context: vscode.ExtensionContext,
    agentsOverride?: AgentRegistry,
    badgeController?: FileBadgesController,
  ): Promise<void> {
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal();
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showErrorMessage('Agent Chat requires an open workspace folder.');
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'agentChat',
      'Agent Chat',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
      }
    );
    const agents = agentsOverride ?? {
      claude: new ClaudeAgent(),
      codex: new CodexAgent(),
      gemini: new GeminiAgent(),
    };
    ChatPanel.current = new ChatPanel(panel, context, folder.uri.fsPath, agents, badgeController);
    await ChatPanel.current.initialize();
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private context: vscode.ExtensionContext,
    private workspacePath: string,
    agents: AgentRegistry,
    private badgeController?: FileBadgesController,
  ) {
    this.panel = panel;
    this.extensionUri = context.extensionUri;
    const watchdogMinutes = vscode.workspace.getConfiguration('agentChat').get<number>('watchdogMinutes', 5);
    this.router = new MessageRouter(
      agents,
      chooseFacilitatorAgent,
      { watchdogMs: watchdogMinutes * 60_000 },
    );
    this.store = new SessionStore(workspacePath);

    this.panel.webview.html = this.renderHtml();
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((m: FromWebview) => this.handleFromWebview(m)),
    );
  }

  private async initialize(): Promise<void> {
    this.hangSec = this.readHangSeconds();
    const session = await this.store.load();
    const status: Record<AgentId, AgentStatus> = {
      claude: await checkClaude(),
      codex: await checkCodex(),
      gemini: await checkGemini(),
    };
    const settings = this.readSettings();
    this.send({ kind: 'init', session, status, settings });

    this.disposables.push(
      { dispose: this.router.onFloorChange((holder) => this.send({ kind: 'floor-changed', holder })) },
      { dispose: this.router.onStatusChange((agentId, s) => this.send({ kind: 'status-changed', agentId, status: s })) },
      {
        dispose: this.store.onWriteError((err) => {
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
        if (e.affectsConfiguration('agentChat')) {
          this.hangSec = this.readHangSeconds();
          this.send({ kind: 'settings-changed', settings: this.readSettings() });
        }
      }),
    );

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
          this.router.notifyStatusChange(id, fresh[id]);
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

  private readSettings(): Settings {
    const config = vscode.workspace.getConfiguration('agentChat');
    return {
      toolCallRenderStyle: config.get<Settings['toolCallRenderStyle']>('toolCallRenderStyle', 'compact'),
    };
  }

  private readHangSeconds(): number {
    return vscode.workspace.getConfiguration('agentChat').get<number>('hangDetectionSeconds', 60);
  }

  private async handleFromWebview(msg: FromWebview): Promise<void> {
    switch (msg.kind) {
      case 'send':
        await this.dispatchUserMessage(msg.text);
        break;
      case 'cancel':
        if (this.currentDispatchInProgress) {
          for (const ip of this.currentDispatchInProgress.values()) {
            ip.cancelled = true;
          }
        }
        await this.router.cancelAll();
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
          this.router.notifyStatusChange(id, fresh[id]);
        }
        break;
      case 'open-external':
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
    }
  }

  private async dispatchUserMessage(text: string): Promise<void> {
    const fileEmbedMaxLines = vscode.workspace.getConfiguration('agentChat').get<number>('fileEmbedMaxLines', 500);
    const sharedContextWindow = vscode.workspace.getConfiguration('agentChat').get<number>('sharedContextWindow', 25);

    const { filePaths, remainingText } = parseFileMentions(text);
    const embedResult = embedFiles(filePaths, this.workspacePath, { maxLines: fileEmbedMaxLines });

    const userMsg: UserMessage = {
      id: ulid(),
      role: 'user',
      text,
      timestamp: Date.now(),
      ...(embedResult.attached.length > 0 ? { attachedFiles: embedResult.attached } : {}),
    };
    if (this.store.isFirstSession()) {
      await this.maybeShowGitignorePrompt(this.workspacePath);
    }
    this.store.appendUser(userMsg);
    this.send({ kind: 'user-message-appended', message: userMsg });

    for (const e of embedResult.errors) {
      const sys: SystemMessage = {
        id: ulid(),
        role: 'system',
        kind: 'error',
        text: `${e.path}: ${e.reason}`,
        timestamp: Date.now(),
      };
      this.store.appendSystem(sys);
      this.send({ kind: 'system-message', message: sys });
    }

    const inProgressByAgent = new Map<AgentId, { id: string; text: string; toolEvents: any[]; agentId: AgentId; timestamp: number; error?: string; cancelled?: boolean }>();
    this.currentDispatchInProgress = inProgressByAgent;

    const hangSec = this.hangSec;
    let lastChunkAt = Date.now();
    let activeAgentForHang: AgentId | null = null;
    const hangCheckTimer = hangSec > 0 ? setInterval(() => {
      if (activeAgentForHang === null) return;
      if (Date.now() - lastChunkAt >= hangSec * 1000) {
        const sys: SystemMessage = {
          id: ulid(),
          role: 'system',
          kind: 'error',
          text: `${activeAgentForHang} hasn't responded for ${hangSec}s — keep waiting or cancel?`,
          timestamp: Date.now(),
        };
        this.store.appendSystem(sys);
        this.send({ kind: 'system-message', message: sys });
        lastChunkAt = Date.now();
      }
    }, 1000) : null;

    const composePromptForTarget = (_targetId: AgentId, baseText: string): string => {
      const session = this.store.snapshot();
      const sharedContext = buildSharedContext(session, { window: sharedContextWindow });
      const rules = readWorkspaceRules(this.workspacePath);
      return composePrompt({
        rules,
        sharedContext,
        fileBlocks: embedResult.embedded,
        userText: baseText,
      });
    };

    const sharedContextForFacilitator = buildSharedContext(
      this.store.snapshot(),
      { window: sharedContextWindow },
    );

    try {
      for await (const event of this.router.handle(
        remainingText,
        {
          cwd: this.workspacePath,
          composePromptForTarget,
          sharedContextForFacilitator,
        },
      )) {
        if (event.kind === 'facilitator-decision') {
          const sys: SystemMessage = {
            id: ulid(),
            role: 'system',
            kind: 'facilitator-decision',
            text: '',
            timestamp: Date.now(),
            agentId: event.agentId,
            reason: event.reason,
          };
          this.store.appendSystem(sys);
          this.send({ kind: 'system-message', message: sys });
          continue;
        }
        if (event.kind === 'routing-needed') {
          const sys: SystemMessage = {
            id: ulid(),
            role: 'system',
            kind: 'routing-needed',
            text: 'Please prefix with @claude / @gpt / @gemini / @all to route this message.',
            timestamp: Date.now(),
          };
          this.store.appendSystem(sys);
          this.send({ kind: 'system-message', message: sys });
          continue;
        }
        if (event.kind === 'dispatch-start') {
          const id = ulid();
          const ts = Date.now();
          inProgressByAgent.set(event.agentId, { id, text: '', toolEvents: [], agentId: event.agentId, timestamp: ts });
          this.send({ kind: 'message-started', id, agentId: event.agentId, timestamp: ts });
          activeAgentForHang = event.agentId;
          lastChunkAt = Date.now();
          continue;
        }
        if (event.kind === 'chunk') {
          const ip = inProgressByAgent.get(event.agentId);
          if (!ip) continue;
          if (event.chunk.type === 'text') ip.text += event.chunk.text;
          else if (event.chunk.type === 'tool-call') ip.toolEvents.push({ kind: 'call', name: event.chunk.name, input: event.chunk.input, timestamp: Date.now() });
          else if (event.chunk.type === 'tool-result') {
            ip.toolEvents.push({ kind: 'result', name: event.chunk.name, output: event.chunk.output, timestamp: Date.now() });
            // Find the matching pending tool-call to recover input — we already pushed the call before the result arrived.
            const matchingCall = [...ip.toolEvents].reverse().find(
              (e: any) => e.kind === 'call' && e.name === event.chunk.name,
            ) as { input: unknown } | undefined;
            if (matchingCall && this.badgeController) {
              const editedPath = getEditedPathForAgent(event.agentId, event.chunk.name, matchingCall.input);
              if (editedPath) {
                this.badgeController.registerEdit(editedPath, event.agentId);
                this.send({ kind: 'file-edited', path: editedPath, agentId: event.agentId, timestamp: Date.now() });
              }
            }
          }
          else if (event.chunk.type === 'error') ip.error = event.chunk.message;
          lastChunkAt = Date.now();
          this.send({ kind: 'message-chunk', id: ip.id, chunk: event.chunk });
          continue;
        }
        if (event.kind === 'dispatch-end') {
          const ip = inProgressByAgent.get(event.agentId);
          if (!ip) continue;
          const status: AgentMessage['status'] =
            ip.cancelled ? 'cancelled' : (ip.error ? 'errored' : 'complete');
          const finalized: AgentMessage = {
            id: ip.id,
            role: 'agent',
            agentId: ip.agentId,
            text: ip.text,
            toolEvents: ip.toolEvents,
            timestamp: ip.timestamp,
            status,
            ...(ip.error ? { error: ip.error } : {}),
          };
          this.store.appendAgent(finalized);
          this.send({ kind: 'message-finalized', message: finalized });
          inProgressByAgent.delete(event.agentId);
          activeAgentForHang = null;
        }
      }
    } finally {
      if (hangCheckTimer) clearInterval(hangCheckTimer);
      this.currentDispatchInProgress = null;
    }
  }

  private async maybeShowGitignorePrompt(workspacePath: string): Promise<void> {
    const stateKey = 'agentChat.gitignorePromptDismissed';
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
               trimmed === '.vscode/agent-chat/' ||
               trimmed === '.vscode/agent-chat';
      });
    if (alreadyCovered) return;

    const choice = await vscode.window.showInformationMessage(
      'Agent Chat stores session history in .vscode/agent-chat/. Add to .gitignore?',
      'Add to .gitignore',
      'Not now',
      "Don't ask again",
    );
    if (choice === 'Add to .gitignore') {
      const additionalLines = (gitignore.length > 0 && !gitignore.endsWith('\n') ? '\n' : '')
        + '\n# Agent Chat session history\n.vscode/agent-chat/\n';
      fs.appendFileSync(gitignorePath, additionalLines, 'utf8');
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
    this.store.flush().catch(() => { /* best-effort */ });
    ChatPanel.current = undefined;
    this.disposables.forEach((d) => d.dispose());
    this.panel.dispose();
  }
}
