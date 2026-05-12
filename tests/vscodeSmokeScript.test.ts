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

import { VEYRA_LANGUAGE_MODELS } from '../src/languageModelProvider.js';

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
      fileExists?: (path: string) => boolean,
    ): string;
    prepareSmokeDirectories(paths: SmokePaths): void;
    initializeSmokeGitRepository(
      workspaceDir: string,
      execFile?: (command: string, args: string[], options: unknown) => Buffer | string,
    ): void;
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
    const paths = smokePaths('C:/repo/veyra');
    const args = buildCodeSmokeArgs(paths).map(normalizePathText);

    expect(args).toContain('--new-window');
    expect(args).toContain('--wait');
    expect(args).toContain('--disable-extensions');
    expect(args).toContain('--disable-workspace-trust');
    expect(args).toContain('--disable-gpu');
    expect(args).toContain('--disable-chromium-sandbox');
    expect(args).toContain('--skip-welcome');
    expect(args).toContain('--skip-release-notes');
    expect(args).toContain('--extensionDevelopmentPath=C:/repo/veyra');
    expect(args).toContain('--extensionTestsPath=C:/repo/veyra/tests/extension-host/smoke.js');
    expect(args).toContain('--user-data-dir=C:/repo/veyra/.vscode-test/user-data');
    expect(args).toContain('--extensions-dir=C:/repo/veyra/.vscode-test/extensions');
    expect(args).toContain('C:/repo/veyra/.vscode-test/workspace');
  });

  it('passes a smoke-result sentinel path to the Extension Host test module', async () => {
    const { buildCodeSmokeEnv, smokePaths } = await smokeScriptModule();
    const paths = smokePaths('C:/repo/veyra');
    const env = buildCodeSmokeEnv(paths, { EXISTING: '1' });

    expect(env.EXISTING).toBe('1');
    expect(env.VSCODE_VEYRA_SMOKE).toBe('1');
    expect(normalizePathText(env.VSCODE_VEYRA_SMOKE_RESULT ?? '')).toBe(
      'C:/repo/veyra/.vscode-test/smoke-result.json',
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

  it('prefers the Windows code command script when PATH resolves code to Code.exe', async () => {
    const { resolveCodeCommand } = await smokeScriptModule();

    expect(normalizePathText(resolveCodeCommand(
      'code',
      'win32',
      () => 'C:/Users/tester/AppData/Local/Programs/Microsoft VS Code/Code.exe\r\n',
      (path) => normalizePathText(path) === 'C:/Users/tester/AppData/Local/Programs/Microsoft VS Code/bin/code.cmd',
    ))).toBe('C:/Users/tester/AppData/Local/Programs/Microsoft VS Code/bin/code.cmd');
  });

  it('reports missing build and smoke-test artifacts before launching VS Code', async () => {
    const { findMissingSmokePrerequisites, smokePaths } = await smokeScriptModule();
    const paths = smokePaths('C:/repo/veyra');

    expect(findMissingSmokePrerequisites(paths, () => false).map(normalizePathText)).toEqual([
      'C:/repo/veyra/dist/extension.js',
      'C:/repo/veyra/tests/extension-host/smoke.js',
    ]);
  });

  it('resets stale smoke workspace state before launching VS Code', async () => {
    const { prepareSmokeDirectories, smokePaths } = await smokeScriptModule();
    const root = mkdtempSync(join(tmpdir(), 'veyra-smoke-runner-'));
    const paths = smokePaths(root);
    const staleSessionPath = join(paths.workspaceDir, '.vscode', 'veyra', 'sessions.json');

    try {
      mkdirSync(join(paths.workspaceDir, '.vscode', 'veyra'), { recursive: true });
      writeFileSync(staleSessionPath, '{"messages":["stale"]}', 'utf8');

      prepareSmokeDirectories(paths);

      expect(existsSync(staleSessionPath)).toBe(false);
      expect(existsSync(paths.workspaceDir)).toBe(true);
      expect(existsSync(join(paths.workspaceDir, '.git'))).toBe(true);
      expect(existsSync(join(paths.workspaceDir, '.git', 'HEAD'))).toBe(true);
      expect(existsSync(join(paths.workspaceDir, 'src', 'codebase-context-smoke.ts'))).toBe(true);
      expect(existsSync(paths.userDataDir)).toBe(true);
      expect(existsSync(paths.extensionsDir)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a clear error when git is unavailable for smoke workspace setup', async () => {
    const { initializeSmokeGitRepository } = await smokeScriptModule();

    expect(() => initializeSmokeGitRepository(
      'C:/repo/veyra/.vscode-test/workspace',
      () => {
        throw new Error('git missing');
      },
    )).toThrow('VS Code smoke test requires git on PATH');
  });

  it('keeps smoke metadata expectations aligned with the language model provider source', async () => {
    const { requiredSmokeLanguageModels } = await smokeScriptModule();

    expect(Object.keys(requiredSmokeLanguageModels)).toContain('veyra-consensus');
    expect(requiredSmokeLanguageModels).toEqual(Object.fromEntries(
      VEYRA_LANGUAGE_MODELS.map((model) => [
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
      extensionId: 'dontcallmejames.veyra-vscode',
      executedCommands: [
        'veyra.checkStatus',
        'veyra.openPanel',
        'veyra.copyDiagnosticReport',
        'veyra.showSetupGuide',
        'veyra.showLiveValidationGuide',
        'veyra.configureCliPaths',
        'veyra.installCommitHook',
        'veyra.uninstallCommitHook',
        'veyra.showCommitHookSnippet',
      ],
      languageModelTokenCounts: {
        'veyra-orchestrator': 3,
        'veyra-review': 3,
        'veyra-debate': 3,
        'veyra-consensus': 3,
        'veyra-implement': 3,
        'veyra-claude': 3,
        'veyra-codex': 3,
        'veyra-gemini': 3,
      },
      languageModelMetadata: {
        'veyra-orchestrator': {
          name: 'Veyra',
          family: 'veyra',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-review': {
          name: 'Veyra Review',
          family: 'veyra',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-debate': {
          name: 'Veyra Debate',
          family: 'veyra',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-consensus': {
          name: 'Veyra Consensus',
          family: 'veyra',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-implement': {
          name: 'Veyra Implement',
          family: 'veyra',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-claude': {
          name: 'Claude via Veyra',
          family: 'claude',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-codex': {
          name: 'Codex via Veyra',
          family: 'codex',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-gemini': {
          name: 'Gemini via Veyra',
          family: 'gemini',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
      },
      languageModelResponses: {
        'veyra-orchestrator': [
          'Routed to Codex',
          '[smoke:codex] write-capable request reached Veyra provider.',
          languageModelSmokeEditEvidence('Codex', 'src/veyra-smoke-codex.ts'),
        ].join('\n'),
        'veyra-review': '[smoke:claude] read-only request reached Veyra provider.\n[smoke:codex] read-only request reached Veyra provider.\n[smoke:gemini] read-only request reached Veyra provider.',
        'veyra-debate': '[smoke:claude] read-only request reached Veyra provider.\n[smoke:codex] read-only request reached Veyra provider.\n[smoke:gemini] read-only request reached Veyra provider.',
        'veyra-consensus': '[smoke:claude] read-only request reached Veyra provider.\n[smoke:codex] read-only request reached Veyra provider.\n[smoke:gemini] read-only request reached Veyra provider.',
        'veyra-implement': [
          '[smoke:claude] write-capable request reached Veyra provider.',
          languageModelSmokeEditEvidence('Claude', 'src/veyra-smoke-claude.ts'),
          '[smoke:codex] write-capable request reached Veyra provider.',
          languageModelSmokeEditEvidence('Codex', 'src/veyra-smoke-codex.ts'),
          '[smoke:gemini] write-capable request reached Veyra provider.',
          languageModelSmokeEditEvidence('Gemini', 'src/veyra-smoke-gemini.ts'),
        ].join('\n'),
        'veyra-claude': [
          '[smoke:claude] write-capable request reached Veyra provider.',
          languageModelSmokeEditEvidence('Claude', 'src/veyra-smoke-claude.ts'),
        ].join('\n'),
        'veyra-codex': [
          '[smoke:codex] write-capable request reached Veyra provider.',
          languageModelSmokeEditEvidence('Codex', 'src/veyra-smoke-codex.ts'),
        ].join('\n'),
        'veyra-gemini': [
          '[smoke:gemini] write-capable request reached Veyra provider.',
          languageModelSmokeEditEvidence('Gemini', 'src/veyra-smoke-gemini.ts'),
        ].join('\n'),
      },
      chatParticipants: [
        {
          id: 'veyra.veyra',
          name: 'veyra',
          commands: ['review', 'debate', 'consensus', 'implement'],
        },
        {
          id: 'veyra.claude',
          name: 'claude',
          commands: [],
        },
        {
          id: 'veyra.codex',
          name: 'codex',
          commands: [],
        },
        {
          id: 'veyra.gemini',
          name: 'gemini',
          commands: [],
        },
      ],
      nativeChatRegistrations: [
        'veyra.veyra',
        'veyra.claude',
        'veyra.codex',
        'veyra.gemini',
      ],
      nativeWorkflowDiagnostics: {
        review: {
          forcedTarget: 'veyra',
          readOnly: true,
          containsAllMention: true,
          containsWorkflowMarker: true,
        },
        debate: {
          forcedTarget: 'veyra',
          readOnly: true,
          containsAllMention: true,
          containsWorkflowMarker: true,
        },
        consensus: {
          forcedTarget: 'veyra',
          readOnly: true,
          containsAllMention: true,
          containsWorkflowMarker: true,
        },
        implement: {
          forcedTarget: 'veyra',
          readOnly: false,
          containsAllMention: true,
          containsWorkflowMarker: true,
        },
      },
      nativeChatResponses: {
        'veyra.veyra': [
          'Routed to Codex',
          '[smoke:codex] write-capable request reached Veyra provider.',
          nativeSmokeEditEvidence('Codex', 'src/veyra-smoke-codex.ts'),
        ].join('\n'),
        'veyra.veyra/codebase': '[smoke:codex] saw @codebase workspace context.',
        'veyra.veyra/review': '[smoke:claude] read-only request reached Veyra provider.\n[smoke:codex] read-only request reached Veyra provider.\n[smoke:gemini] read-only request reached Veyra provider.',
        'veyra.veyra/debate': '[smoke:claude] read-only request reached Veyra provider.\n[smoke:codex] read-only request reached Veyra provider.\n[smoke:gemini] read-only request reached Veyra provider.',
        'veyra.veyra/consensus': '[smoke:claude] read-only request reached Veyra provider.\n[smoke:codex] read-only request reached Veyra provider.\n[smoke:gemini] read-only request reached Veyra provider.',
        'veyra.veyra/implement': [
          '[smoke:claude] write-capable request reached Veyra provider.',
          nativeSmokeEditEvidence('Claude', 'src/veyra-smoke-claude.ts'),
          '[smoke:codex] write-capable request reached Veyra provider.',
          nativeSmokeEditEvidence('Codex', 'src/veyra-smoke-codex.ts'),
          '[smoke:gemini] write-capable request reached Veyra provider.',
          nativeSmokeEditEvidence('Gemini', 'src/veyra-smoke-gemini.ts'),
        ].join('\n'),
        'veyra.claude': [
          '[smoke:claude] write-capable request reached Veyra provider.',
          nativeSmokeEditEvidence('Claude', 'src/veyra-smoke-claude.ts'),
        ].join('\n'),
        'veyra.codex': [
          '[smoke:codex] write-capable request reached Veyra provider.',
          nativeSmokeEditEvidence('Codex', 'src/veyra-smoke-codex.ts'),
        ].join('\n'),
        'veyra.gemini': [
          '[smoke:gemini] write-capable request reached Veyra provider.',
          nativeSmokeEditEvidence('Gemini', 'src/veyra-smoke-gemini.ts'),
        ].join('\n'),
      },
      editConflictEvidence: {
        nativeChat: [
          '[smoke:claude] write-capable request reached Veyra provider.',
          nativeSmokeEditEvidence('Claude', 'src/veyra-smoke-conflict.ts'),
          '[smoke:codex] write-capable request reached Veyra provider.',
          nativeSmokeEditEvidence('Codex', 'src/veyra-smoke-conflict.ts'),
          '**Edit conflict:** Codex created src/veyra-smoke-conflict.ts, which was already edited by Claude in this session.',
        ].join('\n'),
        languageModel: [
          '[smoke:claude] write-capable request reached Veyra provider.',
          languageModelSmokeEditEvidence('Claude', 'src/veyra-smoke-conflict.ts'),
          '[smoke:codex] write-capable request reached Veyra provider.',
          languageModelSmokeEditEvidence('Codex', 'src/veyra-smoke-conflict.ts'),
          '_Edit conflict: Codex created [src/veyra-smoke-conflict.ts](file:///workspace/src/veyra-smoke-conflict.ts), which was already edited by Claude, Gemini in this session._',
        ].join('\n'),
      },
      sharedContextEvidence: {
        nativeChat: [
          '[smoke:claude] write-capable request reached Veyra provider.',
          '[smoke:codex] saw prior Claude reply in shared context.',
          '[smoke:gemini] saw prior Claude and Codex replies in shared context.',
        ].join('\n'),
        languageModel: [
          '[smoke:claude] write-capable request reached Veyra provider.',
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
        veyraPanelOpened: true,
      },
      diagnosticReport: [
        '# Veyra Diagnostic Report',
        'Extension: dontcallmejames.veyra-vscode 0.0.8',
        'veyra.openPanel: registered',
        'veyra.copyDiagnosticReport: registered',
        'Claude: ready',
        'Codex: ready',
        'Gemini: ready',
      ].join('\n'),
    };
    expect(validateSmokeResultContent(JSON.stringify(completeSmokeResult))).toEqual([]);
    expect(validateSmokeResultContent(JSON.stringify({
      ...completeSmokeResult,
      nativeChatResponses: {
        ...completeSmokeResult.nativeChatResponses,
        'veyra.veyra/codebase': '',
      },
    }))).toContain('Missing native chat response evidence: veyra.veyra/codebase');
    expect(validateSmokeResultContent(JSON.stringify({
      ...completeSmokeResult,
      nativeChatResponses: {
        ...completeSmokeResult.nativeChatResponses,
        'veyra.veyra/implement': completeSmokeResult.nativeChatResponses['veyra.veyra/implement']
          .replace(nativeSmokeEditEvidence('Claude', 'src/veyra-smoke-claude.ts'), ''),
      },
    }))).toContain('Missing native chat visible edit evidence: veyra.veyra/implement must show Claude created src/veyra-smoke-claude.ts with a file reference.');

    expect(validateSmokeResultContent(JSON.stringify({
      ...completeSmokeResult,
      languageModelResponses: {
        ...completeSmokeResult.languageModelResponses,
        'veyra-implement': completeSmokeResult.languageModelResponses['veyra-implement']
          .replace(languageModelSmokeEditEvidence('Gemini', 'src/veyra-smoke-gemini.ts'), ''),
      },
    }))).toContain('Missing language model visible edit evidence: veyra-implement must show Gemini created src/veyra-smoke-gemini.ts as a workspace link.');

    expect(validateSmokeResultContent(JSON.stringify({
      ...completeSmokeResult,
      languageModelResponses: {
        ...completeSmokeResult.languageModelResponses,
        'veyra-review': `${completeSmokeResult.languageModelResponses['veyra-review']}\nRead-only workflow violation: Claude edited src/review.ts during a read-only dispatch.`,
      },
    }))).toContain('Unexpected language model response evidence: veyra-review reported a read-only workflow violation.');

    expect(validateSmokeResultContent(JSON.stringify({
      ...completeSmokeResult,
      languageModelResponses: {
        ...completeSmokeResult.languageModelResponses,
        'veyra-review': `${completeSmokeResult.languageModelResponses['veyra-review']}\nClaude edited .vscode/veyra/sessions.json`,
      },
    }))).toContain('Unexpected language model response evidence: veyra-review exposed Veyra internal state path.');

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
      extensionId: 'dontcallmejames.veyra-vscode',
      executedCommands: ['veyra.showSetupGuide'],
    }))).toContain('Missing smoke command execution: veyra.checkStatus');

    expect(validateSmokeResultContent(JSON.stringify({
      ok: true,
      extensionId: 'dontcallmejames.veyra-vscode',
      executedCommands: [
        'veyra.checkStatus',
        'veyra.openPanel',
        'veyra.showSetupGuide',
        'veyra.installCommitHook',
        'veyra.uninstallCommitHook',
        'veyra.showCommitHookSnippet',
      ],
    }))).toContain('Missing smoke command execution: veyra.configureCliPaths');
    expect(validateSmokeResultContent(JSON.stringify({
      ...completeSmokeResult,
      executedCommands: completeSmokeResult.executedCommands.filter(
        (command) => command !== 'veyra.showLiveValidationGuide',
      ),
    }))).toContain('Missing smoke command execution: veyra.showLiveValidationGuide');
    expect(validateSmokeResultContent(JSON.stringify({
      ...completeSmokeResult,
      executedCommands: completeSmokeResult.executedCommands.filter(
        (command) => command !== 'veyra.copyDiagnosticReport',
      ),
    }))).toContain('Missing smoke command execution: veyra.copyDiagnosticReport');
    expect(validateSmokeResultContent(JSON.stringify({
      ...completeSmokeResult,
      diagnosticReport: '',
    }))).toContain('Missing Veyra diagnostic report smoke evidence.');

    expect(validateSmokeResultContent(JSON.stringify({
      ok: true,
      extensionId: 'dontcallmejames.veyra-vscode',
      executedCommands: [
        'veyra.checkStatus',
        'veyra.openPanel',
        'veyra.showSetupGuide',
        'veyra.configureCliPaths',
        'veyra.installCommitHook',
        'veyra.uninstallCommitHook',
        'veyra.showCommitHookSnippet',
      ],
    }))).toContain('Missing language model token count: veyra-orchestrator');

    expect(validateSmokeResultContent(JSON.stringify({
      ok: true,
      extensionId: 'dontcallmejames.veyra-vscode',
      executedCommands: [
        'veyra.checkStatus',
        'veyra.openPanel',
        'veyra.showSetupGuide',
        'veyra.configureCliPaths',
        'veyra.installCommitHook',
        'veyra.uninstallCommitHook',
        'veyra.showCommitHookSnippet',
      ],
      languageModelTokenCounts: {
        'veyra-orchestrator': 3,
        'veyra-review': 3,
        'veyra-debate': 3,
        'veyra-implement': 3,
        'veyra-claude': 3,
        'veyra-codex': 3,
        'veyra-gemini': 3,
      },
    }))).toContain('Missing commit hook lifecycle evidence.');

    expect(validateSmokeResultContent(JSON.stringify({
      ok: true,
      extensionId: 'dontcallmejames.veyra-vscode',
      executedCommands: [
        'veyra.checkStatus',
        'veyra.openPanel',
        'veyra.showSetupGuide',
        'veyra.configureCliPaths',
        'veyra.installCommitHook',
        'veyra.uninstallCommitHook',
        'veyra.showCommitHookSnippet',
      ],
      languageModelTokenCounts: {
        'veyra-orchestrator': 3,
        'veyra-review': 3,
        'veyra-debate': 3,
        'veyra-implement': 3,
        'veyra-claude': 3,
        'veyra-codex': 3,
        'veyra-gemini': 3,
      },
      commitHookLifecycle: {
        installed: true,
        removed: true,
      },
    }))).toContain('Missing language model metadata: veyra-orchestrator');

    expect(validateSmokeResultContent(JSON.stringify({
      ...completeSmokeResult,
      nativeChatRegistrations: [
        'veyra.veyra',
        'veyra.claude',
        'veyra.codex',
      ],
    }))).toContain('Missing native chat registration evidence: veyra.gemini');

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
        'veyra.veyra/review': '[smoke:claude] write-capable request reached Veyra provider.',
      },
    }))).toContain('Unexpected native chat response evidence: veyra.veyra/review missing [smoke:claude] read-only request reached Veyra provider.');

    expect(validateSmokeResultContent(JSON.stringify({
      ...completeSmokeResult,
      nativeChatResponses: {
        ...completeSmokeResult.nativeChatResponses,
        'veyra.veyra/review': `${completeSmokeResult.nativeChatResponses['veyra.veyra/review']}\nRead-only workflow violation: Claude edited src/review.ts during a read-only dispatch.`,
      },
    }))).toContain('Unexpected native chat response evidence: veyra.veyra/review reported a read-only workflow violation.');

    expect(validateSmokeResultContent(JSON.stringify({
      ok: true,
      extensionId: 'dontcallmejames.veyra-vscode',
      executedCommands: [
        'veyra.checkStatus',
        'veyra.openPanel',
        'veyra.showSetupGuide',
        'veyra.configureCliPaths',
        'veyra.installCommitHook',
        'veyra.uninstallCommitHook',
        'veyra.showCommitHookSnippet',
      ],
      languageModelTokenCounts: {
        'veyra-orchestrator': 3,
        'veyra-review': 3,
        'veyra-debate': 3,
        'veyra-implement': 3,
        'veyra-claude': 3,
        'veyra-codex': 3,
        'veyra-gemini': 3,
      },
      languageModelMetadata: {
        'veyra-orchestrator': {
          name: 'Veyra',
          family: 'veyra',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-review': {
          name: 'Veyra Review',
          family: 'veyra',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-debate': {
          name: 'Veyra Debate',
          family: 'veyra',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-implement': {
          name: 'Veyra Implement',
          family: 'veyra',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-claude': {
          name: 'Claude via Veyra',
          family: 'claude',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-codex': {
          name: 'Codex via Veyra',
          family: 'codex',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-gemini': {
          name: 'Gemini via Veyra',
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
        veyraPanelOpened: true,
      },
    }))).toContain('Missing native chat participant evidence: veyra.veyra');

    expect(validateSmokeResultContent(JSON.stringify({
      ...completeSmokeResult,
      nativeChatResponses: {
        ...completeSmokeResult.nativeChatResponses,
        'veyra.veyra/implement': '',
      },
    }))).toContain('Missing native chat response evidence: veyra.veyra/implement');

    expect(validateSmokeResultContent(JSON.stringify({
      ok: true,
      extensionId: 'dontcallmejames.veyra-vscode',
      executedCommands: [
        'veyra.checkStatus',
        'veyra.openPanel',
        'veyra.showSetupGuide',
        'veyra.configureCliPaths',
        'veyra.installCommitHook',
        'veyra.uninstallCommitHook',
        'veyra.showCommitHookSnippet',
      ],
      chatParticipants: [
        {
          id: 'veyra.veyra',
          name: 'veyra',
          commands: ['review', 'debate', 'implement'],
        },
        {
          id: 'veyra.claude',
          name: 'claude',
          commands: [],
        },
        {
          id: 'veyra.codex',
          name: 'codex',
          commands: [],
        },
        {
          id: 'veyra.gemini',
          name: 'gemini',
          commands: [],
        },
      ],
      languageModelTokenCounts: {
        'veyra-orchestrator': 3,
        'veyra-review': 3,
        'veyra-debate': 3,
        'veyra-implement': 3,
        'veyra-claude': 3,
        'veyra-codex': 3,
        'veyra-gemini': 3,
      },
      languageModelMetadata: {
        'veyra-orchestrator': {
          name: 'Veyra',
          family: 'veyra',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-review': {
          name: 'Veyra Review',
          family: 'veyra',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-debate': {
          name: 'Veyra Debate',
          family: 'veyra',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-implement': {
          name: 'Veyra Implement',
          family: 'veyra',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-claude': {
          name: 'Claude via Veyra',
          family: 'claude',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-codex': {
          name: 'Codex via Veyra',
          family: 'codex',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-gemini': {
          name: 'Gemini via Veyra',
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
        veyraPanelOpened: true,
      },
    }))).toContain('Missing language model response evidence: veyra-orchestrator');

    expect(validateSmokeResultContent(JSON.stringify({
      ok: true,
      extensionId: 'dontcallmejames.veyra-vscode',
      executedCommands: [
        'veyra.checkStatus',
        'veyra.openPanel',
        'veyra.showSetupGuide',
        'veyra.configureCliPaths',
        'veyra.installCommitHook',
        'veyra.uninstallCommitHook',
        'veyra.showCommitHookSnippet',
      ],
      chatParticipants: [
        {
          id: 'veyra.veyra',
          name: 'veyra',
          commands: ['review', 'debate', 'implement'],
        },
        {
          id: 'veyra.claude',
          name: 'claude',
          commands: [],
        },
        {
          id: 'veyra.codex',
          name: 'codex',
          commands: [],
        },
        {
          id: 'veyra.gemini',
          name: 'gemini',
          commands: [],
        },
      ],
      languageModelTokenCounts: {
        'veyra-orchestrator': 3,
        'veyra-review': 3,
        'veyra-debate': 3,
        'veyra-implement': 3,
        'veyra-claude': 3,
        'veyra-codex': 3,
        'veyra-gemini': 3,
      },
      languageModelMetadata: {
        'veyra-orchestrator': {
          name: 'Veyra',
          family: 'veyra',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-review': {
          name: 'Veyra Review',
          family: 'veyra',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-debate': {
          name: 'Veyra Debate',
          family: 'veyra',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-implement': {
          name: 'Veyra Implement',
          family: 'veyra',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-claude': {
          name: 'Claude via Veyra',
          family: 'claude',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-codex': {
          name: 'Codex via Veyra',
          family: 'codex',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-gemini': {
          name: 'Gemini via Veyra',
          family: 'gemini',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
      },
      languageModelResponses: {
        'veyra-orchestrator': 'Routed to Codex\n[smoke:codex] write-capable request reached Veyra provider.',
        'veyra-review': '[smoke:claude] read-only request reached Veyra provider.\n[smoke:codex] read-only request reached Veyra provider.\n[smoke:gemini] read-only request reached Veyra provider.',
        'veyra-debate': '[smoke:claude] read-only request reached Veyra provider.\n[smoke:codex] read-only request reached Veyra provider.\n[smoke:gemini] read-only request reached Veyra provider.',
        'veyra-implement': '[smoke:claude] write-capable request reached Veyra provider.\n[smoke:codex] write-capable request reached Veyra provider.\n[smoke:gemini] write-capable request reached Veyra provider.',
        'veyra-claude': '[smoke:claude] write-capable request reached Veyra provider.',
        'veyra-codex': '[smoke:codex] write-capable request reached Veyra provider.',
        'veyra-gemini': '[smoke:gemini] write-capable request reached Veyra provider.',
      },
      commitHookLifecycle: {
        installed: true,
        removed: true,
      },
      uiEvidence: {
        veyraPanelOpened: true,
      },
    }))).toContain('Missing active dispatch sentinel lifecycle evidence.');

    expect(validateSmokeResultContent(JSON.stringify({
      ok: true,
      extensionId: 'dontcallmejames.veyra-vscode',
      executedCommands: [
        'veyra.checkStatus',
        'veyra.openPanel',
        'veyra.showSetupGuide',
        'veyra.configureCliPaths',
        'veyra.installCommitHook',
        'veyra.uninstallCommitHook',
        'veyra.showCommitHookSnippet',
      ],
      chatParticipants: [
        {
          id: 'veyra.veyra',
          name: 'veyra',
          commands: ['review', 'debate', 'implement'],
        },
        {
          id: 'veyra.claude',
          name: 'claude',
          commands: [],
        },
        {
          id: 'veyra.codex',
          name: 'codex',
          commands: [],
        },
        {
          id: 'veyra.gemini',
          name: 'gemini',
          commands: [],
        },
      ],
      languageModelTokenCounts: {
        'veyra-orchestrator': 3,
        'veyra-review': 3,
        'veyra-debate': 3,
        'veyra-implement': 3,
        'veyra-claude': 3,
        'veyra-codex': 3,
        'veyra-gemini': 3,
      },
      languageModelMetadata: {
        'veyra-orchestrator': {
          name: 'Veyra',
          family: 'veyra',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-review': {
          name: 'Veyra Review',
          family: 'veyra',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-debate': {
          name: 'Veyra Debate',
          family: 'veyra',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-implement': {
          name: 'Veyra Implement',
          family: 'veyra',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-claude': {
          name: 'Claude via Veyra',
          family: 'claude',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-codex': {
          name: 'Codex via Veyra',
          family: 'codex',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-gemini': {
          name: 'Gemini via Veyra',
          family: 'gemini',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
      },
      languageModelResponses: {
        'veyra-orchestrator': 'Routed to Codex\n[smoke:codex] write-capable request reached Veyra provider.',
        'veyra-review': '[smoke:claude] write-capable request reached Veyra provider.',
        'veyra-debate': '[smoke:claude] read-only request reached Veyra provider.\n[smoke:codex] read-only request reached Veyra provider.\n[smoke:gemini] read-only request reached Veyra provider.',
        'veyra-implement': '[smoke:claude] write-capable request reached Veyra provider.\n[smoke:codex] write-capable request reached Veyra provider.\n[smoke:gemini] write-capable request reached Veyra provider.',
        'veyra-claude': '[smoke:claude] write-capable request reached Veyra provider.',
        'veyra-codex': '[smoke:codex] write-capable request reached Veyra provider.',
        'veyra-gemini': '[smoke:gemini] write-capable request reached Veyra provider.',
      },
      commitHookLifecycle: {
        installed: true,
        removed: true,
        dispatchSentinelObserved: true,
        dispatchSentinelCleared: true,
      },
      uiEvidence: {
        veyraPanelOpened: true,
      },
    }))).toContain('Unexpected language model response evidence: veyra-review missing [smoke:claude] read-only request reached Veyra provider.');

    expect(validateSmokeResultContent(JSON.stringify({
      ok: true,
      extensionId: 'dontcallmejames.veyra-vscode',
      executedCommands: [
        'veyra.checkStatus',
        'veyra.openPanel',
        'veyra.showSetupGuide',
        'veyra.configureCliPaths',
        'veyra.installCommitHook',
        'veyra.uninstallCommitHook',
        'veyra.showCommitHookSnippet',
      ],
      languageModelTokenCounts: {
        'veyra-orchestrator': 3,
        'veyra-review': 3,
        'veyra-debate': 3,
        'veyra-implement': 3,
        'veyra-claude': 3,
        'veyra-codex': 3,
        'veyra-gemini': 3,
      },
      languageModelMetadata: {
        'veyra-orchestrator': {
          name: 'Veyra',
          family: 'veyra',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-review': {
          name: 'Veyra Review',
          family: 'veyra',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-debate': {
          name: 'Veyra Debate',
          family: 'veyra',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-implement': {
          name: 'Veyra Implement',
          family: 'veyra',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-claude': {
          name: 'Claude via Veyra',
          family: 'claude',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-codex': {
          name: 'Codex via Veyra',
          family: 'codex',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
        'veyra-gemini': {
          name: 'Gemini via Veyra',
          family: 'gemini',
          version: 'local-cli',
          maxInputTokens: 128000,
        },
      },
      commitHookLifecycle: {
        installed: true,
        removed: true,
      },
    }))).toContain('Missing Veyra panel-open evidence.');
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
