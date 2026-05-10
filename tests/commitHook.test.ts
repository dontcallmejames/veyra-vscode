import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SentinelWriter } from '../src/commitHook.js';

const fsState = new Map<string, string>();

vi.mock('node:fs', () => ({
  existsSync: (p: string) => fsState.has(String(p)),
  writeFileSync: (p: string, content: string) => fsState.set(String(p), content),
  unlinkSync: (p: string) => { fsState.delete(String(p)); },
  mkdirSync: vi.fn(),
  readFileSync: (p: string) => {
    const v = fsState.get(String(p));
    if (v === undefined) throw new Error('ENOENT');
    return v;
  },
}));

beforeEach(() => {
  fsState.clear();
});

describe('SentinelWriter', () => {
  const ws = '/fake/ws';
  const sentinelPath = '/fake/ws/.vscode/veyra/active-dispatch';

  it('writes the agent id to the sentinel file on dispatchStart', () => {
    const w = new SentinelWriter(ws);
    w.dispatchStart('claude');
    expect(fsState.get(sentinelPath)).toBe('claude\n');
  });

  it('overwrites with the most recent agent on consecutive dispatchStart calls', () => {
    const w = new SentinelWriter(ws);
    w.dispatchStart('claude');
    w.dispatchStart('codex');
    expect(fsState.get(sentinelPath)).toBe('codex\n');
  });

  it('deletes the sentinel only when all dispatches end', () => {
    const w = new SentinelWriter(ws);
    w.dispatchStart('claude');
    w.dispatchStart('codex');
    w.dispatchEnd('claude');
    expect(fsState.has(sentinelPath)).toBe(true);
    w.dispatchEnd('codex');
    expect(fsState.has(sentinelPath)).toBe(false);
  });

  it('is a no-op when disabled', () => {
    const w = new SentinelWriter(ws, { enabled: false });
    w.dispatchStart('claude');
    expect(fsState.has(sentinelPath)).toBe(false);
  });

  it('handles dispatchEnd for an agent never started gracefully', () => {
    const w = new SentinelWriter(ws);
    w.dispatchEnd('claude');
    expect(fsState.has(sentinelPath)).toBe(false);
  });
});

import { detectHookManager, installCommitHook, uninstallCommitHook, COMMIT_HOOK_SNIPPET } from '../src/commitHook.js';

describe('detectHookManager', () => {
  const ws = '/fake/ws';

  it('returns null when no manager files present', () => {
    expect(detectHookManager(ws)).toBeNull();
  });

  it('detects husky', () => {
    fsState.set('/fake/ws/.husky', 'directory-marker');
    expect(detectHookManager(ws)).toBe('husky');
  });

  it('detects lefthook.yml', () => {
    fsState.set('/fake/ws/lefthook.yml', '...');
    expect(detectHookManager(ws)).toBe('lefthook');
  });

  it('detects pre-commit', () => {
    fsState.set('/fake/ws/.pre-commit-config.yaml', '...');
    expect(detectHookManager(ws)).toBe('pre-commit');
  });

  it('detects simple-git-hooks in package.json', () => {
    fsState.set('/fake/ws/package.json', JSON.stringify({ 'simple-git-hooks': { 'pre-commit': '...' } }));
    expect(detectHookManager(ws)).toBe('simple-git-hooks');
  });
});

describe('installCommitHook', () => {
  const ws = '/fake/ws';
  const hookPath = '/fake/ws/.git/hooks/prepare-commit-msg';

  it('installs the hook in a clean repo', () => {
    fsState.set('/fake/ws/.git', 'directory-marker');
    const result = installCommitHook(ws);
    expect(result).toEqual({ status: 'installed', path: hookPath });
    expect(fsState.get(hookPath)).toContain('VEYRA-MANAGED');
    expect(fsState.get(hookPath)).toContain('Co-Authored-By: Veyra');
  });

  it('refuses when a non-marker hook already exists', () => {
    fsState.set('/fake/ws/.git', 'directory-marker');
    fsState.set(hookPath, '#!/bin/sh\necho "user hook"\n');
    const result = installCommitHook(ws);
    expect(result.status).toBe('refused-existing');
  });

  it('overwrites an existing VEYRA-MANAGED hook (idempotent upgrade)', () => {
    fsState.set('/fake/ws/.git', 'directory-marker');
    fsState.set(hookPath, '#!/bin/sh\n# VEYRA-MANAGED\nold-content\n');
    const result = installCommitHook(ws);
    expect(result.status).toBe('installed');
    expect(fsState.get(hookPath)).toContain('Co-Authored-By: Veyra');
    expect(fsState.get(hookPath)).not.toContain('old-content');
  });

  it('refuses when a hook manager is detected', () => {
    fsState.set('/fake/ws/.git', 'directory-marker');
    fsState.set('/fake/ws/.husky', 'directory-marker');
    const result = installCommitHook(ws);
    expect(result.status).toBe('refused-hook-manager');
    if (result.status === 'refused-hook-manager') {
      expect(result.manager).toBe('husky');
    }
  });

  it('refuses when .git is missing', () => {
    const result = installCommitHook(ws);
    expect(result.status).toBe('refused-no-git');
  });
});

describe('uninstallCommitHook', () => {
  const ws = '/fake/ws';
  const hookPath = '/fake/ws/.git/hooks/prepare-commit-msg';

  it('removes our managed hook', () => {
    fsState.set(hookPath, '#!/bin/sh\n# VEYRA-MANAGED\n...');
    const result = uninstallCommitHook(ws);
    expect(result.status).toBe('removed');
    expect(fsState.has(hookPath)).toBe(false);
  });

  it('refuses to remove a user-authored hook', () => {
    fsState.set(hookPath, '#!/bin/sh\necho "user hook"\n');
    const result = uninstallCommitHook(ws);
    expect(result.status).toBe('refused-not-managed');
    expect(fsState.has(hookPath)).toBe(true);
  });

  it('reports no-op when nothing to remove', () => {
    const result = uninstallCommitHook(ws);
    expect(result.status).toBe('not-installed');
  });
});

describe('COMMIT_HOOK_SNIPPET', () => {
  it('contains the VEYRA-MANAGED marker', () => {
    expect(COMMIT_HOOK_SNIPPET).toContain('VEYRA-MANAGED');
  });
  it('reads the active-dispatch sentinel', () => {
    expect(COMMIT_HOOK_SNIPPET).toContain('.vscode/veyra/active-dispatch');
  });
  it('is idempotent (greps before appending)', () => {
    expect(COMMIT_HOOK_SNIPPET).toContain('Co-Authored-By: Veyra');
    expect(COMMIT_HOOK_SNIPPET).toContain('grep -q');
  });
});
