import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const commandCallbacks = new Map<string, (...args: unknown[]) => unknown>();
  let configListener: ((event: { affectsConfiguration(key: string): boolean }) => void) | undefined;
  const defaultWorkspaceFolders = [{ uri: { fsPath: '/workspace' } }];
  const service = { id: 'service', flush: vi.fn().mockResolvedValue(undefined) };
  const smokeAgents = { id: 'smoke-agents' };
  const fileDecorationProviderDisposable = { dispose: vi.fn() };
  return {
    commandCallbacks,
    workspaceFolders: [...defaultWorkspaceFolders] as typeof defaultWorkspaceFolders | undefined,
    service,
    smokeAgents,
    fileDecorationProviderDisposable,
    configGet: vi.fn((_key: string, dflt: unknown) => dflt),
    registerCommand: vi.fn((command: string, callback: (...args: unknown[]) => unknown) => {
      commandCallbacks.set(command, callback);
      return { dispose: vi.fn() };
    }),
    registerFileDecorationProvider: vi.fn(() => fileDecorationProviderDisposable),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showInputBox: vi.fn(),
    executeCommand: vi.fn(),
    configUpdate: vi.fn().mockResolvedValue(undefined),
    openTextDocument: vi.fn().mockResolvedValue({ uri: { fsPath: '/snippet' } }),
    showTextDocument: vi.fn().mockResolvedValue(undefined),
    chatPanelShow: vi.fn(),
    createGambitSessionService: vi.fn(() => service),
    createSmokeAgents: vi.fn(() => smokeAgents),
    shouldUseSmokeAgents: vi.fn(() => false),
    refreshGambitSessionOptions: vi.fn(),
    registerNativeChatParticipants: vi.fn(),
    registerGambitLanguageModelProvider: vi.fn(),
    checkClaude: vi.fn().mockResolvedValue('ready'),
    checkCodex: vi.fn().mockResolvedValue('unauthenticated'),
    checkGemini: vi.fn().mockResolvedValue('not-installed'),
    clearStatusCache: vi.fn(),
    detectCliBundlePaths: vi.fn(() => ({
      codex: { status: 'missing', path: 'C:\\npm-root\\@openai\\codex\\bin\\codex.js', detail: 'Codex missing' },
      gemini: { status: 'missing', path: 'C:\\npm-root\\@google\\gemini-cli\\bundle\\gemini.js', detail: 'Gemini missing' },
    })),
    onDidChangeConfiguration: vi.fn((listener: typeof configListener) => {
      configListener = listener;
      return { dispose: vi.fn() };
    }),
    getConfigListener: () => configListener,
    reset() {
      commandCallbacks.clear();
      configListener = undefined;
      this.workspaceFolders = [...defaultWorkspaceFolders];
      this.configGet.mockReset();
      this.configGet.mockImplementation((_key: string, dflt: unknown) => dflt);
      this.registerCommand.mockClear();
      this.registerFileDecorationProvider.mockClear();
      this.fileDecorationProviderDisposable.dispose.mockClear();
      this.showInformationMessage.mockClear();
      this.showErrorMessage.mockClear();
      this.showWarningMessage.mockClear();
      this.showInputBox.mockClear();
      this.showInputBox.mockResolvedValue(undefined);
      this.executeCommand.mockClear();
      this.configUpdate.mockClear();
      this.openTextDocument.mockClear();
      this.showTextDocument.mockClear();
      this.chatPanelShow.mockClear();
      this.service.flush.mockClear();
      this.service.flush.mockResolvedValue(undefined);
      this.createGambitSessionService.mockClear();
      this.createSmokeAgents.mockClear();
      this.shouldUseSmokeAgents.mockClear();
      this.shouldUseSmokeAgents.mockReturnValue(false);
      this.refreshGambitSessionOptions.mockClear();
      this.registerNativeChatParticipants.mockClear();
      this.registerGambitLanguageModelProvider.mockClear();
      this.checkClaude.mockClear();
      this.checkCodex.mockClear();
      this.checkGemini.mockClear();
      this.clearStatusCache.mockClear();
      this.detectCliBundlePaths.mockClear();
      this.detectCliBundlePaths.mockReturnValue({
        codex: { status: 'missing', path: 'C:\\npm-root\\@openai\\codex\\bin\\codex.js', detail: 'Codex missing' },
        gemini: { status: 'missing', path: 'C:\\npm-root\\@google\\gemini-cli\\bundle\\gemini.js', detail: 'Gemini missing' },
      });
      this.onDidChangeConfiguration.mockClear();
    },
  };
});

