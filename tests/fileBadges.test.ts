import { describe, it, expect, vi } from 'vitest';

// fileBadges.ts imports vscode at the top level (for FileBadgesController).
// Stub it so the pure-function tests can load the module without a VS Code host.
vi.mock('vscode', () => ({
  EventEmitter: class { event = undefined; fire = vi.fn(); dispose = vi.fn(); },
  ThemeColor: class { constructor(public id: string) {} },
  Uri: { file: (p: string) => ({ scheme: 'file', fsPath: p }) },
}));

import { recordEdit, pruneStale, type FileEditRecord } from '../src/fileBadges.js';

const HOUR = 60 * 60 * 1000;

describe('recordEdit', () => {
  it('adds a new record when path absent', () => {
    const state: FileEditRecord[] = [];
    const next = recordEdit(state, '/abs/foo.ts', 'claude', 1000);
    expect(next).toEqual([
      { path: '/abs/foo.ts', agentId: 'claude', editedAt: 1000, alsoBy: [] },
    ]);
  });

  it('updates editedAt and agentId when same path edited again by different agent', () => {
    const state: FileEditRecord[] = [
      { path: '/abs/foo.ts', agentId: 'claude', editedAt: 1000, alsoBy: [] },
    ];
    const next = recordEdit(state, '/abs/foo.ts', 'codex', 2000);
    expect(next[0]).toEqual({
      path: '/abs/foo.ts',
      agentId: 'codex',
      editedAt: 2000,
      alsoBy: ['claude'],
    });
  });

  it('does not duplicate alsoBy when same prior agent edits twice', () => {
    const state: FileEditRecord[] = [
      { path: '/abs/foo.ts', agentId: 'claude', editedAt: 1000, alsoBy: ['codex'] },
    ];
    const next = recordEdit(state, '/abs/foo.ts', 'codex', 2000);
    expect(next[0].alsoBy).toEqual(['claude']);
  });

  it('does not add the active agent to alsoBy', () => {
    const state: FileEditRecord[] = [
      { path: '/abs/foo.ts', agentId: 'claude', editedAt: 1000, alsoBy: [] },
    ];
    const next = recordEdit(state, '/abs/foo.ts', 'claude', 2000);
    expect(next[0]).toEqual({
      path: '/abs/foo.ts',
      agentId: 'claude',
      editedAt: 2000,
      alsoBy: [],
    });
  });

  it('preserves other unrelated records', () => {
    const state: FileEditRecord[] = [
      { path: '/abs/foo.ts', agentId: 'claude', editedAt: 1000, alsoBy: [] },
      { path: '/abs/bar.ts', agentId: 'codex', editedAt: 1000, alsoBy: [] },
    ];
    const next = recordEdit(state, '/abs/foo.ts', 'gemini', 2000);
    expect(next.find((r) => r.path === '/abs/bar.ts')).toEqual({
      path: '/abs/bar.ts', agentId: 'codex', editedAt: 1000, alsoBy: [],
    });
  });
});

describe('pruneStale', () => {
  it('drops records older than 24h', () => {
    const now = 100 * HOUR;
    const state: FileEditRecord[] = [
      { path: '/abs/old.ts', agentId: 'claude', editedAt: now - 25 * HOUR, alsoBy: [] },
      { path: '/abs/new.ts', agentId: 'codex', editedAt: now - 1 * HOUR, alsoBy: [] },
    ];
    const pruned = pruneStale(state, now);
    expect(pruned).toEqual([
      { path: '/abs/new.ts', agentId: 'codex', editedAt: now - 1 * HOUR, alsoBy: [] },
    ]);
  });
});
