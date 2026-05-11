import { describe, it, expect, vi, beforeEach } from 'vitest';

// fsState must be declared at module scope so both the vi.mock factory
// (which runs once at module-load) and individual test bodies can access it.
// Keys are always forward-slash normalized so Windows path.join backslashes are handled.
const fsState = new Map<string, string>();
const fsNorm = (p: string) => String(p).replace(/\\/g, '/');
fsState.set('/fake/ext/dist/index.html', '<html><body><div id="root"></div><script src="{{WEBVIEW_JS_URI}}"></script></body></html>');

// Hoist a fake vscode module before importing ChatPanel.
vi.mock('vscode', () => {
  const messages: any[] = [];
  const onDidReceive = { handler: undefined as any };
  const onDidDispose = { handler: undefined as any };
  const onDidChangeConfiguration = { handler: undefined as any };
  const fakePanel = {
    webview: {
      postMessage: vi.fn((m: any) => messages.push(m)),
      onDidReceiveMessage: vi.fn((h: any) => { onDidReceive.handler = h; return { dispose: vi.fn() }; }),
      asWebviewUri: vi.fn((u: any) => u),
      cspSource: 'vscode-webview:',
      html: '',
    },
    onDidDispose: vi.fn((h: any) => { onDidDispose.handler = h; return { dispose: vi.fn() }; }),
    reveal: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    Uri: { joinPath: (...args: any[]) => args.join('/'), file: (p: string) => ({ fsPath: p }), parse: (s: string) => ({ toString: () => s }) },
    ViewColumn: { One: 1 },
    window: {
      createWebviewPanel: vi.fn(() => fakePanel),
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showTextDocument: vi.fn().mockResolvedValue(undefined),
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/fake/workspace' } }],
      getConfiguration: vi.fn(() => ({ get: (_k: string, dflt: any) => dflt })),
      onDidChangeConfiguration: vi.fn((h: any) => { onDidChangeConfiguration.handler = h; return { dispose: vi.fn() }; }),
      createFileSystemWatcher: vi.fn(() => ({
        onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
        onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
        dispose: vi.fn(),
      })),
      openTextDocument: vi.fn().mockResolvedValue({}),
    },
    env: { openExternal: vi.fn() },
    commands: { executeCommand: vi.fn() },
    __test: { messages, onDidReceive, onDidChangeConfiguration, fakePanel },
  };
});

vi.mock('node:fs', () => ({
  existsSync: (p: string) => fsState.has(fsNorm(p)),
  readFileSync: (p: string) => {
    const v = fsState.get(fsNorm(p));
    if (v === undefined) throw new Error('ENOENT');
    return v;
  },
  statSync: (p: string) => {
    const v = fsState.get(fsNorm(p));
    if (v === undefined) throw new Error('ENOENT');
    return { size: Buffer.byteLength(v, 'utf8') };
  },
  promises: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
  },
  appendFileSync: vi.fn(),
}));

// Mock the agent SDK and child_process so adapters don't try to run anything
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string, stderr?: string) => void) => {
    cb(null, '', '');
    return { on: vi.fn() };
  }),
  execSync: vi.fn(() => '/fake/npm/root\n'),
}));

import { ChatPanel } from '../src/panel.js';
import * as vscode from 'vscode';

const ctx = {
  extensionUri: { fsPath: '/fake/ext' },
  subscriptions: [] as any[],
  workspaceState: {
    get: vi.fn().mockReturnValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  },
} as unknown as import('vscode').ExtensionContext;

