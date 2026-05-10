import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkClaude, checkCodex, checkGemini, clearStatusCache } from '../src/statusChecks.js';

const vscodeMocks = vi.hoisted(() => ({
  configGet: vi.fn((_key: string, dflt: unknown) => dflt),
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({ get: vscodeMocks.configGet })),
  },
}));

vi.mock('node:fs', () => ({
  accessSync: vi.fn(),
  existsSync: vi.fn(),
}));
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { accessSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
const mockedAccessSync = accessSync as unknown as ReturnType<typeof vi.fn>;
const mockedExistsSync = existsSync as unknown as ReturnType<typeof vi.fn>;
const mockedExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
const originalPlatform = process.platform;

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  clearStatusCache();
  delete process.env.VEYRA_CODEX_CLI_PATH;
  delete process.env.VEYRA_GEMINI_CLI_PATH;
  vscodeMocks.configGet.mockReset();
  vscodeMocks.configGet.mockImplementation((_key: string, dflt: unknown) => dflt);
  mockedAccessSync.mockReset();
  mockedExistsSync.mockReset();
  mockedExecSync.mockReset();
  mockedAccessSync.mockImplementation((path: unknown) => {
    if (!mockedExistsSync(path)) {
      const error = new Error(`missing ${String(path)}`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
  });
});

describe('checkClaude', () => {
  it('returns not-installed when the Claude CLI cannot be found', async () => {
    mockedExecSync.mockImplementation(() => { throw new Error('claude not found'); });

    expect(await checkClaude()).toBe('not-installed');
  });

  it('uses PowerShell command lookup on Windows when where misses Claude', async () => {
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    mockedExecSync.mockImplementation((command: string) => {
      if (command.startsWith('where')) throw new Error('where missed claude');
      if (command.includes('Get-Command claude')) return '';
      throw new Error(`unexpected command: ${command}`);
    });
    mockedExistsSync.mockReturnValue(true);
    try {
      expect(await checkClaude()).toBe('ready');
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true });
    }
  });

  it('returns ready when credentials exist', async () => {
    mockedExecSync.mockReturnValue('/usr/local/bin/claude\n');
    mockedExistsSync.mockReturnValue(true);
    expect(await checkClaude()).toBe('ready');
  });

  it('returns unauthenticated when credentials missing', async () => {
    mockedExecSync.mockReturnValue('/usr/local/bin/claude\n');
    mockedExistsSync.mockReturnValue(false);
    expect(await checkClaude()).toBe('unauthenticated');
  });
});

