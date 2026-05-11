import * as vscode from 'vscode';
import * as path from 'node:path';
import { ChatPanel } from './panel.js';
import { FileBadgesController } from './fileBadges.js';
import { installCommitHook, uninstallCommitHook, COMMIT_HOOK_SNIPPET } from './commitHook.js';
import { createVeyraSessionService, createSmokeAgents, refreshVeyraSessionOptions, shouldUseSmokeAgents } from './veyraRuntime.js';
import { nativeChatSmokeResponses, nativeChatWorkflowDiagnostics, registerNativeChatParticipants } from './nativeChat.js';
import { registerVeyraLanguageModelProvider } from './languageModelProvider.js';
import { checkClaude, checkCodex, checkGemini, clearStatusCache } from './statusChecks.js';
import { detectCliBundlePaths } from './cliPathDetection.js';
import { cliPathMisconfiguration, normalizeCliPathOverride } from './cliPathValidation.js';
import { registerDiffPreviewCommands } from './diffPreviewCommands.js';
import { registerCheckpointCommands } from './checkpointCommands.js';
import type { NativeChatRegistration } from './nativeChat.js';
import type { AgentStatus } from './types.js';
import type { DetectedCliBundlePath } from './cliPathDetection.js';

type FlushableVeyraService = { flush(): Promise<void> };

const activeVeyraServices = new Set<FlushableVeyraService>();

const SETUP_GUIDE_MARKDOWN = `# Veyra Setup Guide

Veyra coordinates Claude, Codex, and Gemini through their local authenticated tools.

## Backend Setup

1. Claude: install Claude Code, then run \`claude /login\`.
2. Codex: install with \`npm install -g @openai/codex\`, then run \`codex login\`.
3. Gemini: install with \`npm install -g @google/gemini-cli\`, then run \`gemini\` once to complete OAuth.
4. Install Node.js and ensure the \`node\` command is on PATH when Veyra launches JS bundle paths or runs inside the VS Code Extension Host.

## Verify

Run \`Veyra: Check agent status\` from the Command Palette. All three agents should report ready before starting \`@veyra /review\`, \`@veyra /debate\`, \`@veyra /consensus\`, or \`@veyra /implement\`.

On Windows, run \`Veyra: Configure Codex/Gemini CLI paths\` to detect native executables or npm global CLI bundle paths and save them to workspace settings. If detection cannot inspect the package tree, choose \`Enter paths manually\` and paste the JS bundle paths, native executable paths, or npm shim paths such as \`codex.cmd\` and \`gemini.ps1\`. Veyra resolves npm shim paths to the underlying JS bundle before launch.

## Preview Quickstart

1. Run \`Veyra: Check agent status\`.
2. Start with read-only prompts such as \`@veyra /review @codebase inspect this change for risk\`, \`@veyra /debate choose a safe implementation approach\`, or \`@veyra /consensus decide which option to take\`.
3. Use \`@veyra /implement ...\` only when you want write-capable agent work, then inspect changes with \`Veyra: Open Pending Changes\`.
4. Follow \`docs/preview-demo-script.md\` for a repeatable demo covering setup, workflows, diff preview, checkpoints, and verification.

## Inaccessible Windows CLI Bundles

If Codex or Gemini reports inaccessible files because Windows npm global package paths are sandboxed, rerun outside the sandbox or set explicit JS bundle paths, native executable paths, or Windows npm shim paths.

For durable VS Code configuration, set:

\`\`\`json
{
  "veyra.codexCliPath": "C:\\\\Users\\\\<you>\\\\AppData\\\\Roaming\\\\npm\\\\node_modules\\\\@openai\\\\codex\\\\bin\\\\codex.js",
  "veyra.geminiCliPath": "C:\\\\Users\\\\<you>\\\\AppData\\\\Roaming\\\\npm\\\\node_modules\\\\@google\\\\gemini-cli\\\\bundle\\\\gemini.js"
}
\`\`\`

For a single shell session before starting VS Code, set:

\`\`\`powershell
$env:VEYRA_CODEX_CLI_PATH = 'C:\\Users\\<you>\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'
$env:VEYRA_GEMINI_CLI_PATH = 'C:\\Users\\<you>\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js'
\`\`\`

For extension-host validation, use \`docs/vscode-smoke-test.md\`.
For paid backend validation, run \`Veyra: Show live validation guide\` before sending live prompts.
`;
const LIVE_VALIDATION_GUIDE_MARKDOWN = `# Veyra Live Validation Guide

Live validation is the final paid-backend gate for Claude, Codex, and Gemini.

## Readiness

Run readiness first:

\`\`\`powershell
npm run verify:live-ready
\`\`\`

No paid prompts are sent unless readiness is green. If readiness reports Codex or Gemini as inaccessible, run \`Veyra: Configure Codex/Gemini CLI paths\` and use JS bundle paths, native executable paths, or Windows npm shim paths such as \`codex.cmd\` and \`gemini.ps1\`.

## Full Goal Verification

PowerShell:

\`\`\`powershell
$env:VEYRA_RUN_LIVE = '1'
npm run verify:goal
Remove-Item Env:\\VEYRA_RUN_LIVE -ErrorAction SilentlyContinue
\`\`\`

Bash-compatible shells:

\`\`\`bash
VEYRA_RUN_LIVE=1 npm run verify:goal
\`\`\`

## Live Tests Only

PowerShell:

\`\`\`powershell
$env:VEYRA_RUN_LIVE = '1'
npm run test:integration:live
Remove-Item Env:\\VEYRA_RUN_LIVE -ErrorAction SilentlyContinue
\`\`\`

Bash-compatible shells:

\`\`\`bash
VEYRA_RUN_LIVE=1 npm run test:integration:live
\`\`\`

The live suite checks each backend individually, the read-only all-agent handoff with shared-context relay, and a disposable write-capable implementation workflow with visible file-edit evidence.
`;
const SHOW_SETUP_GUIDE_ACTION = 'Show setup guide';
const SHOW_LIVE_VALIDATION_GUIDE_ACTION = 'Show live validation guide';
const CONFIGURE_CLI_PATHS_ACTION = 'Configure CLI paths';
const ENTER_CLI_PATHS_ACTION = 'Enter paths manually';

