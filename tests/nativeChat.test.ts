import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMocks = vi.hoisted(() => {
  const participantHandlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    participantHandlers,
    toolCallRenderStyle: 'compact' as 'verbose' | 'compact' | 'hidden',
    createChatParticipant: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
      participantHandlers.set(id, handler);
      return { dispose: vi.fn() };
    }),
    reset() {
      participantHandlers.clear();
      this.toolCallRenderStyle = 'compact';
      this.createChatParticipant.mockClear();
    },
  };
});

function cancellationToken() {
  return {
    isCancellationRequested: false,
    onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
  };
}

vi.mock('vscode', () => ({
  ThemeIcon: class {
    constructor(public id: string) {}
  },
  chat: {
    createChatParticipant: vscodeMocks.createChatParticipant,
  },
  Uri: {
    file: (path: string) => ({ fsPath: path }),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string, dflt: unknown) =>
        key === 'toolCallRenderStyle' ? vscodeMocks.toolCallRenderStyle : dflt
      ),
    })),
  },
}));

import {
  NATIVE_CHAT_PARTICIPANTS,
  nativeChatPromptForRequest,
  registerNativeChatParticipants,
} from '../src/nativeChat.js';
import { parseFileMentions } from '../src/fileMentions.js';

describe('native chat workflow prompts', () => {
  beforeEach(() => {
    vscodeMocks.reset();
  });

  it('leaves direct participants as direct forced-target requests', () => {
    const claude = NATIVE_CHAT_PARTICIPANTS.find((participant) => participant.name === 'claude')!;

    expect(nativeChatPromptForRequest(claude, { prompt: 'review this', command: undefined } as any)).toEqual({
      text: 'review this',
      forcedTarget: 'claude',
    });
  });

  it('rewrites VS Code file references into Veyra file attachments', () => {
    const claude = NATIVE_CHAT_PARTICIPANTS.find((participant) => participant.name === 'claude')!;

    expect(nativeChatPromptForRequest(
      claude,
      {
        prompt: 'review #file before editing',
        command: undefined,
        references: [
          {
            id: 'file',
            range: [7, 12],
            value: { fsPath: '/workspace/src/context.ts' },
          },
        ],
      } as any,
      '/workspace',
    )).toEqual({
      text: 'review @src/context.ts before editing',
      forcedTarget: 'claude',
    });
  });

  it('preserves VS Code selection ranges on file references', () => {
    const claude = NATIVE_CHAT_PARTICIPANTS.find((participant) => participant.name === 'claude')!;

    expect(nativeChatPromptForRequest(
      claude,
      {
        prompt: 'review #selection',
        command: undefined,
        references: [
          {
            id: 'selection',
            range: [7, 17],
            value: {
              uri: { fsPath: '/workspace/src/context.ts' },
              range: {
                start: { line: 9, character: 0 },
                end: { line: 11, character: 4 },
              },
            },
          },
        ],
      } as any,
      '/workspace',
    )).toEqual({
      text: [
        'review @src/context.ts',
        '',
        'Reference focus: src/context.ts lines 10-12',
      ].join('\n'),
      forcedTarget: 'claude',
    });
  });

  it('keeps selection ranges tied to their file after attachment parsing', () => {
    const claude = NATIVE_CHAT_PARTICIPANTS.find((participant) => participant.name === 'claude')!;
    const routed = nativeChatPromptForRequest(
      claude,
      {
        prompt: 'review #selection',
        command: undefined,
        references: [
          {
            id: 'selection',
            range: [7, 17],
            value: {
              uri: { fsPath: '/workspace/src/context.ts' },
              range: {
                start: { line: 9, character: 0 },
                end: { line: 11, character: 4 },
              },
            },
          },
        ],
      } as any,
      '/workspace',
    );

    const parsed = parseFileMentions(routed.text);

    expect(parsed.filePaths).toEqual(['src/context.ts']);
    expect(parsed.remainingText).toContain('Reference focus: src/context.ts lines 10-12');
  });

  it('inlines VS Code string references so resolved context is not lost', () => {
    const claude = NATIVE_CHAT_PARTICIPANTS.find((participant) => participant.name === 'claude')!;

    expect(nativeChatPromptForRequest(
      claude,
      {
        prompt: 'explain #terminalSelection',
        command: undefined,
        references: [
          {
            id: 'terminalSelection',
            range: [8, 26],
            modelDescription: 'Selected terminal output',
            value: 'npm test failed with TS2304',
          },
        ],
      } as any,
      '/workspace',
    )).toEqual({
      text: [
        'explain [Terminal context]',
        'Selected terminal output:',
        'npm test failed with TS2304',
        '[/Terminal context]',
      ].join('\n'),
      forcedTarget: 'claude',
    });
  });

  it('rewrites multiple VS Code references without corrupting prompt ranges', () => {
    const claude = NATIVE_CHAT_PARTICIPANTS.find((participant) => participant.name === 'claude')!;

    expect(nativeChatPromptForRequest(
      claude,
      {
        prompt: 'compare #a with #b',
        command: undefined,
        references: [
          {
            id: 'a',
            range: [8, 10],
            value: { fsPath: '/workspace/src/a.ts' },
          },
          {
            id: 'b',
            range: [16, 18],
            value: { fsPath: '/workspace/src/b.ts' },
          },
        ],
      } as any,
      '/workspace',
    )).toEqual({
      text: 'compare @src/a.ts with @src/b.ts',
      forcedTarget: 'claude',
    });
  });

  it('surfaces VS Code tool references as prompt context', () => {
    const claude = NATIVE_CHAT_PARTICIPANTS.find((participant) => participant.name === 'claude')!;

    expect(nativeChatPromptForRequest(
      claude,
      {
        prompt: 'summarize with #repo',
        command: undefined,
        references: [],
        toolReferences: [
          {
            name: 'githubRepo',
            range: [15, 20],
          },
        ],
      } as any,
      '/workspace',
    )).toEqual({
      text: 'summarize with [VS Code tool: githubRepo]',
      forcedTarget: 'claude',
    });
  });

  it('turns @veyra /review into an all-agent review request', () => {
    const veyra = NATIVE_CHAT_PARTICIPANTS.find((participant) => participant.name === 'veyra')!;
    const routed = nativeChatPromptForRequest(veyra, { prompt: 'check this diff', command: 'review' } as any);

    expect(routed.forcedTarget).toBe('veyra');
    expect(routed.text).toContain('@all');
    expect(routed.text).toContain('check this diff');
    expect(routed.text).toContain('review');
  });

  it('keeps @veyra /review read-only so review passes do not make invisible edits', () => {
    const veyra = NATIVE_CHAT_PARTICIPANTS.find((participant) => participant.name === 'veyra')!;
    const routed = nativeChatPromptForRequest(veyra, { prompt: 'check this diff', command: 'review' } as any);

    expect(routed.text).toContain('Read-only workflow');
    expect(routed.text).toContain('Do not create, edit, rename, or delete files');
  });

  it('turns @veyra /debate into an all-agent debate request', () => {
    const veyra = NATIVE_CHAT_PARTICIPANTS.find((participant) => participant.name === 'veyra')!;
    const routed = nativeChatPromptForRequest(veyra, { prompt: 'which design should we use?', command: 'debate' } as any);

    expect(routed.forcedTarget).toBe('veyra');
    expect(routed.text).toContain('@all');
    expect(routed.text).toContain('which design should we use?');
    expect(routed.text).toContain('debate');
  });

  it('keeps @veyra /debate read-only until the user chooses implementation', () => {
    const veyra = NATIVE_CHAT_PARTICIPANTS.find((participant) => participant.name === 'veyra')!;
    const routed = nativeChatPromptForRequest(veyra, { prompt: 'which design should we use?', command: 'debate' } as any);

    expect(routed.text).toContain('Read-only workflow');
    expect(routed.text).toContain('Do not create, edit, rename, or delete files');
  });

  it('turns @veyra /consensus into an all-agent consensus request', () => {
    const veyra = NATIVE_CHAT_PARTICIPANTS.find((participant) => participant.name === 'veyra')!;
    const routed = nativeChatPromptForRequest(veyra, { prompt: 'choose the release path', command: 'consensus' } as any);

    expect(routed.forcedTarget).toBe('veyra');
    expect(routed.text).toContain('@all');
    expect(routed.text).toContain('Workflow: consensus');
    expect(routed.text).toContain('choose the release path');
    expect(routed.text).toContain('Consensus Recommendation');
  });

  it('keeps @veyra /consensus read-only until the user chooses implementation', () => {
    const veyra = NATIVE_CHAT_PARTICIPANTS.find((participant) => participant.name === 'veyra')!;
    const routed = nativeChatPromptForRequest(veyra, { prompt: 'choose the release path', command: 'consensus' } as any);

    expect(routed.readOnly).toBe(true);
    expect(routed.text).toContain('Read-only workflow');
    expect(routed.text).toContain('Do not create, edit, rename, or delete files');
  });

  it('turns @veyra /implement into an all-agent autonomous implementation request', () => {
    const veyra = NATIVE_CHAT_PARTICIPANTS.find((participant) => participant.name === 'veyra')!;
    const routed = nativeChatPromptForRequest(veyra, { prompt: 'fix the parser bug', command: 'implement' } as any);

    expect(routed.forcedTarget).toBe('veyra');
    expect(routed.text).toContain('@all');
    expect(routed.text).toContain('Workflow: implement');
    expect(routed.text).toContain('fix the parser bug');
    expect(routed.text).toContain('review');
  });

  it('does not dispatch when the native chat request is already cancelled', async () => {
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    const service = {
      dispatch: vi.fn(),
      cancelAll: vi.fn(),
    };

    registerNativeChatParticipants(
      context as any,
      () => ({ service, workspacePath: '/workspace' } as any),
    );

    const handler = vscodeMocks.participantHandlers.get('veyra.veyra');
    expect(handler).toBeTypeOf('function');
    await handler!(
      { prompt: 'run this', command: undefined },
      {},
      { markdown: vi.fn(), progress: vi.fn(), reference: vi.fn() },
      {
        isCancellationRequested: true,
        onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
      },
    );

    expect(service.dispatch).not.toHaveBeenCalled();
    expect(service.cancelAll).not.toHaveBeenCalled();
  });

  it('does not dispatch empty native chat prompts', async () => {
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    const service = {
      dispatch: vi.fn(async () => {}),
      cancelAll: vi.fn(),
    };

    registerNativeChatParticipants(
      context as any,
      () => ({ service, workspacePath: '/workspace' } as any),
    );

    const handler = vscodeMocks.participantHandlers.get('veyra.veyra');
    expect(handler).toBeTypeOf('function');
    const response = { markdown: vi.fn(), progress: vi.fn(), reference: vi.fn() };
    await handler!(
      { prompt: '   ', command: undefined, references: [], toolReferences: [] },
      {},
      response,
      cancellationToken(),
    );

    expect(service.dispatch).not.toHaveBeenCalled();
    expect(response.markdown).toHaveBeenCalledWith('Provide a prompt before using Veyra chat participants.');
  });

  it('does not dispatch empty native chat workflow prompts', async () => {
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    const service = {
      dispatch: vi.fn(async () => {}),
      cancelAll: vi.fn(),
    };

    registerNativeChatParticipants(
      context as any,
      () => ({ service, workspacePath: '/workspace' } as any),
    );

    const handler = vscodeMocks.participantHandlers.get('veyra.veyra');
    expect(handler).toBeTypeOf('function');
    const response = { markdown: vi.fn(), progress: vi.fn(), reference: vi.fn() };
    await handler!(
      { prompt: '   ', command: 'review', references: [], toolReferences: [] },
      {},
      response,
      cancellationToken(),
    );

    expect(service.dispatch).not.toHaveBeenCalled();
    expect(response.markdown).toHaveBeenCalledWith('Provide a prompt before using Veyra chat participants.');
  });

  it('passes VS Code chat history into dispatched prompts', async () => {
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    const service = {
      dispatch: vi.fn(async () => {}),
      cancelAll: vi.fn(),
    };

    registerNativeChatParticipants(
      context as any,
      () => ({ service, workspacePath: '/workspace' } as any),
    );

    const handler = vscodeMocks.participantHandlers.get('veyra.veyra');
    expect(handler).toBeTypeOf('function');
    await handler!(
      { prompt: 'continue from there', command: undefined, references: [], toolReferences: [] },
      {
        history: [
          {
            prompt: 'what changed?',
            participant: 'veyra.veyra',
            references: [],
            toolReferences: [],
          },
          {
            participant: 'veyra.veyra',
            response: [
              { value: { value: 'Changed the parser and tests.' } },
            ],
            result: {},
          },
        ],
      },
      { markdown: vi.fn(), progress: vi.fn(), reference: vi.fn() },
      cancellationToken(),
    );

    expect(service.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        text: [
          '[VS Code chat history]',
          'User (veyra.veyra): what changed?',
          'Assistant (veyra.veyra): Changed the parser and tests.',
          '[/VS Code chat history]',
          '',
          'continue from there',
        ].join('\n'),
      }),
      expect.any(Function),
    );
  });

  it('dispatches read-only native review workflows without auto-edit permission', async () => {
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    const service = {
      dispatch: vi.fn(async () => {}),
      cancelAll: vi.fn(),
    };

    registerNativeChatParticipants(
      context as any,
      () => ({ service, workspacePath: '/workspace' } as any),
    );

    const handler = vscodeMocks.participantHandlers.get('veyra.veyra');
    expect(handler).toBeTypeOf('function');
    await handler!(
      { prompt: 'check this diff', command: 'review', references: [], toolReferences: [] },
      {},
      { markdown: vi.fn(), progress: vi.fn(), reference: vi.fn() },
      cancellationToken(),
    );

    expect(service.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        readOnly: true,
        text: expect.stringContaining('Workflow: review'),
      }),
      expect.any(Function),
    );
  });

  it('dispatches read-only native consensus workflows without auto-edit permission', async () => {
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    const service = {
      dispatch: vi.fn(async () => {}),
      cancelAll: vi.fn(),
    };

    registerNativeChatParticipants(
      context as any,
      () => ({ service, workspacePath: '/workspace' } as any),
    );

    const handler = vscodeMocks.participantHandlers.get('veyra.veyra');
    expect(handler).toBeTypeOf('function');
    await handler!(
      { prompt: 'choose the release path', command: 'consensus', references: [], toolReferences: [] },
      {},
      { markdown: vi.fn(), progress: vi.fn(), reference: vi.fn() },
      cancellationToken(),
    );

    expect(service.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        readOnly: true,
        text: expect.stringContaining('Workflow: consensus'),
      }),
      expect.any(Function),
    );
  });

  it('passes raw @codebase workflow prompts as the workspace-context query', async () => {
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    const service = {
      dispatch: vi.fn(async () => {}),
      cancelAll: vi.fn(),
    };

    registerNativeChatParticipants(
      context as any,
      () => ({ service, workspacePath: '/workspace' } as any),
    );

    const handler = vscodeMocks.participantHandlers.get('veyra.veyra');
    expect(handler).toBeTypeOf('function');
    await handler!(
      { prompt: '@codebase inspect the auth flow for correctness risks', command: 'review', references: [], toolReferences: [] },
      {},
      { markdown: vi.fn(), progress: vi.fn(), reference: vi.fn() },
      cancellationToken(),
    );

    expect(service.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        readOnly: true,
        text: expect.stringContaining('Workflow: review'),
        workspaceContextQuery: '@codebase inspect the auth flow for correctness risks',
      }),
      expect.any(Function),
    );
  });

  it('does not pass file-like @codebase workflow prompts as workspace-context queries', async () => {
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    const service = {
      dispatch: vi.fn(async (_request: unknown) => {}),
      cancelAll: vi.fn(),
    };

    registerNativeChatParticipants(
      context as any,
      () => ({ service, workspacePath: '/workspace' } as any),
    );

    const handler = vscodeMocks.participantHandlers.get('veyra.veyra');
    expect(handler).toBeTypeOf('function');
    await handler!(
      { prompt: '@codebase.ts explain this file', command: 'review', references: [], toolReferences: [] },
      {},
      { markdown: vi.fn(), progress: vi.fn(), reference: vi.fn() },
      cancellationToken(),
    );

    expect(service.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        readOnly: true,
        text: expect.stringContaining('@codebase.ts explain this file'),
      }),
      expect.any(Function),
    );
    expect(service.dispatch.mock.calls[0][0]).not.toHaveProperty('workspaceContextQuery');
  });

  it('references the conflicted workspace file from edit-conflict notices', async () => {
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    const service = {
      dispatch: vi.fn(async (_request, emit) => {
        await emit({
          kind: 'system-message',
          message: {
            id: 'sys1',
            role: 'system',
            kind: 'edit-conflict',
            text: 'Codex edited src/shared.ts, which was already edited by Claude in this session.',
            timestamp: 1,
            agentId: 'codex',
            filePath: 'src/shared.ts',
          },
        });
      }),
      cancelAll: vi.fn(),
    };

    registerNativeChatParticipants(
      context as any,
      () => ({ service, workspacePath: '/workspace' } as any),
    );

    const handler = vscodeMocks.participantHandlers.get('veyra.veyra');
    const response = { markdown: vi.fn(), progress: vi.fn(), reference: vi.fn() };
    await handler!(
      { prompt: 'run this', command: undefined },
      {},
      response,
      {
        isCancellationRequested: false,
        onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
      },
    );

    expect(response.markdown).toHaveBeenCalledWith(expect.stringContaining('**Edit conflict:**'));
    expect(response.reference).toHaveBeenCalledTimes(1);
    expect(response.reference.mock.calls[0][0].fsPath.replace(/\\/g, '/')).toBe('/workspace/src/shared.ts');
  });

  it('references the affected workspace file from file-scoped error notices', async () => {
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    const service = {
      dispatch: vi.fn(async (_request, emit) => {
        await emit({
          kind: 'system-message',
          message: {
            id: 'sys1',
            role: 'system',
            kind: 'error',
            text: 'Read-only workflow violation: Claude edited src/review.ts during a read-only dispatch.',
            timestamp: 1,
            agentId: 'claude',
            filePath: 'src/review.ts',
          },
        });
      }),
      cancelAll: vi.fn(),
    };

    registerNativeChatParticipants(
      context as any,
      () => ({ service, workspacePath: '/workspace' } as any),
    );

    const handler = vscodeMocks.participantHandlers.get('veyra.veyra');
    const response = { markdown: vi.fn(), progress: vi.fn(), reference: vi.fn() };
    await handler!(
      { prompt: 'review this', command: undefined },
      {},
      response,
      cancellationToken(),
    );

    expect(response.reference).toHaveBeenCalledTimes(1);
    expect(response.reference.mock.calls[0][0].fsPath.replace(/\\/g, '/')).toBe('/workspace/src/review.ts');
    expect(response.markdown).toHaveBeenCalledWith(expect.stringContaining('Read-only workflow violation'));
  });

  it('does not fail the whole native chat result for pre-agent attachment warnings', async () => {
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    const service = {
      dispatch: vi.fn(async (_request, emit) => {
        await emit({
          kind: 'system-message',
          message: {
            id: 'sys1',
            role: 'system',
            kind: 'error',
            text: 'c:/Users/jford/.claude/CLAUDE.md: Path escapes workspace',
            timestamp: 1,
            filePath: 'c:/Users/jford/.claude/CLAUDE.md',
          },
        });
        await emit({
          kind: 'chunk',
          agentId: 'codex',
          chunk: { type: 'text', text: 'Codex still completed the debate.' },
          timestamp: 2,
        });
      }),
      cancelAll: vi.fn(),
    };

    registerNativeChatParticipants(
      context as any,
      () => ({ service, workspacePath: '/workspace' } as any),
    );

    const handler = vscodeMocks.participantHandlers.get('veyra.veyra');
    const response = { markdown: vi.fn(), progress: vi.fn(), reference: vi.fn() };
    const result = await handler!(
      { prompt: 'debate this', command: 'debate', references: [], toolReferences: [] },
      {},
      response,
      cancellationToken(),
    );

    expect(response.markdown).toHaveBeenCalledWith(expect.stringContaining('Path escapes workspace'));
    expect(response.markdown).toHaveBeenCalledWith('Codex still completed the debate.');
    expect(result).not.toHaveProperty('errorDetails');
  });

  it('offers the setup guide from native chat routing-needed messages', async () => {
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    const service = {
      dispatch: vi.fn(async (_request, emit) => {
        await emit({
          kind: 'system-message',
          message: {
            id: 'sys1',
            role: 'system',
            kind: 'routing-needed',
            text: 'Codex is unauthenticated. Run `codex login`. You can also run Veyra: Show setup guide.',
            timestamp: 1,
          },
        });
      }),
      cancelAll: vi.fn(),
    };

    registerNativeChatParticipants(
      context as any,
      () => ({ service, workspacePath: '/workspace' } as any),
    );

    const handler = vscodeMocks.participantHandlers.get('veyra.veyra');
    const response = { markdown: vi.fn(), progress: vi.fn(), reference: vi.fn(), button: vi.fn() };
    await handler!(
      { prompt: 'implement this', command: undefined },
      {},
      response,
      cancellationToken(),
    );

    expect(response.markdown).toHaveBeenCalledWith('Codex is unauthenticated. Run `codex login`. You can also run Veyra: Show setup guide.');
    expect(response.button).toHaveBeenCalledWith({
      command: 'veyra.showSetupGuide',
      title: 'Open setup guide',
    });
    expect(response.button).toHaveBeenCalledWith({
      command: 'veyra.showLiveValidationGuide',
      title: 'Open live validation guide',
    });
  });

  it('offers CLI path configuration from native chat routing-needed messages', async () => {
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    const service = {
      dispatch: vi.fn(async (_request, emit) => {
        await emit({
          kind: 'system-message',
          message: {
            id: 'sys1',
            role: 'system',
            kind: 'routing-needed',
            text: 'Codex files are inaccessible. You can also run Veyra: Configure Codex/Gemini CLI paths, Veyra: Show setup guide, or Veyra: Show live validation guide.',
            timestamp: 1,
          },
        });
      }),
      cancelAll: vi.fn(),
    };

    registerNativeChatParticipants(
      context as any,
      () => ({ service, workspacePath: '/workspace' } as any),
    );

    const handler = vscodeMocks.participantHandlers.get('veyra.veyra');
    const response = { markdown: vi.fn(), progress: vi.fn(), reference: vi.fn(), button: vi.fn() };
    await handler!(
      { prompt: 'implement this', command: undefined },
      {},
      response,
      cancellationToken(),
    );

    expect(response.button).toHaveBeenCalledWith({
      command: 'veyra.configureCliPaths',
      title: 'Configure CLI paths',
    });
  });

  it('offers pending change-set commands from native chat notices', async () => {
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    const service = {
      dispatch: vi.fn(async (_request, emit) => {
        await emit({
          kind: 'system-message',
          message: {
            id: 'sys1',
            role: 'system',
            kind: 'change-set',
            text: 'Codex changed 2 files. Review pending changes before continuing.',
            timestamp: 1,
            agentId: 'codex',
            changeSet: {
              id: 'change-set-1',
              agentId: 'codex',
              messageId: 'msg1',
              timestamp: 1,
              readOnly: false,
              status: 'pending',
              fileCount: 2,
              files: [
                { path: 'src/a.ts', changeKind: 'edited' },
                { path: 'src/b.ts', changeKind: 'created' },
              ],
            },
          },
        });
      }),
      cancelAll: vi.fn(),
    };

    registerNativeChatParticipants(
      context as any,
      () => ({ service, workspacePath: '/workspace' } as any),
    );

    const handler = vscodeMocks.participantHandlers.get('veyra.veyra');
    const response = { markdown: vi.fn(), progress: vi.fn(), reference: vi.fn(), button: vi.fn() };
    await handler!(
      { prompt: 'implement this', command: undefined },
      {},
      response,
      cancellationToken(),
    );

    expect(response.markdown).toHaveBeenCalledWith(expect.stringContaining('Codex changed 2 files'));
    expect(response.button).toHaveBeenCalledWith({
      command: 'veyra.openPendingChanges',
      title: 'Open pending changes',
      arguments: ['change-set-1'],
    });
    expect(response.button).toHaveBeenCalledWith({
      command: 'veyra.acceptPendingChanges',
      title: 'Accept pending changes',
      arguments: ['change-set-1'],
    });
    expect(response.button).toHaveBeenCalledWith({
      command: 'veyra.rejectPendingChanges',
      title: 'Reject pending changes',
      arguments: ['change-set-1'],
    });
  });

  it('renders checkpoint notices in native chat', async () => {
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    const service = {
      dispatch: vi.fn(async (_request, emit) => {
        await emit({
          kind: 'system-message',
          message: {
            id: 'sys1',
            role: 'system',
            kind: 'checkpoint',
            text: 'Checkpoint saved: Before Codex dispatch.',
            timestamp: 1,
            agentId: 'codex',
            checkpoint: {
              id: 'checkpoint-1',
              timestamp: 1,
              source: 'automatic',
              label: 'Before Codex dispatch',
              promptSummary: '@codex edit',
              status: 'available',
              fileCount: 1,
            },
          },
        });
      }),
      cancelAll: vi.fn(),
    };

    registerNativeChatParticipants(
      context as any,
      () => ({ service, workspacePath: '/workspace' } as any),
    );

    const handler = vscodeMocks.participantHandlers.get('veyra.veyra');
    const response = { markdown: vi.fn(), progress: vi.fn(), reference: vi.fn() };
    await handler!(
      { prompt: 'implement this', command: undefined },
      {},
      response,
      cancellationToken(),
    );

    expect(response.markdown).toHaveBeenCalledWith(expect.stringContaining('Checkpoint saved: Before Codex dispatch.'));
    expect(response.markdown).not.toHaveBeenCalledWith('_No text response._');
  });

  it('does not append no-output fallback when a file edit was surfaced', async () => {
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    const service = {
      dispatch: vi.fn(async (_request, emit) => {
        await emit({
          kind: 'file-edited',
          agentId: 'codex',
          path: 'src/generated.ts',
          timestamp: 1,
        });
      }),
      cancelAll: vi.fn(),
    };

    registerNativeChatParticipants(
      context as any,
      () => ({ service, workspacePath: '/workspace' } as any),
    );

    const handler = vscodeMocks.participantHandlers.get('veyra.veyra');
    const response = { markdown: vi.fn(), progress: vi.fn(), reference: vi.fn() };
    await handler!(
      { prompt: 'make a tiny edit', command: undefined },
      {},
      response,
      {
        isCancellationRequested: false,
        onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
      },
    );

    expect(response.reference).toHaveBeenCalledTimes(1);
    expect(response.reference.mock.calls[0][0].fsPath.replace(/\\/g, '/')).toBe('/workspace/src/generated.ts');
    expect(response.progress).toHaveBeenCalledWith('Codex edited src/generated.ts');
    expect(response.markdown).not.toHaveBeenCalledWith('_No text response._');
  });

  it('labels deleted files in native chat file activity', async () => {
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    const service = {
      dispatch: vi.fn(async (_request, emit) => {
        await emit({
          kind: 'file-edited',
          agentId: 'codex',
          path: 'src/removed.ts',
          changeKind: 'deleted',
          timestamp: 1,
        });
      }),
      cancelAll: vi.fn(),
    };

    registerNativeChatParticipants(
      context as any,
      () => ({ service, workspacePath: '/workspace' } as any),
    );

    const handler = vscodeMocks.participantHandlers.get('veyra.veyra');
    const response = { markdown: vi.fn(), progress: vi.fn(), reference: vi.fn() };
    await handler!(
      { prompt: 'remove obsolete file', command: undefined },
      {},
      response,
      cancellationToken(),
    );

    expect(response.progress).toHaveBeenCalledWith('Codex deleted src/removed.ts');
    expect(response.markdown).not.toHaveBeenCalledWith('_No text response._');
  });

  it('labels created files in native chat file activity', async () => {
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    const service = {
      dispatch: vi.fn(async (_request, emit) => {
        await emit({
          kind: 'file-edited',
          agentId: 'gemini',
          path: 'src/new.ts',
          changeKind: 'created',
          timestamp: 1,
        });
      }),
      cancelAll: vi.fn(),
    };

    registerNativeChatParticipants(
      context as any,
      () => ({ service, workspacePath: '/workspace' } as any),
    );

    const handler = vscodeMocks.participantHandlers.get('veyra.veyra');
    const response = { markdown: vi.fn(), progress: vi.fn(), reference: vi.fn() };
    await handler!(
      { prompt: 'create a file', command: undefined },
      {},
      response,
      cancellationToken(),
    );

    expect(response.progress).toHaveBeenCalledWith('Gemini created src/new.ts');
  });

  it('surfaces tool-only native chat activity instead of no-output fallback', async () => {
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    const service = {
      dispatch: vi.fn(async (_request, emit) => {
        await emit({
          kind: 'chunk',
          agentId: 'codex',
          chunk: { type: 'tool-call', name: 'shell', input: { command: 'npm test' } },
          timestamp: 1,
        });
        await emit({
          kind: 'chunk',
          agentId: 'codex',
          chunk: { type: 'tool-result', name: 'shell', output: 'tests passed' },
          timestamp: 2,
        });
      }),
      cancelAll: vi.fn(),
    };

    registerNativeChatParticipants(
      context as any,
      () => ({ service, workspacePath: '/workspace' } as any),
    );

    const handler = vscodeMocks.participantHandlers.get('veyra.veyra');
    const response = { markdown: vi.fn(), progress: vi.fn(), reference: vi.fn() };
    await handler!(
      { prompt: 'run tests', command: undefined },
      {},
      response,
      cancellationToken(),
    );

    expect(response.progress).toHaveBeenCalledWith('Codex: shell');
    expect(response.markdown).toHaveBeenCalledWith('\n\n_Codex used shell: npm test_');
    expect(response.markdown).toHaveBeenCalledWith('\n\n_Codex shell result: tests passed_');
    expect(response.markdown).not.toHaveBeenCalledWith('_No text response._');
  });

  it('surfaces notebook paths in native chat tool activity', async () => {
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    const service = {
      dispatch: vi.fn(async (_request, emit) => {
        await emit({
          kind: 'chunk',
          agentId: 'claude',
          chunk: { type: 'tool-call', name: 'NotebookEdit', input: { notebook_path: 'notebooks/analysis.ipynb' } },
          timestamp: 1,
        });
      }),
      cancelAll: vi.fn(),
    };

    registerNativeChatParticipants(
      context as any,
      () => ({ service, workspacePath: '/workspace' } as any),
    );

    const handler = vscodeMocks.participantHandlers.get('veyra.veyra');
    const response = { markdown: vi.fn(), progress: vi.fn(), reference: vi.fn() };
    await handler!(
      { prompt: 'update the notebook', command: undefined },
      {},
      response,
      cancellationToken(),
    );

    expect(response.markdown).toHaveBeenCalledWith('\n\n_Claude used NotebookEdit: notebooks/analysis.ipynb_');
    expect(response.markdown).not.toHaveBeenCalledWith('_No text response._');
  });

  it('hides raw native chat tool activity when configured while keeping file edits visible', async () => {
    vscodeMocks.toolCallRenderStyle = 'hidden';
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    const service = {
      dispatch: vi.fn(async (_request, emit) => {
        await emit({
          kind: 'chunk',
          agentId: 'codex',
          chunk: { type: 'tool-call', name: 'shell', input: { command: 'npm test' } },
          timestamp: 1,
        });
        await emit({
          kind: 'file-edited',
          agentId: 'codex',
          path: 'src/generated.ts',
          changeKind: 'created',
          timestamp: 2,
        });
        await emit({
          kind: 'chunk',
          agentId: 'codex',
          chunk: { type: 'tool-result', name: 'shell', output: 'tests passed' },
          timestamp: 3,
        });
      }),
      cancelAll: vi.fn(),
    };

    registerNativeChatParticipants(
      context as any,
      () => ({ service, workspacePath: '/workspace' } as any),
    );

    const handler = vscodeMocks.participantHandlers.get('veyra.veyra');
    const response = { markdown: vi.fn(), progress: vi.fn(), reference: vi.fn() };
    await handler!(
      { prompt: 'run tests and create file', command: undefined },
      {},
      response,
      cancellationToken(),
    );

    expect(response.progress).not.toHaveBeenCalledWith('Codex: shell');
    expect(response.markdown).not.toHaveBeenCalledWith('\n\n_Codex used shell: npm test_');
    expect(response.markdown).not.toHaveBeenCalledWith('\n\n_Codex shell result: tests passed_');
    expect(response.progress).toHaveBeenCalledWith('Codex created src/generated.ts');
    expect(response.reference.mock.calls[0][0].fsPath.replace(/\\/g, '/')).toBe('/workspace/src/generated.ts');
    expect(response.markdown).not.toHaveBeenCalledWith('_No text response._');
  });

  it('shows the no-output fallback when hidden native chat tool activity is the only output', async () => {
    vscodeMocks.toolCallRenderStyle = 'hidden';
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    const service = {
      dispatch: vi.fn(async (_request, emit) => {
        await emit({
          kind: 'chunk',
          agentId: 'codex',
          chunk: { type: 'tool-call', name: 'shell', input: { command: 'npm test' } },
          timestamp: 1,
        });
        await emit({
          kind: 'chunk',
          agentId: 'codex',
          chunk: { type: 'tool-result', name: 'shell', output: 'tests passed' },
          timestamp: 2,
        });
      }),
      cancelAll: vi.fn(),
    };

    registerNativeChatParticipants(
      context as any,
      () => ({ service, workspacePath: '/workspace' } as any),
    );

    const handler = vscodeMocks.participantHandlers.get('veyra.veyra');
    const response = { markdown: vi.fn(), progress: vi.fn(), reference: vi.fn() };
    await handler!(
      { prompt: 'run tests', command: undefined },
      {},
      response,
      cancellationToken(),
    );

    expect(response.progress).not.toHaveBeenCalledWith('Codex: shell');
    expect(response.markdown).not.toHaveBeenCalledWith('\n\n_Codex used shell: npm test_');
    expect(response.markdown).not.toHaveBeenCalledWith('\n\n_Codex shell result: tests passed_');
    expect(response.markdown).toHaveBeenCalledWith('_No text response._');
  });
});
