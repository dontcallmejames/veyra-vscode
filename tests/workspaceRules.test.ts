import { describe, it, expect, vi, beforeEach } from 'vitest';

const fsState = new Map<string, string>();

vi.mock('node:fs', () => ({
  existsSync: (p: string) => fsState.has(String(p)),
  readFileSync: (p: string) => {
    const v = fsState.get(String(p));
    if (v === undefined) throw new Error('ENOENT');
    return v;
  },
  statSync: (p: string) => {
    const v = fsState.get(String(p));
    if (v === undefined) throw new Error('ENOENT');
    return { size: Buffer.byteLength(v, 'utf8') };
  },
}));

// Import after mock is defined
const { readWorkspaceRules } = await import('../src/workspaceRules.js');

beforeEach(() => {
  fsState.clear();
});

describe('readWorkspaceRules', () => {
  it('returns empty string when agentchat.md missing', () => {
    expect(readWorkspaceRules('/fake/ws')).toBe('');
  });

  it('returns file contents verbatim when present', () => {
    fsState.set('\\fake\\ws\\agentchat.md', '# Rules\n\n- always pnpm\n');
    expect(readWorkspaceRules('/fake/ws')).toBe('# Rules\n\n- always pnpm\n');
  });

  it('re-reads on each call (no caching)', () => {
    fsState.set('\\fake\\ws\\agentchat.md', 'first');
    expect(readWorkspaceRules('/fake/ws')).toBe('first');
    fsState.set('\\fake\\ws\\agentchat.md', 'second');
    expect(readWorkspaceRules('/fake/ws')).toBe('second');
  });

  it('returns empty string when file exceeds 10MB ceiling', () => {
    fsState.set('\\fake\\ws\\agentchat.md', 'x'.repeat(11 * 1024 * 1024));
    expect(readWorkspaceRules('/fake/ws')).toBe('');
  });
});