export function activate(context: vscode.ExtensionContext): void {
  let badgeController: FileBadgesController | undefined;
  let badgeProviderDisposable: vscode.Disposable | undefined;
  const fileBadgesEnabled = (): boolean =>
    vscode.workspace.getConfiguration('veyra').get<boolean>('fileBadges.enabled', true);
  const ensureBadgeController = (): FileBadgesController | undefined => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || !fileBadgesEnabled()) {
      badgeProviderDisposable?.dispose();
      badgeProviderDisposable = undefined;
      return undefined;
    }
    if (!badgeController) {
      badgeController = new FileBadgesController(context);
    }
    if (!badgeProviderDisposable) {
      badgeProviderDisposable = vscode.window.registerFileDecorationProvider(badgeController);
      context.subscriptions.push(badgeProviderDisposable);
    }
    return badgeController;
  };

  ensureBadgeController();

  let nativeRegistration: NativeChatRegistration | undefined;
  const ensureNativeRegistration = (): NativeChatRegistration | undefined => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return undefined;
    const currentBadgeController = ensureBadgeController();
    if (!nativeRegistration || nativeRegistration.workspacePath !== folder.uri.fsPath) {
      const smokeAgents = shouldUseSmokeAgents() ? createSmokeAgents() : undefined;
      const service = smokeAgents
        ? createVeyraSessionService(folder.uri.fsPath, currentBadgeController, smokeAgents)
        : createVeyraSessionService(folder.uri.fsPath, currentBadgeController);
      activeVeyraServices.add(service);
      nativeRegistration = {
        workspacePath: folder.uri.fsPath,
        service,
      };
    }
    return nativeRegistration;
  };

  const contextWatcher = vscode.workspace.createFileSystemWatcher('**/*');
  const invalidateWorkspaceContext = (uri?: vscode.Uri): void => {
    if (uri && nativeRegistration && isVeyraInternalStatePath(nativeRegistration.workspacePath, uri.fsPath)) {
      return;
    }
    nativeRegistration?.service.invalidateWorkspaceContext();
  };
  context.subscriptions.push(
    contextWatcher,
    contextWatcher.onDidCreate(invalidateWorkspaceContext),
    contextWatcher.onDidChange(invalidateWorkspaceContext),
    contextWatcher.onDidDelete(invalidateWorkspaceContext),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('veyra.openPanel', () => {
      const registration = ensureNativeRegistration();
      return ChatPanel.show(context, undefined, ensureBadgeController(), registration?.service, ensureBadgeController);
    }),
    vscode.commands.registerCommand('veyra.checkStatus', async () => {
      clearStatusCache();
      const [claude, codex, gemini] = await Promise.all([
        checkClaude(),
        checkCodex(),
        checkGemini(),
      ]);
      vscode.window.showInformationMessage(
        `Veyra agent status: Claude ${formatAgentStatus(claude)}; Codex ${formatAgentStatus(codex)}; Gemini ${formatAgentStatus(gemini)}`,
      );
      const guidance = formatSetupGuidance({ claude, codex, gemini });
      if (guidance) {
        const actions = statusHasCliPathIssue({ codex, gemini })
          ? [CONFIGURE_CLI_PATHS_ACTION, SHOW_SETUP_GUIDE_ACTION, SHOW_LIVE_VALIDATION_GUIDE_ACTION]
          : [SHOW_SETUP_GUIDE_ACTION];
        void Promise.resolve(vscode.window.showWarningMessage(guidance, ...actions)).then((selected) => {
          if (selected === CONFIGURE_CLI_PATHS_ACTION) {
            void vscode.commands.executeCommand('veyra.configureCliPaths');
          } else if (selected === SHOW_SETUP_GUIDE_ACTION) {
            void vscode.commands.executeCommand('veyra.showSetupGuide');
          } else if (selected === SHOW_LIVE_VALIDATION_GUIDE_ACTION) {
            void vscode.commands.executeCommand('veyra.showLiveValidationGuide');
          }
        });
      }
    }),
    vscode.commands.registerCommand('veyra.showSetupGuide', async () => {
      const doc = await vscode.workspace.openTextDocument({
        content: SETUP_GUIDE_MARKDOWN,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc);
    }),
    vscode.commands.registerCommand('veyra.showLiveValidationGuide', async () => {
      const doc = await vscode.workspace.openTextDocument({
        content: LIVE_VALIDATION_GUIDE_MARKDOWN,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc);
    }),
    vscode.commands.registerCommand('veyra.configureCliPaths', async () => {
      await configureCliPaths();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('veyra')
        || e.affectsConfiguration('veyra.codexCliPath')
        || e.affectsConfiguration('veyra.geminiCliPath')
      ) {
        clearStatusCache();
      }
      if (e.affectsConfiguration('veyra')) {
        const currentBadgeController = ensureBadgeController();
        const registration = ensureNativeRegistration();
        if (registration) {
          refreshVeyraSessionOptions(registration.service, registration.workspacePath, currentBadgeController);
        }
      }
    }),
    vscode.commands.registerCommand('veyra.installCommitHook', async () => {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!ws) {
        vscode.window.showErrorMessage('Open a workspace folder first.');
        return;
      }
      const result = installCommitHook(ws);
      if (result.status === 'installed') {
        vscode.window.showInformationMessage(`Installed Veyra commit hook at ${result.path}`);
      } else if (result.status === 'refused-hook-manager') {
        vscode.window.showWarningMessage(
          `Detected ${result.manager}. Add the Veyra trailer logic manually - run "Veyra: Show commit hook snippet" to copy it.`,
        );
      } else if (result.status === 'refused-existing') {
        vscode.window.showWarningMessage('A non-Veyra prepare-commit-msg hook already exists; refusing to overwrite.');
      } else if (result.status === 'refused-no-git') {
        vscode.window.showErrorMessage('No .git directory at workspace root.');
      }
    }),
    vscode.commands.registerCommand('veyra.uninstallCommitHook', async () => {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!ws) {
        vscode.window.showErrorMessage('Open a workspace folder first.');
        return;
      }
      const result = uninstallCommitHook(ws);
      if (result.status === 'removed') {
        vscode.window.showInformationMessage('Removed Veyra commit hook.');
      } else if (result.status === 'refused-not-managed') {
        vscode.window.showWarningMessage('Existing prepare-commit-msg is not Veyra-managed; refusing to remove.');
      } else {
        vscode.window.showInformationMessage('No Veyra commit hook installed.');
      }
    }),
    vscode.commands.registerCommand('veyra.showCommitHookSnippet', async () => {
      const doc = await vscode.workspace.openTextDocument({
        content: COMMIT_HOOK_SNIPPET,
        language: 'shellscript',
      });
      await vscode.window.showTextDocument(doc);
    }),
  );

  registerDiffPreviewCommands(context, () => ensureNativeRegistration()?.service);
  registerCheckpointCommands(context, () => ensureNativeRegistration()?.service);

  let nativeChatRegistrations: string[] = [];
  registerOptionalSurface('native chat', () => {
    nativeChatRegistrations = registerNativeChatParticipants(context, ensureNativeRegistration);
  });
  if (process.env.VSCODE_VEYRA_SMOKE === '1') {
    context.subscriptions.push(
      vscode.commands.registerCommand('veyra.internalSmokeDiagnostics', async () => {
        const registration = ensureNativeRegistration();
        return {
          nativeChatRegistrations,
          nativeWorkflowDiagnostics: nativeChatWorkflowDiagnostics(),
          nativeChatResponses: registration
            ? await nativeChatSmokeResponses(registration)
            : {},
        };
      }),
    );
  }
  registerOptionalSurface('language model provider', () => {
    registerVeyraLanguageModelProvider(context, ensureNativeRegistration);
  });
}

