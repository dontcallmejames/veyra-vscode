import { describe, it, expect } from 'vitest';
import { initialState, reduce } from '../src/webview/state.js';
import type { FromExtension, Session, AgentMessage } from '../src/shared/protocol.js';
import { DEFAULT_SETTINGS } from '../src/shared/protocol.js';

const emptySession: Session = { version: 1, messages: [] };

describe('webview state reducer', () => {
  it('init replaces session/status/settings', () => {
    const state = initialState();
    const event: FromExtension = {
      kind: 'init',
      session: { version: 1, messages: [{ id: 'u1', role: 'user', text: 'hi', timestamp: 1 }] },
      status: { claude: 'ready', codex: 'unauthenticated', gemini: 'ready' },
      settings: { toolCallRenderStyle: 'verbose' },
      veyraMdPresent: false,
    };
    const next = reduce(state, event);
    expect(next.session.messages).toHaveLength(1);
    expect(next.status.codex).toBe('unauthenticated');
    expect(next.settings.toolCallRenderStyle).toBe('verbose');
  });

  it('message-started adds an in-progress entry', () => {
    let state = initialState();
    state = reduce(state, {
      kind: 'message-started',
      id: 'm1',
      agentId: 'claude',
      timestamp: 100,
    });
    expect(state.inProgress.size).toBe(1);
    const msg = state.inProgress.get('m1');
    expect(msg).toEqual({
      id: 'm1', role: 'agent', agentId: 'claude',
      text: '', toolEvents: [], timestamp: 100,
    });
  });

  it('message-chunk text appends to in-progress text', () => {
    let state = initialState();
    state = reduce(state, { kind: 'message-started', id: 'm1', agentId: 'claude', timestamp: 100 });
    state = reduce(state, { kind: 'message-chunk', id: 'm1', chunk: { type: 'text', text: 'hello ' } });
    state = reduce(state, { kind: 'message-chunk', id: 'm1', chunk: { type: 'text', text: 'world' } });
    expect(state.inProgress.get('m1')!.text).toBe('hello world');
  });

  it('message-chunk tool-call appends to toolEvents', () => {
    let state = initialState();
    state = reduce(state, { kind: 'message-started', id: 'm1', agentId: 'claude', timestamp: 100 });
    state = reduce(state, {
      kind: 'message-chunk',
      id: 'm1',
      chunk: { type: 'tool-call', name: 'read_file', input: { path: 'a.ts' } },
    });
    expect(state.inProgress.get('m1')!.toolEvents).toHaveLength(1);
    expect(state.inProgress.get('m1')!.toolEvents[0]).toMatchObject({
      kind: 'call', name: 'read_file',
    });
  });

  it('message-chunk done is ignored (state unchanged)', () => {
    let state = initialState();
    state = reduce(state, { kind: 'message-started', id: 'm1', agentId: 'claude', timestamp: 100 });
    const before = state;
    state = reduce(state, { kind: 'message-chunk', id: 'm1', chunk: { type: 'done' } });
    expect(state).toEqual(before);
  });

  it('message-finalized moves from in-progress to session.messages', () => {
    let state = initialState();
    state = reduce(state, { kind: 'message-started', id: 'm1', agentId: 'claude', timestamp: 100 });
    const finalized: AgentMessage = {
      id: 'm1', role: 'agent', agentId: 'claude',
      text: 'done!', toolEvents: [], timestamp: 100, status: 'complete',
    };
    state = reduce(state, { kind: 'message-finalized', message: finalized });
    expect(state.inProgress.size).toBe(0);
    expect(state.session.messages).toContainEqual(finalized);
  });

  it('system-message appends to session.messages', () => {
    const state = reduce(initialState(), {
      kind: 'system-message',
      message: { id: 's1', role: 'system', kind: 'routing-needed', text: 'Please prefix...', timestamp: 1 },
    });
    expect(state.session.messages).toHaveLength(1);
  });

  it('system-message appends visible change-set notices', () => {
    const state = reduce(initialState(), {
      kind: 'system-message',
      message: {
        id: 's2',
        role: 'system',
        kind: 'change-set',
        text: 'Codex changed 1 file. Review pending changes before continuing.',
        timestamp: 1,
        agentId: 'codex',
        changeSet: {
          id: 'change-set-1',
          agentId: 'codex',
          messageId: 'msg1',
          timestamp: 1,
          readOnly: false,
          status: 'pending',
          fileCount: 1,
          files: [{ path: 'src/a.ts', changeKind: 'edited' }],
        },
      },
    });

    expect(state.session.messages).toContainEqual(expect.objectContaining({
      role: 'system',
      kind: 'change-set',
      changeSet: expect.objectContaining({
        id: 'change-set-1',
        files: [{ path: 'src/a.ts', changeKind: 'edited' }],
      }),
    }));
  });

  it('floor-changed updates floorHolder', () => {
    const state = reduce(initialState(), { kind: 'floor-changed', holder: 'codex' });
    expect(state.floorHolder).toBe('codex');
  });

  it('status-changed updates a single agent status', () => {
    let state = initialState();
    state = reduce(state, {
      kind: 'init',
      session: emptySession,
      status: { claude: 'ready', codex: 'ready', gemini: 'ready' },
      settings: DEFAULT_SETTINGS,
      veyraMdPresent: false,
    });
    state = reduce(state, { kind: 'status-changed', agentId: 'gemini', status: 'unauthenticated' });
    expect(state.status.gemini).toBe('unauthenticated');
    expect(state.status.claude).toBe('ready');
  });

  it('settings-changed replaces settings', () => {
    let state = initialState();
    state = reduce(state, {
      kind: 'settings-changed',
      settings: { toolCallRenderStyle: 'hidden' },
    });
    expect(state.settings.toolCallRenderStyle).toBe('hidden');
  });

  it('user-message-appended adds to session.messages', () => {
    const state = reduce(initialState(), {
      kind: 'user-message-appended',
      message: { id: 'u1', role: 'user', text: 'hi', timestamp: 1 },
    });
    expect(state.session.messages).toEqual([{ id: 'u1', role: 'user', text: 'hi', timestamp: 1 }]);
  });

  it('file-edited appends a visible system notice', () => {
    const state = reduce(initialState(), {
      kind: 'file-edited',
      path: 'src/parser.ts',
      agentId: 'codex',
      timestamp: 100,
    });

    expect(state.session.messages).toContainEqual(expect.objectContaining({
      role: 'system',
      kind: 'file-edited',
      text: 'Codex edited src/parser.ts',
      agentId: 'codex',
      filePath: 'src/parser.ts',
      timestamp: 100,
    }));
  });

  it('file-edited labels deleted files as deleted', () => {
    const state = reduce(initialState(), {
      kind: 'file-edited',
      path: 'src/removed.ts',
      agentId: 'claude',
      timestamp: 100,
      changeKind: 'deleted',
    });

    expect(state.session.messages).toContainEqual(expect.objectContaining({
      role: 'system',
      kind: 'file-edited',
      text: 'Claude deleted src/removed.ts',
      agentId: 'claude',
      filePath: 'src/removed.ts',
      changeKind: 'deleted',
      timestamp: 100,
    }));
  });
});