const flushAsyncWork = () => new Promise((resolve) => setTimeout(resolve, 0));

vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() {
      return mocks.workspaceFolders;
    },
    getConfiguration: vi.fn(() => ({ get: mocks.configGet, update: mocks.configUpdate })),
    onDidChangeConfiguration: mocks.onDidChangeConfiguration,
    openTextDocument: mocks.openTextDocument,
  },
  ConfigurationTarget: {
    Workspace: 'Workspace',
  },
  window: {
    registerFileDecorationProvider: mocks.registerFileDecorationProvider,
    showInformationMessage: mocks.showInformationMessage,
    showErrorMessage: mocks.showErrorMessage,
    showWarningMessage: mocks.showWarningMessage,
    showInputBox: mocks.showInputBox,
    showTextDocument: mocks.showTextDocument,
  },
  commands: {
    registerCommand: mocks.registerCommand,
    executeCommand: mocks.executeCommand,
  },
}));

vi.mock('../src/panel.js', () => ({
  ChatPanel: {
    show: mocks.chatPanelShow,
  },
}));

vi.mock('../src/fileBadges.js', () => ({
  FileBadgesController: vi.fn(function FileBadgesController() {}),
}));

vi.mock('../src/commitHook.js', () => ({
  COMMIT_HOOK_SNIPPET: '# hook snippet',
  installCommitHook: vi.fn(() => ({ status: 'installed', path: '/workspace/.git/hooks/prepare-commit-msg' })),
  uninstallCommitHook: vi.fn(() => ({ status: 'removed' })),
}));

vi.mock('../src/gambitRuntime.js', () => ({
  createGambitSessionService: mocks.createGambitSessionService,
  createSmokeAgents: mocks.createSmokeAgents,
  shouldUseSmokeAgents: mocks.shouldUseSmokeAgents,
  refreshGambitSessionOptions: mocks.refreshGambitSessionOptions,
}));

vi.mock('../src/nativeChat.js', () => ({
  registerNativeChatParticipants: mocks.registerNativeChatParticipants,
}));

vi.mock('../src/languageModelProvider.js', () => ({
  registerGambitLanguageModelProvider: mocks.registerGambitLanguageModelProvider,
}));

vi.mock('../src/statusChecks.js', () => ({
  checkClaude: mocks.checkClaude,
  checkCodex: mocks.checkCodex,
  checkGemini: mocks.checkGemini,
  clearStatusCache: mocks.clearStatusCache,
}));

vi.mock('../src/cliPathDetection.js', () => ({
  detectCliBundlePaths: mocks.detectCliBundlePaths,
}));

import { activate, deactivate } from '../src/extension.js';
import { installCommitHook } from '../src/commitHook.js';

const context = () => ({ subscriptions: [] as Array<{ dispose(): void }> });
const mockedInstallCommitHook = installCommitHook as unknown as ReturnType<typeof vi.fn>;