function registerOptionalSurface(label: string, register: () => void): void {
  try {
    register();
  } catch (err) {
    vscode.window.showWarningMessage(`Veyra ${label} registration failed: ${errorMessage(err)}`);
  }
}

function isVeyraInternalStatePath(workspacePath: string, fsPath: string): boolean {
  const relative = path.relative(workspacePath, fsPath).replace(/\\/g, '/');
  return relative === '.vscode/veyra' || relative.startsWith('.vscode/veyra/');
}

export async function deactivate(): Promise<void> {
  const services = [...activeVeyraServices];
  activeVeyraServices.clear();
  await Promise.all(services.map((service) =>
    service.flush().catch((err) => {
      console.error('Veyra session flush failed during deactivation:', err);
    })
  ));
}

function formatAgentStatus(status: AgentStatus): string {
  if (status === 'not-installed') return 'not installed';
  if (status === 'node-missing') return 'Node.js missing';
  return status;
}

function statusHasCliPathIssue(status: Pick<Record<'codex' | 'gemini', AgentStatus>, 'codex' | 'gemini'>): boolean {
  return status.codex === 'inaccessible'
    || status.codex === 'misconfigured'
    || status.codex === 'not-installed'
    || status.codex === 'node-missing'
    || status.gemini === 'inaccessible'
    || status.gemini === 'misconfigured'
    || status.gemini === 'not-installed'
    || status.gemini === 'node-missing';
}

