import * as vscode from 'vscode';
import { ChatPanel } from './panel.js';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('agentChat.openPanel', () => ChatPanel.show(context)),
  );
}

export function deactivate(): void {
  // no-op
}
