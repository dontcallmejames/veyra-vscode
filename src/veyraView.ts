import * as vscode from 'vscode';
import type { FileBadgesController } from './fileBadges.js';
import type { VeyraSessionService } from './veyraService.js';
import { VeyraWebviewController } from './veyraWebviewController.js';

export const VEYRA_VIEW_CONTAINER_ID = 'veyra';
export const VEYRA_VIEW_ID = 'veyra.chatView';
export const VEYRA_VIEW_CONTAINER_COMMAND = 'workbench.view.extension.veyra';

export interface VeyraViewProviderOptions {
  context: vscode.ExtensionContext;
  getRegistration(): { workspacePath: string; service: VeyraSessionService } | undefined;
  getBadgeController(): FileBadgesController | undefined;
}

export class VeyraViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private controller: VeyraWebviewController | undefined;

  constructor(private readonly options: VeyraViewProviderOptions) {}

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.options.context.extensionUri, 'dist')],
    };

    this.controller?.dispose();
    this.controller = undefined;

    const registration = this.options.getRegistration();
    if (!registration) {
      webviewView.webview.html = this.noWorkspaceHtml();
      return;
    }

    const controller = new VeyraWebviewController({
      context: this.options.context,
      workspacePath: registration.workspacePath,
      extensionUri: this.options.context.extensionUri,
      service: registration.service,
      badgeControllerProvider: this.options.getBadgeController,
    });
    this.controller = controller;

    try {
      await controller.attach({
        webview: webviewView.webview,
        send: (message) => webviewView.webview.postMessage(message),
        onDidDispose: (listener) => webviewView.onDidDispose(listener),
      });
    } catch (err) {
      if (this.controller === controller) {
        this.controller = undefined;
      }
      controller.dispose();
      throw err;
    }
  }

  dispose(): void {
    this.controller?.dispose();
    this.controller = undefined;
  }

  private noWorkspaceHtml(): string {
    return [
      '<!doctype html>',
      '<html lang="en">',
      '<head><meta charset="UTF-8"><title>Veyra</title></head>',
      '<body><p>Open a workspace folder to use Veyra.</p></body>',
      '</html>',
    ].join('');
  }
}

export function revealVeyraView(): Thenable<unknown> {
  return vscode.commands.executeCommand(VEYRA_VIEW_CONTAINER_COMMAND);
}