async function configureCliPaths(): Promise<void> {
  const detection = detectCliBundlePaths();
  const config = vscode.workspace.getConfiguration('veyra');
  const configured: string[] = [];
  const incomplete: string[] = [];

  if (detection.codex.status === 'detected' && detection.codex.path) {
    await config.update('codexCliPath', detection.codex.path, vscode.ConfigurationTarget.Workspace);
    configured.push('Codex');
  } else {
    incomplete.push(formatCliDetectionIssue('Codex', detection.codex));
  }

  if (detection.gemini.status === 'detected' && detection.gemini.path) {
    await config.update('geminiCliPath', detection.gemini.path, vscode.ConfigurationTarget.Workspace);
    configured.push('Gemini');
  } else {
    incomplete.push(formatCliDetectionIssue('Gemini', detection.gemini));
  }

  if (configured.length > 0) {
    announceConfiguredCliPaths(configured);
  }

  if (incomplete.length > 0) {
    const message = `Veyra CLI path detection incomplete: ${incomplete.join('; ')}.`;
    void handleIncompleteCliPathDetection(message, detection).catch((err) => {
      vscode.window.showErrorMessage(`Veyra CLI path configuration failed: ${errorMessage(err)}`);
    });
  }
}

async function handleIncompleteCliPathDetection(
  message: string,
  detection: ReturnType<typeof detectCliBundlePaths>,
): Promise<void> {
  const selected = await vscode.window.showWarningMessage(
    message,
    ENTER_CLI_PATHS_ACTION,
    SHOW_SETUP_GUIDE_ACTION,
    SHOW_LIVE_VALIDATION_GUIDE_ACTION,
  );
  if (selected === ENTER_CLI_PATHS_ACTION) {
    const configured: string[] = [];
    if (detection.codex.status !== 'detected') {
      const didConfigure = await promptForCliPath('Codex', 'codexCliPath', detection.codex.path);
      if (didConfigure) configured.push('Codex');
    }
    if (detection.gemini.status !== 'detected') {
      const didConfigure = await promptForCliPath('Gemini', 'geminiCliPath', detection.gemini.path);
      if (didConfigure) configured.push('Gemini');
    }
    if (configured.length > 0) {
      announceConfiguredCliPaths(configured);
    }
  } else if (selected === SHOW_SETUP_GUIDE_ACTION) {
    void vscode.commands.executeCommand('veyra.showSetupGuide');
  } else if (selected === SHOW_LIVE_VALIDATION_GUIDE_ACTION) {
    void vscode.commands.executeCommand('veyra.showLiveValidationGuide');
  }
}

function announceConfiguredCliPaths(configured: string[]): void {
  clearStatusCache();
  vscode.window.showInformationMessage(`Configured Veyra CLI path settings: ${configured.join(', ')}.`);
  void vscode.commands.executeCommand('veyra.checkStatus');
}

