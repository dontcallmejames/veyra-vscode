import { describe, it, expect } from 'vitest';
import { buildSharedContext } from '../src/sharedContext.js';
import type { Session, UserMessage, AgentMessage, SystemMessage } from '../src/shared/protocol.js';

const u = (id: string, text: string, ts = 1000): UserMessage => ({
  id, role: 'user', text, timestamp: ts,
});

const a = (
  id: string,
  agentId: 'claude' | 'codex' | 'gemini',
  text: string,
  status: AgentMessage['status'] = 'complete',
  ts = 2000,
): AgentMessage => ({
  id, role: 'agent', agentId, text, toolEvents: [], timestamp: ts, status,
});

const sys = (id: string, kind: SystemMessage['kind'] = 'error', text = ''): SystemMessage => ({
  id, role: 'system', kind, text, timestamp: 3000,
});

const session = (...messages: Session['messages']): Session => ({ version: 1, messages });

describe('buildSharedContext', () => {
  it('returns empty string for empty session', () => {
    expect(buildSharedContext(session(), { window: 25 })).toBe('');
  });

  it('includes user + complete agent text', () => {
    const ctx = buildSharedContext(
      session(u('1', 'hi'), a('2', 'claude', 'hello back')),
      { window: 25 },
    );
    expect(ctx).toContain('user: hi');
    expect(ctx).toContain('claude: hello back');
    expect(ctx.startsWith('[Conversation so far]')).toBe(true);
    expect(ctx.trimEnd().endsWith('[/Conversation so far]')).toBe(true);
  });

  it('includes errored agent text (still went to user)', () => {
    const ctx = buildSharedContext(
      session(u('1', 'hi'), a('2', 'codex', 'partial', 'errored')),
      { window: 25 },
    );
    expect(ctx).toContain('codex: partial');
  });

  it('excludes cancelled agent text', () => {
    const ctx = buildSharedContext(
      session(u('1', 'hi'), a('2', 'codex', 'never delivered', 'cancelled')),
      { window: 25 },
    );
    expect(ctx).not.toContain('never delivered');
  });

  it('excludes system messages', () => {
    const ctx = buildSharedContext(
      session(u('1', 'hi'), sys('2', 'facilitator-decision', 'routed to claude')),
      { window: 25 },
    );
    expect(ctx).not.toContain('routed to claude');
  });

  it('excludes tool events even when present', () => {
    const msg = a('2', 'claude', 'reply');
    msg.toolEvents = [
      { kind: 'call', name: 'Read', input: { file_path: '/foo' }, timestamp: 100 },
      { kind: 'result', name: 'Read', output: 'file contents', timestamp: 101 },
    ];
    const ctx = buildSharedContext(session(u('1', 'hi'), msg), { window: 25 });
    expect(ctx).toContain('claude: reply');
    expect(ctx).not.toContain('file contents');
    expect(ctx).not.toContain('Read');
  });

  it('applies sliding window and prepends omitted prefix', () => {
    const messages = [];
    for (let i = 0; i < 30; i++) {
      messages.push(u(`u${i}`, `msg ${i}`, i * 10));
    }
    const ctx = buildSharedContext(session(...messages), { window: 5 });
    expect(ctx).toContain('[Conversation so far — earlier messages omitted]');
    expect(ctx).toContain('msg 25');
    expect(ctx).toContain('msg 29');
    expect(ctx).not.toContain('msg 24');
    expect(ctx).not.toContain('msg 0');
  });

  it('does not add omitted prefix when window not exceeded', () => {
    const ctx = buildSharedContext(
      session(u('1', 'a'), u('2', 'b'), u('3', 'c')),
      { window: 25 },
    );
    expect(ctx).not.toContain('earlier messages omitted');
    expect(ctx.startsWith('[Conversation so far]')).toBe(true);
  });

  it('preserves @mentions inside user text', () => {
    const ctx = buildSharedContext(
      session(u('1', '@gpt continue from claude')),
      { window: 25 },
    );
    expect(ctx).toContain('user: @gpt continue from claude');
  });

  it('counts user + agent messages combined for window', () => {
    // 4 user + 4 agent = 8 total; window of 3 keeps last 3
    const messages = [
      u('u1', 'a', 100), a('a1', 'claude', 'A', 'complete', 200),
      u('u2', 'b', 300), a('a2', 'codex', 'B', 'complete', 400),
      u('u3', 'c', 500), a('a3', 'claude', 'C', 'complete', 600),
      u('u4', 'd', 700), a('a4', 'gemini', 'D', 'complete', 800),
    ];
    const ctx = buildSharedContext(session(...messages), { window: 3 });
    expect(ctx).toContain('user: d');
    expect(ctx).toContain('claude: C');
    expect(ctx).toContain('gemini: D');
    expect(ctx).not.toContain('codex: B');
    expect(ctx).not.toContain('user: c');
  });
});
