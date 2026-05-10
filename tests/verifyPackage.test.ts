import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

async function packageVerifierModule() {
  // @ts-expect-error The verifier is a plain Node .mjs script; this test asserts its exported runtime contract.
  return await import('../scripts/verify-package.mjs') as {
    allowedPackageFiles: string[];
    verifyPackageFiles(fileList: string[]): {
      ok: boolean;
      missing: string[];
      forbidden: string[];
      unexpected: string[];
    };
    verifyRuntimeExternalDependencies(bundleText: string, dependencies: Record<string, string>): {
      ok: boolean;
      missing: string[];
    };
  };
}

async function vsixPackagerModule() {
  // @ts-expect-error The VSIX packager is a plain Node .mjs script used by npm packaging.
  return await import('../scripts/package-vsix.mjs') as {
    vsixFileName(manifest: { name: string; version: string }): string;
    vsixEntriesForPackage(fileList: string[]): string[];
    createVsixManifest(manifest: {
      name: string;
      displayName?: string;
      description?: string;
      publisher: string;
      version: string;
      preview?: boolean;
      icon?: string;
      categories?: string[];
      engines?: { vscode?: string };
    }): string;
    contentTypesXml(): string;
  };
}

describe('verify-package script', () => {
  beforeAll(() => {
    const npmCommand = resolveNpmRunBuildCommand();
    const result = spawnSync(npmCommand.command, npmCommand.args, {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(result.status, result.stderr || result.stdout || String(result.error)).toBe(0);
  });

  it('runs direct invocation without Node child-process deprecation warnings', () => {
    const env = { ...process.env };
    delete env.npm_execpath;
    env.npm_config_cache = join(process.cwd(), 'package.json');
    env.NPM_CONFIG_CACHE = join(process.cwd(), 'package.json');

    const result = spawnSync(process.execPath, ['scripts/verify-package.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env,
    });

    expect(result.status, result.stderr || result.stdout || String(result.error)).toBe(0);
    expect(result.stderr).not.toContain('[DEP0190]');
  });

  it('excludes unexpected local files through the package manifest allowlist', () => {
    const unexpectedFile = join(process.cwd(), 'unexpected-package-file.txt');
    writeFileSync(unexpectedFile, 'local artifact\n');
    try {
      const result = spawnSync(process.execPath, ['scripts/verify-package.mjs'], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });

      expect(result.status, result.stderr || result.stdout || String(result.error)).toBe(0);
      expect(result.stdout).toContain('Package dry-run verified 13 files.');
    } finally {
      rmSync(unexpectedFile, { force: true });
    }
  });

  it('classifies unexpected files when package dry-run output drifts', async () => {
    const { allowedPackageFiles, verifyPackageFiles } = await packageVerifierModule();

    const verification = verifyPackageFiles([
      ...allowedPackageFiles,
      'unexpected-package-file.txt',
    ]);

    expect(verification.ok).toBe(false);
    expect(verification.unexpected).toEqual(['unexpected-package-file.txt']);
    expect(verification.missing).toEqual([]);
    expect(verification.forbidden).toEqual([]);
  });

  it('reports bundled external runtime requires that are missing from dependencies', async () => {
    const { verifyRuntimeExternalDependencies } = await packageVerifierModule();
    const bundleText = [
      'const sdk = require("@anthropic-ai/claude-agent-sdk");',
      'const jsx = require("preact/jsx-runtime");',
      'const vscode = require("vscode");',
      'const fs = require("node:fs");',
      'const local = require("./local");',
    ].join('\n');

    expect(typeof verifyRuntimeExternalDependencies).toBe('function');
    expect(verifyRuntimeExternalDependencies(bundleText, {
      preact: '^10.29.1',
    })).toEqual({
      ok: false,
      missing: ['@anthropic-ai/claude-agent-sdk'],
    });
    expect(verifyRuntimeExternalDependencies(bundleText, {
      '@anthropic-ai/claude-agent-sdk': '^0.2.123',
      preact: '^10.29.1',
    })).toEqual({
      ok: true,
      missing: [],
    });
  });

  it('defines deterministic VSIX package metadata from the verified package allowlist', async () => {
    const { allowedPackageFiles } = await packageVerifierModule();
    const { contentTypesXml, createVsixManifest, vsixEntriesForPackage, vsixFileName } =
      await vsixPackagerModule();

    expect(vsixFileName({ name: 'gambit', version: '0.0.1' })).toBe('gambit-0.0.1.vsix');
    expect(vsixEntriesForPackage(allowedPackageFiles)).toContain('extension/package.json');
    expect(vsixEntriesForPackage(allowedPackageFiles)).toContain('extension/dist/extension.js');

    const manifest = createVsixManifest({
      name: 'gambit',
      displayName: 'Gambit',
      description: 'Routes agents through VS Code.',
      publisher: 'dontcallmejames',
      version: '0.0.1',
      preview: true,
      icon: 'resources/icon.png',
      categories: ['Other'],
      engines: { vscode: '^1.118.0' },
    });
    expect(manifest).toContain('Id="gambit"');
    expect(manifest).toContain('Version="0.0.1"');
    expect(manifest).toContain('Publisher="dontcallmejames"');
    expect(manifest).toContain('Path="extension/package.json"');
    expect(manifest).toContain('Path="extension/resources/icon.png"');
    expect(manifest).toContain('Path="extension/LICENSE.txt"');
    expect(manifest).toContain('Path="extension/CHANGELOG.md"');
    expect(manifest).toContain('<GalleryFlags>Public,Preview</GalleryFlags>');
    expect(manifest).toContain('Microsoft.VisualStudio.Code.Engine');
    expect(manifest).toContain('^1.118.0');

    expect(contentTypesXml()).toContain('Extension="vsixmanifest"');
    expect(contentTypesXml()).toContain('Extension="png"');
    expect(contentTypesXml()).toContain('Extension="txt"');
  });
});

function resolveNpmRunBuildCommand(): { command: string; args: string[] } {
  if (process.env.npm_execpath) {
    return { command: process.execPath, args: [process.env.npm_execpath, 'run', 'build'] };
  }

  if (process.platform === 'win32') {
    const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (existsSync(npmCli)) {
      return { command: process.execPath, args: [npmCli, 'run', 'build'] };
    }
  }

  return { command: 'npm', args: ['run', 'build'] };
}