async function promptForCliPath(label: 'Codex' | 'Gemini', configKey: 'codexCliPath' | 'geminiCliPath', detectedPath?: string): Promise<boolean> {
  const runtime = label.toLowerCase() as 'codex' | 'gemini';
  const value = await vscode.window.showInputBox({
    title: `${label} CLI path`,
    prompt: `Enter the ${label} CLI JS bundle, native executable, or Windows npm shim path.`,
    value: detectedPath ?? '',
    placeHolder: label === 'Codex'
      ? 'C:\\Users\\<you>\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'
      : 'C:\\Users\\<you>\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js',
    ignoreFocusOut: true,
    validateInput: (input) => {
      const trimmed = input.trim();
      if (!trimmed) return undefined;
      const normalized = normalizeCliPathOverride(runtime, trimmed);
      const misconfiguration = cliPathMisconfiguration(runtime, normalized);
      if (misconfiguration) return misconfiguration;
      return undefined;
    },
  });
  const trimmed = value?.trim();
  if (!trimmed) return false;
  const normalized = normalizeCliPathOverride(runtime, trimmed);
  const misconfiguration = cliPathMisconfiguration(runtime, normalized);
  if (misconfiguration) {
    vscode.window.showWarningMessage(`Veyra did not save ${label}: ${misconfiguration}`);
    return false;
  }
  await vscode.workspace.getConfiguration('veyra').update(configKey, normalized, vscode.ConfigurationTarget.Workspace);
  return true;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function formatCliDetectionIssue(label: 'Codex' | 'Gemini', result: DetectedCliBundlePath): string {
  const detail = result.detail.replace(/[.\s]+$/u, '');
  if (result.status === 'unsupported') return `${label} unsupported - ${detail}`;
  if (result.status === 'inaccessible') return `${label} inaccessible - ${detail}`;
  return `${label} missing - ${detail}`;
}

function formatSetupGuidance(status: Record<'claude' | 'codex' | 'gemini', AgentStatus>): string | null {
  const items: string[] = [];
  if (status.claude === 'unauthenticated') {
    items.push('Claude is unauthenticated (run claude /login)');
  } else if (status.claude === 'not-installed') {
    items.push('Claude is not installed (install Claude Code, then run claude /login)');
  } else if (status.claude === 'inaccessible') {
    items.push('Claude files are inaccessible (check filesystem permissions or rerun outside the current sandbox)');
  } else if (status.claude === 'node-missing') {
    items.push('Claude needs Node.js on PATH when running inside VS Code (install Node.js)');
  }

  if (status.codex === 'unauthenticated') {
    items.push('Codex is unauthenticated (run codex login)');
  } else if (status.codex === 'not-installed') {
    items.push('Codex is not installed (install with npm install -g @openai/codex, then run codex login)');
  } else if (status.codex === 'inaccessible') {
    items.push('Codex files are inaccessible (check filesystem permissions, rerun outside the current sandbox, put native codex.exe on PATH, or set VEYRA_CODEX_CLI_PATH / veyra.codexCliPath to a JS bundle, native executable, or npm shim)');
  } else if (status.codex === 'misconfigured') {
    items.push('Codex CLI path is misconfigured (set VEYRA_CODEX_CLI_PATH / veyra.codexCliPath to codex.js, codex.exe, or codex)');
  } else if (status.codex === 'node-missing') {
    items.push('Codex needs Node.js on PATH to launch a JS bundle (install Node.js or set VEYRA_CODEX_CLI_PATH / veyra.codexCliPath to a native codex executable)');
  }

  if (status.gemini === 'unauthenticated') {
    items.push('Gemini is unauthenticated (run gemini once to complete OAuth)');
  } else if (status.gemini === 'not-installed') {
    items.push('Gemini is not installed (install with npm install -g @google/gemini-cli, then run gemini once to complete OAuth)');
  } else if (status.gemini === 'inaccessible') {
    items.push('Gemini files are inaccessible (check filesystem permissions, rerun outside the current sandbox, put native gemini.exe on PATH, or set VEYRA_GEMINI_CLI_PATH / veyra.geminiCliPath to a JS bundle, native executable, or npm shim)');
  } else if (status.gemini === 'misconfigured') {
    items.push('Gemini CLI path is misconfigured (set VEYRA_GEMINI_CLI_PATH / veyra.geminiCliPath to gemini.js, gemini.exe, or gemini)');
  } else if (status.gemini === 'node-missing') {
    items.push('Gemini needs Node.js on PATH to launch a JS bundle (install Node.js or set VEYRA_GEMINI_CLI_PATH / veyra.geminiCliPath to a native gemini executable)');
  }

  if (items.length === 0) return null;
  return `Veyra setup needed: ${items.join('; ')}.`;
}
