import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('agentChat.openPanel', () => {
      vscode.window.showInformationMessage('Agent Chat: panel coming in Plan 2');
    })
  );
}

export function deactivate(): void {
  // no-op
}
