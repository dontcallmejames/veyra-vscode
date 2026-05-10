import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cliPathMisconfiguration as extensionCliPathMisconfiguration } from '../src/cliPathValidation.js';

async function readinessModule() {
  // @ts-expect-error The verifier is a plain Node .mjs script; this test asserts its exported runtime contract.
  return await import('../scripts/verify-live-ready.mjs') as {
    npmRootGlobal(
      env: Record<string, string | undefined>,
      execFile: (command: string, args: string[], options: unknown) => string,
      nodeExecPath: string,
    ): string | null;
    resolveCliOverrides(input: {
      env: Record<string, string | undefined>;
      cwd: string;
      fileExists(filePath: string): boolean;
      readFile(filePath: string, encoding: 'utf8'): string;
    }): { codex?: string; gemini?: string };
    evaluateLiveReadiness(input: {
      commandAvailable(command: string): boolean;
      commandPath?(command: string): string | null;
      fileExists(filePath: string): boolean;
      fileStatus?(filePath: string): 'exists' | 'missing' | 'inaccessible';
      homeDir: string;
      npmRoot: string | null;
      platform: NodeJS.Platform;
      cliOverrides?: { codex?: string; gemini?: string };
      cliOverrideSources?: {
        codex?: { source: string; path: string };
        gemini?: { source: string; path: string };
      };
    }): {
      ok: boolean;
      checks: Array<{ name: string; status: 'ready' | 'not-installed' | 'unauthenticated' | 'inaccessible' | 'misconfigured'; detail: string }>;
      diagnostics?: string[];
    };
    assertLiveReadiness(result?: {
      ok: boolean;
      checks: Array<{ name: string; status: 'ready' | 'not-installed' | 'unauthenticated' | 'inaccessible' | 'misconfigured'; detail: string }>;
    }): void;
    liveReadinessFailure(result: {
      ok: boolean;
      checks: Array<{ name: string; status: 'ready' | 'not-installed' | 'unauthenticated' | 'inaccessible' | 'misconfigured'; detail: string }>;
      diagnostics?: string[];
    }): string;
    liveReadinessSuccess(result: {
      ok: boolean;
      checks: Array<{ name: string; status: 'ready' | 'not-installed' | 'unauthenticated' | 'inaccessible' | 'misconfigured'; detail: string }>;
      diagnostics?: string[];
    }, env?: Record<string, string | undefined>): string;
    cliPathMisconfiguration(runtime: 'codex' | 'gemini', filePath: string): string | null;
  };
}

