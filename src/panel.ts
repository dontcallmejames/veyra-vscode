import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ulid } from './ulid.js';
import { MessageRouter } from './messageRouter.js';
import { ClaudeAgent } from './agents/claude.js';
import { CodexAgent } from './agents/codex.js';
import { GeminiAgent } from './agents/gemini.js';
import { SessionStore } from './sessionStore.js';
import { checkClaude, checkCodex, checkGemini, clearStatusCache } from './statusChecks.js';
import type {
  FromExtension, FromWebview, Settings, AgentMessage, UserMessage, SystemMessage,
} from './shared/protocol.js';
import type { AgentId, AgentStatus } from './types.js';

export class ChatPanel {
  private static current: ChatPanel | undefined;
  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private router: MessageRouter;
  private store: SessionStore;
  private extensionUri: vscode.Uri;

  static async show(context: vscode.ExtensionContext): Promise<void> {
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
    ChatPanel.current = new ChatPanel(panel, context.extensionUri, folder.uri.fsPath);
    await ChatPanel.current.initialize();
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, workspacePath: string) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    const claude = new ClaudeAgent();
    const codex = new CodexAgent();
    const gemini = new GeminiAgent();
    this.router = new MessageRouter({ claude, codex, gemini });
    this.store = new SessionStore(workspacePath);

    this.panel.webview.html = this.renderHtml();
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((m: FromWebview) => this.handleFromWebview(m)),
    );
  }

  private async initialize(): Promise<void> {
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
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('agentChat')) {
          this.send({ kind: 'settings-changed', settings: this.readSettings() });
        }
      }),
    );
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

  // Stubbed in G1; G2 wires this up
  private async handleFromWebview(_msg: FromWebview): Promise<void> {
    // intentionally empty for G1
  }

  private renderHtml(): string {
    const htmlPath = path.join(this.extensionUri.fsPath, 'src', 'webview', 'index.html');
    const jsUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js')
    );
    const nonce = ulid();
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
