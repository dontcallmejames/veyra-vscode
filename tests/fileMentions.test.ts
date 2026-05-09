import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseFileMentions, embedFiles } from '../src/fileMentions.js';

const fsState = new Map<string, string | Buffer>();

vi.mock('node:fs', () => ({
  existsSync: (p: string) => fsState.has(String(p)),
  readFileSync: (p: string, _enc?: string) => {
    const v = fsState.get(String(p));
    if (v === undefined) throw new Error('ENOENT');
    return v;
  },
  statSync: (p: string) => {
    const v = fsState.get(String(p));
    if (v === undefined) throw new Error('ENOENT');
    return { size: typeof v === 'string' ? Buffer.byteLength(v, 'utf8') : v.length };
  },
}));

beforeEach(() => {
  fsState.clear();
});

describe('parseFileMentions', () => {
  it('returns empty list when no @ tokens', () => {
    expect(parseFileMentions('hello world')).toEqual({ filePaths: [], remainingText: 'hello world' });
  });

  it('skips agent mentions (@claude, @gpt, @gemini, @all, @codex, @chatgpt)', () => {
    expect(parseFileMentions('@claude review')).toEqual({ filePaths: [], remainingText: '@claude review' });
    expect(parseFileMentions('@gpt @gemini both')).toEqual({ filePaths: [], remainingText: '@gpt @gemini both' });
  });

  it('extracts a single @path token (contains slash)', () => {
    const r = parseFileMentions('review @src/auth.ts please');
    expect(r.filePaths).toEqual(['src/auth.ts']);
    expect(r.remainingText).toBe('review please');
  });

  it('extracts a single @path token (contains dot, no slash)', () => {
    const r = parseFileMentions('look at @package.json');
    expect(r.filePaths).toEqual(['package.json']);
    expect(r.remainingText).toBe('look at');
  });

  it('extracts multiple paths preserving order', () => {
    const r = parseFileMentions('compare @a/foo.ts and @b/bar.ts');
    expect(r.filePaths).toEqual(['a/foo.ts', 'b/bar.ts']);
    expect(r.remainingText).toBe('compare and');
  });

  it('strips trailing sentence punctuation from file mention tokens', () => {
    const r = parseFileMentions('compare @a/foo.ts, then @b/bar.ts:');
    expect(r.filePaths).toEqual(['a/foo.ts', 'b/bar.ts']);
    expect(r.remainingText).toBe('compare then');
  });

  it('extracts parenthesized file mentions without leaving empty wrappers', () => {
    const r = parseFileMentions('review (@src/auth.ts) before editing');
    expect(r.filePaths).toEqual(['src/auth.ts']);
    expect(r.remainingText).toBe('review before editing');
  });

  it('extracts parenthesized file mentions adjacent to prompt words', () => {
    const r = parseFileMentions('review(@src/auth.ts) before editing');
    expect(r.filePaths).toEqual(['src/auth.ts']);
    expect(r.remainingText).toBe('review before editing');
  });

  it('mid-sentence @path is still parsed (file mentions are not position-restricted)', () => {
    const r = parseFileMentions('please review @src/auth.ts thanks');
    expect(r.filePaths).toEqual(['src/auth.ts']);
  });

  it('handles agent mention + file mention together', () => {
    const r = parseFileMentions('@claude review @src/auth.ts');
    expect(r.filePaths).toEqual(['src/auth.ts']);
    expect(r.remainingText).toBe('@claude review');
  });

  it('preserves multiline prompt formatting while removing file mentions', () => {
    const r = parseFileMentions([
      '@claude review @src/auth.ts',
      '',
      'Keep this checklist shape:',
      '  - first item',
      '  - second item',
      '',
      '```ts',
      'const value = 1;',
      '```',
    ].join('\n'));

    expect(r.filePaths).toEqual(['src/auth.ts']);
    expect(r.remainingText).toBe([
      '@claude review',
      '',
      'Keep this checklist shape:',
      '  - first item',
      '  - second item',
      '',
      '```ts',
      'const value = 1;',
      '```',
    ].join('\n'));
  });

  it('does not treat scoped package names as file attachments', () => {
    const r = parseFileMentions('upgrade @anthropic-ai/claude-agent-sdk and @openai/codex');

    expect(r.filePaths).toEqual([]);
    expect(r.remainingText).toBe('upgrade @anthropic-ai/claude-agent-sdk and @openai/codex');
  });

  it('extracts extensionless workspace paths with slashes', () => {
    const r = parseFileMentions('review @src/schema and @config/app');

    expect(r.filePaths).toEqual(['src/schema', 'config/app']);
    expect(r.remainingText).toBe('review and');
  });

  it('does not remove file-looking tokens inside fenced code blocks', () => {
    const r = parseFileMentions([
      'review @src/auth.ts and this snippet:',
      '',
      '```ts',
      '@fixtures/not-an-attachment.ts',
      '```',
    ].join('\n'));

    expect(r.filePaths).toEqual(['src/auth.ts']);
    expect(r.remainingText).toBe([
      'review and this snippet:',
      '',
      '```ts',
      '@fixtures/not-an-attachment.ts',
      '```',
    ].join('\n'));
  });

  it('does not remove file-looking tokens inside tilde fenced code blocks', () => {
    const r = parseFileMentions([
      'review @src/auth.ts and this snippet:',
      '',
      '~~~text',
      '@fixtures/not-an-attachment.ts',
      '~~~',
    ].join('\n'));

    expect(r.filePaths).toEqual(['src/auth.ts']);
    expect(r.remainingText).toBe([
      'review and this snippet:',
      '',
      '~~~text',
      '@fixtures/not-an-attachment.ts',
      '~~~',
    ].join('\n'));
  });

  it('keeps scanning disabled until the matching fence marker closes', () => {
    const r = parseFileMentions([
      'review @src/auth.ts and this snippet:',
      '',
      '```md',
      '~~~',
      '@fixtures/not-an-attachment.ts',
      '~~~',
      '```',
    ].join('\n'));

    expect(r.filePaths).toEqual(['src/auth.ts']);
    expect(r.remainingText).toBe([
      'review and this snippet:',
      '',
      '```md',
      '~~~',
      '@fixtures/not-an-attachment.ts',
      '~~~',
      '```',
    ].join('\n'));
  });
});

