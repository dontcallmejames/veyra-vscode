import { accessSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentId, AgentStatus } from './types.js';
import { getCodexCliPathOverride, getGeminiCliPathOverride } from './cliPathOverrides.js';
import { cliPathMisconfiguration, normalizeCliPathOverride, windowsNpmShimNames, type CliRuntimeName } from './cliPathValidation.js';

const CACHE_TTL_MS = 30_000;
const cache = new Map<AgentId, { status: AgentStatus; expiresAt: number }>();

export function clearStatusCache(): void {
  cache.clear();
  cachedNpmRoot = null;
}

async function memoize(agentId: AgentId, check: () => Promise<AgentStatus>): Promise<AgentStatus> {
  const entry = cache.get(agentId);
  const now = Date.now();
  if (entry && entry.expiresAt > now) return entry.status;
  const status = await check();
  cache.set(agentId, { status, expiresAt: now + CACHE_TTL_MS });
  return status;
}

export async function checkClaude(): Promise<AgentStatus> {
  return memoize('claude', async () => {
    if (!commandExists('claude')) return 'not-installed';
    const credPath = join(homedir(), '.claude', '.credentials.json');
    const credStatus = inspectPath(credPath);
    if (credStatus === 'inaccessible') return 'inaccessible';
    if (credStatus === 'missing') return 'unauthenticated';
    if (process.versions.electron !== undefined && !commandExists('node')) return 'node-missing';
    return 'ready';
  });
}

export async function checkCodex(): Promise<AgentStatus> {
  return memoize('codex', async () => {
    const bundle = resolveCodexBundle();
    if (bundle === null) return 'not-installed';
    if (bundle) {
      if (isUnsupportedWindowsCommandShim(bundle)) return 'inaccessible';
      if (cliPathMisconfiguration('codex', bundle)) return 'misconfigured';
      const bundleStatus = inspectPath(bundle);
      if (bundleStatus === 'inaccessible') return 'inaccessible';
      if (bundleStatus === 'missing') return 'not-installed';
      if (requiresNode(bundle) && !commandExists('node')) return 'node-missing';
    }
    const authPath = join(homedir(), '.codex', 'auth.json');
    const authStatus = inspectPath(authPath);
    if (authStatus === 'inaccessible') return 'inaccessible';
    if (authStatus === 'missing') return 'unauthenticated';
    return 'ready';
  });
}

export async function checkGemini(): Promise<AgentStatus> {
  return memoize('gemini', async () => {
    const bundle = resolveGeminiBundle();
    if (bundle === null) return 'not-installed';
    if (bundle) {
      if (isUnsupportedWindowsCommandShim(bundle)) return 'inaccessible';
      if (cliPathMisconfiguration('gemini', bundle)) return 'misconfigured';
      const bundleStatus = inspectPath(bundle);
      if (bundleStatus === 'inaccessible') return 'inaccessible';
      if (bundleStatus === 'missing') return 'not-installed';
      if (requiresNode(bundle) && !commandExists('node')) return 'node-missing';
    }
    const authPath = join(homedir(), '.gemini', 'oauth_creds.json');
    const authStatus = inspectPath(authPath);
    if (authStatus === 'inaccessible') return 'inaccessible';
    if (authStatus === 'missing') return 'unauthenticated';
    return 'ready';
  });
}

function inspectPath(filePath: string): 'exists' | 'missing' | 'inaccessible' {
  try {
    accessSync(filePath);
    return 'exists';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EACCES' || (error as NodeJS.ErrnoException).code === 'EPERM') {
      return 'inaccessible';
    }
    return 'missing';
  }
}

function isUnsupportedWindowsCommandShim(filePath: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(filePath);
}

function requiresNode(filePath: string): boolean {
  return /\.js$/i.test(filePath);
}

let cachedNpmRoot: string | null = null;
function getNpmRoot(): string | null {
  if (cachedNpmRoot !== null) return cachedNpmRoot;
  try {
    cachedNpmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return cachedNpmRoot;
  } catch {
    return null;
  }
}

function resolveCodexBundle(): string | null {
  const override = getCodexCliPathOverride();
  if (override) return override;

  if (process.platform !== 'win32') {
    return commandExists('codex') ? '' : null;
  }
  const nativeExecutable = resolveWindowsNativeExecutable('codex');
  if (nativeExecutable) return nativeExecutable;
  const shimExecutable = resolveWindowsNpmShim('codex');
  if (shimExecutable) return shimExecutable;

  const npmRoot = getNpmRoot();
  return npmRoot ? join(npmRoot, '@openai', 'codex', 'bin', 'codex.js') : null;
}

function resolveGeminiBundle(): string | null {
  const override = getGeminiCliPathOverride();
  if (override) return override;

  if (process.platform !== 'win32') {
    return commandExists('gemini') ? '' : null;
  }
  const nativeExecutable = resolveWindowsNativeExecutable('gemini');
  if (nativeExecutable) return nativeExecutable;
  const shimExecutable = resolveWindowsNpmShim('gemini');
  if (shimExecutable) return shimExecutable;

  const npmRoot = getNpmRoot();
  return npmRoot ? join(npmRoot, '@google', 'gemini-cli', 'bundle', 'gemini.js') : null;
}

function resolveWindowsNpmShim(runtime: CliRuntimeName): string | null {
  for (const shimName of windowsNpmShimNames(runtime)) {
    try {
      const output = execSync(`where.exe ${shimName}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const shimPath = output
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find((line) => line.toLowerCase().endsWith(shimName));
      if (shimPath) {
        const bundle = normalizeCliPathOverride(runtime, shimPath);
        const status = inspectPath(bundle);
        if (status !== 'missing') return bundle;
      }
    } catch {
      // keep probing alternate shim extensions, then fall back to npm root
    }
  }

  return null;
}

function resolveWindowsNativeExecutable(baseName: 'codex' | 'gemini'): string | null {
  try {
    const output = execSync(`where.exe ${baseName}.exe`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const expectedName = `${baseName}.exe`.toLowerCase();
    return output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.toLowerCase().endsWith(expectedName)) ?? null;
  } catch {
    return null;
  }
}

function commandExists(command: string): boolean {
  if (process.platform === 'win32') {
    try {
      execSync(
        `where.exe ${command}`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      return true;
    } catch {
      if (!/^[A-Za-z0-9_.-]+$/.test(command)) return false;
      try {
        execSync(
          `powershell.exe -NoProfile -Command "Get-Command ${command} -ErrorAction Stop | Out-Null"`,
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        );
        return true;
      } catch {
        return false;
      }
    }
  }

  try {
    execSync(`which ${command}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}
