import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist a fake vscode module before importing ChatPanel.
vi.mock('vscode', () => {
  const messages: any[] = [];
  const onDidReceive = { handler: undefined as any };
  const onDidDispose = { handler: undefined as any };
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
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/fake/workspace' } }],
      getConfiguration: vi.fn(() => ({ get: (_k: string, dflt: any) => dflt })),
      onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    },
    env: { openExternal: vi.fn() },
    __test: { messages, onDidReceive, fakePanel },
  };
});

vi.mock('node:fs', () => ({
  existsSync: vi.fn((p: string) => p.endsWith('.html')),
  readFileSync: vi.fn().mockReturnValue('<html><body><div id="root"></div><script src="{{WEBVIEW_JS_URI}}"></script></body></html>'),
  promises: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock the agent SDK and child_process so adapters don't try to run anything
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: vi.fn(), execSync: vi.fn(() => '/fake/npm/root\n') }));

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

  it('reads agentChat.hangDetectionSeconds setting on init', async () => {
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
});
