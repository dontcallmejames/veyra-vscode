import { afterEach, describe, it, expect, vi } from 'vitest';

// fileBadges.ts imports vscode at the top level (for FileBadgesController).
// Stub it so the pure-function tests can load the module without a VS Code host.
vi.mock('vscode', () => ({
  EventEmitter: class { event = undefined; fire = vi.fn(); dispose = vi.fn(); },
  ThemeColor: class { constructor(public id: string) {} },
  Uri: { file: (p: string) => ({ scheme: 'file', fsPath: p }) },
  workspace: { workspaceFolders: undefined },
}));

import { FileBadgesController, recordEdit, pruneStale, type FileEditRecord } from '../src/fileBadges.js';

const HOUR = 60 * 60 * 1000;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recordEdit', () => {
  it('adds a new record when path absent', () => {
    const state: FileEditRecord[] = [];
    const next = recordEdit(state, '/abs/foo.ts', 'claude', 1000);
    expect(next).toEqual([
      { path: '/abs/foo.ts', agentId: 'claude', editedAt: 1000, alsoBy: [], changeKind: 'edited' },
    ]);
  });

  it('records the change kind for a newly changed path', () => {
    const state: FileEditRecord[] = [];
    const next = recordEdit(state, '/abs/foo.ts', 'claude', 1000, 'created');
    expect(next).toEqual([
      { path: '/abs/foo.ts', agentId: 'claude', editedAt: 1000, alsoBy: [], changeKind: 'created' },
    ]);
  });

  it('updates editedAt and agentId when same path edited again by different agent', () => {
    const state: FileEditRecord[] = [
      { path: '/abs/foo.ts', agentId: 'claude', editedAt: 1000, alsoBy: [], changeKind: 'edited' },
    ];
    const next = recordEdit(state, '/abs/foo.ts', 'codex', 2000);
    expect(next[0]).toEqual({
      path: '/abs/foo.ts',
      agentId: 'codex',
      editedAt: 2000,
      alsoBy: ['claude'],
      changeKind: 'edited',
    });
  });

  it('updates the change kind when an existing path changes again', () => {
    const state: FileEditRecord[] = [
      { path: '/abs/foo.ts', agentId: 'claude', editedAt: 1000, alsoBy: [], changeKind: 'created' },
    ];
    const next = recordEdit(state, '/abs/foo.ts', 'codex', 2000, 'deleted');
    expect(next[0]).toEqual({
      path: '/abs/foo.ts',
      agentId: 'codex',
      editedAt: 2000,
      alsoBy: ['claude'],
      changeKind: 'deleted',
    });
  });

  it('does not duplicate alsoBy when same prior agent edits twice', () => {
    const state: FileEditRecord[] = [
      { path: '/abs/foo.ts', agentId: 'claude', editedAt: 1000, alsoBy: ['codex'], changeKind: 'edited' },
    ];
    const next = recordEdit(state, '/abs/foo.ts', 'codex', 2000);
    expect(next[0].alsoBy).toEqual(['claude']);
  });

  it('does not add the active agent to alsoBy', () => {
    const state: FileEditRecord[] = [
      { path: '/abs/foo.ts', agentId: 'claude', editedAt: 1000, alsoBy: [], changeKind: 'edited' },
    ];
    const next = recordEdit(state, '/abs/foo.ts', 'claude', 2000);
    expect(next[0]).toEqual({
      path: '/abs/foo.ts',
      agentId: 'claude',
      editedAt: 2000,
      alsoBy: [],
      changeKind: 'edited',
    });
  });

  it('preserves other unrelated records', () => {
    const state: FileEditRecord[] = [
      { path: '/abs/foo.ts', agentId: 'claude', editedAt: 1000, alsoBy: [], changeKind: 'edited' },
      { path: '/abs/bar.ts', agentId: 'codex', editedAt: 1000, alsoBy: [], changeKind: 'edited' },
    ];
    const next = recordEdit(state, '/abs/foo.ts', 'gemini', 2000);
    expect(next.find((r) => r.path === '/abs/bar.ts')).toEqual({
      path: '/abs/bar.ts', agentId: 'codex', editedAt: 1000, alsoBy: [], changeKind: 'edited',
    });
  });
});

describe('pruneStale', () => {
  it('drops records older than 24h', () => {
    const now = 100 * HOUR;
    const state: FileEditRecord[] = [
      { path: '/abs/old.ts', agentId: 'claude', editedAt: now - 25 * HOUR, alsoBy: [], changeKind: 'edited' },
      { path: '/abs/new.ts', agentId: 'codex', editedAt: now - 1 * HOUR, alsoBy: [], changeKind: 'deleted' },
    ];
    const pruned = pruneStale(state, now);
    expect(pruned).toEqual([
      { path: '/abs/new.ts', agentId: 'codex', editedAt: now - 1 * HOUR, alsoBy: [], changeKind: 'deleted' },
    ]);
  });
});

describe('FileBadgesController', () => {
  function createController() {
    const updates: unknown[] = [];
    const context = {
      workspaceState: {
        get: vi.fn(() => []),
        update: vi.fn((_key: string, value: unknown) => {
          updates.push(value);
          return Promise.resolve();
        }),
      },
    };
    return { controller: new FileBadgesController(context as any), updates };
  }

  it('uses created wording in file decoration tooltips', () => {
    vi.spyOn(Date, 'now').mockReturnValue(60_000);
    const { controller } = createController();

    controller.registerEdit('/abs/new.ts', 'gemini', 'created');

    const decoration = controller.provideFileDecoration({ scheme: 'file', fsPath: '/abs/new.ts' } as any);
    expect(decoration?.tooltip).toBe('Created by gemini 0m ago');
  });

  it('uses deleted wording in file decoration tooltips when multiple agents touched the path', () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(60_000)
      .mockReturnValueOnce(120_000)
      .mockReturnValue(180_000);
    const { controller } = createController();

    controller.registerEdit('/abs/old.ts', 'claude', 'edited');
    controller.registerEdit('/abs/old.ts', 'codex', 'deleted');

    const decoration = controller.provideFileDecoration({ scheme: 'file', fsPath: '/abs/old.ts' } as any);
    expect(decoration?.tooltip).toBe('Last deleted by codex 1m ago (also: claude)');
  });
});
