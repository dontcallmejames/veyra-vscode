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

  private async handleFromWebview(msg: FromWebview): Promise<void> {
    switch (msg.kind) {
      case 'send':
        await this.dispatchUserMessage(msg.text);
        break;
      case 'cancel':
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
    const userMsg: UserMessage = {
      id: ulid(),
      role: 'user',
      text,
      timestamp: Date.now(),
    };
    this.store.appendUser(userMsg);
    this.send({ kind: 'user-message-appended', message: userMsg });

    // Build the in-progress message states + drive the router.
    const inProgressByAgent = new Map<AgentId, { id: string; text: string; toolEvents: any[]; agentId: AgentId; timestamp: number; error?: string; cancelled?: boolean }>();

    for await (const event of this.router.handle(text)) {
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
        continue;
      }
      if (event.kind === 'chunk') {
        const ip = inProgressByAgent.get(event.agentId);
        if (!ip) continue;
        // Mirror state on the extension side so we can persist a final AgentMessage.
        if (event.chunk.type === 'text') ip.text += event.chunk.text;
        else if (event.chunk.type === 'tool-call') ip.toolEvents.push({ kind: 'call', name: event.chunk.name, input: event.chunk.input, timestamp: Date.now() });
        else if (event.chunk.type === 'tool-result') ip.toolEvents.push({ kind: 'result', name: event.chunk.name, output: event.chunk.output, timestamp: Date.now() });
        else if (event.chunk.type === 'error') ip.error = event.chunk.message;
        // Forward to webview
        this.send({ kind: 'message-chunk', id: ip.id, chunk: event.chunk });
        continue;
      }
      if (event.kind === 'dispatch-end') {
        const ip = inProgressByAgent.get(event.agentId);
        if (!ip) continue;
        const finalized: AgentMessage = {
          id: ip.id,
          role: 'agent',
          agentId: ip.agentId,
          text: ip.text,
          toolEvents: ip.toolEvents,
          timestamp: ip.timestamp,
          status: ip.error ? 'errored' : 'complete',
          ...(ip.error ? { error: ip.error } : {}),
        };
        this.store.appendAgent(finalized);
        this.send({ kind: 'message-finalized', message: finalized });
        inProgressByAgent.delete(event.agentId);
      }
    }
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
