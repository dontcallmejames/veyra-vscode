import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({ get: (_k: string, dflt: unknown) => dflt })),
  },
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn().mockReturnValue('/fake/npm/root\n'),
}));

import { getEditedPath as getClaudeEditedPath } from '../../src/agents/claude.js';
import { getEditedPath as getCodexEditedPath } from '../../src/agents/codex.js';
import { getEditedPath as getGeminiEditedPath } from '../../src/agents/gemini.js';

describe('Claude getEditedPath', () => {
  it('returns path for Edit tool', () => {
    expect(getClaudeEditedPath('Edit', { file_path: '/abs/foo.ts' })).toBe('/abs/foo.ts');
  });
  it('returns path for Write tool', () => {
    expect(getClaudeEditedPath('Write', { file_path: '/abs/bar.ts' })).toBe('/abs/bar.ts');
  });
  it('returns path for MultiEdit tool', () => {
    expect(getClaudeEditedPath('MultiEdit', { file_path: '/abs/baz.ts' })).toBe('/abs/baz.ts');
  });
  it('returns path for NotebookEdit tool', () => {
    expect(getClaudeEditedPath('NotebookEdit', { notebook_path: '/abs/n.ipynb' })).toBe('/abs/n.ipynb');
  });
  it('returns null for read-class tools', () => {
    expect(getClaudeEditedPath('Read', { file_path: '/abs/foo.ts' })).toBeNull();
    expect(getClaudeEditedPath('Bash', { command: 'ls' })).toBeNull();
  });
  it('returns null for unknown tools', () => {
    expect(getClaudeEditedPath('Unknown', { file_path: '/abs/foo.ts' })).toBeNull();
  });
  it('returns null when input shape is wrong', () => {
    expect(getClaudeEditedPath('Edit', {})).toBeNull();
    expect(getClaudeEditedPath('Edit', { file_path: 42 })).toBeNull();
  });
});

describe('Codex getEditedPath', () => {
  it('returns path for apply_patch tool when input.path present', () => {
    expect(getCodexEditedPath('apply_patch', { path: '/abs/foo.ts' })).toBe('/abs/foo.ts');
  });
  it('returns path for write_file tool', () => {
    expect(getCodexEditedPath('write_file', { path: '/abs/bar.ts' })).toBe('/abs/bar.ts');
  });
  it('returns path for update_file tool', () => {
    expect(getCodexEditedPath('update_file', { path: '/abs/baz.ts' })).toBe('/abs/baz.ts');
  });
  it('returns null for read-class tools', () => {
    expect(getCodexEditedPath('read_file', { path: '/abs/foo.ts' })).toBeNull();
    expect(getCodexEditedPath('shell', { command: 'ls' })).toBeNull();
  });
});

describe('Gemini getEditedPath', () => {
  it('returns path for write_file tool', () => {
    expect(getGeminiEditedPath('write_file', { file_path: '/abs/bar.ts' })).toBe('/abs/bar.ts');
  });
  it('returns path for replace tool', () => {
    expect(getGeminiEditedPath('replace', { file_path: '/abs/foo.ts' })).toBe('/abs/foo.ts');
  });
  it('returns null for read-class tools', () => {
    expect(getGeminiEditedPath('read_file', { absolute_path: '/abs/foo.ts' })).toBeNull();
  });
});
