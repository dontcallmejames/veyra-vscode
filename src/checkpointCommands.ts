import * as vscode from 'vscode';
import type {
  CheckpointSummary,
  RollbackCheckpointPreview,
  RollbackCheckpointResult,
} from './shared/protocol.js';

export interface CheckpointCommandService {
  createManualCheckpoint(label?: string): Promise<CheckpointSummary>;
  listCheckpoints(): Promise<CheckpointSummary[]>;
  previewLatestCheckpointRollback(): Promise<RollbackCheckpointPreview | null>;
  rollbackLatestCheckpoint(): Promise<RollbackCheckpointResult>;
}

type ServiceProvider = () => CheckpointCommandService | undefined;

interface CheckpointQuickPickItem extends vscode.QuickPickItem {
  checkpoint: CheckpointSummary;
}

export function registerCheckpointCommands(
  context: vscode.ExtensionContext,
  getService: ServiceProvider,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('veyra.createCheckpoint', async (labelArg?: string) => {
      await runCheckpointCommand(async () => {
        const service = activeService(getService);
        if (!service) return;
        const label = labelArg !== undefined ? labelArg : await vscode.window.showInputBox({
          title: 'Veyra checkpoint label',
          prompt: 'Optional label for this checkpoint.',
          placeHolder: 'Manual checkpoint',
          ignoreFocusOut: true,
        });
        const checkpoint = await service.createManualCheckpoint(label);
        vscode.window.showInformationMessage(`Checkpoint saved: ${checkpoint.label}.`);
      });
    }),
    vscode.commands.registerCommand('veyra.listCheckpoints', async () => {
      await runCheckpointCommand(async () => {
        const service = activeService(getService);
        if (!service) return;
        const checkpoints = await service.listCheckpoints();
        if (checkpoints.length === 0) {
          vscode.window.showInformationMessage('No Veyra checkpoints found.');
          return;
        }
        await vscode.window.showQuickPick(
          checkpoints.map((checkpoint): CheckpointQuickPickItem => ({
            label: checkpoint.label,
            description: `${checkpoint.source} - ${checkpoint.status}`,
            detail: `${formatFileCount(checkpoint.fileCount)} - ${checkpoint.promptSummary}`,
            checkpoint,
          })),
          { placeHolder: 'Veyra checkpoints' },
        );
      });
    }),
    vscode.commands.registerCommand('veyra.rollbackLatestCheckpoint', async () => {
      await runCheckpointCommand(async () => {
        const service = activeService(getService);
        if (!service) return;
        const preview = await service.previewLatestCheckpointRollback();
        if (!preview) {
          vscode.window.showInformationMessage('No Veyra checkpoints to roll back.');
          return;
        }
        if (preview.status === 'stale') {
          vscode.window.showWarningMessage(
            `Rollback refused because files changed after the checkpoint: ${preview.staleFiles.join(', ')}.`,
          );
          return;
        }

        const selected = await vscode.window.showWarningMessage(
          `Roll back latest Veyra checkpoint? This will restore or delete ${formatFileCount(preview.files.length)}.`,
          'Roll back',
        );
        if (selected !== 'Roll back') return;

        const result = await service.rollbackLatestCheckpoint();
        if (result.status === 'stale') {
          vscode.window.showWarningMessage(
            `Rollback refused because files changed after the checkpoint: ${result.staleFiles.join(', ')}.`,
          );
          return;
        }
        vscode.window.showInformationMessage(
          `Rolled back Veyra checkpoint for ${formatFileCount(result.restoredFiles.length)}.`,
        );
      });
    }),
  );
}

function activeService(getService: ServiceProvider): CheckpointCommandService | undefined {
  const service = getService();
  if (!service) {
    vscode.window.showWarningMessage('Open a workspace folder before using Veyra checkpoints.');
  }
  return service;
}

async function runCheckpointCommand(command: () => Promise<void>): Promise<void> {
  try {
    await command();
  } catch (err) {
    vscode.window.showErrorMessage(`Veyra checkpoint command failed: ${errorMessage(err)}`);
  }
}

function formatFileCount(fileCount: number): string {
  return `${fileCount} ${fileCount === 1 ? 'file' : 'files'}`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
