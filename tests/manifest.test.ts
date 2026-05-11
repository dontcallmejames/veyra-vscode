import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import manifest from '../package.json';
import lockfile from '../package-lock.json';

vi.mock('vscode', () => ({
  ThemeIcon: class {
    constructor(public id: string) {}
  },
  chat: {
    createChatParticipant: vi.fn(),
  },
  lm: {
    registerLanguageModelChatProvider: vi.fn(),
  },
  LanguageModelChatMessageRole: {
    User: 1,
    Assistant: 2,
  },
  LanguageModelTextPart: class {
    constructor(public value: string) {}
  },
  Uri: {
    file: (path: string) => ({ fsPath: path }),
  },
}));

import { NATIVE_CHAT_PARTICIPANTS } from '../src/nativeChat.js';
import { VEYRA_LANGUAGE_MODELS } from '../src/languageModelProvider.js';

describe('extension manifest', () => {
  it('declares the VS Code API floor used by native chat and language model providers', () => {
    expect(manifest.engines.vscode).toBe('^1.118.0');
    expect(manifest.devDependencies['@types/vscode']).toBe('^1.118.0');
  });

  it('describes the actual Claude, Codex, and Gemini backend set', () => {
    expect(manifest.description).toContain('Claude');
    expect(manifest.description).toContain('Codex');
    expect(manifest.description).toContain('Gemini');
    expect(manifest.description).toContain('VS Code Chat');
    expect(manifest.description).toContain('Language Model');
    expect(manifest.description).not.toMatch(/chat panel/i);
    expect(manifest.description).not.toMatch(/\bGPT\b/i);
  });

  it('keeps manifest text ASCII-safe for VS Code packaging metadata', () => {
    const rawManifest = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
    expect(rawManifest).not.toMatch(/[^\x00-\x7F]/);
  });

  it('declares Marketplace preview listing metadata and assets', () => {
    const manifestRecord = manifest as Record<string, unknown>;
    const icon = readFileSync(join(process.cwd(), 'resources', 'icon.png'));

    expect(manifest.name).toBe('veyra-vscode');
    expect(manifest.displayName).toBe('Veyra');
    expect(manifestRecord.private).toBeUndefined();
    expect(manifest.preview).toBe(true);
    expect(manifest.license).toBe('SEE LICENSE IN LICENSE.txt');
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'https://github.com/dontcallmejames/veyra-vscode.git',
    });
    expect(manifest.bugs).toEqual({
      url: 'https://github.com/dontcallmejames/veyra-vscode/issues',
    });
    expect(manifest.homepage).toBe('https://github.com/dontcallmejames/veyra-vscode#readme');
    expect(manifest.icon).toBe('resources/icon.png');
    expect(manifest.galleryBanner).toEqual({
      color: '#15171a',
      theme: 'dark',
    });
    expect(manifest.keywords).toEqual([
      'ai',
      'agents',
      'chat',
      'claude',
      'codex',
      'gemini',
      'workflow',
      'vscode',
    ]);
    expect(existsSync(join(process.cwd(), 'LICENSE.txt'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'CHANGELOG.md'))).toBe(true);
    expect(icon.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(icon.readUInt32BE(16)).toBe(128);
    expect(icon.readUInt32BE(20)).toBe(128);
  });

  it('uses the package files allowlist as the single VSIX inclusion strategy', () => {
    expect(existsSync(join(process.cwd(), '.vscodeignore'))).toBe(false);
    expect(manifest.files).toContain('package.json');
    expect(manifest.files).not.toContain('.vscodeignore');
  });

  it('backs the Run Extension launch config with an explicit build task', () => {
    const launch = JSON.parse(readFileSync(join(process.cwd(), '.vscode', 'launch.json'), 'utf8'));
    const tasksPath = join(process.cwd(), '.vscode', 'tasks.json');
    expect(existsSync(tasksPath)).toBe(true);
    const tasks = JSON.parse(readFileSync(tasksPath, 'utf8'));
    const runExtension = launch.configurations.find(
      (configuration: { name?: string }) => configuration.name === 'Run Extension',
    );

    expect(runExtension).toMatchObject({
      type: 'extensionHost',
      request: 'launch',
      preLaunchTask: 'npm: build',
    });
    expect(runExtension.args).toContain('--extensionDevelopmentPath=${workspaceFolder}');
    expect(runExtension.outFiles).toContain('${workspaceFolder}/dist/**/*.js');

    const buildTask = tasks.tasks.find(
      (task: { label?: string }) => task.label === runExtension.preLaunchTask,
    );
    expect(buildTask).toMatchObject({
      label: 'npm: build',
      type: 'npm',
      script: 'build',
    });
    expect(buildTask.problemMatcher).toEqual([]);
  });

  it('keeps package-lock root metadata synchronized with package.json', () => {
    expect(lockfile.name).toBe(manifest.name);
    expect(lockfile.version).toBe(manifest.version);
    expect(lockfile.packages[''].name).toBe(manifest.name);
    expect(lockfile.packages[''].version).toBe(manifest.version);
    expect(lockfile.packages[''].engines).toEqual(manifest.engines);
    expect(lockfile.packages[''].devDependencies['@types/vscode']).toBe(
      manifest.devDependencies['@types/vscode'],
    );
  });

  it('provides a single local verification script for release readiness checks', () => {
    expect(manifest.scripts.verify).toBe(
      'npm run typecheck && npm test && npm run build && npm run verify:package && npm run test:integration && git diff --check',
    );
    expect(manifest.scripts.test).toBe(
      'vitest run --passWithNoTests --environment node --exclude "tests/integration/**" --exclude ".vscode-test/**" tests',
    );
    expect(manifest.scripts['verify:package']).toBe('node scripts/verify-package.mjs');
    expect(manifest.scripts['verify:live-ready']).toBe('node scripts/verify-live-ready.mjs');
    expect(manifest.scripts['verify:completion']).toBe('npm run verify && npm run test:vscode-smoke && npm run verify:live-ready');
    expect(manifest.scripts['preverify:goal']).toBe('node scripts/require-live-opt-in.mjs');
    expect(manifest.scripts['verify:goal']).toBe('npm run verify:completion && npm run test:integration:live');
    expect(manifest.scripts['package:vsix']).toBe(
      'npm run build && npm run verify:package && node scripts/package-vsix.mjs',
    );
    expect(manifest.scripts['test:vscode-smoke']).toBe('npm run build && node scripts/run-vscode-smoke.mjs');
    expect(manifest.scripts['test:integration']).toContain('--exclude ".vscode-test/**"');
    expect(manifest.scripts['pretest:integration:live']).toBe(
      'node scripts/require-live-opt-in.mjs && npm run verify:live-ready',
    );
    expect(manifest.scripts['test:integration:live']).toContain('--exclude ".vscode-test/**"');
    expect(manifest.scripts['test:integration:live']).toContain('tests/integration/veyra.live.test.ts');

    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
    const audit = readFileSync(join(process.cwd(), 'docs', 'goal-completion-audit.md'), 'utf8');
    const smokeChecklist = readFileSync(join(process.cwd(), 'docs', 'vscode-smoke-test.md'), 'utf8');
    const liveReadme = readFileSync(join(process.cwd(), 'tests', 'integration', 'README.md'), 'utf8');
    expect(readme).toContain('npm run verify:completion');
    expect(readme).toContain('npm run verify:goal');
    expect(readme).toContain('Run Extension');
    expect(readme).toContain('F5');
    expect(readme).toContain('.vscode/launch.json');
    expect(readme).toContain('Veyra: Show live validation guide');
    expect(readme).toContain('Veyra: Configure Codex/Gemini CLI paths');
    expect(readme).toContain('explicit JS bundle, native executable, or npm shim paths');
    expect(readme).toContain('stale PATH shims');
    expect(readme).toContain('falls back to `npm root -g`');
    expect(readme).toContain('shared-context relay');
    expect(readme).toContain('write-capable implementation');
    expect(readme).toContain("Remove-Item Env:\\VEYRA_RUN_LIVE -ErrorAction SilentlyContinue");
    expect(readme).toContain("stays set for the current terminal session");
    expect(audit).toContain('npm run verify:completion');
    expect(audit).toContain('npm run verify:goal');
    expect(audit).toContain('Veyra: Show live validation guide');
    expect(audit).toContain('Veyra: Configure Codex/Gemini CLI paths');
    expect(smokeChecklist).toContain('paste JS bundle paths, native executable paths, or npm shim paths');
    expect(smokeChecklist).toContain('skips stale PATH shims');
    expect(smokeChecklist).toContain('Veyra: Show live validation guide');
    expect(smokeChecklist).toContain('reports inaccessible, misconfigured, or Node.js missing');
    expect(smokeChecklist).toContain('install Node.js or switch to native executable paths');
    expect(smokeChecklist).toContain('Before sending prompts that can reach paid backends');
    expect(smokeChecklist).toContain('npm run verify:goal');
    expect(smokeChecklist).toContain('npm: build');
    expect(smokeChecklist).toContain('.vscode/launch.json');
    expect(smokeChecklist).toContain('Continue only when Claude, Codex, and Gemini all report `ready`');
    expect(liveReadme).toContain('all-agent Veyra handoff');
    expect(liveReadme).toContain('first requires the explicit `VEYRA_RUN_LIVE=1` paid-prompt opt-in');
    expect(liveReadme).toContain('then automatically runs `npm run verify:live-ready`');
    expect(liveReadme).toContain('npm run verify:goal');
    expect(liveReadme).toContain("$env:VEYRA_RUN_LIVE = '1'");
    expect(liveReadme).toContain('In Bash-compatible shells');
    expect(liveReadme).toContain('Remove-Item Env:\\VEYRA_RUN_LIVE -ErrorAction SilentlyContinue');
    expect(liveReadme).toContain('VEYRA_CODEX_CLI_PATH');
    expect(liveReadme).toContain('VEYRA_GEMINI_CLI_PATH');
    expect(liveReadme).toContain('veyra.codexCliPath');
    expect(liveReadme).toContain('veyra.geminiCliPath');
    expect(liveReadme).toContain('JS bundle paths, native executables, or Windows npm shim paths');
    expect(liveReadme).toContain('resolved to the underlying JS bundle');
    expect(liveReadme).toContain('Node.js');
    expect(liveReadme).toContain('node` command is on PATH');
    expect(liveReadme).toContain('first uses native `codex.exe` and `gemini.exe` executables on PATH');
    expect(liveReadme).toContain('then recognized PATH npm shims');
    expect(liveReadme).toContain('missing derived bundle targets are skipped');
    expect(liveReadme).toContain('Native executable paths do not need the JS-bundle Node launcher');
  });

  it('contributes settings for explicit Codex and Gemini CLI bundle paths', () => {
    const properties = manifest.contributes.configuration.properties;

    expect(properties['veyra.codexCliPath']).toMatchObject({
      type: 'string',
      default: '',
    });
    const codexPattern = new RegExp(properties['veyra.codexCliPath'].pattern);
    expect(codexPattern.test('')).toBe(true);
    expect(codexPattern.test('C:\\tools\\codex.js')).toBe(true);
    expect(codexPattern.test('C:\\tools\\codex.exe')).toBe(true);
    expect(codexPattern.test('/usr/local/bin/codex')).toBe(true);
    expect(codexPattern.test('C:\\tools\\not-codex.exe')).toBe(false);
    expect(codexPattern.test('C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd')).toBe(true);
    expect(codexPattern.test('C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.ps1')).toBe(true);
    expect(properties['veyra.codexCliPath'].patternErrorMessage).toContain('codex.js, codex.exe, codex, codex.cmd, codex.bat, or codex.ps1');
    expect(properties['veyra.codexCliPath'].description).toContain('VEYRA_CODEX_CLI_PATH');
    expect(properties['veyra.codexCliPath'].description).toContain('Windows');
    expect(properties['veyra.codexCliPath'].description).toContain('.cmd');
    expect(properties['veyra.codexCliPath'].description).toContain('JS bundle');
    expect(properties['veyra.codexCliPath'].description).toContain('resolved to');
    expect(properties['veyra.codexCliPath'].description).toContain('codex.exe');
    expect(properties['veyra.geminiCliPath']).toMatchObject({
      type: 'string',
      default: '',
    });
    const geminiPattern = new RegExp(properties['veyra.geminiCliPath'].pattern);
    expect(geminiPattern.test('')).toBe(true);
    expect(geminiPattern.test('C:\\tools\\gemini.js')).toBe(true);
    expect(geminiPattern.test('C:\\tools\\gemini.exe')).toBe(true);
    expect(geminiPattern.test('/usr/local/bin/gemini')).toBe(true);
    expect(geminiPattern.test('C:\\tools\\not-gemini.exe')).toBe(false);
    expect(geminiPattern.test('C:\\Users\\tester\\AppData\\Roaming\\npm\\gemini.cmd')).toBe(true);
    expect(geminiPattern.test('C:\\Users\\tester\\AppData\\Roaming\\npm\\gemini.ps1')).toBe(true);
    expect(properties['veyra.geminiCliPath'].patternErrorMessage).toContain('gemini.js, gemini.exe, gemini, gemini.cmd, gemini.bat, or gemini.ps1');
    expect(properties['veyra.geminiCliPath'].description).toContain('VEYRA_GEMINI_CLI_PATH');
    expect(properties['veyra.geminiCliPath'].description).toContain('Windows');
    expect(properties['veyra.geminiCliPath'].description).toContain('.cmd');
    expect(properties['veyra.geminiCliPath'].description).toContain('JS bundle');
    expect(properties['veyra.geminiCliPath'].description).toContain('resolved to');
    expect(properties['veyra.geminiCliPath'].description).toContain('gemini.exe');
  });

  it('contributes workspace context settings documented in the README', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const properties = manifest.contributes.configuration.properties;
    expect(properties['veyra.workspaceContext.maxFiles']).toMatchObject({
      type: 'number',
      default: 8,
      minimum: 1,
    });
    expect(properties['veyra.workspaceContext.maxSnippetLines']).toMatchObject({
      type: 'number',
      default: 80,
      minimum: 1,
    });
    expect(properties['veyra.workspaceContext.maxFileBytes']).toMatchObject({
      type: 'number',
      default: 1000000,
      minimum: 1024,
    });

    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
    expect(readme).toContain('@codebase');
    expect(readme).toContain('veyra.workspaceContext.maxFiles');
    expect(readme).toContain('veyra.workspaceContext.maxSnippetLines');
    expect(readme).toContain('veyra.workspaceContext.maxFileBytes');
  });

  it('contributes diff preview commands and settings', () => {
    const properties = manifest.contributes.configuration.properties;
    const commands = new Map(manifest.contributes.commands.map((command) => [command.command, command.title]));
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');

    expect(manifest.contributes.commands.map((command) => command.command)).toContain('veyra.openPendingChanges');
    expect(manifest.contributes.commands.map((command) => command.command)).toContain('veyra.acceptPendingChanges');
    expect(manifest.contributes.commands.map((command) => command.command)).toContain('veyra.rejectPendingChanges');
    expect(commands.get('veyra.openPendingChanges')).toBe('Veyra: Open Pending Changes');
    expect(commands.get('veyra.acceptPendingChanges')).toBe('Veyra: Accept Pending Changes');
    expect(commands.get('veyra.rejectPendingChanges')).toBe('Veyra: Reject Pending Changes');
    expect(manifest.activationEvents).toContain('onCommand:veyra.openPendingChanges');
    expect(manifest.activationEvents).toContain('onCommand:veyra.acceptPendingChanges');
    expect(manifest.activationEvents).toContain('onCommand:veyra.rejectPendingChanges');
    expect(properties['veyra.diffPreview.enabled']).toMatchObject({
      type: 'boolean',
      default: true,
    });
    expect(properties['veyra.diffPreview.maxFileBytes']).toMatchObject({
      type: 'number',
      default: 1000000,
      minimum: 1024,
    });
    expect(readme).toContain('Veyra: Open Pending Changes');
    expect(readme).toContain('Veyra: Accept Pending Changes');
    expect(readme).toContain('Veyra: Reject Pending Changes');
    expect(readme).toContain('veyra.diffPreview.enabled');
    expect(readme).toContain('veyra.diffPreview.maxFileBytes');
  });

  it('contributes checkpoint commands and settings', () => {
    const properties = manifest.contributes.configuration.properties;
    const commands = new Map(manifest.contributes.commands.map((command) => [command.command, command.title]));
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');

    expect(manifest.contributes.commands.map((command) => command.command)).toContain('veyra.createCheckpoint');
    expect(manifest.contributes.commands.map((command) => command.command)).toContain('veyra.listCheckpoints');
    expect(manifest.contributes.commands.map((command) => command.command)).toContain('veyra.rollbackLatestCheckpoint');
    expect(commands.get('veyra.createCheckpoint')).toBe('Veyra: Create Checkpoint');
    expect(commands.get('veyra.listCheckpoints')).toBe('Veyra: List Checkpoints');
    expect(commands.get('veyra.rollbackLatestCheckpoint')).toBe('Veyra: Roll Back Latest Checkpoint');
    expect(manifest.activationEvents).toContain('onCommand:veyra.createCheckpoint');
    expect(manifest.activationEvents).toContain('onCommand:veyra.listCheckpoints');
    expect(manifest.activationEvents).toContain('onCommand:veyra.rollbackLatestCheckpoint');
    expect(properties['veyra.checkpoints.enabled']).toMatchObject({
      type: 'boolean',
      default: true,
    });
    expect(properties['veyra.checkpoints.maxFileBytes']).toMatchObject({
      type: 'number',
      default: 1000000,
      minimum: 1024,
    });
    expect(properties['veyra.checkpoints.maxCount']).toMatchObject({
      type: 'number',
      default: 20,
      minimum: 1,
      maximum: 100,
    });
    expect(readme).toContain('Veyra: Create Checkpoint');
    expect(readme).toContain('Veyra: List Checkpoints');
    expect(readme).toContain('Veyra: Roll Back Latest Checkpoint');
    expect(readme).toContain('veyra.checkpoints.enabled');
    expect(readme).toContain('veyra.checkpoints.maxFileBytes');
    expect(readme).toContain('veyra.checkpoints.maxCount');
  });

  it('contributes command-palette entries for panel, status, and commit-hook operations', () => {
    expect(manifest.contributes.commands.map((command) => command.command)).toEqual([
      'veyra.openPanel',
      'veyra.checkStatus',
      'veyra.showSetupGuide',
      'veyra.showLiveValidationGuide',
      'veyra.configureCliPaths',
      'veyra.installCommitHook',
      'veyra.uninstallCommitHook',
      'veyra.showCommitHookSnippet',
      'veyra.openPendingChanges',
      'veyra.acceptPendingChanges',
      'veyra.rejectPendingChanges',
      'veyra.createCheckpoint',
      'veyra.listCheckpoints',
      'veyra.rollbackLatestCheckpoint',
    ]);
    expect(manifest.activationEvents).toContain('onCommand:veyra.checkStatus');
    expect(manifest.activationEvents).toContain('onCommand:veyra.showSetupGuide');
    expect(manifest.activationEvents).toContain('onCommand:veyra.showLiveValidationGuide');
    expect(manifest.activationEvents).toContain('onCommand:veyra.configureCliPaths');
  });

  it('activates and contributes every native chat participant', () => {
    const activationEvents = new Set(manifest.activationEvents);
    const contributed = new Map(
      manifest.contributes.chatParticipants.map((participant) => [participant.id, participant]),
    );

    for (const participant of NATIVE_CHAT_PARTICIPANTS) {
      expect(activationEvents.has(`onChatParticipant:${participant.id}`)).toBe(true);
      expect(contributed.get(participant.id)).toMatchObject({
        id: participant.id,
        name: participant.name,
        fullName: participant.fullName,
        description: participant.description,
      });
    }
  });

  it('contributes the Veyra slash workflows on the orchestrator participant', () => {
    const veyra = manifest.contributes.chatParticipants.find(
      (participant) => participant.id === 'veyra.veyra',
    );

    expect(veyra?.commands?.map((command) => command.name)).toEqual([
      'review',
      'debate',
      'implement',
    ]);
  });

  it('describes /review and /debate as read-only all-agent workflows', () => {
    const veyra = manifest.contributes.chatParticipants.find(
      (participant) => participant.id === 'veyra.veyra',
    );
    const review = veyra?.commands?.find((command) => command.name === 'review');
    const debate = veyra?.commands?.find((command) => command.name === 'debate');

    for (const command of [review, debate]) {
      expect(command?.description).toMatch(/Claude, Codex, and Gemini/);
      expect(command?.description).toMatch(/read-only/i);
    }
  });

  it('describes /implement as a serial all-agent workflow', () => {
    const veyra = manifest.contributes.chatParticipants.find(
      (participant) => participant.id === 'veyra.veyra',
    );
    const implement = veyra?.commands?.find((command) => command.name === 'implement');

    expect(implement?.description).toMatch(/Claude, Codex, and Gemini/);
    expect(implement?.description).toMatch(/serial/i);
    expect(implement?.description).not.toMatch(/choose the right agent path/i);
  });

  it('activates the Veyra language model provider and exposes all local models', () => {
    expect(manifest.activationEvents).toContain('onLanguageModelChatProvider:veyra');
    expect(manifest.contributes.languageModelChatProviders).toContainEqual({
      vendor: 'veyra',
      displayName: 'Veyra',
    });
    expect(VEYRA_LANGUAGE_MODELS.map((model) => [model.id, model.forcedTarget])).toEqual([
      ['veyra-orchestrator', 'veyra'],
      ['veyra-review', 'veyra'],
      ['veyra-debate', 'veyra'],
      ['veyra-implement', 'veyra'],
      ['veyra-claude', 'claude'],
      ['veyra-codex', 'codex'],
      ['veyra-gemini', 'gemini'],
    ]);
  });

  it('keeps the VS Code smoke checklist aligned with every exposed language model id', () => {
    const smokeChecklist = readFileSync(join(process.cwd(), 'docs', 'vscode-smoke-test.md'), 'utf8');

    for (const model of VEYRA_LANGUAGE_MODELS) {
      expect(smokeChecklist).toContain(model.id);
    }
  });

  it('documents that VS Code smoke evidence includes language model metadata', () => {
    const smokeChecklist = readFileSync(join(process.cwd(), 'docs', 'vscode-smoke-test.md'), 'utf8');
    const audit = readFileSync(join(process.cwd(), 'docs', 'goal-completion-audit.md'), 'utf8');

    for (const document of [smokeChecklist, audit]) {
      expect(document).toContain('language model metadata');
      expect(document).toContain('name, family, version, and maxInputTokens');
      expect(document).toContain('native chat registration evidence');
      expect(document).toContain('native chat workflow diagnostics');
    }
  });

  it('documents the autonomous workflow guardrails for broad implementation requests', () => {
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
    const smokeChecklist = readFileSync(join(process.cwd(), 'docs', 'vscode-smoke-test.md'), 'utf8');
    const audit = readFileSync(join(process.cwd(), 'docs', 'goal-completion-audit.md'), 'utf8');

    for (const document of [readme, smokeChecklist, audit]) {
      expect(document).toContain('brainstorming or approval checkpoints');
      expect(document).toContain('available model and CLI capabilities');
      expect(document).toContain('read-only or edit-permitted instructions');
    }
  });

  it('keeps the goal audit as an explicit prompt-to-artifact checklist', () => {
    const audit = readFileSync(join(process.cwd(), 'docs', 'goal-completion-audit.md'), 'utf8');

    for (const requiredText of [
      '## Prompt-to-Artifact Checklist',
      'without losing context',
      'without stomping each other',
      'without making invisible changes',
      'Claude, Codex, and Gemini',
      'paid-backend validation',
      'Native VS Code Chat Participant API',
      'Language Model Chat Provider API',
      '/review',
      '/debate',
      '/implement',
      'bounded intervention',
      'shared-context relay',
      'write-capable implementation',
      'Residual Manual Extension Host Gate',
      'manual native chat prompt submission',
      'npm run verify:completion',
      'npm run verify:goal',
      "$env:VEYRA_RUN_LIVE = '1'",
      'VEYRA_RUN_LIVE=1 npm run test:integration:live',
      'Remove-Item Env:\\VEYRA_RUN_LIVE -ErrorAction SilentlyContinue',
      'stays set for the current terminal session',
    ]) {
      expect(audit).toContain(requiredText);
    }
  });

  it('keeps packaged artifacts focused on runtime extension files', () => {
    const packageVerifier = readFileSync(join(process.cwd(), 'scripts', 'verify-package.mjs'), 'utf8');
    expect(manifest.files).toEqual([
      'package.json',
      'README.md',
      'LICENSE.txt',
      'CHANGELOG.md',
      'resources/icon.png',
      'dist/extension.js',
      'dist/extension.js.map',
      'dist/index.html',
      'dist/webview.js',
      'dist/webview.js.map',
      'docs/goal-completion-audit.md',
      'docs/vscode-smoke-test.md',
    ]);
    expect(packageVerifier).toContain("'LICENSE.txt'");
    expect(packageVerifier).toContain("'CHANGELOG.md'");
    expect(packageVerifier).toContain("'resources/icon.png'");
    expect(packageVerifier).toContain("'docs/vscode-smoke-test.md'");
    expect(packageVerifier).toContain("'docs/goal-completion-audit.md'");
    expect(packageVerifier).toContain("'.vscode/'");
    expect(packageVerifier).toContain("'.vscode-test/'");

    const npmIgnore = readFileSync(join(process.cwd(), '.npmignore'), 'utf8');
    for (const pattern of [
      '.superpowers/',
      '.claude/',
      '.npm-cache/',
      'docs/superpowers/',
      'src/',
      'tests/',
      'foo.ts',
      'scripts/',
    ]) {
      expect(npmIgnore).toContain(pattern);
    }
  });
});
