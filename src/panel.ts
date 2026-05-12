import * as vscode from 'vscode';
import type { VeyraSessionService } from './veyraService.js';
import { createVeyraSessionService } from './veyraRuntime.js';
import type { AgentRegistry } from './messageRouter.js';
import type { FileBadgesController } from './fileBadges.js';
import type { FromExtension } from './shared/protocol.js';
import { fileBadgesEnabled, VeyraWebviewController } from './veyraWebviewController.js';

export class ChatPanel {
  private static current: ChatPanel | undefined;
  private disposed = false;

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
    const controller = new VeyraWebviewController({
      context,
      workspacePath: folder.uri.fsPath,
      extensionUri: context.extensionUri,
      service,
      badgeController,
      badgeControllerProvider,
    });
    const chatPanel = new ChatPanel(panel, controller);
    ChatPanel.current = chatPanel;
    try {
      await controller.attach({
        webview: panel.webview,
        send: (message: FromExtension) => panel.webview.postMessage(message),
        onDidDispose: (listener) => panel.onDidDispose(listener),
      });
    } catch (err) {
      if (ChatPanel.current === chatPanel) {
        ChatPanel.current = undefined;
      }
      controller.dispose();
      panel.dispose();
      throw err;
    }
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly controller: VeyraWebviewController,
  ) {
    this.panel.onDidDispose(() => {
      ChatPanel.current = undefined;
      this.controller.dispose();
      this.disposed = true;
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    ChatPanel.current = undefined;
    this.controller.dispose();
    this.panel.dispose();
  }
}
