import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkClaude, checkCodex, checkGemini, clearStatusCache } from '../src/statusChecks.js';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
const mockedExistsSync = existsSync as unknown as ReturnType<typeof vi.fn>;
const mockedExecSync = execSync as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearStatusCache();
  mockedExistsSync.mockReset();
  mockedExecSync.mockReset();
});

describe('checkClaude', () => {
  it('returns ready when credentials exist', async () => {
    mockedExistsSync.mockReturnValue(true);
    expect(await checkClaude()).toBe('ready');
  });

  it('returns unauthenticated when credentials missing', async () => {
    mockedExistsSync.mockReturnValue(false);
    expect(await checkClaude()).toBe('unauthenticated');
  });
});

describe('checkCodex', () => {
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

  it('returns ready when both bundle and auth exist', async () => {
    mockedExecSync.mockReturnValue('/fake/npm/root\n');
    mockedExistsSync.mockReturnValue(true);
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    expect(await checkCodex()).toBe('ready');
  });
});

describe('checkGemini', () => {
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
});

describe('cache', () => {
  it('returns the cached value within 30 seconds', async () => {
    mockedExistsSync.mockReturnValue(true);
    await checkClaude();
    mockedExistsSync.mockReturnValue(false);
    expect(await checkClaude()).toBe('ready'); // cached, didn't re-check
  });

  it('clearStatusCache forces re-check', async () => {
    mockedExistsSync.mockReturnValue(true);
    await checkClaude();
    mockedExistsSync.mockReturnValue(false);
    clearStatusCache();
    expect(await checkClaude()).toBe('unauthenticated');
  });
});