describe('embedFiles', () => {
  const ws = '/fake/ws';

  it('embeds a small file with surrounding markers', () => {
    fsState.set('/fake/ws/foo.ts', 'export const x = 1;\nexport const y = 2;\n');
    const r = embedFiles(['foo.ts'], ws, { maxLines: 500 });
    expect(r.errors).toEqual([]);
    expect(r.attached).toEqual([{ path: 'foo.ts', lines: 2, truncated: false }]);
    expect(r.embedded).toContain('[File: foo.ts]');
    expect(r.embedded).toContain('export const x = 1;');
    expect(r.embedded).toContain('[/File]');
  });

  it('truncates oversized files with explicit marker', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n');
    fsState.set('/fake/ws/big.ts', lines);
    const r = embedFiles(['big.ts'], ws, { maxLines: 100 });
    expect(r.attached[0]).toEqual({ path: 'big.ts', lines: 100, truncated: true });
    expect(r.embedded).toContain('[File: big.ts - first 100 of 1000 lines]');
    expect(r.embedded).toContain('[/File - truncated; use the Read tool to fetch the rest]');
    expect(r.embedded).toContain('line 0');
    expect(r.embedded).toContain('line 99');
    expect(r.embedded).not.toContain('line 100');
  });

  it('preserves order across multiple files', () => {
    fsState.set('/fake/ws/a.ts', 'A');
    fsState.set('/fake/ws/b.ts', 'B');
    const r = embedFiles(['a.ts', 'b.ts'], ws, { maxLines: 500 });
    expect(r.embedded.indexOf('[File: a.ts]')).toBeLessThan(r.embedded.indexOf('[File: b.ts]'));
  });

  it('rejects path traversal escaping the workspace', () => {
    fsState.set('/secret', 'top secret');
    const r = embedFiles(['../../../secret'], ws, { maxLines: 500 });
    expect(r.errors).toEqual([{ path: '../../../secret', reason: 'Path escapes workspace' }]);
    expect(r.attached).toEqual([]);
    expect(r.embedded).toBe('');
  });

  it('reports file-not-found without halting other files', () => {
    fsState.set('/fake/ws/exists.ts', 'ok');
    const r = embedFiles(['missing.ts', 'exists.ts'], ws, { maxLines: 500 });
    expect(r.errors).toEqual([{ path: 'missing.ts', reason: 'File not found' }]);
    expect(r.attached).toEqual([{ path: 'exists.ts', lines: 1, truncated: false }]);
  });

  it('rejects binary files (null bytes in first 8KB)', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    fsState.set('/fake/ws/img.png', buf);
    const r = embedFiles(['img.png'], ws, { maxLines: 500 });
    expect(r.errors).toEqual([{ path: 'img.png', reason: 'Binary file' }]);
  });

  it('rejects files exceeding the byte ceiling', () => {
    const huge = 'x'.repeat(11 * 1024 * 1024);
    fsState.set('/fake/ws/huge.txt', huge);
    const r = embedFiles(['huge.txt'], ws, { maxLines: 500 });
    expect(r.errors).toEqual([{ path: 'huge.txt', reason: 'File too large' }]);
  });

  it('returns empty embedded string and empty attached when given no paths', () => {
    expect(embedFiles([], ws, { maxLines: 500 })).toEqual({
      embedded: '', attached: [], errors: [],
    });
  });

  it('accepts absolute paths inside the workspace', () => {
    fsState.set('/fake/ws/inside.ts', 'ok');
    const r = embedFiles(['/fake/ws/inside.ts'], ws, { maxLines: 500 });
    expect(r.attached).toEqual([{ path: '/fake/ws/inside.ts', lines: 1, truncated: false }]);
  });

  it('rejects absolute paths outside the workspace', () => {
    fsState.set('/elsewhere/outside.ts', 'nope');
    const r = embedFiles(['/elsewhere/outside.ts'], ws, { maxLines: 500 });
    expect(r.errors).toEqual([{ path: '/elsewhere/outside.ts', reason: 'Path escapes workspace' }]);
  });

  it('rejects paths in a sibling directory whose name starts with the workspace name (substring trap)', () => {
    fsState.set('/fake/ws-other/x.ts', 'sibling');
    const r = embedFiles(['/fake/ws-other/x.ts'], ws, { maxLines: 500 });
    expect(r.errors).toEqual([{ path: '/fake/ws-other/x.ts', reason: 'Path escapes workspace' }]);
    expect(r.attached).toEqual([]);
  });
});
