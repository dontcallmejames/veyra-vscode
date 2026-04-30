import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentId, AgentStatus } from './types.js';

const CACHE_TTL_MS = 30_000;
const cache = new Map<AgentId, { status: AgentStatus; expiresAt: number }>();

export function clearStatusCache(): void {
  cache.clear();
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
    const credPath = join(homedir(), '.claude', '.credentials.json');
    if (!existsSync(credPath)) return 'unauthenticated';
    return 'ready';
  });
}

export async function checkCodex(): Promise<AgentStatus> {
  return memoize('codex', async () => {
    const bundle = resolveCodexBundle();
    if (bundle === null) return 'not-installed';
    if (bundle && !existsSync(bundle)) return 'not-installed';
    const authPath = join(homedir(), '.codex', 'auth.json');
    if (!existsSync(authPath)) return 'unauthenticated';
    return 'ready';
  });
}

export async function checkGemini(): Promise<AgentStatus> {
  return memoize('gemini', async () => {
    const bundle = resolveGeminiBundle();
    if (bundle === null) return 'not-installed';
    if (bundle && !existsSync(bundle)) return 'not-installed';
    const authPath = join(homedir(), '.gemini', 'oauth_creds.json');
    if (!existsSync(authPath)) return 'unauthenticated';
    return 'ready';
  });
}

function resolveCodexBundle(): string | null {
  if (process.platform !== 'win32') {
    try {
      execSync('which codex', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return '';
    } catch {
      return null;
    }
  }
  try {
    const npmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return join(npmRoot, '@openai', 'codex', 'bin', 'codex.js');
  } catch {
    return null;
  }
}

function resolveGeminiBundle(): string | null {
  if (process.platform !== 'win32') {
    try {
      execSync('which gemini', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return '';
    } catch {
      return null;
    }
  }
  try {
    const npmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return join(npmRoot, '@google', 'gemini-cli', 'bundle', 'gemini.js');
  } catch {
    return null;
  }
}