describe('checkCodex', () => {
  it('uses veyra.codexCliPath before resolving the Windows npm bundle', async () => {
    vscodeMocks.configGet.mockImplementation((key: string, dflt: unknown) =>
      key === 'codexCliPath' ? 'D:\\settings\\codex\\codex.js' : dflt
    );
    mockedExistsSync.mockReturnValue(true);
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    expect(await checkCodex()).toBe('ready');
    expect(mockedExecSync).not.toHaveBeenCalledWith('npm root -g', expect.anything());
    expect(mockedAccessSync).toHaveBeenCalledWith('D:\\settings\\codex\\codex.js');
  });

  it('uses VEYRA_CODEX_CLI_PATH before resolving the Windows npm bundle', async () => {
    process.env.VEYRA_CODEX_CLI_PATH = 'D:\\tools\\codex\\codex.js';
    mockedExistsSync.mockReturnValue(true);
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    expect(await checkCodex()).toBe('ready');
    expect(mockedExecSync).not.toHaveBeenCalledWith('npm root -g', expect.anything());
    expect(mockedAccessSync).toHaveBeenCalledWith('D:\\tools\\codex\\codex.js');
  });

  it('does not report Codex ready for a JS bundle when the Node CLI is missing', async () => {
    process.env.VEYRA_CODEX_CLI_PATH = 'D:\\tools\\codex\\codex.js';
    mockedExistsSync.mockReturnValue(true);
    mockedExecSync.mockImplementation((command: string) => {
      if (command.startsWith('where') || command.includes('Get-Command node')) {
        throw new Error('node not found');
      }
      throw new Error(`unexpected command: ${command}`);
    });
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    expect(await checkCodex()).toBe('node-missing');
  });

  it('uses native codex.exe from PATH before resolving the Windows npm bundle', async () => {
    mockedExecSync.mockImplementation((command: string) => {
      if (command === 'where.exe codex.exe') return 'D:\\tools\\codex\\codex.exe\r\n';
      throw new Error(`unexpected command: ${command}`);
    });
    mockedExistsSync.mockReturnValue(true);
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    expect(await checkCodex()).toBe('ready');
    expect(mockedExecSync).not.toHaveBeenCalledWith('npm root -g', expect.anything());
    expect(mockedAccessSync).toHaveBeenCalledWith('D:\\tools\\codex\\codex.exe');
  });

  it('uses codex.cmd from PATH before resolving the Windows npm bundle', async () => {
    mockedExecSync.mockImplementation((command: string) => {
      if (command === 'where.exe codex.exe') throw new Error('native codex missing');
      if (command === 'where.exe codex.cmd') return 'D:\\npm\\codex.cmd\r\n';
      if (command.startsWith('where.exe node')) return 'D:\\node\\node.exe\r\n';
      throw new Error(`unexpected command: ${command}`);
    });
    mockedExistsSync.mockReturnValue(true);
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    expect(await checkCodex()).toBe('ready');
    expect(mockedExecSync).not.toHaveBeenCalledWith('npm root -g', expect.anything());
    expect(mockedAccessSync).toHaveBeenCalledWith('D:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js');
  });

  it('ignores stale codex.cmd PATH shims whose bundle target is missing', async () => {
    mockedExecSync.mockImplementation((command: string) => {
      if (command === 'where.exe codex.exe') throw new Error('native codex missing');
      if (command === 'where.exe codex.cmd') return 'D:\\stale-npm\\codex.cmd\r\n';
      if (command === 'where.exe codex.bat') throw new Error('stale codex bat missing');
      if (command === 'where.exe codex.ps1') throw new Error('stale codex ps1 missing');
      if (command === 'npm root -g') return 'C:\\npm-root\n';
      if (command.startsWith('where.exe node')) return 'D:\\node\\node.exe\r\n';
      throw new Error(`unexpected command: ${command}`);
    });
    mockedAccessSync.mockImplementation((path: unknown) => {
      if (String(path).startsWith('D:\\stale-npm\\')) {
        const error = new Error(`missing ${String(path)}`) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
    });
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    expect(await checkCodex()).toBe('ready');
    expect(mockedExecSync).toHaveBeenCalledWith('npm root -g', expect.anything());
    expect(mockedAccessSync).toHaveBeenCalledWith('C:\\npm-root\\@openai\\codex\\bin\\codex.js');
  });

  it('normalizes Windows npm command shim Codex overrides before checking readiness', async () => {
    process.env.VEYRA_CODEX_CLI_PATH = 'D:\\npm\\codex.cmd';
    mockedExistsSync.mockReturnValue(true);
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    expect(await checkCodex()).toBe('ready');
    expect(mockedExecSync).not.toHaveBeenCalledWith('npm root -g', expect.anything());
    expect(mockedAccessSync).toHaveBeenCalledWith('D:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js');
  });

  it('returns misconfigured for malformed Codex CLI path overrides', async () => {
    process.env.VEYRA_CODEX_CLI_PATH = 'D:\\tools\\not-codex.exe';
    mockedExistsSync.mockReturnValue(true);
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    expect(await checkCodex()).toBe('misconfigured');
    expect(mockedExecSync).not.toHaveBeenCalledWith('npm root -g', expect.anything());
  });

  it('returns not-installed when bundle path resolution throws', async () => {
    mockedExecSync.mockImplementation(() => { throw new Error('npm not found'); });
    // Override platform to win32 for this test path
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(await checkCodex()).toBe('not-installed');
    } finally {
      Object.defineProperty(process, 'platform', { value: orig });
    }
  });

  it('returns unauthenticated when bundle exists but auth.json missing', async () => {
    mockedExecSync.mockReturnValue('/fake/npm/root\n');
    // existsSync is called twice: once for bundle, once for auth file
    mockedExistsSync.mockImplementation((p: any) =>
      String(p).includes('codex.js') ? true : false
    );
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    expect(await checkCodex()).toBe('unauthenticated');
  });

  it('returns inaccessible when the Windows bundle path cannot be inspected', async () => {
    mockedExecSync.mockReturnValue('/fake/npm/root\n');
    mockedAccessSync.mockImplementation((path: unknown) => {
      if (String(path).includes('codex.js')) {
        const error = new Error('permission denied') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
    });
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    expect(await checkCodex()).toBe('inaccessible');
  });

  it('returns ready when both bundle and auth exist', async () => {
    mockedExecSync.mockReturnValue('/fake/npm/root\n');
    mockedExistsSync.mockReturnValue(true);
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    expect(await checkCodex()).toBe('ready');
  });
});

describe('checkGemini', () => {
  it('uses veyra.geminiCliPath before resolving the Windows npm bundle', async () => {
    vscodeMocks.configGet.mockImplementation((key: string, dflt: unknown) =>
      key === 'geminiCliPath' ? 'D:\\settings\\gemini\\gemini.js' : dflt
    );
    mockedExistsSync.mockReturnValue(true);
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    expect(await checkGemini()).toBe('ready');
    expect(mockedExecSync).not.toHaveBeenCalledWith('npm root -g', expect.anything());
    expect(mockedAccessSync).toHaveBeenCalledWith('D:\\settings\\gemini\\gemini.js');
  });

  it('uses VEYRA_GEMINI_CLI_PATH before resolving the Windows npm bundle', async () => {
    process.env.VEYRA_GEMINI_CLI_PATH = 'D:\\tools\\gemini\\gemini.js';
    mockedExistsSync.mockReturnValue(true);
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    expect(await checkGemini()).toBe('ready');
    expect(mockedExecSync).not.toHaveBeenCalledWith('npm root -g', expect.anything());
    expect(mockedAccessSync).toHaveBeenCalledWith('D:\\tools\\gemini\\gemini.js');
  });

  it('does not report Gemini ready for a JS bundle when the Node CLI is missing', async () => {
    process.env.VEYRA_GEMINI_CLI_PATH = 'D:\\tools\\gemini\\gemini.js';
    mockedExistsSync.mockReturnValue(true);
    mockedExecSync.mockImplementation((command: string) => {
      if (command.startsWith('where') || command.includes('Get-Command node')) {
        throw new Error('node not found');
      }
      throw new Error(`unexpected command: ${command}`);
    });
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    expect(await checkGemini()).toBe('node-missing');
  });

  it('uses native gemini.exe from PATH before resolving the Windows npm bundle', async () => {
    mockedExecSync.mockImplementation((command: string) => {
      if (command === 'where.exe gemini.exe') return 'D:\\tools\\gemini\\gemini.exe\r\n';
      throw new Error(`unexpected command: ${command}`);
    });
    mockedExistsSync.mockReturnValue(true);
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    expect(await checkGemini()).toBe('ready');
    expect(mockedExecSync).not.toHaveBeenCalledWith('npm root -g', expect.anything());
    expect(mockedAccessSync).toHaveBeenCalledWith('D:\\tools\\gemini\\gemini.exe');
  });

  it('uses gemini.ps1 from PATH before resolving the Windows npm bundle', async () => {
    mockedExecSync.mockImplementation((command: string) => {
      if (command === 'where.exe gemini.exe') throw new Error('native gemini missing');
      if (command === 'where.exe gemini.ps1') return 'D:\\npm\\gemini.ps1\r\n';
      if (command.startsWith('where.exe node')) return 'D:\\node\\node.exe\r\n';
      throw new Error(`unexpected command: ${command}`);
    });
    mockedExistsSync.mockReturnValue(true);
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    expect(await checkGemini()).toBe('ready');
    expect(mockedExecSync).not.toHaveBeenCalledWith('npm root -g', expect.anything());
    expect(mockedAccessSync).toHaveBeenCalledWith('D:\\npm\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js');
  });

  it('ignores stale gemini.ps1 PATH shims whose bundle target is missing', async () => {
    mockedExecSync.mockImplementation((command: string) => {
      if (command === 'where.exe gemini.exe') throw new Error('native gemini missing');
      if (command === 'where.exe gemini.cmd') throw new Error('stale gemini cmd missing');
      if (command === 'where.exe gemini.bat') throw new Error('stale gemini bat missing');
      if (command === 'where.exe gemini.ps1') return 'D:\\stale-npm\\gemini.ps1\r\n';
      if (command === 'npm root -g') return 'C:\\npm-root\n';
      if (command.startsWith('where.exe node')) return 'D:\\node\\node.exe\r\n';
      throw new Error(`unexpected command: ${command}`);
    });
    mockedAccessSync.mockImplementation((path: unknown) => {
      if (String(path).startsWith('D:\\stale-npm\\')) {
        const error = new Error(`missing ${String(path)}`) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
    });
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    expect(await checkGemini()).toBe('ready');
    expect(mockedExecSync).toHaveBeenCalledWith('npm root -g', expect.anything());
    expect(mockedAccessSync).toHaveBeenCalledWith('C:\\npm-root\\@google\\gemini-cli\\bundle\\gemini.js');
  });

  it('normalizes Windows npm command shim Gemini overrides before checking readiness', async () => {
    process.env.VEYRA_GEMINI_CLI_PATH = 'D:\\npm\\gemini.cmd';
    mockedExistsSync.mockReturnValue(true);
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    expect(await checkGemini()).toBe('ready');
    expect(mockedExecSync).not.toHaveBeenCalledWith('npm root -g', expect.anything());
    expect(mockedAccessSync).toHaveBeenCalledWith('D:\\npm\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js');
  });

  it('returns misconfigured for malformed Gemini CLI path overrides', async () => {
    process.env.VEYRA_GEMINI_CLI_PATH = 'D:\\tools\\not-gemini.exe';
    mockedExistsSync.mockReturnValue(true);
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    expect(await checkGemini()).toBe('misconfigured');
    expect(mockedExecSync).not.toHaveBeenCalledWith('npm root -g', expect.anything());
  });

  it('returns ready when bundle and oauth_creds exist', async () => {
    mockedExecSync.mockReturnValue('/fake/npm/root\n');
    mockedExistsSync.mockReturnValue(true);
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    expect(await checkGemini()).toBe('ready');
  });

  it('returns unauthenticated when oauth_creds missing', async () => {
    mockedExecSync.mockReturnValue('/fake/npm/root\n');
    mockedExistsSync.mockImplementation((p: any) =>
      String(p).includes('gemini.js') ? true : false
    );
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    expect(await checkGemini()).toBe('unauthenticated');
  });

  it('returns inaccessible when the Windows Gemini bundle path cannot be inspected', async () => {
    mockedExecSync.mockReturnValue('/fake/npm/root\n');
    mockedAccessSync.mockImplementation((path: unknown) => {
      if (String(path).includes('gemini.js')) {
        const error = new Error('permission denied') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
    });
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    expect(await checkGemini()).toBe('inaccessible');
  });
});

describe('cache', () => {
  it('returns the cached value within 30 seconds', async () => {
    mockedExecSync.mockReturnValue('/usr/local/bin/claude\n');
    mockedExistsSync.mockReturnValue(true);
    await checkClaude();
    mockedExistsSync.mockReturnValue(false);
    expect(await checkClaude()).toBe('ready'); // cached, didn't re-check
  });

  it('clearStatusCache forces re-check', async () => {
    mockedExecSync.mockReturnValue('/usr/local/bin/claude\n');
    mockedExistsSync.mockReturnValue(true);
    await checkClaude();
    mockedExistsSync.mockReturnValue(false);
    clearStatusCache();
    expect(await checkClaude()).toBe('unauthenticated');
  });
});
