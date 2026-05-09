import { describe, expect, it, vi } from 'vitest';

import { detectCliBundlePaths } from '../src/cliPathDetection.js';

describe('detectCliBundlePaths', () => {
  it('detects Windows npm Codex and Gemini JS bundles', () => {
    const accessSync = vi.fn();
    const execSync = vi.fn(() => 'C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\r\n');

    const result = detectCliBundlePaths({
      platform: 'win32',
      execSync: execSync as any,
      accessSync: accessSync as any,
    });

    expect(result.codex).toEqual({
      status: 'detected',
      path: 'C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
      detail: '',
    });
    expect(result.gemini).toEqual({
      status: 'detected',
      path: 'C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js',
      detail: '',
    });
    expect(accessSync).toHaveBeenCalledWith(result.codex.path);
    expect(accessSync).toHaveBeenCalledWith(result.gemini.path);
  });

  it('detects native Codex and Gemini executables on PATH before probing npm bundles', () => {
    const accessSync = vi.fn();
    const execSync = vi.fn((command: string) => {
      if (command === 'where.exe codex.exe') return 'D:\\tools\\codex\\codex.exe\r\n';
      if (command === 'where.exe gemini.exe') return 'D:\\tools\\gemini\\gemini.exe\r\n';
      throw new Error('npm root should not be probed');
    });

    const result = detectCliBundlePaths({
      platform: 'win32',
      execSync: execSync as any,
      accessSync: accessSync as any,
    });

    expect(result.codex).toEqual({
      status: 'detected',
      path: 'D:\\tools\\codex\\codex.exe',
      detail: '',
    });
    expect(result.gemini).toEqual({
      status: 'detected',
      path: 'D:\\tools\\gemini\\gemini.exe',
      detail: '',
    });
    expect(execSync).not.toHaveBeenCalledWith('npm root -g', expect.anything());
    expect(accessSync).toHaveBeenCalledWith('D:\\tools\\codex\\codex.exe');
    expect(accessSync).toHaveBeenCalledWith('D:\\tools\\gemini\\gemini.exe');
  });

  it('detects Windows npm shims on PATH before probing npm bundles', () => {
    const accessSync = vi.fn();
    const execSync = vi.fn((command: string) => {
      if (command === 'where.exe codex.exe') throw new Error('native codex missing');
      if (command === 'where.exe gemini.exe') throw new Error('native gemini missing');
      if (command === 'where.exe codex.cmd') return 'D:\\npm\\codex.cmd\r\n';
      if (command === 'where.exe gemini.ps1') return 'D:\\npm\\gemini.ps1\r\n';
      throw new Error('npm root should not be probed');
    });

    const result = detectCliBundlePaths({
      platform: 'win32',
      execSync: execSync as any,
      accessSync: accessSync as any,
    });

    expect(result.codex).toEqual({
      status: 'detected',
      path: 'D:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
      detail: '',
    });
    expect(result.gemini).toEqual({
      status: 'detected',
      path: 'D:\\npm\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js',
      detail: '',
    });
    expect(execSync).not.toHaveBeenCalledWith('npm root -g', expect.anything());
    expect(accessSync).toHaveBeenCalledWith(result.codex.path);
    expect(accessSync).toHaveBeenCalledWith(result.gemini.path);
  });

  it('ignores stale Windows npm PATH shims whose bundle targets are missing', () => {
    const execSync = vi.fn((command: string) => {
      if (command === 'where.exe codex.exe') throw new Error('native codex missing');
      if (command === 'where.exe gemini.exe') throw new Error('native gemini missing');
      if (command === 'where.exe codex.cmd') return 'D:\\stale-npm\\codex.cmd\r\n';
      if (command === 'where.exe gemini.ps1') return 'D:\\stale-npm\\gemini.ps1\r\n';
      if (command === 'npm root -g') return 'C:\\npm-root\n';
      throw new Error(`unexpected command: ${command}`);
    });
    const accessSync = vi.fn((filePath: string) => {
      if (String(filePath).startsWith('D:\\stale-npm\\')) {
        const error = new Error(`missing ${filePath}`) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
    });

    const result = detectCliBundlePaths({
      platform: 'win32',
      execSync: execSync as any,
      accessSync: accessSync as any,
    });

    expect(result.codex).toEqual({
      status: 'detected',
      path: 'C:\\npm-root\\@openai\\codex\\bin\\codex.js',
      detail: '',
    });
    expect(result.gemini).toEqual({
      status: 'detected',
      path: 'C:\\npm-root\\@google\\gemini-cli\\bundle\\gemini.js',
      detail: '',
    });
    expect(execSync).toHaveBeenCalledWith('npm root -g', expect.anything());
  });

  it('reports inaccessible native executables on PATH instead of hiding them behind npm bundle probing', () => {
    const execSync = vi.fn((command: string) => {
      if (command === 'where.exe codex.exe') return 'D:\\tools\\codex\\codex.exe\r\n';
      if (command === 'where.exe gemini.exe') return 'D:\\tools\\gemini\\gemini.exe\r\n';
      if (command === 'npm root -g') return 'C:\\npm-root\n';
      throw new Error(`unexpected command: ${command}`);
    });
    const accessSync = vi.fn((filePath: string) => {
      const error = new Error(`cannot access ${filePath}`) as NodeJS.ErrnoException;
      error.code = filePath.endsWith('.exe') ? 'EPERM' : 'ENOENT';
      throw error;
    });

    const result = detectCliBundlePaths({
      platform: 'win32',
      execSync: execSync as any,
      accessSync: accessSync as any,
    });

    expect(result.codex).toMatchObject({
      status: 'inaccessible',
      path: 'D:\\tools\\codex\\codex.exe',
    });
    expect(result.codex.detail).toContain('Cannot inspect D:\\tools\\codex\\codex.exe');
    expect(result.gemini).toMatchObject({
      status: 'inaccessible',
      path: 'D:\\tools\\gemini\\gemini.exe',
    });
    expect(result.gemini.detail).toContain('Cannot inspect D:\\tools\\gemini\\gemini.exe');
  });

  it('reports inaccessible bundle probes separately from missing bundles', () => {
    const execSync = vi.fn(() => 'C:\\npm-root\n');
    const accessSync = vi.fn((filePath: string) => {
      const error = new Error(`cannot access ${filePath}`) as NodeJS.ErrnoException;
      error.code = filePath.includes('codex') ? 'EPERM' : 'ENOENT';
      throw error;
    });

    const result = detectCliBundlePaths({
      platform: 'win32',
      execSync: execSync as any,
      accessSync: accessSync as any,
    });

    expect(result.codex).toMatchObject({
      status: 'inaccessible',
      path: 'C:\\npm-root\\@openai\\codex\\bin\\codex.js',
    });
    expect(result.codex.detail).toContain('Cannot inspect');
    expect(result.gemini).toMatchObject({
      status: 'missing',
      path: 'C:\\npm-root\\@google\\gemini-cli\\bundle\\gemini.js',
    });
  });

  it('returns unsupported outside Windows because explicit bundle paths are not needed', () => {
    const result = detectCliBundlePaths({
      platform: 'linux',
      execSync: vi.fn() as any,
      accessSync: vi.fn() as any,
    });

    expect(result.codex.status).toBe('unsupported');
    expect(result.gemini.status).toBe('unsupported');
  });
});