describe('activate', () => {
  beforeEach(() => {
    mocks.reset();
    mockedInstallCommitHook.mockReset();
    mockedInstallCommitHook.mockReturnValue({
      status: 'installed',
      path: '/workspace/.git/hooks/prepare-commit-msg',
    });
  });

  it('registers the native VS Code integration surface', () => {
    const ctx = context();

    activate(ctx as any);

    expect(mocks.registerCommand.mock.calls.map(([command]) => command)).toEqual([
      'gambit.openPanel',
      'gambit.checkStatus',
      'gambit.showSetupGuide',
      'gambit.showLiveValidationGuide',
      'gambit.configureCliPaths',
      'gambit.installCommitHook',
      'gambit.uninstallCommitHook',
      'gambit.showCommitHookSnippet',
    ]);
    expect(mocks.registerNativeChatParticipants).toHaveBeenCalledWith(ctx, expect.any(Function));
    expect(mocks.registerGambitLanguageModelProvider).toHaveBeenCalledWith(ctx, expect.any(Function));
    expect(mocks.registerFileDecorationProvider).toHaveBeenCalledTimes(1);
  });

  it('auto-configures detected Codex and Gemini CLI bundle paths from the command palette', async () => {
    mocks.detectCliBundlePaths.mockReturnValueOnce({
      codex: { status: 'detected', path: 'D:\\tools\\codex\\codex.js', detail: '' },
      gemini: { status: 'detected', path: 'D:\\tools\\gemini\\gemini.js', detail: '' },
    });
    activate(context() as any);

    const configureCliPaths = mocks.commandCallbacks.get('gambit.configureCliPaths');
    expect(configureCliPaths).toBeTypeOf('function');
    await configureCliPaths!();

    expect(mocks.configUpdate).toHaveBeenCalledWith('codexCliPath', 'D:\\tools\\codex\\codex.js', 'Workspace');
    expect(mocks.configUpdate).toHaveBeenCalledWith('geminiCliPath', 'D:\\tools\\gemini\\gemini.js', 'Workspace');
    expect(mocks.clearStatusCache).toHaveBeenCalledTimes(1);
    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      'Configured Gambit CLI path settings: Codex, Gemini.',
    );
    expect(mocks.executeCommand).toHaveBeenCalledWith('gambit.checkStatus');
  });

  it('warns when automatic CLI bundle path configuration cannot find usable bundles', async () => {
    mocks.detectCliBundlePaths.mockReturnValueOnce({
      codex: { status: 'inaccessible', path: 'C:\\npm-root\\@openai\\codex\\bin\\codex.js', detail: 'Cannot inspect Codex path.' },
      gemini: { status: 'missing', path: 'C:\\npm-root\\@google\\gemini-cli\\bundle\\gemini.js', detail: 'Gemini bundle missing.' },
    });
    activate(context() as any);

    const configureCliPaths = mocks.commandCallbacks.get('gambit.configureCliPaths');
    expect(configureCliPaths).toBeTypeOf('function');
    await configureCliPaths!();

    expect(mocks.configUpdate).not.toHaveBeenCalled();
    expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      'Gambit CLI path detection incomplete: Codex inaccessible - Cannot inspect Codex path; Gemini missing - Gemini bundle missing.',
      'Enter paths manually',
      'Show setup guide',
      'Show live validation guide',
    );
  });

  it('opens the live validation guide when selected from incomplete CLI path detection', async () => {
    mocks.detectCliBundlePaths.mockReturnValueOnce({
      codex: { status: 'inaccessible', path: 'C:\\npm-root\\@openai\\codex\\bin\\codex.js', detail: 'Cannot inspect Codex path.' },
      gemini: { status: 'missing', path: 'C:\\npm-root\\@google\\gemini-cli\\bundle\\gemini.js', detail: 'Gemini bundle missing.' },
    });
    mocks.showWarningMessage.mockResolvedValueOnce('Show live validation guide');
    activate(context() as any);

    const configureCliPaths = mocks.commandCallbacks.get('gambit.configureCliPaths');
    expect(configureCliPaths).toBeTypeOf('function');
    await configureCliPaths!();
    await flushAsyncWork();

    expect(mocks.executeCommand).toHaveBeenCalledWith('gambit.showLiveValidationGuide');
  });

  it('accepts manual CLI runtime paths when automatic configuration cannot inspect bundles', async () => {
    mocks.detectCliBundlePaths.mockReturnValueOnce({
      codex: { status: 'inaccessible', path: 'C:\\npm-root\\@openai\\codex\\bin\\codex.js', detail: 'Cannot inspect Codex path.' },
      gemini: { status: 'missing', path: 'C:\\npm-root\\@google\\gemini-cli\\bundle\\gemini.js', detail: 'Gemini bundle missing.' },
    });
    mocks.showWarningMessage.mockResolvedValueOnce('Enter paths manually');
    mocks.showInputBox
      .mockResolvedValueOnce('D:\\manual\\codex\\codex.exe')
      .mockResolvedValueOnce('D:\\manual\\gemini\\gemini.exe');
    activate(context() as any);

    const configureCliPaths = mocks.commandCallbacks.get('gambit.configureCliPaths');
    expect(configureCliPaths).toBeTypeOf('function');
    await configureCliPaths!();
    await flushAsyncWork();

    expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      'Gambit CLI path detection incomplete: Codex inaccessible - Cannot inspect Codex path; Gemini missing - Gemini bundle missing.',
      'Enter paths manually',
      'Show setup guide',
      'Show live validation guide',
    );
    expect(mocks.showInputBox).toHaveBeenNthCalledWith(1, expect.objectContaining({
      title: 'Codex CLI path',
      prompt: 'Enter the Codex CLI JS bundle, native executable, or Windows npm shim path.',
      value: 'C:\\npm-root\\@openai\\codex\\bin\\codex.js',
    }));
    expect(mocks.showInputBox).toHaveBeenNthCalledWith(2, expect.objectContaining({
      title: 'Gemini CLI path',
      prompt: 'Enter the Gemini CLI JS bundle, native executable, or Windows npm shim path.',
      value: 'C:\\npm-root\\@google\\gemini-cli\\bundle\\gemini.js',
    }));
    const codexOptions = mocks.showInputBox.mock.calls[0][0];
    expect(codexOptions.validateInput('D:\\npm\\codex.bat')).toBeUndefined();
    expect(codexOptions.validateInput('D:\\tools\\not-codex.exe')).toBe('Codex CLI path override must point to codex.js, codex.exe, or codex. Received D:\\tools\\not-codex.exe.');
    const geminiOptions = mocks.showInputBox.mock.calls[1][0];
    expect(geminiOptions.validateInput('D:\\tools\\not-gemini.js')).toBe('Gemini CLI path override must point to gemini.js, gemini.exe, or gemini. Received D:\\tools\\not-gemini.js.');
    expect(mocks.configUpdate).toHaveBeenCalledWith('codexCliPath', 'D:\\manual\\codex\\codex.exe', 'Workspace');
    expect(mocks.configUpdate).toHaveBeenCalledWith('geminiCliPath', 'D:\\manual\\gemini\\gemini.exe', 'Workspace');
    expect(mocks.clearStatusCache).toHaveBeenCalledTimes(1);
    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      'Configured Gambit CLI path settings: Codex, Gemini.',
    );
    expect(mocks.executeCommand).toHaveBeenCalledWith('gambit.checkStatus');
  });

  it('normalizes manually entered Windows npm shim paths before saving workspace settings', async () => {
    mocks.detectCliBundlePaths.mockReturnValueOnce({
      codex: { status: 'missing', path: 'C:\\npm-root\\@openai\\codex\\bin\\codex.js', detail: 'Codex missing.' },
      gemini: { status: 'missing', path: 'C:\\npm-root\\@google\\gemini-cli\\bundle\\gemini.js', detail: 'Gemini missing.' },
    });
    mocks.showWarningMessage.mockResolvedValueOnce('Enter paths manually');
    mocks.showInputBox
      .mockResolvedValueOnce('D:\\npm\\codex.cmd')
      .mockResolvedValueOnce('D:\\npm\\gemini.ps1');
    activate(context() as any);

    const configureCliPaths = mocks.commandCallbacks.get('gambit.configureCliPaths');
    expect(configureCliPaths).toBeTypeOf('function');
    await configureCliPaths!();
    await flushAsyncWork();

    expect(mocks.configUpdate).toHaveBeenCalledWith('codexCliPath', 'D:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js', 'Workspace');
    expect(mocks.configUpdate).toHaveBeenCalledWith('geminiCliPath', 'D:\\npm\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js', 'Workspace');
    expect(mocks.executeCommand).toHaveBeenCalledWith('gambit.checkStatus');
  });

  it('does not block CLI path configuration while waiting for manual path selection', async () => {
    let resolveWarning: (value: unknown) => void = () => {};
    mocks.detectCliBundlePaths.mockReturnValueOnce({
      codex: { status: 'inaccessible', path: 'C:\\npm-root\\@openai\\codex\\bin\\codex.js', detail: 'Cannot inspect Codex path.' },
      gemini: { status: 'missing', path: 'C:\\npm-root\\@google\\gemini-cli\\bundle\\gemini.js', detail: 'Gemini bundle missing.' },
    });
    mocks.showWarningMessage.mockReturnValueOnce(new Promise((resolve) => {
      resolveWarning = resolve;
    }));
    mocks.showInputBox
      .mockResolvedValueOnce('D:\\manual\\codex\\codex.js')
      .mockResolvedValueOnce('D:\\manual\\gemini\\gemini.js');
    activate(context() as any);

    const configureCliPaths = mocks.commandCallbacks.get('gambit.configureCliPaths');
    expect(configureCliPaths).toBeTypeOf('function');
    await expect(configureCliPaths!()).resolves.toBeUndefined();
    expect(mocks.showInputBox).not.toHaveBeenCalled();

    resolveWarning('Enter paths manually');
    await flushAsyncWork();

    expect(mocks.configUpdate).toHaveBeenCalledWith('codexCliPath', 'D:\\manual\\codex\\codex.js', 'Workspace');
    expect(mocks.configUpdate).toHaveBeenCalledWith('geminiCliPath', 'D:\\manual\\gemini\\gemini.js', 'Workspace');
    expect(mocks.executeCommand).toHaveBeenCalledWith('gambit.checkStatus');
  });

  it('reports background manual CLI path configuration failures', async () => {
    mocks.detectCliBundlePaths.mockReturnValueOnce({
      codex: { status: 'inaccessible', path: 'C:\\npm-root\\@openai\\codex\\bin\\codex.js', detail: 'Cannot inspect Codex path.' },
      gemini: { status: 'missing', path: 'C:\\npm-root\\@google\\gemini-cli\\bundle\\gemini.js', detail: 'Gemini bundle missing.' },
    });
    mocks.showWarningMessage.mockResolvedValueOnce('Enter paths manually');
    mocks.showInputBox.mockResolvedValueOnce('D:\\manual\\codex\\codex.js');
    mocks.configUpdate.mockRejectedValueOnce(new Error('settings are read-only'));
    activate(context() as any);

    const configureCliPaths = mocks.commandCallbacks.get('gambit.configureCliPaths');
    expect(configureCliPaths).toBeTypeOf('function');
    await configureCliPaths!();
    await flushAsyncWork();

    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      'Gambit CLI path configuration failed: settings are read-only',
    );
  });

  it('does not save malformed manual CLI runtime paths even if validation is bypassed', async () => {
    mocks.detectCliBundlePaths.mockReturnValueOnce({
      codex: { status: 'missing', path: 'C:\\npm-root\\@openai\\codex\\bin\\codex.js', detail: 'Codex missing.' },
      gemini: { status: 'missing', path: 'C:\\npm-root\\@google\\gemini-cli\\bundle\\gemini.js', detail: 'Gemini missing.' },
    });
    mocks.showWarningMessage.mockResolvedValueOnce('Enter paths manually');
    mocks.showInputBox
      .mockResolvedValueOnce('D:\\tools\\not-codex.exe')
      .mockResolvedValueOnce('D:\\tools\\not-gemini.js');
    activate(context() as any);

    const configureCliPaths = mocks.commandCallbacks.get('gambit.configureCliPaths');
    expect(configureCliPaths).toBeTypeOf('function');
    await configureCliPaths!();
    await flushAsyncWork();

    expect(mocks.configUpdate).not.toHaveBeenCalled();
    expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      'Gambit did not save Codex: Codex CLI path override must point to codex.js, codex.exe, or codex. Received D:\\tools\\not-codex.exe.',
    );
    expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      'Gambit did not save Gemini: Gemini CLI path override must point to gemini.js, gemini.exe, or gemini. Received D:\\tools\\not-gemini.js.',
    );
  });

  it('checks all agent backends from the command palette', async () => {
    activate(context() as any);

    const checkStatus = mocks.commandCallbacks.get('gambit.checkStatus');
    expect(checkStatus).toBeTypeOf('function');
    await checkStatus!();

    expect(mocks.clearStatusCache).toHaveBeenCalledTimes(1);
    expect(mocks.checkClaude).toHaveBeenCalledTimes(1);
    expect(mocks.checkCodex).toHaveBeenCalledTimes(1);
    expect(mocks.checkGemini).toHaveBeenCalledTimes(1);
    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      'Gambit agent status: Claude ready; Codex unauthenticated; Gemini not installed',
    );
    expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      'Gambit setup needed: Codex is unauthenticated (run codex login); Gemini is not installed (install with npm install -g @google/gemini-cli, then run gemini once to complete OAuth).',
      'Configure CLI paths',
      'Show setup guide',
      'Show live validation guide',
    );
  });

  it('opens the setup guide when selected from the status warning', async () => {
    mocks.showWarningMessage.mockResolvedValueOnce('Show setup guide');
    activate(context() as any);

    const checkStatus = mocks.commandCallbacks.get('gambit.checkStatus');
    expect(checkStatus).toBeTypeOf('function');
    await checkStatus!();

    expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      'Gambit setup needed: Codex is unauthenticated (run codex login); Gemini is not installed (install with npm install -g @google/gemini-cli, then run gemini once to complete OAuth).',
      'Configure CLI paths',
      'Show setup guide',
      'Show live validation guide',
    );
    expect(mocks.executeCommand).toHaveBeenCalledWith('gambit.showSetupGuide');
  });

  it('does not block the status command while waiting for warning button selection', async () => {
    let resolveWarning: (value: unknown) => void = () => {};
    mocks.showWarningMessage.mockReturnValueOnce(new Promise((resolve) => {
      resolveWarning = resolve;
    }));
    activate(context() as any);

    const checkStatus = mocks.commandCallbacks.get('gambit.checkStatus');
    expect(checkStatus).toBeTypeOf('function');
    await expect(checkStatus!()).resolves.toBeUndefined();
    expect(mocks.executeCommand).not.toHaveBeenCalledWith('gambit.showSetupGuide');

    resolveWarning('Show setup guide');
    await Promise.resolve();

    expect(mocks.executeCommand).toHaveBeenCalledWith('gambit.showSetupGuide');
  });

  it('shows inaccessible backend guidance from the command palette', async () => {
    mocks.checkClaude.mockResolvedValueOnce('ready');
    mocks.checkCodex.mockResolvedValueOnce('inaccessible');
    mocks.checkGemini.mockResolvedValueOnce('ready');
    activate(context() as any);

    const checkStatus = mocks.commandCallbacks.get('gambit.checkStatus');
    expect(checkStatus).toBeTypeOf('function');
    await checkStatus!();

    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      'Gambit agent status: Claude ready; Codex inaccessible; Gemini ready',
    );
    expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      'Gambit setup needed: Codex files are inaccessible (check filesystem permissions, rerun outside the current sandbox, put native codex.exe on PATH, or set GAMBIT_CODEX_CLI_PATH / gambit.codexCliPath to a JS bundle, native executable, or npm shim).',
      'Configure CLI paths',
      'Show setup guide',
      'Show live validation guide',
    );
  });

  it('opens CLI path configuration when selected from an inaccessible status warning', async () => {
    mocks.checkClaude.mockResolvedValueOnce('ready');
    mocks.checkCodex.mockResolvedValueOnce('inaccessible');
    mocks.checkGemini.mockResolvedValueOnce('ready');
    mocks.showWarningMessage.mockResolvedValueOnce('Configure CLI paths');
    activate(context() as any);

    const checkStatus = mocks.commandCallbacks.get('gambit.checkStatus');
    expect(checkStatus).toBeTypeOf('function');
    await checkStatus!();
    await Promise.resolve();

    expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      'Gambit setup needed: Codex files are inaccessible (check filesystem permissions, rerun outside the current sandbox, put native codex.exe on PATH, or set GAMBIT_CODEX_CLI_PATH / gambit.codexCliPath to a JS bundle, native executable, or npm shim).',
      'Configure CLI paths',
      'Show setup guide',
      'Show live validation guide',
    );
    expect(mocks.executeCommand).toHaveBeenCalledWith('gambit.configureCliPaths');
  });

  it('opens the live validation guide when selected from a CLI status warning', async () => {
    mocks.checkClaude.mockResolvedValueOnce('ready');
    mocks.checkCodex.mockResolvedValueOnce('inaccessible');
    mocks.checkGemini.mockResolvedValueOnce('ready');
    mocks.showWarningMessage.mockResolvedValueOnce('Show live validation guide');
    activate(context() as any);

    const checkStatus = mocks.commandCallbacks.get('gambit.checkStatus');
    await checkStatus!();
    await Promise.resolve();

    expect(mocks.executeCommand).toHaveBeenCalledWith('gambit.showLiveValidationGuide');
  });

  it('shows misconfigured backend guidance from the command palette', async () => {
    mocks.checkClaude.mockResolvedValueOnce('ready');
    mocks.checkCodex.mockResolvedValueOnce('misconfigured');
    mocks.checkGemini.mockResolvedValueOnce('ready');
    activate(context() as any);

    const checkStatus = mocks.commandCallbacks.get('gambit.checkStatus');
    expect(checkStatus).toBeTypeOf('function');
    await checkStatus!();

    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      'Gambit agent status: Claude ready; Codex misconfigured; Gemini ready',
    );
    expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      'Gambit setup needed: Codex CLI path is misconfigured (set GAMBIT_CODEX_CLI_PATH / gambit.codexCliPath to codex.js, codex.exe, or codex).',
      'Configure CLI paths',
      'Show setup guide',
      'Show live validation guide',
    );
  });

  it('shows Node runtime guidance from the command palette for JS-bundle backends', async () => {
    mocks.checkClaude.mockResolvedValueOnce('ready');
    mocks.checkCodex.mockResolvedValueOnce('node-missing');
    mocks.checkGemini.mockResolvedValueOnce('ready');
    activate(context() as any);

    const checkStatus = mocks.commandCallbacks.get('gambit.checkStatus');
    expect(checkStatus).toBeTypeOf('function');
    await checkStatus!();

    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      'Gambit agent status: Claude ready; Codex Node.js missing; Gemini ready',
    );
    expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      'Gambit setup needed: Codex needs Node.js on PATH to launch a JS bundle (install Node.js or set GAMBIT_CODEX_CLI_PATH / gambit.codexCliPath to a native codex executable).',
      'Configure CLI paths',
      'Show setup guide',
      'Show live validation guide',
    );
  });

  it('shows the backend setup guide from the command palette', async () => {
    const doc = { uri: { fsPath: '/setup-guide' } };
    mocks.openTextDocument.mockResolvedValueOnce(doc);
    activate(context() as any);

    const showSetupGuide = mocks.commandCallbacks.get('gambit.showSetupGuide');
    expect(showSetupGuide).toBeTypeOf('function');
    await showSetupGuide!();

    expect(mocks.openTextDocument).toHaveBeenCalledWith({
      content: expect.stringContaining('codex login'),
      language: 'markdown',
    });
    expect(mocks.openTextDocument).toHaveBeenCalledWith({
      content: expect.stringContaining('npm install -g @openai/codex'),
      language: 'markdown',
    });
    expect(mocks.openTextDocument).toHaveBeenCalledWith({
      content: expect.stringContaining('npm install -g @google/gemini-cli'),
      language: 'markdown',
    });
    expect(mocks.openTextDocument).toHaveBeenCalledWith({
      content: expect.stringContaining('Install Node.js and ensure the `node` command is on PATH'),
      language: 'markdown',
    });
    expect(mocks.openTextDocument).toHaveBeenCalledWith({
      content: expect.stringContaining('GAMBIT_CODEX_CLI_PATH'),
      language: 'markdown',
    });
    expect(mocks.openTextDocument).toHaveBeenCalledWith({
      content: expect.stringContaining('gambit.codexCliPath'),
      language: 'markdown',
    });
    expect(mocks.openTextDocument).toHaveBeenCalledWith({
      content: expect.stringContaining('GAMBIT_GEMINI_CLI_PATH'),
      language: 'markdown',
    });
    expect(mocks.openTextDocument).toHaveBeenCalledWith({
      content: expect.stringContaining('gambit.geminiCliPath'),
      language: 'markdown',
    });
    expect(mocks.openTextDocument).toHaveBeenCalledWith({
      content: expect.stringContaining('npm shim paths such as `codex.cmd` and `gemini.ps1`'),
      language: 'markdown',
    });
    expect(mocks.openTextDocument).toHaveBeenCalledWith({
      content: expect.stringContaining('Gambit resolves npm shim paths to the underlying JS bundle before launch'),
      language: 'markdown',
    });
    expect(mocks.openTextDocument).toHaveBeenCalledWith({
      content: expect.stringContaining('Gambit: Show live validation guide'),
      language: 'markdown',
    });
    expect(mocks.showTextDocument).toHaveBeenCalledWith(doc);
  });

  it('shows the live validation guide from the command palette', async () => {
    const doc = { uri: { fsPath: '/live-validation-guide' } };
    mocks.openTextDocument.mockResolvedValueOnce(doc);
    activate(context() as any);

    const showLiveValidationGuide = mocks.commandCallbacks.get('gambit.showLiveValidationGuide');
    expect(showLiveValidationGuide).toBeTypeOf('function');
    await showLiveValidationGuide!();

    const liveGuideCall = mocks.openTextDocument.mock.calls[0]?.[0] as { content?: string };
    const liveGuide = liveGuideCall.content ?? '';
    expect(mocks.openTextDocument).toHaveBeenCalledWith({
      content: expect.stringContaining('npm run verify:live-ready'),
      language: 'markdown',
    });
    expect(mocks.openTextDocument).toHaveBeenCalledWith({
      content: expect.stringContaining("$env:GAMBIT_RUN_LIVE = '1'"),
      language: 'markdown',
    });
    expect(mocks.openTextDocument).toHaveBeenCalledWith({
      content: expect.stringContaining('npm run verify:goal'),
      language: 'markdown',
    });
    expect(mocks.openTextDocument).toHaveBeenCalledWith({
      content: expect.stringContaining('GAMBIT_RUN_LIVE=1 npm run test:integration:live'),
      language: 'markdown',
    });
    expect(mocks.openTextDocument).toHaveBeenCalledWith({
      content: expect.stringContaining('No paid prompts are sent unless readiness is green'),
      language: 'markdown',
    });
    expect(liveGuide.match(/\$env:GAMBIT_RUN_LIVE = '1'/g)).toHaveLength(2);
    expect(liveGuide.match(/Remove-Item Env:\\GAMBIT_RUN_LIVE -ErrorAction SilentlyContinue/g)).toHaveLength(2);
    expect(mocks.showTextDocument).toHaveBeenCalledWith(doc);
  });

  it('creates file badges when a workspace folder appears after activation', () => {
    mocks.workspaceFolders = undefined;
    const ctx = context();

    activate(ctx as any);

    expect(mocks.registerFileDecorationProvider).not.toHaveBeenCalled();

    mocks.workspaceFolders = [{ uri: { fsPath: '/late-workspace' } }];
    const openPanel = mocks.commandCallbacks.get('gambit.openPanel');
    expect(openPanel).toBeTypeOf('function');
    openPanel!();

    expect(mocks.registerFileDecorationProvider).toHaveBeenCalledTimes(1);
    expect(mocks.createGambitSessionService).toHaveBeenCalledWith('/late-workspace', expect.anything());
    expect(mocks.chatPanelShow).toHaveBeenCalledWith(
      ctx,
      undefined,
      expect.anything(),
      mocks.service,
      expect.any(Function),
    );
  });

  it('turns off file badge registration and session badge updates when file badges are disabled at runtime', () => {
    const ctx = context();

    activate(ctx as any);
    const openPanel = mocks.commandCallbacks.get('gambit.openPanel');
    expect(openPanel).toBeTypeOf('function');
    openPanel!();
    mocks.refreshGambitSessionOptions.mockClear();

    mocks.configGet.mockImplementation((key: string, dflt: unknown) =>
      key === 'fileBadges.enabled' ? false : dflt
    );
    const listener = mocks.getConfigListener();
    expect(listener).toBeTypeOf('function');
    listener!({ affectsConfiguration: (key) => key === 'gambit' || key === 'gambit.fileBadges.enabled' });

    expect(mocks.fileDecorationProviderDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.refreshGambitSessionOptions).toHaveBeenCalledWith(mocks.service, undefined);
  });

  it('clears cached backend status when CLI path settings change', () => {
    activate(context() as any);
    mocks.clearStatusCache.mockClear();

    const listener = mocks.getConfigListener();
    expect(listener).toBeTypeOf('function');
    listener!({ affectsConfiguration: (key) => key === 'gambit.codexCliPath' });

    expect(mocks.clearStatusCache).toHaveBeenCalledTimes(1);
  });

  it('uses deterministic smoke agents for Extension Host smoke runs', () => {
    mocks.shouldUseSmokeAgents.mockReturnValueOnce(true);
    const ctx = context();

    activate(ctx as any);
    const openPanel = mocks.commandCallbacks.get('gambit.openPanel');
    expect(openPanel).toBeTypeOf('function');
    openPanel!();

    expect(mocks.createSmokeAgents).toHaveBeenCalledTimes(1);
    expect(mocks.createGambitSessionService).toHaveBeenCalledWith(
      '/workspace',
      expect.anything(),
      mocks.smokeAgents,
    );
  });

  it('flushes the active Gambit session service on extension deactivation', async () => {
    const ctx = context();

    activate(ctx as any);
    const openPanel = mocks.commandCallbacks.get('gambit.openPanel');
    expect(openPanel).toBeTypeOf('function');
    await openPanel!();

    await deactivate();

    expect(mocks.service.flush).toHaveBeenCalledTimes(1);
  });

  it('shows ASCII hook-manager guidance when commit hook install is refused', async () => {
    mockedInstallCommitHook.mockReturnValueOnce({
      status: 'refused-hook-manager',
      manager: 'Husky',
    });
    activate(context() as any);

    const installHook = mocks.commandCallbacks.get('gambit.installCommitHook');
    expect(installHook).toBeTypeOf('function');
    await installHook!();

    expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      'Detected Husky. Add the Gambit trailer logic manually - run "Gambit: Show commit hook snippet" to copy it.',
    );
    expect(mocks.showWarningMessage.mock.calls[0][0]).not.toMatch(/[^\x00-\x7F]/);
  });
});
