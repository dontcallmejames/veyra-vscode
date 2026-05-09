import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  LanguageModelChatMessageRole: {
    User: 1,
    Assistant: 2,
  },
  LanguageModelTextPart: class {
    constructor(public value: string) {}
  },
  Uri: {
    file: (path: string) => ({ toString: () => `file://${path.replace(/\\/g, '/')}` }),
  },
  lm: {
    registerLanguageModelChatProvider: vi.fn(),
  },
}));

import { GAMBIT_LANGUAGE_MODELS } from '../src/languageModelProvider.js';

type SmokePaths = {
  rootDir: string;
  userDataDir: string;
  extensionsDir: string;
  workspaceDir: string;
  smokeResultPath: string;
  extensionEntryPath: string;
  extensionTestsPath: string;
};

async function smokeScriptModule() {
  // @ts-expect-error The smoke runner is a plain Node .mjs script; this test asserts its exported runtime contract.
  return await import('../scripts/run-vscode-smoke.mjs') as {
    smokePaths(rootDir: string): SmokePaths;
    buildCodeSmokeArgs(paths: SmokePaths): string[];
    buildCodeSmokeEnv(paths: SmokePaths, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
    buildCodeSpawnInvocation(codeCommand: string, args: string[], platform: NodeJS.Platform): {
      command: string;
      args: string[];
      shell: boolean;
    };
    resolveCodeCommand(
      codeCommand: string,
      platform: NodeJS.Platform,
      execFile: (command: string, args: string[], options: unknown) => Buffer | string,
    ): string;
    prepareSmokeDirectories(paths: SmokePaths): void;
    findMissingSmokePrerequisites(paths: SmokePaths, fileExists: (path: string) => boolean): string[];
    requiredSmokeLanguageModels: Record<string, {
      name: string;
      family: string;
      version: string;
      maxInputTokens: number;
    }>;
    validateSmokeResultContent(content: string): string[];
  };
}

describe('VS Code smoke runner script', () => {
  it('builds isolated Extension Development Host arguments for the real VS Code CLI', async () => {
    const { buildCodeSmokeArgs, smokePaths } = await smokeScriptModule();
    const paths = smokePaths('C:/repo/gambit');
    const args = buildCodeSmokeArgs(paths).map(normalizePathText);

    expect(args).toContain('--new-window');
    expect(args).toContain('--wait');
    expect(args).toContain('--disable-extensions');
    expect(args).toContain('--disable-workspace-trust');
    expect(args).toContain('--disable-gpu');
    expect(args).toContain('--disable-chromium-sandbox');
    expect(args).toContain('--skip-welcome');
    expect(args).toContain('--skip-release-notes');
    expect(args).toContain('--extensionDevelopmentPath=C:/repo/gambit');
    expect(args).toContain('--extensionTestsPath=C:/repo/gambit/tests/extension-host/smoke.js');
    expect(args).toContain('--user-data-dir=C:/repo/gambit/.vscode-test/user-data');
    expect(args).toContain('--extensions-dir=C:/repo/gambit/.vscode-test/extensions');
    expect(args).toContain('C:/repo/gambit/.vscode-test/workspace');
  });

  it('passes a smoke-result sentinel path to the Extension Host test module', async () => {
    const { buildCodeSmokeEnv, smokePaths } = await smokeScriptModule();
    const paths = smokePaths('C:/repo/gambit');
    const env = buildCodeSmokeEnv(paths, { EXISTING: '1' });

    expect(env.EXISTING).toBe('1');
    expect(env.VSCODE_GAMBIT_SMOKE).toBe('1');
    expect(normalizePathText(env.VSCODE_GAMBIT_SMOKE_RESULT ?? '')).toBe(
      'C:/repo/gambit/.vscode-test/smoke-result.json',
    );
  });

  it('quotes Windows command invocations without shell argument splitting', async () => {
    const { buildCodeSpawnInvocation } = await smokeScriptModule();
    const invocation = buildCodeSpawnInvocation(
      'C:/Users/tester/AppData/Local/Programs/Microsoft VS Code/bin/code.cmd',
      ['--extensionDevelopmentPath=C:/repo/Agent Chat VSCode', '--wait'],
      'win32',
    );

    expect(invocation).toEqual({
      command: 'cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        'call',
        'C:/Users/tester/AppData/Local/Programs/Microsoft VS Code/bin/code.cmd',
        '--extensionDevelopmentPath=C:/repo/Agent Chat VSCode',
        '--wait',
      ],
      shell: false,
    });
  });

  it('resolves the default Windows code launcher to its concrete command script', async () => {
    const { resolveCodeCommand } = await smokeScriptModule();

    expect(resolveCodeCommand(
      'code',
      'win32',
      () => 'C:/Users/tester/AppData/Local/Programs/Microsoft VS Code/bin/code.cmd\r\n',
    )).toBe('C:/Users/tester/AppData/Local/Programs/Microsoft VS Code/bin/code.cmd');
  });

  it('reports missing build and smoke-test artifacts before launching VS Code', async () => {
    const { findMissingSmokePrerequisites, smokePaths } = await smokeScriptModule();
    const paths = smokePaths('C:/repo/gambit');

    expect(findMissingSmokePrerequisites(paths, () => false).map(normalizePathText)).toEqual([
      'C:/repo/gambit/dist/extension.js',
      'C:/repo/gambit/tests/extension-host/smoke.js',
    ]);
  });

  it('resets stale smoke workspace state before launching VS Code', async () => {
    const { prepareSmokeDirectories, smokePaths } = await smokeScriptModule();
    const root = mkdtempSync(join(tmpdir(), 'gambit-smoke-runner-'));
    const paths = smokePaths(root);
    const staleSessionPath = join(paths.workspaceDir, '.vscode', 'gambit', 'sessions.json');

    try {
      mkdirSync(join(paths.workspaceDir, '.vscode', 'gambit'), { recursive: true });
      writeFileSync(staleSessionPath, '{"messages":["stale"]}', 'utf8');

      prepareSmokeDirectories(paths);

      expect(existsSync(staleSessionPath)).toBe(false);
      expect(existsSync(paths.workspaceDir)).toBe(true);
      expect(existsSync(join(paths.workspaceDir, '.git'))).toBe(true);
      expect(existsSync(paths.userDataDir)).toBe(true);
      expect(existsSync(paths.extensionsDir)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps smoke metadata expectations aligned with the language model provider source', async () => {
    const { requiredSmokeLanguageModels } = await smokeScriptModule();

    expect(requiredSmokeLanguageModels).toEqual(Object.fromEntries(
      GAMBIT_LANGUAGE_MODELS.map((model) => [
        model.id,
        {
          name: model.name,
          family: model.family,
          version: model.version,
          maxInputTokens: model.maxInputTokens,
        },
      ]),
    ));
  });

  it('requires the Extension Host smoke result to include executed command evidence', async () => {
    const { validateSmokeResultContent } = await smokeScriptModule();

    const completeSmokeResult = {
      ok: true,
      extensionId: 'dontcallmejames.gambit',
      executedCommands: [
        'gambit.checkStatus',
        'gambit.openPanel',
        'gambit.showSetupGuide',
        'gambit.showLiveValidationGuide',
        'gambit.configureCliPaths',
        'gambit.installCommitHook',
        'gambit.uninstallCommitHook',
        'gambit.showCommitHookSnippet',
      ],
      languageModelTokenCounts: {
        'gambit-orchestrator': 3,
        'gambit-review': 3,
        'gambit-debate': 3,
        'gambit-implement': 3,
        'gambit-claude': 3,
        'gambit-codex': 3,
        'gambit-gemini': 3,
      },
      languageModelMetadata: {
        'gambit-orchestrator': {
          name: 'Gambit',
          family: 'gambit',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-review': {
          name: 'Gambit Review',
          family: 'gambit',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-debate': {
          name: 'Gambit Debate',
          family: 'gambit',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-implement': {
          name: 'Gambit Implement',
          family: 'gambit',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-claude': {
          name: 'Claude via Gambit',
          family: 'claude',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-codex': {
          name: 'Codex via Gambit',
          family: 'codex',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-gemini': {
          name: 'Gemini via Gambit',
          family: 'gemini',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
      },
      languageModelResponses: {
        'gambit-orchestrator': [
          'Routed to Codex',
          '[smoke:codex] write-capable request reached Gambit provider.',
          languageModelSmokeEditEvidence('Codex', 'src/gambit-smoke-codex.ts'),
        ].join('\n'),
        'gambit-review': '[smoke:claude] read-only request reached Gambit provider.\n[smoke:codex] read-only request reached Gambit provider.\n[smoke:gemini] read-only request reached Gambit provider.',
        'gambit-debate': '[smoke:claude] read-only request reached Gambit provider.\n[smoke:codex] read-only request reached Gambit provider.\n[smoke:gemini] read-only request reached Gambit provider.',
        'gambit-implement': [
          '[smoke:claude] write-capable request reached Gambit provider.',
          languageModelSmokeEditEvidence('Claude', 'src/gambit-smoke-claude.ts'),
          '[smoke:codex] write-capable request reached Gambit provider.',
          languageModelSmokeEditEvidence('Codex', 'src/gambit-smoke-codex.ts'),
          '[smoke:gemini] write-capable request reached Gambit provider.',
          languageModelSmokeEditEvidence('Gemini', 'src/gambit-smoke-gemini.ts'),
        ].join('\n'),
        'gambit-claude': [
          '[smoke:claude] write-capable request reached Gambit provider.',
          languageModelSmokeEditEvidence('Claude', 'src/gambit-smoke-claude.ts'),
        ].join('\n'),
        'gambit-codex': [
          '[smoke:codex] write-capable request reached Gambit provider.',
          languageModelSmokeEditEvidence('Codex', 'src/gambit-smoke-codex.ts'),
        ].join('\n'),
        'gambit-gemini': [
          '[smoke:gemini] write-capable request reached Gambit provider.',
          languageModelSmokeEditEvidence('Gemini', 'src/gambit-smoke-gemini.ts'),
        ].join('\n'),
      },
      chatParticipants: [
        {
          id: 'gambit.gambit',
          name: 'gambit',
          commands: ['review', 'debate', 'implement'],
        },
        {
          id: 'gambit.claude',
          name: 'claude',
          commands: [],
        },
        {
          id: 'gambit.codex',
          name: 'codex',
          commands: [],
        },
        {
          id: 'gambit.gemini',
          name: 'gemini',
          commands: [],
        },
      ],
      nativeChatRegistrations: [
        'gambit.gambit',
        'gambit.claude',
        'gambit.codex',
        'gambit.gemini',
      ],
      nativeWorkflowDiagnostics: {
        review: {
          forcedTarget: 'gambit',
          readOnly: true,
          containsAllMention: true,
          containsWorkflowMarker: true,
        },
        debate: {
          forcedTarget: 'gambit',
          readOnly: true,
          containsAllMention: true,
          containsWorkflowMarker: true,
        },
        implement: {
          forcedTarget: 'gambit',
          readOnly: false,
          containsAllMention: true,
          containsWorkflowMarker: true,
        },
      },
      nativeChatResponses: {
        'gambit.gambit': [
          'Routed to Codex',
          '[smoke:codex] write-capable request reached Gambit provider.',
          nativeSmokeEditEvidence('Codex', 'src/gambit-smoke-codex.ts'),
        ].join('\n'),
        'gambit.gambit/review': '[smoke:claude] read-only request reached Gambit provider.\n[smoke:codex] read-only request reached Gambit provider.\n[smoke:gemini] read-only request reached Gambit provider.',
        'gambit.gambit/debate': '[smoke:claude] read-only request reached Gambit provider.\n[smoke:codex] read-only request reached Gambit provider.\n[smoke:gemini] read-only request reached Gambit provider.',
        'gambit.gambit/implement': [
          '[smoke:claude] write-capable request reached Gambit provider.',
          nativeSmokeEditEvidence('Claude', 'src/gambit-smoke-claude.ts'),
          '[smoke:codex] write-capable request reached Gambit provider.',
          nativeSmokeEditEvidence('Codex', 'src/gambit-smoke-codex.ts'),
          '[smoke:gemini] write-capable request reached Gambit provider.',
          nativeSmokeEditEvidence('Gemini', 'src/gambit-smoke-gemini.ts'),
        ].join('\n'),
        'gambit.claude': [
          '[smoke:claude] write-capable request reached Gambit provider.',
          nativeSmokeEditEvidence('Claude', 'src/gambit-smoke-claude.ts'),
        ].join('\n'),
        'gambit.codex': [
          '[smoke:codex] write-capable request reached Gambit provider.',
          nativeSmokeEditEvidence('Codex', 'src/gambit-smoke-codex.ts'),
        ].join('\n'),
        'gambit.gemini': [
          '[smoke:gemini] write-capable request reached Gambit provider.',
          nativeSmokeEditEvidence('Gemini', 'src/gambit-smoke-gemini.ts'),
        ].join('\n'),
      },
      editConflictEvidence: {
        nativeChat: [
          '[smoke:claude] write-capable request reached Gambit provider.',
          nativeSmokeEditEvidence('Claude', 'src/gambit-smoke-conflict.ts'),
          '[smoke:codex] write-capable request reached Gambit provider.',
          nativeSmokeEditEvidence('Codex', 'src/gambit-smoke-conflict.ts'),
          '**Edit conflict:** Codex created src/gambit-smoke-conflict.ts, which was already edited by Claude in this session.',
        ].join('\n'),
        languageModel: [
          '[smoke:claude] write-capable request reached Gambit provider.',
          languageModelSmokeEditEvidence('Claude', 'src/gambit-smoke-conflict.ts'),
          '[smoke:codex] write-capable request reached Gambit provider.',
          languageModelSmokeEditEvidence('Codex', 'src/gambit-smoke-conflict.ts'),
          '_Edit conflict: Codex created [src/gambit-smoke-conflict.ts](file:///workspace/src/gambit-smoke-conflict.ts), which was already edited by Claude, Gemini in this session._',
        ].join('\n'),
      },
      sharedContextEvidence: {
        nativeChat: [
          '[smoke:claude] write-capable request reached Gambit provider.',
          '[smoke:codex] saw prior Claude reply in shared context.',
          '[smoke:gemini] saw prior Claude and Codex replies in shared context.',
        ].join('\n'),
        languageModel: [
          '[smoke:claude] write-capable request reached Gambit provider.',
          '[smoke:codex] saw prior Claude reply in shared context.',
          '[smoke:gemini] saw prior Claude and Codex replies in shared context.',
        ].join('\n'),
      },
      languageModelToolContextEvidence: [
        '[smoke:codex] saw VS Code request tool workspaceSearch in provider context.',
        '[smoke:codex] saw VS Code model option temperature in provider context.',
      ].join('\n'),
      commitHookLifecycle: {
        installed: true,
        removed: true,
        dispatchSentinelObserved: true,
        dispatchSentinelCleared: true,
        commitMessageAttributed: true,
      },
      uiEvidence: {
        gambitPanelOpened: true,
      },
    };
    expect(validateSmokeResultContent(JSON.stringify(completeSmokeResult))).toEqual([]);
    expect(validateSmokeResultContent(JSON.stringify({
      ...completeSmokeResult,
      nativeChatResponses: {
        ...completeSmokeResult.nativeChatResponses,
        'gambit.gambit/implement': completeSmokeResult.nativeChatResponses['gambit.gambit/implement']
          .replace(nativeSmokeEditEvidence('Claude', 'src/gambit-smoke-claude.ts'), ''),
      },
    }))).toContain('Missing native chat visible edit evidence: gambit.gambit/implement must show Claude created src/gambit-smoke-claude.ts with a file reference.');

    expect(validateSmokeResultContent(JSON.stringify({
      ...completeSmokeResult,
      languageModelResponses: {
        ...completeSmokeResult.languageModelResponses,
        'gambit-implement': completeSmokeResult.languageModelResponses['gambit-implement']
          .replace(languageModelSmokeEditEvidence('Gemini', 'src/gambit-smoke-gemini.ts'), ''),
      },
    }))).toContain('Missing language model visible edit evidence: gambit-implement must show Gemini created src/gambit-smoke-gemini.ts as a workspace link.');

    expect(validateSmokeResultContent(JSON.stringify({
      ...completeSmokeResult,
      languageModelResponses: {
        ...completeSmokeResult.languageModelResponses,
        'gambit-review': `${completeSmokeResult.languageModelResponses['gambit-review']}\nRead-only workflow violation: Claude edited src/review.ts during a read-only dispatch.`,
      },
    }))).toContain('Unexpected language model response evidence: gambit-review reported a read-only workflow violation.');

    expect(validateSmokeResultContent(JSON.stringify({
      ...completeSmokeResult,
      languageModelResponses: {
        ...completeSmokeResult.languageModelResponses,
        'gambit-review': `${completeSmokeResult.languageModelResponses['gambit-review']}\nClaude edited .vscode/gambit/sessions.json`,
      },
    }))).toContain('Unexpected language model response evidence: gambit-review exposed Gambit internal state path.');

    expect(validateSmokeResultContent(JSON.stringify({
      ...completeSmokeResult,
      commitHookLifecycle: {
        ...completeSmokeResult.commitHookLifecycle,
        commitMessageAttributed: false,
      },
    }))).toContain('Missing commit hook commit-message attribution evidence.');

    expect(validateSmokeResultContent(JSON.stringify({
      ...completeSmokeResult,
      editConflictEvidence: undefined,
    }))).toContain('Missing edit conflict smoke evidence.');

    expect(validateSmokeResultContent(JSON.stringify({
      ...completeSmokeResult,
      sharedContextEvidence: undefined,
    }))).toContain('Missing shared-context smoke evidence.');

    expect(validateSmokeResultContent(JSON.stringify({
      ...completeSmokeResult,
      languageModelToolContextEvidence: undefined,
    }))).toContain('Missing language model request-tool context smoke evidence.');

    expect(validateSmokeResultContent(JSON.stringify({
      ...completeSmokeResult,
      languageModelToolContextEvidence: '[smoke:codex] saw VS Code request tool workspaceSearch in provider context.',
    }))).toContain('Missing language model request model-options context marker: [smoke:codex] saw VS Code model option temperature in provider context.');

    expect(validateSmokeResultContent(JSON.stringify({
      ok: true,
      extensionId: 'dontcallmejames.gambit',
      executedCommands: ['gambit.showSetupGuide'],
    }))).toContain('Missing smoke command execution: gambit.checkStatus');

    expect(validateSmokeResultContent(JSON.stringify({
      ok: true,
      extensionId: 'dontcallmejames.gambit',
      executedCommands: [
        'gambit.checkStatus',
        'gambit.openPanel',
        'gambit.showSetupGuide',
        'gambit.installCommitHook',
        'gambit.uninstallCommitHook',
        'gambit.showCommitHookSnippet',
      ],
    }))).toContain('Missing smoke command execution: gambit.configureCliPaths');
    expect(validateSmokeResultContent(JSON.stringify({
      ...completeSmokeResult,
      executedCommands: completeSmokeResult.executedCommands.filter(
        (command) => command !== 'gambit.showLiveValidationGuide',
      ),
    }))).toContain('Missing smoke command execution: gambit.showLiveValidationGuide');

    expect(validateSmokeResultContent(JSON.stringify({
      ok: true,
      extensionId: 'dontcallmejames.gambit',
      executedCommands: [
        'gambit.checkStatus',
        'gambit.openPanel',
        'gambit.showSetupGuide',
        'gambit.configureCliPaths',
        'gambit.installCommitHook',
        'gambit.uninstallCommitHook',
        'gambit.showCommitHookSnippet',
      ],
    }))).toContain('Missing language model token count: gambit-orchestrator');

    expect(validateSmokeResultContent(JSON.stringify({
      ok: true,
      extensionId: 'dontcallmejames.gambit',
      executedCommands: [
        'gambit.checkStatus',
        'gambit.openPanel',
        'gambit.showSetupGuide',
        'gambit.configureCliPaths',
        'gambit.installCommitHook',
        'gambit.uninstallCommitHook',
        'gambit.showCommitHookSnippet',
      ],
      languageModelTokenCounts: {
        'gambit-orchestrator': 3,
        'gambit-review': 3,
        'gambit-debate': 3,
        'gambit-implement': 3,
        'gambit-claude': 3,
        'gambit-codex': 3,
        'gambit-gemini': 3,
      },
    }))).toContain('Missing commit hook lifecycle evidence.');

    expect(validateSmokeResultContent(JSON.stringify({
      ok: true,
      extensionId: 'dontcallmejames.gambit',
      executedCommands: [
        'gambit.checkStatus',
        'gambit.openPanel',
        'gambit.showSetupGuide',
        'gambit.configureCliPaths',
        'gambit.installCommitHook',
        'gambit.uninstallCommitHook',
        'gambit.showCommitHookSnippet',
      ],
      languageModelTokenCounts: {
        'gambit-orchestrator': 3,
        'gambit-review': 3,
        'gambit-debate': 3,
        'gambit-implement': 3,
        'gambit-claude': 3,
        'gambit-codex': 3,
        'gambit-gemini': 3,
      },
      commitHookLifecycle: {
        installed: true,
        removed: true,
      },
    }))).toContain('Missing language model metadata: gambit-orchestrator');

    expect(validateSmokeResultContent(JSON.stringify({
      ...completeSmokeResult,
      nativeChatRegistrations: [
        'gambit.gambit',
        'gambit.claude',
        'gambit.codex',
      ],
    }))).toContain('Missing native chat registration evidence: gambit.gemini');

    expect(validateSmokeResultContent(JSON.stringify({
      ...completeSmokeResult,
      nativeWorkflowDiagnostics: {
        ...completeSmokeResult.nativeWorkflowDiagnostics,
        debate: {
          ...completeSmokeResult.nativeWorkflowDiagnostics.debate,
          readOnly: false,
        },
      },
    }))).toContain('Unexpected native chat workflow diagnostic: debate must be read-only.');

    expect(validateSmokeResultContent(JSON.stringify({
      ...completeSmokeResult,
      nativeChatResponses: {
        ...completeSmokeResult.nativeChatResponses,
        'gambit.gambit/review': '[smoke:claude] write-capable request reached Gambit provider.',
      },
    }))).toContain('Unexpected native chat response evidence: gambit.gambit/review missing [smoke:claude] read-only request reached Gambit provider.');

    expect(validateSmokeResultContent(JSON.stringify({
      ...completeSmokeResult,
      nativeChatResponses: {
        ...completeSmokeResult.nativeChatResponses,
        'gambit.gambit/review': `${completeSmokeResult.nativeChatResponses['gambit.gambit/review']}\nRead-only workflow violation: Claude edited src/review.ts during a read-only dispatch.`,
      },
    }))).toContain('Unexpected native chat response evidence: gambit.gambit/review reported a read-only workflow violation.');

    expect(validateSmokeResultContent(JSON.stringify({
      ok: true,
      extensionId: 'dontcallmejames.gambit',
      executedCommands: [
        'gambit.checkStatus',
        'gambit.openPanel',
        'gambit.showSetupGuide',
        'gambit.configureCliPaths',
        'gambit.installCommitHook',
        'gambit.uninstallCommitHook',
        'gambit.showCommitHookSnippet',
      ],
      languageModelTokenCounts: {
        'gambit-orchestrator': 3,
        'gambit-review': 3,
        'gambit-debate': 3,
        'gambit-implement': 3,
        'gambit-claude': 3,
        'gambit-codex': 3,
        'gambit-gemini': 3,
      },
      languageModelMetadata: {
        'gambit-orchestrator': {
          name: 'Gambit',
          family: 'gambit',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-review': {
          name: 'Gambit Review',
          family: 'gambit',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-debate': {
          name: 'Gambit Debate',
          family: 'gambit',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-implement': {
          name: 'Gambit Implement',
          family: 'gambit',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-claude': {
          name: 'Claude via Gambit',
          family: 'claude',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-codex': {
          name: 'Codex via Gambit',
          family: 'codex',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-gemini': {
          name: 'Gemini via Gambit',
          family: 'gemini',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
      },
      commitHookLifecycle: {
        installed: true,
        removed: true,
      },
      uiEvidence: {
        gambitPanelOpened: true,
      },
    }))).toContain('Missing native chat participant evidence: gambit.gambit');

    expect(validateSmokeResultContent(JSON.stringify({
      ...completeSmokeResult,
      nativeChatResponses: {
        ...completeSmokeResult.nativeChatResponses,
        'gambit.gambit/implement': '',
      },
    }))).toContain('Missing native chat response evidence: gambit.gambit/implement');

    expect(validateSmokeResultContent(JSON.stringify({
      ok: true,
      extensionId: 'dontcallmejames.gambit',
      executedCommands: [
        'gambit.checkStatus',
        'gambit.openPanel',
        'gambit.showSetupGuide',
        'gambit.configureCliPaths',
        'gambit.installCommitHook',
        'gambit.uninstallCommitHook',
        'gambit.showCommitHookSnippet',
      ],
      chatParticipants: [
        {
          id: 'gambit.gambit',
          name: 'gambit',
          commands: ['review', 'debate', 'implement'],
        },
        {
          id: 'gambit.claude',
          name: 'claude',
          commands: [],
        },
        {
          id: 'gambit.codex',
          name: 'codex',
          commands: [],
        },
        {
          id: 'gambit.gemini',
          name: 'gemini',
          commands: [],
        },
      ],
      languageModelTokenCounts: {
        'gambit-orchestrator': 3,
        'gambit-review': 3,
        'gambit-debate': 3,
        'gambit-implement': 3,
        'gambit-claude': 3,
        'gambit-codex': 3,
        'gambit-gemini': 3,
      },
      languageModelMetadata: {
        'gambit-orchestrator': {
          name: 'Gambit',
          family: 'gambit',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-review': {
          name: 'Gambit Review',
          family: 'gambit',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-debate': {
          name: 'Gambit Debate',
          family: 'gambit',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-implement': {
          name: 'Gambit Implement',
          family: 'gambit',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-claude': {
          name: 'Claude via Gambit',
          family: 'claude',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-codex': {
          name: 'Codex via Gambit',
          family: 'codex',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-gemini': {
          name: 'Gemini via Gambit',
          family: 'gemini',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
      },
      commitHookLifecycle: {
        installed: true,
        removed: true,
      },
      uiEvidence: {
        gambitPanelOpened: true,
      },
    }))).toContain('Missing language model response evidence: gambit-orchestrator');

    expect(validateSmokeResultContent(JSON.stringify({
      ok: true,
      extensionId: 'dontcallmejames.gambit',
      executedCommands: [
        'gambit.checkStatus',
        'gambit.openPanel',
        'gambit.showSetupGuide',
        'gambit.configureCliPaths',
        'gambit.installCommitHook',
        'gambit.uninstallCommitHook',
        'gambit.showCommitHookSnippet',
      ],
      chatParticipants: [
        {
          id: 'gambit.gambit',
          name: 'gambit',
          commands: ['review', 'debate', 'implement'],
        },
        {
          id: 'gambit.claude',
          name: 'claude',
          commands: [],
        },
        {
          id: 'gambit.codex',
          name: 'codex',
          commands: [],
        },
        {
          id: 'gambit.gemini',
          name: 'gemini',
          commands: [],
        },
      ],
      languageModelTokenCounts: {
        'gambit-orchestrator': 3,
        'gambit-review': 3,
        'gambit-debate': 3,
        'gambit-implement': 3,
        'gambit-claude': 3,
        'gambit-codex': 3,
        'gambit-gemini': 3,
      },
      languageModelMetadata: {
        'gambit-orchestrator': {
          name: 'Gambit',
          family: 'gambit',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-review': {
          name: 'Gambit Review',
          family: 'gambit',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-debate': {
          name: 'Gambit Debate',
          family: 'gambit',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-implement': {
          name: 'Gambit Implement',
          family: 'gambit',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-claude': {
          name: 'Claude via Gambit',
          family: 'claude',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-codex': {
          name: 'Codex via Gambit',
          family: 'codex',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-gemini': {
          name: 'Gemini via Gambit',
          family: 'gemini',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
      },
      languageModelResponses: {
        'gambit-orchestrator': 'Routed to Codex\n[smoke:codex] write-capable request reached Gambit provider.',
        'gambit-review': '[smoke:claude] read-only request reached Gambit provider.\n[smoke:codex] read-only request reached Gambit provider.\n[smoke:gemini] read-only request reached Gambit provider.',
        'gambit-debate': '[smoke:claude] read-only request reached Gambit provider.\n[smoke:codex] read-only request reached Gambit provider.\n[smoke:gemini] read-only request reached Gambit provider.',
        'gambit-implement': '[smoke:claude] write-capable request reached Gambit provider.\n[smoke:codex] write-capable request reached Gambit provider.\n[smoke:gemini] write-capable request reached Gambit provider.',
        'gambit-claude': '[smoke:claude] write-capable request reached Gambit provider.',
        'gambit-codex': '[smoke:codex] write-capable request reached Gambit provider.',
        'gambit-gemini': '[smoke:gemini] write-capable request reached Gambit provider.',
      },
      commitHookLifecycle: {
        installed: true,
        removed: true,
      },
      uiEvidence: {
        gambitPanelOpened: true,
      },
    }))).toContain('Missing active dispatch sentinel lifecycle evidence.');

    expect(validateSmokeResultContent(JSON.stringify({
      ok: true,
      extensionId: 'dontcallmejames.gambit',
      executedCommands: [
        'gambit.checkStatus',
        'gambit.openPanel',
        'gambit.showSetupGuide',
        'gambit.configureCliPaths',
        'gambit.installCommitHook',
        'gambit.uninstallCommitHook',
        'gambit.showCommitHookSnippet',
      ],
      chatParticipants: [
        {
          id: 'gambit.gambit',
          name: 'gambit',
          commands: ['review', 'debate', 'implement'],
        },
        {
          id: 'gambit.claude',
          name: 'claude',
          commands: [],
        },
        {
          id: 'gambit.codex',
          name: 'codex',
          commands: [],
        },
        {
          id: 'gambit.gemini',
          name: 'gemini',
          commands: [],
        },
      ],
      languageModelTokenCounts: {
        'gambit-orchestrator': 3,
        'gambit-review': 3,
        'gambit-debate': 3,
        'gambit-implement': 3,
        'gambit-claude': 3,
        'gambit-codex': 3,
        'gambit-gemini': 3,
      },
      languageModelMetadata: {
        'gambit-orchestrator': {
          name: 'Gambit',
          family: 'gambit',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-review': {
          name: 'Gambit Review',
          family: 'gambit',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-debate': {
          name: 'Gambit Debate',
          family: 'gambit',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-implement': {
          name: 'Gambit Implement',
          family: 'gambit',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-claude': {
          name: 'Claude via Gambit',
          family: 'claude',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-codex': {
          name: 'Codex via Gambit',
          family: 'codex',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-gemini': {
          name: 'Gemini via Gambit',
          family: 'gemini',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
      },
      languageModelResponses: {
        'gambit-orchestrator': 'Routed to Codex\n[smoke:codex] write-capable request reached Gambit provider.',
        'gambit-review': '[smoke:claude] write-capable request reached Gambit provider.',
        'gambit-debate': '[smoke:claude] read-only request reached Gambit provider.\n[smoke:codex] read-only request reached Gambit provider.\n[smoke:gemini] read-only request reached Gambit provider.',
        'gambit-implement': '[smoke:claude] write-capable request reached Gambit provider.\n[smoke:codex] write-capable request reached Gambit provider.\n[smoke:gemini] write-capable request reached Gambit provider.',
        'gambit-claude': '[smoke:claude] write-capable request reached Gambit provider.',
        'gambit-codex': '[smoke:codex] write-capable request reached Gambit provider.',
        'gambit-gemini': '[smoke:gemini] write-capable request reached Gambit provider.',
      },
      commitHookLifecycle: {
        installed: true,
        removed: true,
        dispatchSentinelObserved: true,
        dispatchSentinelCleared: true,
      },
      uiEvidence: {
        gambitPanelOpened: true,
      },
    }))).toContain('Unexpected language model response evidence: gambit-review missing [smoke:claude] read-only request reached Gambit provider.');

    expect(validateSmokeResultContent(JSON.stringify({
      ok: true,
      extensionId: 'dontcallmejames.gambit',
      executedCommands: [
        'gambit.checkStatus',
        'gambit.openPanel',
        'gambit.showSetupGuide',
        'gambit.configureCliPaths',
        'gambit.installCommitHook',
        'gambit.uninstallCommitHook',
        'gambit.showCommitHookSnippet',
      ],
      languageModelTokenCounts: {
        'gambit-orchestrator': 3,
        'gambit-review': 3,
        'gambit-debate': 3,
        'gambit-implement': 3,
        'gambit-claude': 3,
        'gambit-codex': 3,
        'gambit-gemini': 3,
      },
      languageModelMetadata: {
        'gambit-orchestrator': {
          name: 'Gambit',
          family: 'gambit',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-review': {
          name: 'Gambit Review',
          family: 'gambit',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-debate': {
          name: 'Gambit Debate',
          family: 'gambit',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-implement': {
          name: 'Gambit Implement',
          family: 'gambit',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-claude': {
          name: 'Claude via Gambit',
          family: 'claude',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-codex': {
          name: 'Codex via Gambit',
          family: 'codex',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'gambit-gemini': {
          name: 'Gemini via Gambit',
          family: 'gemini',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
      },
      commitHookLifecycle: {
        installed: true,
        removed: true,
      },
    }))).toContain('Missing Gambit panel-open evidence.');
  });
});

function normalizePathText(value: string): string {
  return value.replace(/\\/g, '/');
}

function nativeSmokeEditEvidence(agentLabel: string, filePath: string): string {
  return `${agentLabel} created ${filePath}\n[reference:/workspace/${filePath}]`;
}

function languageModelSmokeEditEvidence(agentLabel: string, filePath: string): string {
  return `${agentLabel} created [${filePath}](file:///workspace/${filePath})`;
}