describe('live readiness verifier', () => {
  it('uses npm_execpath when resolving the global npm root from npm scripts', async () => {
    const { npmRootGlobal } = await readinessModule();
    const calls: Array<{ command: string; args: string[] }> = [];

    const root = npmRootGlobal(
      { npm_execpath: 'C:/node/npm-cli.js' },
      (command, args) => {
        calls.push({ command, args });
        return 'C:/Users/tester/AppData/Roaming/npm/node_modules\r\n';
      },
      'C:/node/node.exe',
    );

    expect(root).toBe('C:/Users/tester/AppData/Roaming/npm/node_modules');
    expect(calls).toEqual([
      {
        command: 'C:/node/node.exe',
        args: ['C:/node/npm-cli.js', 'root', '-g'],
      },
    ]);
  });

  it('reports all live prerequisites ready without sending model prompts', async () => {
    const { evaluateLiveReadiness } = await readinessModule();
    const result = evaluateLiveReadiness({
      platform: 'win32',
      homeDir: 'C:/Users/tester',
      npmRoot: 'C:/npm/root',
      commandAvailable: (command) => command === 'code' || command === 'node' || command === 'claude',
      fileExists: (filePath) => [
        'C:/Users/tester/.claude/.credentials.json',
        'C:/npm/root/@openai/codex/bin/codex.js',
        'C:/Users/tester/.codex/auth.json',
        'C:/npm/root/@google/gemini-cli/bundle/gemini.js',
        'C:/Users/tester/.gemini/oauth_creds.json',
      ].includes(filePath.replace(/\\/g, '/')),
    });

    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => [check.name, check.status])).toEqual([
      ['VS Code CLI', 'ready'],
      ['Node.js CLI', 'ready'],
      ['Claude Code', 'ready'],
      ['Codex CLI', 'ready'],
      ['Gemini CLI', 'ready'],
    ]);
  });

  it('reports concrete missing Codex and Gemini setup without model prompts', async () => {
    const { evaluateLiveReadiness } = await readinessModule();
    const result = evaluateLiveReadiness({
      platform: 'win32',
      homeDir: 'C:/Users/tester',
      npmRoot: 'C:/npm/root',
      commandAvailable: (command) => command === 'code' || command === 'node' || command === 'claude',
      fileExists: (filePath) => filePath.replace(/\\/g, '/') === 'C:/Users/tester/.claude/.credentials.json',
    });

    expect(result.ok).toBe(false);
    expect(result.checks.map((check) => [check.name, check.status])).toEqual([
      ['VS Code CLI', 'ready'],
      ['Node.js CLI', 'ready'],
      ['Claude Code', 'ready'],
      ['Codex CLI', 'not-installed'],
      ['Gemini CLI', 'not-installed'],
    ]);
  });

  it('reports missing Node because wrapped CLIs need it in the extension host', async () => {
    const { evaluateLiveReadiness } = await readinessModule();
    const result = evaluateLiveReadiness({
      platform: 'win32',
      homeDir: 'C:/Users/tester',
      npmRoot: 'C:/npm/root',
      commandAvailable: (command) => command === 'code' || command === 'claude',
      fileExists: (filePath) => [
        'C:/Users/tester/.claude/.credentials.json',
        'C:/npm/root/@openai/codex/bin/codex.js',
        'C:/Users/tester/.codex/auth.json',
        'C:/npm/root/@google/gemini-cli/bundle/gemini.js',
        'C:/Users/tester/.gemini/oauth_creds.json',
      ].includes(filePath.replace(/\\/g, '/')),
    });

    expect(result.ok).toBe(false);
    expect(result.checks.map((check) => [check.name, check.status])).toContainEqual([
      'Node.js CLI',
      'not-installed',
    ]);
  });

  it('reports inaccessible Windows npm package probes separately from missing installs', async () => {
    const { evaluateLiveReadiness } = await readinessModule();
    const result = evaluateLiveReadiness({
      platform: 'win32',
      homeDir: 'C:/Users/tester',
      npmRoot: 'C:/npm/root',
      commandAvailable: (command) => command === 'code' || command === 'node' || command === 'claude',
      fileExists: () => false,
      fileStatus: (filePath) => {
        const normalized = filePath.replace(/\\/g, '/');
        if (normalized === 'C:/Users/tester/.claude/.credentials.json') return 'exists';
        if (normalized === 'C:/npm/root/@openai/codex/bin/codex.js') return 'inaccessible';
        return 'missing';
      },
    });

    const codex = result.checks.find((check) => check.name === 'Codex CLI');
    expect(result.ok).toBe(false);
    expect(codex?.status).toBe('inaccessible');
    expect(codex?.detail).toContain('Cannot inspect');
    expect(codex?.detail.replace(/\\/g, '/')).toContain('C:/npm/root/@openai/codex/bin/codex.js');
    expect(codex?.detail).toContain('VEYRA_CODEX_CLI_PATH');
    expect(codex?.detail).toContain('veyra.codexCliPath');
    expect(codex?.detail).toContain('JS bundle, native executable, or Windows npm shim');
    expect(codex?.detail).toContain('codex.exe');
    expect(codex?.detail).toContain('PATH');
  });

  it('reports the Gemini override variable when its Windows npm package probe is inaccessible', async () => {
    const { evaluateLiveReadiness } = await readinessModule();
    const result = evaluateLiveReadiness({
      platform: 'win32',
      homeDir: 'C:/Users/tester',
      npmRoot: 'C:/npm/root',
      commandAvailable: (command) => command === 'code' || command === 'node' || command === 'claude',
      fileExists: () => false,
      fileStatus: (filePath) => {
        const normalized = filePath.replace(/\\/g, '/');
        if (normalized === 'C:/Users/tester/.claude/.credentials.json') return 'exists';
        if (normalized === 'C:/npm/root/@openai/codex/bin/codex.js') return 'exists';
        if (normalized === 'C:/Users/tester/.codex/auth.json') return 'exists';
        if (normalized === 'C:/npm/root/@google/gemini-cli/bundle/gemini.js') return 'inaccessible';
        return 'missing';
      },
    });

    const gemini = result.checks.find((check) => check.name === 'Gemini CLI');
    expect(result.ok).toBe(false);
    expect(gemini?.status).toBe('inaccessible');
    expect(gemini?.detail).toContain('Cannot inspect');
    expect(gemini?.detail.replace(/\\/g, '/')).toContain('C:/npm/root/@google/gemini-cli/bundle/gemini.js');
    expect(gemini?.detail).toContain('VEYRA_GEMINI_CLI_PATH');
    expect(gemini?.detail).toContain('veyra.geminiCliPath');
    expect(gemini?.detail).toContain('JS bundle, native executable, or Windows npm shim');
    expect(gemini?.detail).toContain('gemini.exe');
    expect(gemini?.detail).toContain('PATH');
  });

  it('uses explicit Codex and Gemini CLI path overrides before probing global npm bundles', async () => {
    const { evaluateLiveReadiness } = await readinessModule();
    const result = evaluateLiveReadiness({
      platform: 'win32',
      homeDir: 'C:/Users/tester',
      npmRoot: null,
      cliOverrides: {
        codex: 'D:/tools/codex/bin/codex.js',
        gemini: 'D:/tools/gemini/bundle/gemini.js',
      },
      commandAvailable: (command) => command === 'code' || command === 'node' || command === 'claude',
      fileExists: (filePath) => [
        'C:/Users/tester/.claude/.credentials.json',
        'D:/tools/codex/bin/codex.js',
        'C:/Users/tester/.codex/auth.json',
        'D:/tools/gemini/bundle/gemini.js',
        'C:/Users/tester/.gemini/oauth_creds.json',
      ].includes(filePath.replace(/\\/g, '/')),
    });

    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => [check.name, check.status])).toEqual([
      ['VS Code CLI', 'ready'],
      ['Node.js CLI', 'ready'],
      ['Claude Code', 'ready'],
      ['Codex CLI', 'ready'],
      ['Gemini CLI', 'ready'],
    ]);
  });

  it('accepts explicit native executable overrides before probing global npm bundles', async () => {
    const { evaluateLiveReadiness } = await readinessModule();
    const result = evaluateLiveReadiness({
      platform: 'win32',
      homeDir: 'C:/Users/tester',
      npmRoot: null,
      cliOverrides: {
        codex: 'D:/tools/codex/codex.exe',
        gemini: 'D:/tools/gemini/gemini.exe',
      },
      commandAvailable: (command) => command === 'code' || command === 'node' || command === 'claude',
      fileExists: (filePath) => [
        'C:/Users/tester/.claude/.credentials.json',
        'D:/tools/codex/codex.exe',
        'C:/Users/tester/.codex/auth.json',
        'D:/tools/gemini/gemini.exe',
        'C:/Users/tester/.gemini/oauth_creds.json',
      ].includes(filePath.replace(/\\/g, '/')),
    });

    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => [check.name, check.status])).toEqual([
      ['VS Code CLI', 'ready'],
      ['Node.js CLI', 'ready'],
      ['Claude Code', 'ready'],
      ['Codex CLI', 'ready'],
      ['Gemini CLI', 'ready'],
    ]);
  });

  it('does not require a PATH node when explicit Codex and Gemini overrides are native executables', async () => {
    const { evaluateLiveReadiness } = await readinessModule();
    const result = evaluateLiveReadiness({
      platform: 'win32',
      homeDir: 'C:/Users/tester',
      npmRoot: null,
      cliOverrides: {
        codex: 'D:/tools/codex/codex.exe',
        gemini: 'D:/tools/gemini/gemini.exe',
      },
      commandAvailable: (command) => command === 'code' || command === 'claude',
      fileExists: (filePath) => [
        'C:/Users/tester/.claude/.credentials.json',
        'D:/tools/codex/codex.exe',
        'C:/Users/tester/.codex/auth.json',
        'D:/tools/gemini/gemini.exe',
        'C:/Users/tester/.gemini/oauth_creds.json',
      ].includes(filePath.replace(/\\/g, '/')),
    });

    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => [check.name, check.status])).toEqual([
      ['VS Code CLI', 'ready'],
      ['Node.js CLI', 'ready'],
      ['Claude Code', 'ready'],
      ['Codex CLI', 'ready'],
      ['Gemini CLI', 'ready'],
    ]);
    expect(result.checks.find((check) => check.name === 'Node.js CLI')?.detail)
      .toContain('not required');
  });

  it('accepts native Codex and Gemini executables on PATH before probing inaccessible global npm bundles', async () => {
    const { evaluateLiveReadiness } = await readinessModule();
    const result = evaluateLiveReadiness({
      platform: 'win32',
      homeDir: 'C:/Users/tester',
      npmRoot: 'C:/npm/root',
      commandAvailable: (command) => [
        'code',
        'node',
        'claude',
        'codex.exe',
        'gemini.exe',
      ].includes(command),
      fileExists: () => false,
      fileStatus: (filePath) => {
        const normalized = filePath.replace(/\\/g, '/');
        if (normalized === 'C:/Users/tester/.claude/.credentials.json') return 'exists';
        if (normalized === 'C:/Users/tester/.codex/auth.json') return 'exists';
        if (normalized === 'C:/Users/tester/.gemini/oauth_creds.json') return 'exists';
        if (normalized === 'C:/npm/root/@openai/codex/bin/codex.js') return 'inaccessible';
        if (normalized === 'C:/npm/root/@google/gemini-cli/bundle/gemini.js') return 'inaccessible';
        return 'missing';
      },
    });

    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => [check.name, check.status])).toEqual([
      ['VS Code CLI', 'ready'],
      ['Node.js CLI', 'ready'],
      ['Claude Code', 'ready'],
      ['Codex CLI', 'ready'],
      ['Gemini CLI', 'ready'],
    ]);
  });

  it('accepts Windows npm shims on PATH before probing inaccessible global npm bundles', async () => {
    const { evaluateLiveReadiness } = await readinessModule();
    const result = evaluateLiveReadiness({
      platform: 'win32',
      homeDir: 'C:/Users/tester',
      npmRoot: 'C:/npm/root',
      commandAvailable: (command) => [
        'code',
        'node',
        'claude',
        'codex.cmd',
        'gemini.ps1',
      ].includes(command),
      commandPath: (command) => {
        if (command === 'codex.cmd') return 'D:/npm/codex.cmd';
        if (command === 'gemini.ps1') return 'D:/npm/gemini.ps1';
        return null;
      },
      fileExists: () => false,
      fileStatus: (filePath) => {
        const normalized = filePath.replace(/\\/g, '/');
        if (normalized === 'C:/Users/tester/.claude/.credentials.json') return 'exists';
        if (normalized === 'D:/npm/node_modules/@openai/codex/bin/codex.js') return 'exists';
        if (normalized === 'D:/npm/node_modules/@google/gemini-cli/bundle/gemini.js') return 'exists';
        if (normalized === 'C:/Users/tester/.codex/auth.json') return 'exists';
        if (normalized === 'C:/Users/tester/.gemini/oauth_creds.json') return 'exists';
        if (normalized === 'C:/npm/root/@openai/codex/bin/codex.js') return 'inaccessible';
        if (normalized === 'C:/npm/root/@google/gemini-cli/bundle/gemini.js') return 'inaccessible';
        return 'missing';
      },
    });

    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => [check.name, check.status])).toEqual([
      ['VS Code CLI', 'ready'],
      ['Node.js CLI', 'ready'],
      ['Claude Code', 'ready'],
      ['Codex CLI', 'ready'],
      ['Gemini CLI', 'ready'],
    ]);
  });

  it('does not require a PATH node when Codex and Gemini resolve to native executables on PATH', async () => {
    const { evaluateLiveReadiness } = await readinessModule();
    const result = evaluateLiveReadiness({
      platform: 'win32',
      homeDir: 'C:/Users/tester',
      npmRoot: 'C:/npm/root',
      commandAvailable: (command) => [
        'code',
        'claude',
        'codex.exe',
        'gemini.exe',
      ].includes(command),
      commandPath: (command) => {
        if (command === 'codex.exe') return 'D:/tools/codex.exe';
        if (command === 'gemini.exe') return 'D:/tools/gemini.exe';
        return null;
      },
      fileExists: () => false,
      fileStatus: (filePath) => {
        const normalized = filePath.replace(/\\/g, '/');
        if (normalized === 'C:/Users/tester/.claude/.credentials.json') return 'exists';
        if (normalized === 'D:/tools/codex.exe') return 'exists';
        if (normalized === 'D:/tools/gemini.exe') return 'exists';
        if (normalized === 'C:/Users/tester/.codex/auth.json') return 'exists';
        if (normalized === 'C:/Users/tester/.gemini/oauth_creds.json') return 'exists';
        if (normalized === 'C:/npm/root/@openai/codex/bin/codex.js') return 'inaccessible';
        if (normalized === 'C:/npm/root/@google/gemini-cli/bundle/gemini.js') return 'inaccessible';
        return 'missing';
      },
    });

    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => [check.name, check.status])).toEqual([
      ['VS Code CLI', 'ready'],
      ['Node.js CLI', 'ready'],
      ['Claude Code', 'ready'],
      ['Codex CLI', 'ready'],
      ['Gemini CLI', 'ready'],
    ]);
    expect(result.checks.find((check) => check.name === 'Node.js CLI')?.detail)
      .toContain('not required');
  });

  it('reports inaccessible native Codex and Gemini executables on PATH before accepting auth readiness', async () => {
    const { evaluateLiveReadiness } = await readinessModule();
    const result = evaluateLiveReadiness({
      platform: 'win32',
      homeDir: 'C:/Users/tester',
      npmRoot: 'C:/npm/root',
      commandAvailable: (command) => [
        'code',
        'node',
        'claude',
        'codex.exe',
        'gemini.exe',
      ].includes(command),
      commandPath: (command) => {
        if (command === 'codex.exe') return 'D:/tools/codex.exe';
        if (command === 'gemini.exe') return 'D:/tools/gemini.exe';
        return null;
      },
      fileExists: () => false,
      fileStatus: (filePath) => {
        const normalized = filePath.replace(/\\/g, '/');
        if (normalized === 'C:/Users/tester/.claude/.credentials.json') return 'exists';
        if (normalized === 'D:/tools/codex.exe') return 'inaccessible';
        if (normalized === 'D:/tools/gemini.exe') return 'inaccessible';
        if (normalized === 'C:/Users/tester/.codex/auth.json') return 'exists';
        if (normalized === 'C:/Users/tester/.gemini/oauth_creds.json') return 'exists';
        return 'missing';
      },
    });

    const codex = result.checks.find((check) => check.name === 'Codex CLI');
    const gemini = result.checks.find((check) => check.name === 'Gemini CLI');
    expect(result.ok).toBe(false);
    expect(codex?.status).toBe('inaccessible');
    expect(codex?.detail).toContain('D:/tools/codex.exe');
    expect(gemini?.status).toBe('inaccessible');
    expect(gemini?.detail).toContain('D:/tools/gemini.exe');
  });

  it('ignores malformed native executable command paths before probing Windows npm bundles', async () => {
    const { evaluateLiveReadiness } = await readinessModule();
    const result = evaluateLiveReadiness({
      platform: 'win32',
      homeDir: 'C:/Users/tester',
      npmRoot: 'C:/npm/root',
      commandAvailable: (command) => [
        'code',
        'node',
        'claude',
        'codex.exe',
        'gemini.exe',
      ].includes(command),
      commandPath: (command) => {
        if (command === 'codex.exe' || command === 'gemini.exe') return 'C:/npm/root';
        return null;
      },
      fileExists: () => false,
      fileStatus: (filePath) => {
        const normalized = filePath.replace(/\\/g, '/');
        if (normalized === 'C:/Users/tester/.claude/.credentials.json') return 'exists';
        if (normalized === 'C:/Users/tester/.codex/auth.json') return 'exists';
        if (normalized === 'C:/Users/tester/.gemini/oauth_creds.json') return 'exists';
        if (normalized === 'C:/npm/root') return 'exists';
        if (normalized === 'C:/npm/root/@openai/codex/bin/codex.js') return 'inaccessible';
        if (normalized === 'C:/npm/root/@google/gemini-cli/bundle/gemini.js') return 'inaccessible';
        return 'missing';
      },
    });

    const codex = result.checks.find((check) => check.name === 'Codex CLI');
    const gemini = result.checks.find((check) => check.name === 'Gemini CLI');
    expect(result.ok).toBe(false);
    expect(codex?.status).toBe('inaccessible');
    expect(codex?.detail.replace(/\\/g, '/')).toContain('C:/npm/root/@openai/codex/bin/codex.js');
    expect(gemini?.status).toBe('inaccessible');
    expect(gemini?.detail.replace(/\\/g, '/')).toContain('C:/npm/root/@google/gemini-cli/bundle/gemini.js');
  });

  it('normalizes Windows npm command shim overrides before checking readiness', async () => {
    const { evaluateLiveReadiness } = await readinessModule();
    const result = evaluateLiveReadiness({
      platform: 'win32',
      homeDir: 'C:/Users/tester',
      npmRoot: null,
      cliOverrides: {
        codex: 'D:/npm/codex.cmd',
        gemini: 'D:/npm/gemini.cmd',
      },
      commandAvailable: (command) => command === 'code' || command === 'node' || command === 'claude',
      fileExists: (filePath) => [
        'C:/Users/tester/.claude/.credentials.json',
        'D:/npm/node_modules/@openai/codex/bin/codex.js',
        'C:/Users/tester/.codex/auth.json',
        'D:/npm/node_modules/@google/gemini-cli/bundle/gemini.js',
        'C:/Users/tester/.gemini/oauth_creds.json',
      ].includes(filePath.replace(/\\/g, '/')),
    });

    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => [check.name, check.status])).toEqual([
      ['VS Code CLI', 'ready'],
      ['Node.js CLI', 'ready'],
      ['Claude Code', 'ready'],
      ['Codex CLI', 'ready'],
      ['Gemini CLI', 'ready'],
    ]);
  });

  it('rejects malformed explicit CLI path overrides before accepting auth readiness', async () => {
    const { evaluateLiveReadiness } = await readinessModule();
    const result = evaluateLiveReadiness({
      platform: 'win32',
      homeDir: 'C:/Users/tester',
      npmRoot: null,
      cliOverrides: {
        codex: 'D:/tools/not-codex.exe',
        gemini: 'D:/tools/not-gemini.js',
      },
      commandAvailable: (command) => command === 'code' || command === 'node' || command === 'claude',
      fileExists: (filePath) => [
        'C:/Users/tester/.claude/.credentials.json',
        'D:/tools/not-codex.exe',
        'C:/Users/tester/.codex/auth.json',
        'D:/tools/not-gemini.js',
        'C:/Users/tester/.gemini/oauth_creds.json',
      ].includes(filePath.replace(/\\/g, '/')),
    });

    const codex = result.checks.find((check) => check.name === 'Codex CLI');
    const gemini = result.checks.find((check) => check.name === 'Gemini CLI');
    expect(result.ok).toBe(false);
    expect(codex?.status).toBe('misconfigured');
    expect(codex?.detail).toContain('codex.js, codex.exe, or codex');
    expect(gemini?.status).toBe('misconfigured');
    expect(gemini?.detail).toContain('gemini.js, gemini.exe, or gemini');
  });

  it('keeps the standalone readiness CLI path validator aligned with the extension validator', async () => {
    const { cliPathMisconfiguration } = await readinessModule();
    const cases: Array<{ runtime: 'codex' | 'gemini'; filePath: string }> = [
      { runtime: 'codex', filePath: 'D:/tools/codex/bin/codex.js' },
      { runtime: 'codex', filePath: 'D:/tools/codex.exe' },
      { runtime: 'codex', filePath: '/usr/local/bin/codex' },
      { runtime: 'codex', filePath: 'D:/npm/codex.cmd' },
      { runtime: 'codex', filePath: 'D:/tools/not-codex.exe' },
      { runtime: 'gemini', filePath: 'D:/tools/gemini/bundle/gemini.js' },
      { runtime: 'gemini', filePath: 'D:/tools/gemini.exe' },
      { runtime: 'gemini', filePath: '/usr/local/bin/gemini' },
      { runtime: 'gemini', filePath: 'D:/npm/gemini.ps1' },
      { runtime: 'gemini', filePath: 'D:/tools/not-gemini.js' },
    ];

    for (const { runtime, filePath } of cases) {
      expect(cliPathMisconfiguration(runtime, filePath)).toBe(
        extensionCliPathMisconfiguration(runtime, filePath),
      );
    }
  });

  it('reads Codex and Gemini CLI path overrides from workspace VS Code settings', async () => {
    const { resolveCliOverrides } = await readinessModule();

    const overrides = resolveCliOverrides({
      env: {},
      cwd: 'C:/repo',
      fileExists: () => true,
      readFile: () => `{
        // VS Code settings are JSONC.
        "veyra.codexCliPath": "D:/tools/codex/bin/codex.js",
        "veyra.geminiCliPath": "D:/tools/gemini/bundle/gemini.js",
      }`,
    });

    expect(overrides).toEqual({
      codex: 'D:/tools/codex/bin/codex.js',
      gemini: 'D:/tools/gemini/bundle/gemini.js',
    });
  });

  it('prefers environment CLI overrides over workspace VS Code settings', async () => {
    const { resolveCliOverrides } = await readinessModule();

    const overrides = resolveCliOverrides({
      env: {
        VEYRA_CODEX_CLI_PATH: 'E:/env/codex.js',
        VEYRA_GEMINI_CLI_PATH: 'E:/env/gemini.js',
      },
      cwd: 'C:/repo',
      fileExists: () => true,
      readFile: () => `{
        "veyra.codexCliPath": "D:/settings/codex.js",
        "veyra.geminiCliPath": "D:/settings/gemini.js"
      }`,
    });

    expect(overrides).toEqual({
      codex: 'E:/env/codex.js',
      gemini: 'E:/env/gemini.js',
    });
  });

  it('fails before direct live test execution can send paid prompts when readiness is incomplete', async () => {
    const { assertLiveReadiness } = await readinessModule();

    expect(() => assertLiveReadiness({
      ok: false,
      checks: [
        { name: 'VS Code CLI', status: 'ready', detail: '' },
        { name: 'Codex CLI', status: 'inaccessible', detail: 'Cannot inspect Codex.' },
      ],
    })).toThrow(/No paid model prompts were sent[\s\S]*\[inaccessible\] Codex CLI - Cannot inspect Codex\./);
  });

  it('includes PowerShell-safe live-test command guidance in readiness failures', async () => {
    const { liveReadinessFailure } = await readinessModule();

    const message = liveReadinessFailure({
      ok: false,
      checks: [
        { name: 'VS Code CLI', status: 'ready', detail: '' },
        { name: 'Codex CLI', status: 'inaccessible', detail: 'Cannot inspect Codex.' },
      ],
    });

    expect(message).toContain("$env:VEYRA_RUN_LIVE = '1'");
    expect(message).toContain('npm run verify:goal');
    expect(message).toContain('npm run test:integration:live');
    expect(message).toContain('Remove-Item Env:\\VEYRA_RUN_LIVE -ErrorAction SilentlyContinue');
    expect(message.match(/\$env:VEYRA_RUN_LIVE = '1'/g)).toHaveLength(2);
    expect(message.match(/Remove-Item Env:\\VEYRA_RUN_LIVE -ErrorAction SilentlyContinue/g)).toHaveLength(2);
    expect(message).toContain('Bash-compatible shells');
    expect(message).toContain('VEYRA_RUN_LIVE=1 npm run verify:goal');
    expect(message).toContain('VEYRA_RUN_LIVE=1 npm run test:integration:live');
  });

  it('prints the next paid validation command when live readiness is ready', async () => {
    const { liveReadinessSuccess } = await readinessModule();

    const message = liveReadinessSuccess({
      ok: true,
      checks: [
        { name: 'VS Code CLI', status: 'ready', detail: '' },
        { name: 'Node.js CLI', status: 'ready', detail: '' },
        { name: 'Claude Code', status: 'ready', detail: '' },
        { name: 'Codex CLI', status: 'ready', detail: '' },
        { name: 'Gemini CLI', status: 'ready', detail: '' },
      ],
    });

    expect(message).toContain('All live prerequisites are ready.');
    expect(message).toContain('Next paid validation step:');
    expect(message).toContain("$env:VEYRA_RUN_LIVE = '1'");
    expect(message).toContain('npm run test:integration:live');
    expect(message).toContain('Remove-Item Env:\\VEYRA_RUN_LIVE -ErrorAction SilentlyContinue');
  });

  it('omits next paid validation guidance during the live-test npm preflight', async () => {
    const { liveReadinessSuccess } = await readinessModule();

    const message = liveReadinessSuccess({
      ok: true,
      checks: [
        { name: 'VS Code CLI', status: 'ready', detail: '' },
        { name: 'Node.js CLI', status: 'ready', detail: '' },
        { name: 'Claude Code', status: 'ready', detail: '' },
        { name: 'Codex CLI', status: 'ready', detail: '' },
        { name: 'Gemini CLI', status: 'ready', detail: '' },
      ],
    }, { npm_lifecycle_event: 'pretest:integration:live' });

    expect(message).toContain('All live prerequisites are ready.');
    expect(message).not.toContain('Next paid validation step:');
    expect(message).not.toContain('npm run test:integration:live');
  });

  it('includes non-secret path diagnostics in live readiness failures', async () => {
    const { evaluateLiveReadiness, liveReadinessFailure } = await readinessModule();
    const result = evaluateLiveReadiness({
      platform: 'win32',
      homeDir: 'C:/Users/tester',
      npmRoot: 'C:/npm/root',
      commandAvailable: (command) => command === 'code' || command === 'node' || command === 'claude',
      fileExists: () => false,
      fileStatus: (filePath) => {
        const normalized = filePath.replace(/\\/g, '/');
        if (normalized === 'C:/Users/tester/.claude/.credentials.json') return 'exists';
        if (normalized === 'C:/npm/root/@openai/codex/bin/codex.js') return 'inaccessible';
        if (normalized === 'C:/npm/root/@google/gemini-cli/bundle/gemini.js') return 'inaccessible';
        return 'missing';
      },
    });

    const failure = liveReadinessFailure(result);

    expect(failure).toContain('Readiness context:');
    expect(failure).toContain('VEYRA_CODEX_CLI_PATH / veyra.codexCliPath: unset');
    expect(failure).toContain('VEYRA_GEMINI_CLI_PATH / veyra.geminiCliPath: unset');
    expect(failure).toContain('Windows native codex.exe: missing');
    expect(failure).toContain('Windows native gemini.exe: missing');
    expect(failure).toContain('Windows npm Codex shim: missing');
    expect(failure).toContain('Windows npm Gemini shim: missing');
    expect(failure).toContain('npm root -g: C:/npm/root');
  });

  it('includes unrestricted PowerShell diagnostics for inaccessible CLI bundle paths', async () => {
    const { evaluateLiveReadiness, liveReadinessFailure } = await readinessModule();
    const result = evaluateLiveReadiness({
      platform: 'win32',
      homeDir: 'C:/Users/tester',
      npmRoot: 'C:/npm/root',
      commandAvailable: (command) => command === 'code' || command === 'node' || command === 'claude',
      fileExists: () => false,
      fileStatus: (filePath) => {
        const normalized = filePath.replace(/\\/g, '/');
        if (normalized === 'C:/Users/tester/.claude/.credentials.json') return 'exists';
        if (normalized === 'C:/npm/root/@openai/codex/bin/codex.js') return 'inaccessible';
        if (normalized === 'C:/npm/root/@google/gemini-cli/bundle/gemini.js') return 'inaccessible';
        return 'missing';
      },
    });

    const failure = liveReadinessFailure(result).replace(/\\/g, '/');

    expect(failure).toContain('Unrestricted PowerShell diagnostics:');
    expect(failure).toContain("Test-Path -LiteralPath 'C:/npm/root/@openai/codex/bin/codex.js'");
    expect(failure).toContain("Test-Path -LiteralPath 'C:/npm/root/@google/gemini-cli/bundle/gemini.js'");
    expect(failure).toContain("$env:VEYRA_CODEX_CLI_PATH = 'C:/npm/root/@openai/codex/bin/codex.js'");
    expect(failure).toContain("$env:VEYRA_GEMINI_CLI_PATH = 'C:/npm/root/@google/gemini-cli/bundle/gemini.js'");
    expect(failure).toContain('npm run verify:live-ready');
  });

  it('includes resolved Windows npm shim diagnostics in live readiness failures', async () => {
    const { evaluateLiveReadiness, liveReadinessFailure } = await readinessModule();
    const result = evaluateLiveReadiness({
      platform: 'win32',
      homeDir: 'C:/Users/tester',
      npmRoot: 'C:/npm/root',
      commandAvailable: (command) => [
        'code',
        'node',
        'claude',
        'codex.cmd',
        'gemini.ps1',
      ].includes(command),
      commandPath: (command) => {
        if (command === 'codex.cmd') return 'D:/npm/codex.cmd';
        if (command === 'gemini.ps1') return 'D:/npm/gemini.ps1';
        return null;
      },
      fileExists: () => false,
      fileStatus: (filePath) => {
        const normalized = filePath.replace(/\\/g, '/');
        if (normalized === 'C:/Users/tester/.claude/.credentials.json') return 'exists';
        if (normalized === 'D:/npm/node_modules/@openai/codex/bin/codex.js') return 'exists';
        if (normalized === 'D:/npm/node_modules/@google/gemini-cli/bundle/gemini.js') return 'exists';
        return 'missing';
      },
    });

    const failure = liveReadinessFailure(result);
    const normalizedFailure = failure.replace(/\\/g, '/');

    expect(normalizedFailure).toContain('Windows npm Codex shim: found at D:/npm/codex.cmd -> D:/npm/node_modules/@openai/codex/bin/codex.js');
    expect(normalizedFailure).toContain('Windows npm Gemini shim: found at D:/npm/gemini.ps1 -> D:/npm/node_modules/@google/gemini-cli/bundle/gemini.js');
  });

  it('includes npm global bin shim diagnostics when npm root is available', async () => {
    const { evaluateLiveReadiness, liveReadinessFailure } = await readinessModule();
    const result = evaluateLiveReadiness({
      platform: 'win32',
      homeDir: 'C:/Users/tester',
      npmRoot: 'D:/npm/node_modules',
      commandAvailable: (command) => command === 'code' || command === 'node' || command === 'claude',
      fileExists: () => false,
      fileStatus: (filePath) => {
        const normalized = filePath.replace(/\\/g, '/');
        if (normalized === 'C:/Users/tester/.claude/.credentials.json') return 'exists';
        if (normalized === 'D:/npm/codex.cmd') return 'exists';
        if (normalized === 'D:/npm/gemini.ps1') return 'exists';
        return 'missing';
      },
    });

    const normalizedFailure = liveReadinessFailure(result).replace(/\\/g, '/');

    expect(normalizedFailure).toContain('npm global Codex shim: found at D:/npm/codex.cmd');
    expect(normalizedFailure).toContain('npm global Gemini shim: found at D:/npm/gemini.ps1');
  });

  it('requires every opt-in live integration suite to install the direct-run readiness guard', async () => {
    const liveSuites = [
      'claude.live.test.ts',
      'codex.live.test.ts',
      'gemini.live.test.ts',
      'veyra.live.test.ts',
    ];

    for (const fileName of liveSuites) {
      const contents = await readFile(join(process.cwd(), 'tests', 'integration', fileName), 'utf8');
      expect(contents, `${fileName} should import the shared live readiness guard`)
        .toContain("import { guardLiveModelPrompts } from './liveReadinessGuard.js';");
      expect(contents, `${fileName} should call the shared live readiness guard inside describeLive`)
        .toContain('guardLiveModelPrompts();');
    }
  });

  it('requires the live all-agent handoff to verify cross-agent shared-context relay', async () => {
    const contents = await readFile(join(process.cwd(), 'tests', 'integration', 'veyra.live.test.ts'), 'utf8');

    for (const requiredText of [
      'CLAUDE_CONTEXT_MARKER',
      'CODEX_CONTEXT_MARKER',
      'GEMINI_CONTEXT_MARKER',
      'extractMarkerLine',
      "expect(codexText).toContain(claudeMarkerLine)",
      "expect(geminiText).toContain(claudeMarkerLine)",
      "expect(geminiText).toContain(codexMarkerLine)",
    ]) {
      expect(contents).toContain(requiredText);
    }
  });

  it('requires the live all-agent handoff to run read-only while validating shared context', async () => {
    const contents = await readFile(join(process.cwd(), 'tests', 'integration', 'veyra.live.test.ts'), 'utf8');

    expect(contents).toContain('readOnly: true');
  });

  it('requires the live all-agent suite to validate a write-capable implementation workflow', async () => {
    const contents = await readFile(join(process.cwd(), 'tests', 'integration', 'veyra.live.test.ts'), 'utf8');

    for (const requiredText of [
      'write-capable implementation',
      'VEYRA_LIVE_IMPLEMENT_MARKER',
      'readFile',
      "expect(fileEditedEvents.length).toBeGreaterThan(0)",
      "expect(finalContents).toContain(VEYRA_LIVE_IMPLEMENT_MARKER)",
    ]) {
      expect(contents).toContain(requiredText);
    }
  });
});