describe('ChatPanel', () => {
  beforeEach(() => {
    (vscode as any).__test.messages.length = 0;
    vi.mocked((vscode as any).workspace.openTextDocument).mockClear();
    vi.mocked((vscode as any).window.showTextDocument).mockClear();
    vi.mocked((vscode as any).window.showWarningMessage).mockClear();
    vi.mocked((vscode as any).env.openExternal).mockClear();
    vi.mocked((vscode as any).commands.executeCommand).mockClear();
    (vscode as any).workspace.getConfiguration = vi.fn(() => ({ get: (_k: string, dflt: any) => dflt }));
    (vscode as any).__test.onDidChangeConfiguration.handler = undefined;
    // Reset singleton so each test gets a fresh panel
    (ChatPanel as any).current = undefined;
  });

  it('show() creates the panel and posts an init message', async () => {
    await ChatPanel.show(ctx);
    const msgs = (vscode as any).__test.messages;
    expect(msgs[0].kind).toBe('init');
    expect(msgs[0].session.messages).toEqual([]);
    expect(msgs[0].status).toMatchObject({ claude: expect.any(String), codex: expect.any(String), gemini: expect.any(String) });
    expect(msgs[0].settings.toolCallRenderStyle).toBe('compact');
  });

  it('reload-status from webview re-checks and posts status-changed events', async () => {
    await ChatPanel.show(ctx);
    const before = (vscode as any).__test.messages.length;
    const onDidReceive = (vscode as any).__test.onDidReceive.handler;
    await onDidReceive({ kind: 'reload-status' });
    const after = (vscode as any).__test.messages.slice(before);
    const statusChanged = after.filter((m: any) => m.kind === 'status-changed');
    expect(statusChanged.length).toBeGreaterThan(0);
  });

  it('show-live-validation-guide from webview opens the command-palette guide', async () => {
    await ChatPanel.show(ctx);
    const onDidReceive = (vscode as any).__test.onDidReceive.handler;

    await onDidReceive({ kind: 'show-live-validation-guide' });

    expect((vscode as any).commands.executeCommand).toHaveBeenCalledWith('veyra.showLiveValidationGuide');
  });

  it('show-setup-guide from webview opens the setup guide command', async () => {
    await ChatPanel.show(ctx);
    const onDidReceive = (vscode as any).__test.onDidReceive.handler;

    await onDidReceive({ kind: 'show-setup-guide' });

    expect((vscode as any).commands.executeCommand).toHaveBeenCalledWith('veyra.showSetupGuide');
  });

  it('configure-cli-paths from webview opens the CLI path configuration command', async () => {
    await ChatPanel.show(ctx);
    const onDidReceive = (vscode as any).__test.onDidReceive.handler;

    await onDidReceive({ kind: 'configure-cli-paths' });

    expect((vscode as any).commands.executeCommand).toHaveBeenCalledWith('veyra.configureCliPaths');
  });

  it('change-set actions from webview invoke pending-change commands', async () => {
    await ChatPanel.show(ctx);
    const onDidReceive = (vscode as any).__test.onDidReceive.handler;

    await onDidReceive({ kind: 'open-change-set-diff', changeSetId: 'change-set-1', filePath: 'src/a.ts' });
    await onDidReceive({ kind: 'accept-change-set', changeSetId: 'change-set-1' });
    await onDidReceive({ kind: 'reject-change-set', changeSetId: 'change-set-1' });

    expect((vscode as any).commands.executeCommand).toHaveBeenCalledWith(
      'veyra.openPendingChanges',
      'change-set-1',
      'src/a.ts',
    );
    expect((vscode as any).commands.executeCommand).toHaveBeenCalledWith(
      'veyra.acceptPendingChanges',
      'change-set-1',
    );
    expect((vscode as any).commands.executeCommand).toHaveBeenCalledWith(
      'veyra.rejectPendingChanges',
      'change-set-1',
    );
  });

  it('checkpoint actions from webview invoke checkpoint commands', async () => {
    await ChatPanel.show(ctx);
    const onDidReceive = (vscode as any).__test.onDidReceive.handler;

    await onDidReceive({ kind: 'create-checkpoint', label: 'before experiment' });
    await onDidReceive({ kind: 'rollback-latest-checkpoint' });

    expect((vscode as any).commands.executeCommand).toHaveBeenCalledWith(
      'veyra.createCheckpoint',
      'before experiment',
    );
    expect((vscode as any).commands.executeCommand).toHaveBeenCalledWith('veyra.rollbackLatestCheckpoint');
  });

  it('open-external from webview opens https URLs', async () => {
    await ChatPanel.show(ctx);
    const onDidReceive = (vscode as any).__test.onDidReceive.handler;

    await onDidReceive({ kind: 'open-external', url: 'https://example.com/setup' });

    const opened = vi.mocked((vscode as any).env.openExternal).mock.calls[0][0];
    expect(opened.toString()).toBe('https://example.com/setup');
    expect((vscode as any).window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('open-external from webview refuses non-http URLs', async () => {
    await ChatPanel.show(ctx);
    const onDidReceive = (vscode as any).__test.onDidReceive.handler;

    await onDidReceive({ kind: 'open-external', url: 'javascript:alert(1)' });

    expect((vscode as any).env.openExternal).not.toHaveBeenCalled();
    expect((vscode as any).window.showWarningMessage).toHaveBeenCalledWith('Could not open external URL: javascript:alert(1)');
  });

  it('does not refresh the service with a badge controller when file badges are disabled', async () => {
    const getMock = vi.fn((key: string, dflt: any) => key === 'fileBadges.enabled' ? false : dflt);
    (vscode as any).workspace.getConfiguration = vi.fn(() => ({ get: getMock }));
    const badgeController = { registerEdit: vi.fn() };
    const service = {
      loadSession: vi.fn().mockResolvedValue({ messages: [] }),
      onFloorChange: vi.fn(() => vi.fn()),
      onStatusChange: vi.fn(() => vi.fn()),
      onWriteError: vi.fn(() => vi.fn()),
      updateOptions: vi.fn(),
    };

    await ChatPanel.show(ctx, undefined, badgeController as any, service as any);
    const listener = (vscode as any).__test.onDidChangeConfiguration.handler;
    expect(listener).toBeTypeOf('function');
    listener({ affectsConfiguration: (key: string) => key === 'veyra' });

    expect(service.updateOptions).toHaveBeenCalledWith(expect.objectContaining({
      badgeController: undefined,
    }));
  });

  it('refreshes the service with a later badge controller from the extension provider', async () => {
    const getMock = vi.fn((key: string, dflt: any) => key === 'fileBadges.enabled' ? true : dflt);
    (vscode as any).workspace.getConfiguration = vi.fn(() => ({ get: getMock }));
    const badgeController = { registerEdit: vi.fn() };
    const badgeControllerProvider = vi.fn(() => badgeController);
    const service = {
      loadSession: vi.fn().mockResolvedValue({ messages: [] }),
      onFloorChange: vi.fn(() => vi.fn()),
      onStatusChange: vi.fn(() => vi.fn()),
      onWriteError: vi.fn(() => vi.fn()),
      updateOptions: vi.fn(),
    };

    await (ChatPanel.show as any)(ctx, undefined, undefined, service, badgeControllerProvider);
    const listener = (vscode as any).__test.onDidChangeConfiguration.handler;
    expect(listener).toBeTypeOf('function');
    service.updateOptions.mockClear();

    listener({ affectsConfiguration: (key: string) => key === 'veyra' });

    expect(badgeControllerProvider).toHaveBeenCalled();
    expect(service.updateOptions).toHaveBeenCalledWith(expect.objectContaining({
      badgeController,
    }));
  });

  it('reads veyra.hangDetectionSeconds setting on init', async () => {
    const getMock = vi.fn((key: string, dflt: any) => key === 'hangDetectionSeconds' ? 30 : dflt);
    (vscode as any).workspace.getConfiguration = vi.fn(() => ({ get: getMock }));

    (ChatPanel as any).current = undefined;
    await ChatPanel.show(ctx);

    expect(getMock).toHaveBeenCalledWith('hangDetectionSeconds', expect.anything());
  });

  it('full round-trip: send → user-message-appended → message-started → chunks → message-finalized', async () => {
    (ChatPanel as any).current = undefined;
    (vscode as any).__test.messages.length = 0;

    // Mock agents with canned chunks.
    const claude = {
      id: 'claude' as const,
      status: vi.fn().mockResolvedValue('ready'),
      cancel: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(() => (async function* () {
        yield { type: 'text', text: 'hello' };
        yield { type: 'done' };
      })()),
    };
    const codex = {
      id: 'codex' as const,
      status: vi.fn().mockResolvedValue('ready'),
      cancel: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(() => (async function* () { yield { type: 'done' }; })()),
    };
    const gemini = {
      id: 'gemini' as const,
      status: vi.fn().mockResolvedValue('ready'),
      cancel: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(() => (async function* () { yield { type: 'done' }; })()),
    };

    await ChatPanel.show(ctx, { claude, codex, gemini } as any);

    const onDidReceive = (vscode as any).__test.onDidReceive.handler;
    await onDidReceive({ kind: 'send', text: '@claude hi' });

    // Wait for stream to drain.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const msgs = (vscode as any).__test.messages;
    const kinds = msgs.map((m: any) => m.kind);

    expect(kinds).toContain('user-message-appended');
    expect(kinds).toContain('message-started');
    expect(kinds.filter((k: string) => k === 'message-chunk').length).toBeGreaterThan(0);
    expect(kinds).toContain('message-finalized');

    // Confirm order: started before finalized.
    expect(kinds.indexOf('message-started')).toBeLessThan(kinds.indexOf('message-finalized'));
  });

  it('does not block first-session dispatch behind optional onboarding prompts', async () => {
    let resolvePrompt!: (value: unknown) => void;
    vi.mocked((vscode as any).window.showInformationMessage).mockReturnValueOnce(new Promise((resolve) => {
      resolvePrompt = resolve;
    }));
    const service = {
      loadSession: vi.fn().mockResolvedValue({ messages: [] }),
      onFloorChange: vi.fn(() => vi.fn()),
      onStatusChange: vi.fn(() => vi.fn()),
      onWriteError: vi.fn(() => vi.fn()),
      isFirstSession: vi.fn(() => true),
      dispatch: vi.fn().mockResolvedValue(undefined),
      cancelAll: vi.fn().mockResolvedValue(undefined),
      notifyStatusChange: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    };

    await ChatPanel.show(ctx, undefined, undefined, service as any);
    const onDidReceive = (vscode as any).__test.onDidReceive.handler;
    const sendPromise = onDidReceive({ kind: 'send', text: '@claude continue autonomously' });
    await Promise.resolve();

    expect(service.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ text: '@claude continue autonomously' }),
      expect.any(Function),
    );

    resolvePrompt('Not now');
    await sendPromise;
  });

  it('emits file-edited and calls badgeController.registerEdit when an agent successfully writes a file', async () => {
    (ChatPanel as any).current = undefined;
    (vscode as any).__test.messages.length = 0;

    const claude = {
      id: 'claude' as const,
      status: vi.fn().mockResolvedValue('ready'),
      cancel: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(() => (async function* () {
        yield { type: 'tool-call', name: 'Edit', input: { file_path: '/abs/foo.ts', new_string: 'x', old_string: 'y' } };
        yield { type: 'tool-result', name: 'Edit', output: 'OK' };
        yield { type: 'text', text: 'done' };
        yield { type: 'done' };
      })()),
    };
    const codex = {
      id: 'codex' as const,
      status: vi.fn().mockResolvedValue('ready'),
      cancel: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(() => (async function* () { yield { type: 'done' }; })()),
    };
    const gemini = {
      id: 'gemini' as const,
      status: vi.fn().mockResolvedValue('ready'),
      cancel: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(() => (async function* () { yield { type: 'done' }; })()),
    };

    const badgeController = { registerEdit: vi.fn() };

    await ChatPanel.show(ctx, { claude, codex, gemini } as any, badgeController as any);

    const onDidReceive = (vscode as any).__test.onDidReceive.handler;
    await onDidReceive({ kind: 'send', text: '@claude edit foo' });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(badgeController.registerEdit).toHaveBeenCalledTimes(1);
    expect(badgeController.registerEdit).toHaveBeenCalledWith('/abs/foo.ts', 'claude', 'edited');

    const msgs = (vscode as any).__test.messages;
    const fileEdited = msgs.find((m: any) => m.kind === 'file-edited');
    expect(fileEdited).toMatchObject({ kind: 'file-edited', path: '/abs/foo.ts', agentId: 'claude' });
    expect(typeof fileEdited.timestamp).toBe('number');
  });

  it('opens absolute edited file paths inside the workspace without nesting them', async () => {
    (ChatPanel as any).current = undefined;

    await ChatPanel.show(ctx);

    const onDidReceive = (vscode as any).__test.onDidReceive.handler;
    await onDidReceive({ kind: 'open-workspace-file', relativePath: '/fake/workspace/src/foo.ts' });

    const opened = vi.mocked((vscode as any).workspace.openTextDocument).mock.calls[0][0];
    expect(fsNorm(opened.fsPath)).toMatch(/\/fake\/workspace\/src\/foo\.ts$/);
  });

  it('refuses absolute file paths outside the workspace', async () => {
    (ChatPanel as any).current = undefined;

    await ChatPanel.show(ctx);

    const onDidReceive = (vscode as any).__test.onDidReceive.handler;
    await onDidReceive({ kind: 'open-workspace-file', relativePath: '/outside/foo.ts' });

    expect((vscode as any).workspace.openTextDocument).not.toHaveBeenCalled();
    expect((vscode as any).window.showWarningMessage).toHaveBeenCalledWith('Could not open /outside/foo.ts');
  });

  it('refuses relative workspace file paths that escape the workspace', async () => {
    (ChatPanel as any).current = undefined;

    await ChatPanel.show(ctx);

    const onDidReceive = (vscode as any).__test.onDidReceive.handler;
    await onDidReceive({ kind: 'open-workspace-file', relativePath: '../outside.ts' });

    expect((vscode as any).workspace.openTextDocument).not.toHaveBeenCalled();
    expect((vscode as any).window.showWarningMessage).toHaveBeenCalledWith('Could not open ../outside.ts');
  });

  it('persists attachedFiles + surfaces embed errors when @file used', async () => {
    (ChatPanel as any).current = undefined;
    (vscode as any).__test.messages.length = 0;

    // Make /fake/workspace/foo.ts available in the fs mock.
    fsState.set('/fake/workspace/foo.ts', 'export const x = 1;\n');

    const claude = {
      id: 'claude' as const,
      status: vi.fn().mockResolvedValue('ready'),
      cancel: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(() => (async function* () { yield { type: 'done' }; })()),
    };
    const codex = {
      id: 'codex' as const,
      status: vi.fn().mockResolvedValue('ready'),
      cancel: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(() => (async function* () { yield { type: 'done' }; })()),
    };
    const gemini = {
      id: 'gemini' as const,
      status: vi.fn().mockResolvedValue('ready'),
      cancel: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(() => (async function* () { yield { type: 'done' }; })()),
    };

    await ChatPanel.show(ctx, { claude, codex, gemini } as any);

    const onDidReceive = (vscode as any).__test.onDidReceive.handler;
    await onDidReceive({ kind: 'send', text: '@claude review @foo.ts and @missing.ts' });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const msgs = (vscode as any).__test.messages;
    const userAppended = msgs.find((m: any) => m.kind === 'user-message-appended');
    expect(userAppended).toBeDefined();
    expect(userAppended.message.attachedFiles).toEqual([
      { path: 'foo.ts', lines: 1, truncated: false },
    ]);

    const errSys = msgs.find((m: any) => m.kind === 'system-message' && m.message.text.includes('missing.ts'));
    expect(errSys).toBeDefined();

    // Clean up the test-specific fs entry so it doesn't affect other tests.
    fsState.delete('/fake/workspace/foo.ts');
  });
});
