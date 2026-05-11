import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VeyraSessionService, toRoutedInput } from '../src/veyraService.js';
import type { Agent } from '../src/agents/types.js';
import type { AgentChunk, AgentId } from '../src/types.js';
import type { WorkspaceContextProvider, WorkspaceContextResult } from '../src/workspaceContext.js';

describe('toRoutedInput', () => {
  it('leaves text unchanged when routing through Veyra', () => {
    expect(toRoutedInput('review this', 'veyra')).toBe('review this');
  });

  it('leaves text unchanged when no forced target is provided', () => {
    expect(toRoutedInput('@codex review this')).toBe('@codex review this');
  });

  it('prefixes direct participant text with the forced agent mention', () => {
    expect(toRoutedInput('review this', 'claude')).toBe('@claude review this');
    expect(toRoutedInput('review this', 'codex')).toBe('@codex review this');
    expect(toRoutedInput('review this', 'gemini')).toBe('@gemini review this');
  });

  it('strips leading mentions before applying a forced direct participant', () => {
    expect(toRoutedInput('@codex review this', 'claude')).toBe('@claude review this');
    expect(toRoutedInput('@all review this', 'gemini')).toBe('@gemini review this');
  });
});

describe('VeyraSessionService', () => {
  it('retrieves @codebase context and includes it in direct agent prompts', async () => {
    let codexPrompt = '';
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));
    const workspaceContextProvider = fakeWorkspaceContextProvider([
      '[Workspace context from @codebase]',
      'Selected files:',
      '- src/auth/session.ts',
      '[/Workspace context]',
    ].join('\n'));
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: agentNoop('claude'),
        codex: {
          id: 'codex',
          status: async () => 'ready',
          cancel: async () => {},
          async *send(prompt: string) {
            codexPrompt = prompt;
            yield { type: 'done' } as AgentChunk;
          },
        },
        gemini: agentNoop('gemini'),
      },
      { hangSeconds: 0, workspaceContextProvider: workspaceContextProvider as WorkspaceContextProvider },
    );

    const events: any[] = [];
    await service.dispatch(
      { text: '@codex review @codebase auth flow', source: 'native-chat', cwd: workspacePath },
      (event) => {
        events.push(event);
      },
    );

    expect(workspaceContextProvider.retrieve).toHaveBeenCalledWith('review auth flow');
    expect(codexPrompt).toContain('[Workspace context from @codebase]');
    expect(codexPrompt).toContain('- src/auth/session.ts');
    expect(codexPrompt).not.toContain('review @codebase auth flow');
    const userMessage = events.find((event) => event.kind === 'user-message')?.message;
    expect(userMessage.attachedFiles).toEqual([{ path: 'src/auth/session.ts', lines: 4, truncated: true }]);
  });

  it('shares the same retrieved @codebase context across all agents in one workflow', async () => {
    const prompts = new Map<AgentId, string>();
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));
    const workspaceContextProvider = fakeWorkspaceContextProvider([
      '[Workspace context from @codebase]',
      'Selected files:',
      '- src/shared/router.ts',
      '[/Workspace context]',
    ].join('\n'));
    const agent = (id: AgentId): Agent => ({
      id,
      status: async () => 'ready',
      cancel: async () => {},
      async *send(prompt: string) {
        prompts.set(id, prompt);
        yield { type: 'done' } as AgentChunk;
      },
    });
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: agent('claude'),
        codex: agent('codex'),
        gemini: agent('gemini'),
      },
      { hangSeconds: 0, workspaceContextProvider: workspaceContextProvider as WorkspaceContextProvider },
    );

    await service.dispatch(
      { text: '@all debate @codebase routing design', source: 'panel', cwd: workspacePath },
      () => {},
    );

    expect(workspaceContextProvider.retrieve).toHaveBeenCalledTimes(1);
    expect(workspaceContextProvider.retrieve).toHaveBeenCalledWith('debate routing design');
    expect(prompts.get('claude')).toContain('src/shared/router.ts');
    expect(prompts.get('codex')).toContain('src/shared/router.ts');
    expect(prompts.get('gemini')).toContain('src/shared/router.ts');
  });

  it('orders retrieved @codebase attachments before explicit file attachments', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));
    fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspacePath, 'src', 'explicit.ts'), 'export const explicit = true;\n');
    const workspaceContextProvider = fakeWorkspaceContextProvider([
      '[Workspace context from @codebase]',
      'Selected files:',
      '- src/auth/session.ts',
      '[/Workspace context]',
    ].join('\n'));
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: agentNoop('claude'),
        codex: {
          id: 'codex',
          status: async () => 'ready',
          cancel: async () => {},
          async *send() {
            yield { type: 'done' } as AgentChunk;
          },
        },
        gemini: agentNoop('gemini'),
      },
      { hangSeconds: 0, workspaceContextProvider: workspaceContextProvider as WorkspaceContextProvider },
    );

    const events: any[] = [];
    await service.dispatch(
      { text: '@codex review @codebase auth flow @src/explicit.ts', source: 'native-chat', cwd: workspacePath },
      (event) => {
        events.push(event);
      },
    );

    const userMessage = events.find((event) => event.kind === 'user-message')?.message;
    expect(userMessage.attachedFiles).toEqual([
      { path: 'src/auth/session.ts', lines: 4, truncated: true },
      { path: 'src/explicit.ts', lines: 1, truncated: false },
    ]);
  });

  it('deduplicates retrieved and explicit attachments by path', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));
    fs.mkdirSync(path.join(workspacePath, 'src', 'auth'), { recursive: true });
    fs.writeFileSync(path.join(workspacePath, 'src', 'auth', 'session.ts'), 'export const session = true;\n');
    const workspaceContextProvider = fakeWorkspaceContextProvider([
      '[Workspace context from @codebase]',
      'Selected files:',
      '- src/auth/session.ts',
      '[/Workspace context]',
    ].join('\n'));
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: agentNoop('claude'),
        codex: {
          id: 'codex',
          status: async () => 'ready',
          cancel: async () => {},
          async *send() {
            yield { type: 'done' } as AgentChunk;
          },
        },
        gemini: agentNoop('gemini'),
      },
      { hangSeconds: 0, workspaceContextProvider: workspaceContextProvider as WorkspaceContextProvider },
    );

    const events: any[] = [];
    await service.dispatch(
      { text: '@codex review @codebase auth flow @src/auth/session.ts', source: 'native-chat', cwd: workspacePath },
      (event) => {
        events.push(event);
      },
    );

    const userMessage = events.find((event) => event.kind === 'user-message')?.message;
    expect(userMessage.attachedFiles).toEqual([
      { path: 'src/auth/session.ts', lines: 4, truncated: true },
    ]);
  });

  it('emits a workspace context error and still dispatches when @codebase provider is unavailable', async () => {
    let codexStarted = false;
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: agentNoop('claude'),
        codex: {
          id: 'codex',
          status: async () => 'ready',
          cancel: async () => {},
          async *send() {
            codexStarted = true;
            yield { type: 'done' } as AgentChunk;
          },
        },
        gemini: agentNoop('gemini'),
      },
      { hangSeconds: 0 },
    );

    const events: any[] = [];
    await service.dispatch(
      { text: '@codex review @codebase auth flow', source: 'native-chat', cwd: workspacePath },
      (event) => {
        events.push(event);
      },
    );

    expect(codexStarted).toBe(true);
    const userIndex = events.findIndex((event) => event.kind === 'user-message');
    const diagnosticIndex = events.findIndex((event) =>
      event.kind === 'system-message' &&
      event.message.kind === 'error' &&
      event.message.text.includes('Workspace context') &&
      event.message.text.includes('@codebase') &&
      event.message.text.includes('unavailable')
    );
    expect(userIndex).toBeGreaterThanOrEqual(0);
    expect(diagnosticIndex).toBeGreaterThan(userIndex);
  });

  it('emits a workspace context error and still dispatches when @codebase retrieval fails', async () => {
    let codexStarted = false;
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));
    const workspaceContextProvider: Pick<WorkspaceContextProvider, 'retrieve' | 'invalidate'> = {
      invalidate: vi.fn(),
      retrieve: vi.fn(async () => {
        throw new Error('index unavailable');
      }),
    };
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: agentNoop('claude'),
        codex: {
          id: 'codex',
          status: async () => 'ready',
          cancel: async () => {},
          async *send() {
            codexStarted = true;
            yield { type: 'done' } as AgentChunk;
          },
        },
        gemini: agentNoop('gemini'),
      },
      { hangSeconds: 0, workspaceContextProvider: workspaceContextProvider as WorkspaceContextProvider },
    );

    const events: any[] = [];
    await service.dispatch(
      { text: '@codex review @codebase auth flow', source: 'native-chat', cwd: workspacePath },
      (event) => {
        events.push(event);
      },
    );

    expect(codexStarted).toBe(true);
    expect(events.find((event) => event.kind === 'user-message')).toBeDefined();
    const diagnostic = events.find((event) =>
      event.kind === 'system-message' &&
      event.message.kind === 'error' &&
      event.message.text.includes('Workspace context') &&
      event.message.text.includes('@codebase') &&
      event.message.text.includes('index unavailable')
    );
    expect(diagnostic).toBeDefined();
  });

  it('emits successful @codebase diagnostics and still dispatches when no files match', async () => {
    let codexStarted = false;
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));
    const workspaceContextProvider = fakeWorkspaceContextProvider('', {
      attached: [],
      selected: [],
      diagnostics: ['No workspace files matched @codebase query.'],
    });
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: agentNoop('claude'),
        codex: {
          id: 'codex',
          status: async () => 'ready',
          cancel: async () => {},
          async *send() {
            codexStarted = true;
            yield { type: 'done' } as AgentChunk;
          },
        },
        gemini: agentNoop('gemini'),
      },
      { hangSeconds: 0, workspaceContextProvider: workspaceContextProvider as WorkspaceContextProvider },
    );

    const events: any[] = [];
    await service.dispatch(
      { text: '@codex review @codebase auth flow', source: 'native-chat', cwd: workspacePath },
      (event) => {
        events.push(event);
      },
    );

    expect(codexStarted).toBe(true);
    const diagnostic = events.find((event) =>
      event.kind === 'system-message' &&
      event.message.kind === 'error' &&
      event.message.text.includes('Workspace context') &&
      event.message.text.includes('@codebase') &&
      event.message.text.includes('No workspace files matched @codebase query.')
    );
    expect(diagnostic).toBeDefined();
  });

  it('passes prior agent edit summaries to later agents during @all dispatch', async () => {
    const prompts = new Map<AgentId, string>();
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));

    const agent = (id: AgentId, chunks: AgentChunk[]): Agent => ({
      id,
      status: async () => 'ready',
      cancel: async () => {},
      async *send(prompt: string) {
        prompts.set(id, prompt);
        for (const chunk of chunks) yield chunk;
      },
    });

    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: agent('claude', [
          { type: 'tool-call', name: 'edit-file', input: { path: 'src/a.ts' } },
          { type: 'tool-result', name: 'edit-file', output: 'ok' },
          { type: 'done' },
        ]),
        codex: agent('codex', [{ type: 'done' }]),
        gemini: agent('gemini', [{ type: 'done' }]),
      },
      {
        getEditedPathForAgent: (_agentId, _toolName, input) => {
          if (typeof input === 'object' && input && 'path' in input) {
            return String(input.path);
          }
          return null;
        },
      },
    );

    await service.dispatch(
      { text: '@all update this', source: 'panel', cwd: workspacePath },
      () => {},
    );

    expect(prompts.get('codex')).toContain('[Edit coordination]');
    expect(prompts.get('codex')).toContain('src/a.ts edited by claude');
  });

  it('tells each targeted agent which Veyra role it is fulfilling', async () => {
    const prompts = new Map<AgentId, string>();
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));
    const agent = (id: AgentId): Agent => ({
      id,
      status: async () => 'ready',
      cancel: async () => {},
      async *send(prompt: string) {
        prompts.set(id, prompt);
        yield { type: 'done' } as AgentChunk;
      },
    });
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: agent('claude'),
        codex: agent('codex'),
        gemini: agent('gemini'),
      },
      { hangSeconds: 0 },
    );

    await service.dispatch(
      { text: '@all coordinate this', source: 'panel', cwd: workspacePath },
      () => {},
    );

    expect(prompts.get('claude')).toContain('You are Claude in this Veyra dispatch.');
    expect(prompts.get('codex')).toContain('You are Codex in this Veyra dispatch.');
    expect(prompts.get('gemini')).toContain('You are Gemini in this Veyra dispatch.');
    for (const prompt of prompts.values()) {
      expect(prompt).toContain('Use your available model and CLI capabilities that fit this workflow.');
      expect(prompt).toContain('Follow any read-only or edit-permitted instructions in this prompt.');
    }
  });

  it('forwards readOnly dispatches to every targeted agent send call', async () => {
    const optionsByAgent = new Map<AgentId, unknown>();
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));
    const agent = (id: AgentId): Agent => ({
      id,
      status: async () => 'ready',
      cancel: async () => {},
      async *send(_prompt: string, opts) {
        optionsByAgent.set(id, opts);
        yield { type: 'done' } as AgentChunk;
      },
    });
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: agent('claude'),
        codex: agent('codex'),
        gemini: agent('gemini'),
      },
      { hangSeconds: 0 },
    );

    await service.dispatch(
      { text: '@all review this', source: 'native-chat', cwd: workspacePath, readOnly: true },
      () => {},
    );

    expect(optionsByAgent.get('claude')).toMatchObject({ readOnly: true });
    expect(optionsByAgent.get('codex')).toMatchObject({ readOnly: true });
    expect(optionsByAgent.get('gemini')).toMatchObject({ readOnly: true });
  });

  it('emits a read-only violation when a read-only dispatch edits a file', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: {
          id: 'claude',
          status: async () => 'ready',
          cancel: async () => {},
          async *send() {
            yield { type: 'tool-call', name: 'Edit', input: { file_path: 'src/review.ts' } } as AgentChunk;
            yield { type: 'tool-result', name: 'Edit', output: 'ok' } as AgentChunk;
            yield { type: 'done' } as AgentChunk;
          },
        },
        codex: agentNoop('codex'),
        gemini: agentNoop('gemini'),
      },
      {
        hangSeconds: 0,
        getEditedPathForAgent: (_agentId, _toolName, input) => {
          if (typeof input === 'object' && input && 'file_path' in input) {
            return String(input.file_path);
          }
          return null;
        },
      },
    );

    const events: any[] = [];
    await service.dispatch(
      { text: '@claude review this', source: 'native-chat', cwd: workspacePath, readOnly: true },
      (event) => {
        events.push(event);
      },
    );

    const warning = events.find((event) =>
      event.kind === 'system-message' &&
      event.message.kind === 'error' &&
      event.message.text.includes('read-only') &&
      event.message.text.includes('src/review.ts'),
    );
    expect(warning?.message).toMatchObject({
      agentId: 'claude',
      filePath: 'src/review.ts',
    });
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'file-edited',
      agentId: 'claude',
      path: 'src/review.ts',
    }));
  });

  it('stops registering file badge edits after the badge controller is removed from options', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));
    const badgeController = { registerEdit: vi.fn() };
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: {
          id: 'claude',
          status: async () => 'ready',
          cancel: async () => {},
          async *send() {
            yield { type: 'tool-call', name: 'Edit', input: { file_path: 'src/toggle.ts' } } as AgentChunk;
            yield { type: 'tool-result', name: 'Edit', output: 'ok' } as AgentChunk;
            yield { type: 'done' } as AgentChunk;
          },
        },
        codex: agentNoop('codex'),
        gemini: agentNoop('gemini'),
      },
      {
        hangSeconds: 0,
        badgeController: badgeController as any,
        getEditedPathForAgent: (_agentId, _toolName, input) => {
          if (typeof input === 'object' && input && 'file_path' in input) {
            return String(input.file_path);
          }
          return null;
        },
      },
    );

    service.updateOptions({ badgeController: undefined });
    await service.dispatch(
      { text: '@claude update this', source: 'native-chat', cwd: workspacePath },
      () => {},
    );

    expect(badgeController.registerEdit).not.toHaveBeenCalled();
  });

  it('persists forced direct participant routing so later context keeps the target', async () => {
    let codexPrompt = '';
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: agentNoop('claude'),
        codex: {
          id: 'codex',
          status: async () => 'ready',
          cancel: async () => {},
          async *send(prompt: string) {
            codexPrompt = prompt;
            yield { type: 'done' } as AgentChunk;
          },
        },
        gemini: agentNoop('gemini'),
      },
      { hangSeconds: 0 },
    );

    const events: any[] = [];
    await service.dispatch(
      { text: 'review this without a mention', source: 'native-chat', cwd: workspacePath, forcedTarget: 'codex' },
      (event) => {
        events.push(event);
      },
    );

    const userMessage = events.find((event) => event.kind === 'user-message')?.message;
    expect(userMessage.mentions).toEqual(['codex']);
    expect(codexPrompt).toContain('[Autonomy policy]');
    expect(codexPrompt).toContain('reasonable assumptions');
    expect(codexPrompt).toContain('user -> codex: review this without a mention');
  });

  it('includes file attachment failures in the agent prompt', async () => {
    let claudePrompt = '';
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: {
          id: 'claude',
          status: async () => 'ready',
          cancel: async () => {},
          async *send(prompt: string) {
            claudePrompt = prompt;
            yield { type: 'done' } as AgentChunk;
          },
        },
        codex: agentNoop('codex'),
        gemini: agentNoop('gemini'),
      },
      { hangSeconds: 0 },
    );

    const events: any[] = [];
    await service.dispatch(
      { text: '@claude review @missing.ts', source: 'panel', cwd: workspacePath },
      (event) => {
        events.push(event);
      },
    );

    expect(claudePrompt).toContain('[File attachment problems]');
    expect(claudePrompt).toContain('- missing.ts: File not found');
    const systemError = events.find((event) =>
      event.kind === 'system-message' &&
      event.message.kind === 'error' &&
      event.message.text === 'missing.ts: File not found',
    );
    expect(systemError).toBeDefined();
  });

  it('carries file attachment failures into later shared context without repeating raw mentions', async () => {
    let codexPrompt = '';
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: {
          id: 'claude',
          status: async () => 'ready',
          cancel: async () => {},
          async *send() {
            yield { type: 'done' } as AgentChunk;
          },
        },
        codex: {
          id: 'codex',
          status: async () => 'ready',
          cancel: async () => {},
          async *send(prompt: string) {
            codexPrompt = prompt;
            yield { type: 'done' } as AgentChunk;
          },
        },
        gemini: agentNoop('gemini'),
      },
      { hangSeconds: 0 },
    );

    await service.dispatch(
      { text: '@claude review @missing.ts', source: 'panel', cwd: workspacePath },
      () => {},
    );
    await service.dispatch(
      { text: '@codex continue from the prior attachment issue', source: 'panel', cwd: workspacePath },
      () => {},
    );

    expect(codexPrompt).toContain('system error: missing.ts: File not found');
    expect(codexPrompt).toContain('user -> claude: review');
    expect(codexPrompt).not.toContain('@missing.ts');
  });

  it('preserves multiline prompt shape while attaching inline-code file mentions', async () => {
    let claudePrompt = '';
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));
    fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspacePath, 'src', 'auth.ts'), 'export const auth = true;\n');
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: {
          id: 'claude',
          status: async () => 'ready',
          cancel: async () => {},
          async *send(prompt: string) {
            claudePrompt = prompt;
            yield { type: 'done' } as AgentChunk;
          },
        },
        codex: agentNoop('codex'),
        gemini: agentNoop('gemini'),
      },
      { hangSeconds: 0 },
    );

    const events: any[] = [];
    await service.dispatch(
      {
        text: [
          '@claude review `@src/auth.ts`',
          '',
          'Keep this checklist shape:',
          '  - preserve indentation',
          '  - do not flatten blank lines',
        ].join('\n'),
        source: 'native-chat',
        cwd: workspacePath,
      },
      (event) => {
        events.push(event);
      },
    );

    const userMessage = events.find((event) => event.kind === 'user-message')?.message;
    expect(userMessage.attachedFiles).toEqual([{ path: 'src/auth.ts', lines: 1, truncated: false }]);
    expect(claudePrompt).toContain('[File: src/auth.ts]');
    expect(claudePrompt).toContain('export const auth = true;');
    expect(claudePrompt).toContain([
      'review',
      '',
      'Keep this checklist shape:',
      '  - preserve indentation',
      '  - do not flatten blank lines',
    ].join('\n'));
    expect(claudePrompt).not.toContain('`@src/auth.ts`');
  });

  it('surfaces files changed during an agent turn even without reported write tools', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));
    const tracker = {
      snapshot: vi.fn().mockResolvedValue('before-turn'),
      changedFilesSince: vi.fn().mockResolvedValue(['src/invisible.ts']),
    };
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: {
          id: 'claude',
          status: async () => 'ready',
          cancel: async () => {},
          async *send() {
            yield { type: 'text', text: 'changed it' } as AgentChunk;
            yield { type: 'done' } as AgentChunk;
          },
        },
        codex: agentNoop('codex'),
        gemini: agentNoop('gemini'),
      },
      { workspaceChangeTracker: tracker },
    );

    const events: any[] = [];
    await service.dispatch(
      { text: '@claude update this', source: 'panel', cwd: workspacePath },
      (event) => {
        events.push(event);
      },
    );

    expect(tracker.snapshot).toHaveBeenCalledTimes(1);
    expect(tracker.changedFilesSince).toHaveBeenCalledWith('before-turn');
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'file-edited',
      path: 'src/invisible.ts',
      agentId: 'claude',
    }));
    const finalized = events.find((event) => event.kind === 'dispatch-end')?.message;
    expect(finalized.editedFiles).toEqual(['src/invisible.ts']);
  });

  it('marks missing changed files as deleted', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));
    const tracker = {
      snapshot: vi.fn().mockResolvedValue('before-turn'),
      changedFilesSince: vi.fn().mockResolvedValue(['src/removed.ts']),
    };
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: {
          id: 'claude',
          status: async () => 'ready',
          cancel: async () => {},
          async *send() {
            yield { type: 'text', text: 'removed it' } as AgentChunk;
            yield { type: 'done' } as AgentChunk;
          },
        },
        codex: agentNoop('codex'),
        gemini: agentNoop('gemini'),
      },
      { workspaceChangeTracker: tracker },
    );

    const events: any[] = [];
    await service.dispatch(
      { text: '@claude remove this', source: 'panel', cwd: workspacePath },
      (event) => {
        events.push(event);
      },
    );

    expect(events).toContainEqual(expect.objectContaining({
      kind: 'file-edited',
      path: 'src/removed.ts',
      agentId: 'claude',
      changeKind: 'deleted',
    }));
    const finalized = events.find((event) => event.kind === 'dispatch-end')?.message;
    expect(finalized.fileChanges).toEqual([
      { path: 'src/removed.ts', changeKind: 'deleted' },
    ]);
  });

  it('marks newly changed files as created when the tracker provides change details', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));
    const tracker = {
      snapshot: vi.fn().mockResolvedValue('before-turn'),
      changedFilesSince: vi.fn(),
      changedFileChangesSince: vi.fn().mockResolvedValue([
        { path: 'src/new.ts', changeKind: 'created' },
      ]),
    };
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: {
          id: 'claude',
          status: async () => 'ready',
          cancel: async () => {},
          async *send() {
            yield { type: 'text', text: 'created it' } as AgentChunk;
            yield { type: 'done' } as AgentChunk;
          },
        },
        codex: agentNoop('codex'),
        gemini: agentNoop('gemini'),
      },
      { workspaceChangeTracker: tracker },
    );

    const events: any[] = [];
    await service.dispatch(
      { text: '@claude create this', source: 'panel', cwd: workspacePath },
      (event) => {
        events.push(event);
      },
    );

    expect(tracker.changedFilesSince).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'file-edited',
      path: 'src/new.ts',
      agentId: 'claude',
      changeKind: 'created',
    }));
    const finalized = events.find((event) => event.kind === 'dispatch-end')?.message;
    expect(finalized.fileChanges).toEqual([
      { path: 'src/new.ts', changeKind: 'created' },
    ]);
  });

  it('updates a tool-reported generic edit when workspace diff proves a specific change kind', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));
    const tracker = {
      snapshot: vi.fn().mockResolvedValue('before-turn'),
      changedFilesSince: vi.fn(),
      changedFileChangesSince: vi.fn().mockResolvedValue([
        { path: 'src/removed.ts', changeKind: 'deleted' },
      ]),
    };
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: {
          id: 'claude',
          status: async () => 'ready',
          cancel: async () => {},
          async *send() {
            yield { type: 'tool-call', name: 'Edit', input: { path: 'src/removed.ts' } } as AgentChunk;
            yield { type: 'tool-result', name: 'Edit', output: 'ok' } as AgentChunk;
            yield { type: 'done' } as AgentChunk;
          },
        },
        codex: agentNoop('codex'),
        gemini: agentNoop('gemini'),
      },
      {
        workspaceChangeTracker: tracker,
        getEditedPathForAgent: (_agentId, _toolName, input) => {
          if (typeof input === 'object' && input && 'path' in input) {
            return String(input.path);
          }
          return null;
        },
      },
    );

    const events: any[] = [];
    await service.dispatch(
      { text: '@claude remove this', source: 'panel', cwd: workspacePath },
      (event) => {
        events.push(event);
      },
    );

    const editedEvents = events.filter((event) =>
      event.kind === 'file-edited' && event.path === 'src/removed.ts'
    );
    expect(editedEvents.at(-1)).toMatchObject({
      kind: 'file-edited',
      path: 'src/removed.ts',
      agentId: 'claude',
      changeKind: 'deleted',
    });
    const finalized = events.find((event) => event.kind === 'dispatch-end')?.message;
    expect(finalized.fileChanges).toEqual([
      { path: 'src/removed.ts', changeKind: 'deleted' },
    ]);
  });

  it('surfaces workspace change detection failures without losing the agent result', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));
    const sentinelPath = path.join(workspacePath, '.vscode', 'veyra', 'active-dispatch');
    const tracker = {
      snapshot: vi.fn().mockResolvedValue('before-turn'),
      changedFilesSince: vi.fn().mockRejectedValue(new Error('scan failed')),
    };
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: {
          id: 'claude',
          status: async () => 'ready',
          cancel: async () => {},
          async *send() {
            yield { type: 'text', text: 'agent result' } as AgentChunk;
            yield { type: 'done' } as AgentChunk;
          },
        },
        codex: agentNoop('codex'),
        gemini: agentNoop('gemini'),
      },
      { workspaceChangeTracker: tracker },
    );

    const events: any[] = [];
    await service.dispatch(
      { text: '@claude update this', source: 'panel', cwd: workspacePath },
      (event) => {
        events.push(event);
      },
    );

    expect(fs.existsSync(sentinelPath)).toBe(false);
    const systemError = events.find((event) =>
      event.kind === 'system-message' &&
      event.message.kind === 'error' &&
      event.message.text.includes('scan failed'),
    );
    expect(systemError).toBeDefined();
    const finalized = events.find((event) => event.kind === 'dispatch-end')?.message;
    expect(finalized).toMatchObject({
      agentId: 'claude',
      text: 'agent result',
      status: 'complete',
    });
  });

  it('surfaces workspace snapshot failures without losing the agent result', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));
    const sentinelPath = path.join(workspacePath, '.vscode', 'veyra', 'active-dispatch');
    const tracker = {
      snapshot: vi.fn().mockRejectedValue(new Error('snapshot failed')),
      changedFilesSince: vi.fn(),
    };
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: {
          id: 'claude',
          status: async () => 'ready',
          cancel: async () => {},
          async *send() {
            yield { type: 'text', text: 'agent still ran' } as AgentChunk;
            yield { type: 'done' } as AgentChunk;
          },
        },
        codex: agentNoop('codex'),
        gemini: agentNoop('gemini'),
      },
      { workspaceChangeTracker: tracker },
    );

    const events: any[] = [];
    await service.dispatch(
      { text: '@claude update this', source: 'panel', cwd: workspacePath },
      (event) => {
        events.push(event);
      },
    );

    expect(fs.existsSync(sentinelPath)).toBe(false);
    expect(tracker.changedFilesSince).not.toHaveBeenCalled();
    const systemError = events.find((event) =>
      event.kind === 'system-message' &&
      event.message.kind === 'error' &&
      event.message.text.includes('snapshot failed'),
    );
    expect(systemError).toBeDefined();
    const finalized = events.find((event) => event.kind === 'dispatch-end')?.message;
    expect(finalized).toMatchObject({
      agentId: 'claude',
      text: 'agent still ran',
      status: 'complete',
    });
  });

  it('emits an edit conflict notice when a later agent edits a file touched by another agent', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));
    const agent = (id: AgentId): Agent => ({
      id,
      status: async () => 'ready',
      cancel: async () => {},
      async *send() {
        yield { type: 'tool-call', name: 'edit-file', input: { path: 'src/shared.ts' } } as AgentChunk;
        yield { type: 'tool-result', name: 'edit-file', output: 'ok' } as AgentChunk;
        yield { type: 'done' } as AgentChunk;
      },
    });
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: agent('claude'),
        codex: agent('codex'),
        gemini: agentNoop('gemini'),
      },
      {
        getEditedPathForAgent: (_agentId, _toolName, input) => {
          if (typeof input === 'object' && input && 'path' in input) {
            return String(input.path);
          }
          return null;
        },
      },
    );

    const events: any[] = [];
    await service.dispatch(
      { text: '@all update shared code', source: 'panel', cwd: workspacePath },
      (event) => {
        events.push(event);
      },
    );

    const conflict = events.find((event) =>
      event.kind === 'system-message' &&
      event.message.kind === 'edit-conflict',
    );
    expect(conflict).toBeDefined();
    expect(conflict.message.text).toContain('src/shared.ts');
    expect(conflict.message.filePath).toBe('src/shared.ts');
    expect(conflict.message.text).toContain('Claude');
    expect(conflict.message.text).toContain('Codex');
  });

  it('detects edit conflicts when agents report the same workspace file with absolute and relative paths', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));
    const sharedFile = path.join(workspacePath, 'src', 'shared.ts');
    const agent = (id: AgentId, reportedPath: string): Agent => ({
      id,
      status: async () => 'ready',
      cancel: async () => {},
      async *send() {
        yield { type: 'tool-call', name: 'edit-file', input: { path: reportedPath } } as AgentChunk;
        yield { type: 'tool-result', name: 'edit-file', output: 'ok' } as AgentChunk;
        yield { type: 'done' } as AgentChunk;
      },
    });
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: agent('claude', sharedFile),
        codex: agent('codex', 'src/shared.ts'),
        gemini: agentNoop('gemini'),
      },
      {
        getEditedPathForAgent: (_agentId, _toolName, input) => {
          if (typeof input === 'object' && input && 'path' in input) {
            return String(input.path);
          }
          return null;
        },
      },
    );

    const events: any[] = [];
    await service.dispatch(
      { text: '@all update shared code', source: 'panel', cwd: workspacePath },
      (event) => {
        events.push(event);
      },
    );

    const finalized = events
      .filter((event) => event.kind === 'dispatch-end')
      .map((event) => event.message);
    expect(finalized.map((message) => message.editedFiles)).toEqual([
      ['src/shared.ts'],
      ['src/shared.ts'],
      undefined,
    ]);
    const conflict = events.find((event) =>
      event.kind === 'system-message' &&
      event.message.kind === 'edit-conflict',
    );
    expect(conflict?.message.text).toContain('src/shared.ts');
  });

  it('detects edit conflicts when agents report equivalent relative paths', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));
    const agent = (id: AgentId, reportedPath: string): Agent => ({
      id,
      status: async () => 'ready',
      cancel: async () => {},
      async *send() {
        yield { type: 'tool-call', name: 'edit-file', input: { path: reportedPath } } as AgentChunk;
        yield { type: 'tool-result', name: 'edit-file', output: 'ok' } as AgentChunk;
        yield { type: 'done' } as AgentChunk;
      },
    });
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: agent('claude', './src/shared.ts'),
        codex: agent('codex', 'src/shared.ts'),
        gemini: agentNoop('gemini'),
      },
      {
        getEditedPathForAgent: (_agentId, _toolName, input) => {
          if (typeof input === 'object' && input && 'path' in input) {
            return String(input.path);
          }
          return null;
        },
      },
    );

    const events: any[] = [];
    await service.dispatch(
      { text: '@all update shared code', source: 'panel', cwd: workspacePath },
      (event) => {
        events.push(event);
      },
    );

    const finalized = events
      .filter((event) => event.kind === 'dispatch-end')
      .map((event) => event.message);
    expect(finalized.map((message) => message.editedFiles)).toEqual([
      ['src/shared.ts'],
      ['src/shared.ts'],
      undefined,
    ]);
    const conflict = events.find((event) =>
      event.kind === 'system-message' &&
      event.message.kind === 'edit-conflict',
    );
    expect(conflict?.message.text).toContain('src/shared.ts');
  });

  it('serializes concurrent top-level dispatches so shared context cannot interleave', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));
    const started: AgentId[] = [];
    let releaseClaude!: () => void;
    const claudeCanFinish = new Promise<void>((resolve) => {
      releaseClaude = resolve;
    });
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: {
          id: 'claude',
          status: async () => 'ready',
          cancel: async () => {},
          async *send() {
            yield { type: 'text', text: 'claude started' } as AgentChunk;
            await claudeCanFinish;
            yield { type: 'done' } as AgentChunk;
          },
        },
        codex: {
          id: 'codex',
          status: async () => 'ready',
          cancel: async () => {},
          async *send() {
            yield { type: 'done' } as AgentChunk;
          },
        },
        gemini: agentNoop('gemini'),
      },
      { hangSeconds: 0 },
    );

    const first = service.dispatch(
      { text: '@claude first', source: 'native-chat', cwd: workspacePath },
      (event) => {
        if (event.kind === 'dispatch-start') {
          started.push(event.agentId);
        }
      },
    );
    await waitUntil(() => started.includes('claude'));

    const second = service.dispatch(
      { text: '@codex second', source: 'language-model', cwd: workspacePath },
      (event) => {
        if (event.kind === 'dispatch-start') {
          started.push(event.agentId);
        }
      },
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(started).toEqual(['claude']);

    releaseClaude();
    await Promise.all([first, second]);
    expect(started).toEqual(['claude', 'codex']);
  });

  it('queues concurrent top-level dispatches before appending the next user message', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));
    let releaseClaude!: () => void;
    const claudeCanFinish = new Promise<void>((resolve) => {
      releaseClaude = resolve;
    });
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: {
          id: 'claude',
          status: async () => 'ready',
          cancel: async () => {},
          async *send() {
            yield { type: 'text', text: 'claude started' } as AgentChunk;
            await claudeCanFinish;
            yield { type: 'done' } as AgentChunk;
          },
        },
        codex: agentNoop('codex'),
        gemini: agentNoop('gemini'),
      },
      { hangSeconds: 0 },
    );

    const events: Array<string> = [];
    const first = service.dispatch(
      { text: '@claude first', source: 'native-chat', cwd: workspacePath },
      (event) => {
        if (event.kind === 'user-message') events.push(`user:${event.message.text}`);
        if (event.kind === 'dispatch-end') events.push(`end:${event.agentId}`);
      },
    );
    await waitUntil(() => events.includes('user:@claude first'));

    const second = service.dispatch(
      { text: '@codex second', source: 'language-model', cwd: workspacePath },
      (event) => {
        if (event.kind === 'user-message') events.push(`user:${event.message.text}`);
        if (event.kind === 'dispatch-end') events.push(`end:${event.agentId}`);
      },
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(events).toEqual(['user:@claude first']);

    releaseClaude();
    await Promise.all([first, second]);
    expect(events).toEqual([
      'user:@claude first',
      'end:claude',
      'user:@codex second',
      'end:codex',
    ]);
  });

  it('does not start queued top-level dispatches after cancelAll', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));
    let codexStarted = false;
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: {
          id: 'claude',
          status: async () => 'ready',
          cancel: async () => {},
          async *send() {
            yield { type: 'text', text: 'claude started' } as AgentChunk;
            await new Promise(() => { /* cancelled by router abort */ });
          },
        },
        codex: {
          id: 'codex',
          status: async () => 'ready',
          cancel: async () => {},
          async *send() {
            codexStarted = true;
            yield { type: 'done' } as AgentChunk;
          },
        },
        gemini: agentNoop('gemini'),
      },
      { hangSeconds: 0 },
    );

    const events: string[] = [];
    const first = service.dispatch(
      { text: '@claude first', source: 'native-chat', cwd: workspacePath },
      (event) => {
        if (event.kind === 'user-message') events.push(`user:${event.message.text}`);
        if (event.kind === 'dispatch-start') events.push(`start:${event.agentId}`);
        if (event.kind === 'dispatch-end') events.push(`end:${event.agentId}:${event.message.status}`);
      },
    );
    await waitUntil(() => events.includes('start:claude'));

    const second = service.dispatch(
      { text: '@codex second', source: 'language-model', cwd: workspacePath },
      (event) => {
        if (event.kind === 'user-message') events.push(`user:${event.message.text}`);
        if (event.kind === 'dispatch-start') events.push(`start:${event.agentId}`);
        if (event.kind === 'dispatch-end') events.push(`end:${event.agentId}:${event.message.status}`);
      },
    );
    await new Promise((resolve) => setImmediate(resolve));

    await service.cancelAll();
    await Promise.all([first, second]);

    expect(codexStarted).toBe(false);
    expect(events).toEqual([
      'user:@claude first',
      'start:claude',
      'end:claude:cancelled',
    ]);
  });

  it('preserves router routing-needed details for unavailable direct agents', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));
    let codexStarted = false;
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: agentNoop('claude'),
        codex: {
          id: 'codex',
          status: async () => 'unauthenticated',
          cancel: async () => {},
          async *send() {
            codexStarted = true;
            yield { type: 'done' } as AgentChunk;
          },
        },
        gemini: agentNoop('gemini'),
      },
      { hangSeconds: 0 },
    );

    const events: any[] = [];
    await service.dispatch(
      { text: '@codex implement this', source: 'native-chat', cwd: workspacePath },
      (event) => {
        events.push(event);
      },
    );

    expect(codexStarted).toBe(false);
    const routing = events.find((event) =>
      event.kind === 'system-message' &&
      event.message.kind === 'routing-needed',
    );
    expect(routing?.message.text).toBe('Codex is unauthenticated. Run `codex login`. If `codex` is missing, install it with `npm install -g @openai/codex`. You can also run Veyra: Show setup guide.');
  });
});

function fakeWorkspaceContextProvider(
  block: string,
  overrides: Partial<WorkspaceContextResult> = {},
): Pick<WorkspaceContextProvider, 'retrieve' | 'invalidate'> {
  return {
    invalidate: vi.fn(),
    retrieve: vi.fn(async (query: string) => ({
      enabled: true,
      query,
      block,
      attached: [{ path: 'src/auth/session.ts', lines: 4, truncated: true }],
      selected: [{
        path: 'src/auth/session.ts',
        score: 10,
        reasons: ['path:auth'],
        language: 'ts',
        startLine: 1,
        endLine: 4,
      }],
      diagnostics: [],
      ...overrides,
    })),
  };
}

function agentNoop(id: AgentId): Agent {
  return {
    id,
    status: async () => 'ready',
    cancel: async () => {},
    async *send() {
      yield { type: 'done' } as AgentChunk;
    },
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition was not met');
}
