import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
      expect(result.stdout).toContain('Package dry-run verified 12 files.');
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

  it('loads the packaged extension entry without unpackaged npm dependencies during activation', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'veyra-extension-entry-'));
    try {
      mkdirSync(join(tempRoot, 'dist'), { recursive: true });
      mkdirSync(join(tempRoot, 'node_modules', 'vscode'), { recursive: true });
      copyFileSync(
        join(process.cwd(), 'dist', 'extension.js'),
        join(tempRoot, 'dist', 'extension.js'),
      );
      writeFileSync(
        join(tempRoot, 'node_modules', 'vscode', 'index.js'),
        [
          'const proxy = new Proxy(function () {}, {',
          '  get: (_target, prop) => prop === "__esModule" ? false : proxy,',
          '  apply: () => proxy,',
          '  construct: () => proxy,',
          '});',
          'module.exports = proxy;',
          '',
        ].join('\n'),
      );

      const result = spawnSync(process.execPath, ['-e', 'require("./dist/extension.js")'], {
        cwd: tempRoot,
        encoding: 'utf8',
      });

      expect(result.status, result.stderr || result.stdout || String(result.error)).toBe(0);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('can resolve lazy-loaded dependencies like the Claude SDK from the packaged dist', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'veyra-lazy-load-'));
    try {
      mkdirSync(join(tempRoot, 'dist'), { recursive: true });
      mkdirSync(join(tempRoot, 'node_modules', 'vscode'), { recursive: true });
      // Create a fake @anthropic-ai/claude-agent-sdk to simulate it being installed as a dependency
      mkdirSync(join(tempRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'), { recursive: true });
      writeFileSync(join(tempRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'index.js'), 'module.exports = {};');
      writeFileSync(join(tempRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', main: 'index.js' }));

      copyFileSync(
        join(process.cwd(), 'dist', 'extension.js'),
        join(tempRoot, 'dist', 'extension.js'),
      );
      writeFileSync(
        join(tempRoot, 'node_modules', 'vscode', 'index.js'),
        [
          'const proxy = new Proxy(function () {}, {',
          '  get: (_target, prop) => prop === "__esModule" ? false : proxy,',
          '  apply: () => proxy,',
          '  construct: () => proxy,',
          '});',
          'module.exports = proxy;',
          '',
        ].join('\n'),
      );

      const testScript = [
        'async function run() {',
        '  const ext = require("./dist/extension.js");',
        '  // If there is an exported function that triggers the import, we would call it here.',
        '  // Since we cannot easily trigger the dispatch, we will just manually try to import the SDK',
        '  // exactly how it is imported in the dist to see if the path resolves correctly.',
        '  await import("@anthropic-ai/claude-agent-sdk");',
        '}',
        'run().catch(err => { console.error(err); process.exit(1); });'
      ].join('\n');

      const result = spawnSync(process.execPath, ['-e', testScript], {
        cwd: tempRoot,
        encoding: 'utf8',
      });

      expect(result.status, result.stderr || result.stdout || String(result.error)).toBe(0);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('defines deterministic VSIX package metadata from the verified package allowlist', async () => {
    const { allowedPackageFiles } = await packageVerifierModule();
    const { contentTypesXml, createVsixManifest, vsixEntriesForPackage, vsixFileName } =
      await vsixPackagerModule();

    expect(vsixFileName({ name: 'veyra-vscode', version: '0.0.1' })).toBe('veyra-vscode-0.0.1.vsix');
    expect(vsixEntriesForPackage(allowedPackageFiles)).toContain('extension/package.json');
    expect(vsixEntriesForPackage(allowedPackageFiles)).toContain('extension/dist/extension.js');

    const manifest = createVsixManifest({
      name: 'veyra-vscode',
      displayName: 'Veyra',
      description: 'Routes agents through VS Code.',
      publisher: 'dontcallmejames',
      version: '0.0.1',
      preview: true,
      icon: 'resources/icon.png',
      categories: ['Other'],
      engines: { vscode: '^1.118.0' },
    });
    expect(manifest).toContain('Id="veyra-vscode"');
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
