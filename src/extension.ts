import * as vscode from 'vscode';
import { ChatPanel } from './panel.js';
import { FileBadgesController } from './fileBadges.js';
import { installCommitHook, uninstallCommitHook, COMMIT_HOOK_SNIPPET } from './commitHook.js';

export function activate(context: vscode.ExtensionContext): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  let badgeController: FileBadgesController | undefined;
  if (folder) {
    badgeController = new FileBadgesController(context);
    if (vscode.workspace.getConfiguration('gambit').get<boolean>('fileBadges.enabled', true)) {
      context.subscriptions.push(
        vscode.window.registerFileDecorationProvider(badgeController),
      );
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('gambit.openPanel', () =>
      ChatPanel.show(context, undefined, badgeController)),
    vscode.commands.registerCommand('gambit.installCommitHook', async () => {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!ws) {
        vscode.window.showErrorMessage('Open a workspace folder first.');
        return;
      }
      const result = installCommitHook(ws);
      if (result.status === 'installed') {
        vscode.window.showInformationMessage(`Installed Gambit commit hook at ${result.path}`);
      } else if (result.status === 'refused-hook-manager') {
        vscode.window.showWarningMessage(
          `Detected ${result.manager}. Add the Gambit trailer logic manually — run "Gambit: Show commit hook snippet" to copy it.`,
        );
      } else if (result.status === 'refused-existing') {
        vscode.window.showWarningMessage('A non-Gambit prepare-commit-msg hook already exists; refusing to overwrite.');
      } else if (result.status === 'refused-no-git') {
        vscode.window.showErrorMessage('No .git directory at workspace root.');
      }
    }),
    vscode.commands.registerCommand('gambit.uninstallCommitHook', async () => {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!ws) {
        vscode.window.showErrorMessage('Open a workspace folder first.');
        return;
      }
      const result = uninstallCommitHook(ws);
      if (result.status === 'removed') {
        vscode.window.showInformationMessage('Removed Gambit commit hook.');
      } else if (result.status === 'refused-not-managed') {
        vscode.window.showWarningMessage('Existing prepare-commit-msg is not Gambit-managed; refusing to remove.');
      } else {
        vscode.window.showInformationMessage('No Gambit commit hook installed.');
      }
    }),
    vscode.commands.registerCommand('gambit.showCommitHookSnippet', async () => {
      const doc = await vscode.workspace.openTextDocument({
        content: COMMIT_HOOK_SNIPPET,
        language: 'shellscript',
      });
      await vscode.window.showTextDocument(doc);
    }),
  );
}

export function deactivate(): void {
  // no-op
}
