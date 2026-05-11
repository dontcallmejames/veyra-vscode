import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  WorkspaceContextProvider,
  parseWorkspaceContextMention,
} from '../src/workspaceContext.js';

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-context-'));
}

function writeFile(root: string, relativePath: string, content: string): void {
  const absolute = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
}

function runGit(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

describe('parseWorkspaceContextMention', () => {
  it('detects and removes @codebase while preserving the user query', () => {
    expect(parseWorkspaceContextMention('review @codebase auth flow')).toEqual({
      enabled: true,
      remainingText: 'review auth flow',
    });
    expect(parseWorkspaceContextMention('@codebase: where should parser tests go?')).toEqual({
      enabled: true,
      remainingText: 'where should parser tests go?',
    });
  });

  it('does not enable retrieval when @codebase is absent', () => {
    expect(parseWorkspaceContextMention('review @src/auth.ts')).toEqual({
      enabled: false,
      remainingText: 'review @src/auth.ts',
    });
  });
});

describe('WorkspaceContextProvider', () => {
  it('retrieves relevant files with an explainable workspace-context block', async () => {
    const root = tempWorkspace();
    writeFile(root, 'src/auth/session.ts', [
      'export function createSession(userId: string) {',
      '  return { userId, token: "abc" };',
      '}',
      '',
    ].join('\n'));
    writeFile(root, 'src/parser.ts', 'export const parse = (value: string) => value;\n');
    writeFile(root, 'README.md', '# Sample project\n');

    const provider = new WorkspaceContextProvider(root, {
      maxFiles: 3,
      maxSnippetLines: 8,
      maxFileBytes: 100_000,
    });
    const result = await provider.retrieve('review auth session token flow');

    expect(result.enabled).toBe(true);
    expect(result.selected.map((file) => file.path)).toContain('src/auth/session.ts');
    expect(result.block).toContain('[Workspace context from @codebase]');
    expect(result.block).toContain('Query: review auth session token flow');
    expect(result.block).toContain('Selected files:');
    expect(result.block).toContain('src/auth/session.ts');
    expect(result.block).toContain('[Context file: src/auth/session.ts');
    expect(result.block).toContain('createSession');
    expect(result.block).toContain('[/Workspace context]');
    expect(result.attached.some((file) => file.path === 'src/auth/session.ts')).toBe(true);
    expect(result.attached.find((file) => file.path === 'src/auth/session.ts')?.truncated).toBe(false);
  });

  it('ignores generated and dependency directories', async () => {
    const root = tempWorkspace();
    writeFile(root, 'src/app.ts', 'export const app = "auth";\n');
    writeFile(root, 'node_modules/pkg/index.ts', 'export const auth = "dependency";\n');
    writeFile(root, 'dist/app.js', 'export const auth = "built";\n');
    writeFile(root, '.vscode/veyra/sessions.json', '{"auth": true}\n');

    const provider = new WorkspaceContextProvider(root, {
      maxFiles: 10,
      maxSnippetLines: 5,
      maxFileBytes: 100_000,
    });
    const result = await provider.retrieve('auth');

    expect(result.selected.map((file) => file.path)).toEqual(['src/app.ts']);
    expect(result.block).not.toContain('node_modules');
    expect(result.block).not.toContain('dist/app.js');
    expect(result.block).not.toContain('.vscode/veyra');
  });

  it('uses git inventory as authoritative so ignored files are not reintroduced', async () => {
    const root = tempWorkspace();
    runGit(root, ['init']);
    writeFile(root, '.gitignore', 'secret.txt\n');
    writeFile(root, 'src/app.ts', 'export const app = "auth";\n');
    writeFile(root, 'secret.txt', 'auth secret should stay ignored\n');

    const provider = new WorkspaceContextProvider(root, {
      maxFiles: 10,
      maxSnippetLines: 5,
      maxFileBytes: 100_000,
    });
    const result = await provider.retrieve('auth');

    expect(result.selected.map((file) => file.path)).toEqual(['src/app.ts']);
    expect(result.block).not.toContain('secret.txt');
    expect(result.block).not.toContain('auth secret should stay ignored');
  });

  it('rejects symlinked files that would resolve outside the workspace when supported', async () => {
    const root = tempWorkspace();
    const outside = tempWorkspace();
    runGit(root, ['init']);
    writeFile(outside, 'leak.ts', 'export const leakedCredential = "auth-token";\n');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });

    try {
      fs.symlinkSync(path.join(outside, 'leak.ts'), path.join(root, 'src', 'leak.ts'), 'file');
      runGit(root, ['add', 'src/leak.ts']);
    } catch {
      return;
    }

    const provider = new WorkspaceContextProvider(root, {
      maxFiles: 10,
      maxSnippetLines: 5,
      maxFileBytes: 100_000,
    });
    const result = await provider.retrieve('leakedCredential auth-token');

    expect(result.selected).toEqual([]);
    expect(result.block).not.toContain('leakedCredential');
    expect(result.block).not.toContain('auth-token');
  });

  it('marks attached snippets as truncated only when the snippet is partial', async () => {
    const root = tempWorkspace();
    writeFile(root, 'src/long.ts', [
      'const line1 = true;',
      'const line2 = true;',
      'const authToken = true;',
      'const line4 = true;',
      'const line5 = true;',
      'const line6 = true;',
    ].join('\n'));

    const provider = new WorkspaceContextProvider(root, {
      maxFiles: 5,
      maxSnippetLines: 3,
      maxFileBytes: 100_000,
    });
    const result = await provider.retrieve('authToken');

    expect(result.attached).toEqual([
      { path: 'src/long.ts', lines: 3, truncated: true },
    ]);
  });

  it('normalizes negative maxFiles to select no files', async () => {
    const root = tempWorkspace();
    writeFile(root, 'src/app.ts', 'export const app = "auth";\n');

    const provider = new WorkspaceContextProvider(root, {
      maxFiles: -1,
      maxSnippetLines: 5,
      maxFileBytes: 100_000,
    });
    const result = await provider.retrieve('auth');

    expect(result.selected).toEqual([]);
    expect(result.attached).toEqual([]);
    expect(result.block).toBe('');
  });

  it('invalidates the cached inventory when requested', async () => {
    const root = tempWorkspace();
    writeFile(root, 'src/first.ts', 'export const first = true;\n');
    const provider = new WorkspaceContextProvider(root, {
      maxFiles: 5,
      maxSnippetLines: 5,
      maxFileBytes: 100_000,
    });

    const first = await provider.retrieve('second');
    expect(first.selected).toEqual([]);

    writeFile(root, 'src/second.ts', 'export const second = true;\n');
    const beforeInvalidate = await provider.retrieve('second');
    expect(beforeInvalidate.selected).toEqual([]);

    provider.invalidate();
    const afterInvalidate = await provider.retrieve('second');
    expect(afterInvalidate.selected.map((file) => file.path)).toEqual(['src/second.ts']);
  });
});
