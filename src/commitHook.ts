import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentId } from './types.js';

const SENTINEL_DIR_REL = path.join('.vscode', 'agent-chat');
const SENTINEL_NAME = 'active-dispatch';

export interface SentinelWriterOptions {
  enabled?: boolean;
}

export class SentinelWriter {
  private active = new Set<AgentId>();
  private latest: AgentId | null = null;
  private readonly enabled: boolean;
  private readonly dir: string;
  private readonly file: string;

  constructor(workspacePath: string, options: SentinelWriterOptions = {}) {
    this.enabled = options.enabled !== false;
    this.dir = path.join(workspacePath, SENTINEL_DIR_REL).replace(/\\/g, '/');
    this.file = path.join(this.dir, SENTINEL_NAME).replace(/\\/g, '/');
  }

  dispatchStart(agentId: AgentId): void {
    if (!this.enabled) return;
    this.active.add(agentId);
    this.latest = agentId;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, `${agentId}\n`);
    } catch {
      // best-effort
    }
  }

  dispatchEnd(agentId: AgentId): void {
    if (!this.enabled) return;
    this.active.delete(agentId);
    if (this.active.size === 0) {
      this.latest = null;
      try {
        if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
      } catch {
        // best-effort
      }
    } else {
      const remaining = this.active.values().next().value;
      if (remaining) {
        this.latest = remaining;
        try {
          fs.writeFileSync(this.file, `${remaining}\n`);
        } catch {
          // best-effort
        }
      }
    }
  }
}

export const COMMIT_HOOK_SNIPPET = [
  '#!/bin/sh',
  '# AGENT-CHAT-MANAGED',
  '# Tags commits made during an Agent Chat dispatch with a Co-Authored-By trailer.',
  'SENTINEL=".vscode/agent-chat/active-dispatch"',
  'if [ -f "$SENTINEL" ]; then',
  '  AGENT_ID=$(cat "$SENTINEL" | tr -d \'[:space:]\')',
  '  if [ -n "$AGENT_ID" ]; then',
  '    if ! grep -q "Co-Authored-By: Agent Chat" "$1"; then',
  '      printf "\\nCo-Authored-By: Agent Chat (%s) <agent-chat@local>\\n" "$AGENT_ID" >> "$1"',
  '    fi',
  '  fi',
  'fi',
  '',
].join('\n');

export type HookManager = 'husky' | 'lefthook' | 'pre-commit' | 'simple-git-hooks';

export function detectHookManager(workspacePath: string): HookManager | null {
  const wsNorm = (p: string) => p.replace(/\\/g, '/');
  if (fs.existsSync(wsNorm(path.join(workspacePath, '.husky')))) return 'husky';
  if (fs.existsSync(wsNorm(path.join(workspacePath, 'lefthook.yml')))) return 'lefthook';
  if (fs.existsSync(wsNorm(path.join(workspacePath, '.pre-commit-config.yaml')))) return 'pre-commit';
  const pkgPath = wsNorm(path.join(workspacePath, 'package.json'));
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg && typeof pkg === 'object' && pkg['simple-git-hooks']) return 'simple-git-hooks';
    } catch {
      // ignore malformed package.json
    }
  }
  return null;
}

export type InstallResult =
  | { status: 'installed'; path: string }
  | { status: 'refused-no-git' }
  | { status: 'refused-existing' }
  | { status: 'refused-hook-manager'; manager: HookManager };

export function installCommitHook(workspacePath: string): InstallResult {
  const wsNorm = (p: string) => p.replace(/\\/g, '/');
  if (!fs.existsSync(wsNorm(path.join(workspacePath, '.git')))) {
    return { status: 'refused-no-git' };
  }
  const manager = detectHookManager(workspacePath);
  if (manager) {
    return { status: 'refused-hook-manager', manager };
  }
  const hookDir = wsNorm(path.join(workspacePath, '.git', 'hooks'));
  const hookPath = wsNorm(path.join(hookDir, 'prepare-commit-msg'));

  if (fs.existsSync(hookPath)) {
    let existing = '';
    try {
      existing = fs.readFileSync(hookPath, 'utf8');
    } catch {
      return { status: 'refused-existing' };
    }
    if (!existing.includes('AGENT-CHAT-MANAGED')) {
      return { status: 'refused-existing' };
    }
  }

  try {
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(hookPath, COMMIT_HOOK_SNIPPET, { mode: 0o755 });
  } catch {
    return { status: 'refused-existing' };
  }
  return { status: 'installed', path: hookPath };
}

export type UninstallResult =
  | { status: 'removed' }
  | { status: 'refused-not-managed' }
  | { status: 'not-installed' };

export function uninstallCommitHook(workspacePath: string): UninstallResult {
  const wsNorm = (p: string) => p.replace(/\\/g, '/');
  const hookPath = wsNorm(path.join(workspacePath, '.git', 'hooks', 'prepare-commit-msg'));
  if (!fs.existsSync(hookPath)) return { status: 'not-installed' };
  let existing = '';
  try {
    existing = fs.readFileSync(hookPath, 'utf8');
  } catch {
    return { status: 'refused-not-managed' };
  }
  if (!existing.includes('AGENT-CHAT-MANAGED')) {
    return { status: 'refused-not-managed' };
  }
  try {
    fs.unlinkSync(hookPath);
  } catch {
    return { status: 'refused-not-managed' };
  }
  return { status: 'removed' };
}
