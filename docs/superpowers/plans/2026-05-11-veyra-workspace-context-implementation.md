# Veyra Workspace Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first v1.0 workspace-context slice: an explainable `@codebase` mention that retrieves relevant repo files and feeds the same context to panel, native chat, and Language Model provider dispatches.

**Architecture:** Add a focused `workspaceContext` module that owns workspace inventory, lexical retrieval, snippet extraction, and cache invalidation. Wire it into `VeyraSessionService` before prompt composition so all surfaces inherit the same behavior. Keep retrieval lexical and explainable; no embeddings or cloud index in this slice.

**Tech Stack:** TypeScript, Node `fs/promises`, `child_process.execFile`, VS Code extension API, Vitest, existing `VeyraSessionService`, existing `composePrompt`, existing session and file mention types.

---

## Scope Check

This plan implements only Milestone 1 from `docs/superpowers/specs/2026-05-11-veyra-v1-roadmap-design.md`: workspace context and `@codebase`. It does not implement diff preview, checkpoints, terminal awareness, autocomplete, embeddings, browser automation, or GitHub/GitLab workflows.

## File Structure

- Create `src/workspaceContext.ts`
  - Parses `@codebase`.
  - Builds a lightweight workspace inventory.
  - Retrieves relevant files with lexical scoring.
  - Extracts bounded snippets.
  - Formats an explainable prompt block.
  - Owns a small invalidatable per-workspace cache.
- Create `tests/workspaceContext.test.ts`
  - Unit tests for parsing, inventory, retrieval, excludes, snippets, metadata hints, and cache invalidation.
- Modify `src/composePrompt.ts`
  - Adds an optional `workspaceContext` prompt section between edit awareness and explicit file attachments.
- Modify `tests/composePrompt.test.ts`
  - Covers prompt ordering and omission when workspace context is empty.
- Modify `src/veyraService.ts`
  - Uses `parseWorkspaceContextMention`.
  - Requests context from an injected `WorkspaceContextProvider`.
  - Combines retrieved files with explicit `@file` attachments in the user message.
  - Passes the workspace context block into `composePrompt`.
- Modify `tests/veyraService.test.ts`
  - Covers service-level `@codebase` behavior for direct and all-agent dispatches.
- Modify `src/veyraRuntime.ts`
  - Creates the default workspace context provider.
  - Reads context settings.
- Modify `src/extension.ts`
  - Invalidates the workspace context provider on file create/change/delete.
- Modify `package.json`
  - Adds `veyra.workspaceContext.maxFiles`, `veyra.workspaceContext.maxSnippetLines`, and `veyra.workspaceContext.maxFileBytes`.
- Modify `README.md`
  - Documents `@codebase` and the new settings.

## Task 1: Add Pure Workspace Context Retrieval

**Files:**
- Create: `src/workspaceContext.ts`
- Create: `tests/workspaceContext.test.ts`

- [ ] **Step 1: Write failing parser and retrieval tests**

Create `tests/workspaceContext.test.ts` with this complete content:

```ts
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/workspaceContext.test.ts
```

Expected: fail because `src/workspaceContext.ts` does not exist.

- [ ] **Step 3: Implement `src/workspaceContext.ts`**

Create `src/workspaceContext.ts` with this complete content:

```ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AttachedFile } from './fileMentions.js';

const execFileAsync = promisify(execFile);

export interface WorkspaceContextOptions {
  maxFiles: number;
  maxSnippetLines: number;
  maxFileBytes: number;
}

export interface WorkspaceInventoryFile {
  path: string;
  size: number;
  language: string;
  metadata: boolean;
}

export interface WorkspaceInventory {
  files: WorkspaceInventoryFile[];
}

export interface WorkspaceContextSelection {
  path: string;
  score: number;
  reasons: string[];
  language: string;
  startLine: number;
  endLine: number;
}

export interface WorkspaceContextResult {
  enabled: boolean;
  query: string;
  block: string;
  attached: AttachedFile[];
  selected: WorkspaceContextSelection[];
  diagnostics: string[];
}

export interface WorkspaceContextMention {
  enabled: boolean;
  remainingText: string;
}

const DEFAULT_EXCLUDED_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
]);

const DEFAULT_EXCLUDED_DIR_PATHS = new Set([
  '.vscode/veyra',
]);

const METADATA_FILES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'tsconfig.json',
  'jsconfig.json',
  'vite.config.ts',
  'vitest.config.ts',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'README.md',
]);

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'for',
  'from',
  'how',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'should',
  'the',
  'this',
  'to',
  'where',
  'with',
]);

export function parseWorkspaceContextMention(input: string): WorkspaceContextMention {
  let enabled = false;
  const remainingText = input
    .replace(/(^|[\s([{<`])@codebase\b[,:;]?/gi, (match, prefix: string) => {
      enabled = true;
      return prefix;
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\r?\n/g, '\n')
    .trim();
  return { enabled, remainingText };
}

export class WorkspaceContextProvider {
  private inventory: WorkspaceInventory | null = null;

  constructor(
    private readonly workspacePath: string,
    private readonly options: WorkspaceContextOptions,
  ) {}

  invalidate(): void {
    this.inventory = null;
  }

  async retrieve(query: string): Promise<WorkspaceContextResult> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return emptyWorkspaceContextResult(true, normalizedQuery, ['No query text remained after @codebase.']);
    }

    const inventory = await this.getInventory();
    const terms = tokenize(normalizedQuery);
    if (terms.length === 0) {
      return emptyWorkspaceContextResult(true, normalizedQuery, ['No searchable query terms found.']);
    }

    const candidates = await Promise.all(inventory.files.map(async (file) => {
      const content = await readTextFile(path.join(this.workspacePath, file.path), this.options.maxFileBytes);
      if (content === null) return null;
      const scored = scoreFile(file, content, terms);
      if (scored.score <= 0) return null;
      const snippet = extractSnippet(content, terms, this.options.maxSnippetLines);
      return {
        file,
        score: scored.score,
        reasons: scored.reasons,
        snippet,
      };
    }));

    const selected = candidates
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
      .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
      .slice(0, this.options.maxFiles);

    if (selected.length === 0) {
      return emptyWorkspaceContextResult(true, normalizedQuery, ['No workspace files matched @codebase query.']);
    }

    const selections = selected.map((entry): WorkspaceContextSelection => ({
      path: entry.file.path,
      score: entry.score,
      reasons: entry.reasons,
      language: entry.file.language,
      startLine: entry.snippet.startLine,
      endLine: entry.snippet.endLine,
    }));
    const attached = selections.map((selection): AttachedFile => ({
      path: selection.path,
      lines: selection.endLine - selection.startLine + 1,
      truncated: true,
    }));

    return {
      enabled: true,
      query: normalizedQuery,
      block: formatWorkspaceContextBlock(normalizedQuery, selected),
      attached,
      selected: selections,
      diagnostics: [],
    };
  }

  private async getInventory(): Promise<WorkspaceInventory> {
    this.inventory ??= await buildWorkspaceInventory(this.workspacePath);
    return this.inventory;
  }
}

export async function buildWorkspaceInventory(workspacePath: string): Promise<WorkspaceInventory> {
  const filePaths = await listWorkspaceFiles(workspacePath);
  const files: WorkspaceInventoryFile[] = [];
  for (const filePath of filePaths) {
    try {
      const stat = await fs.stat(path.join(workspacePath, filePath));
      if (!stat.isFile()) continue;
      files.push({
        path: normalizePath(filePath),
        size: stat.size,
        language: inferLanguage(filePath),
        metadata: METADATA_FILES.has(path.basename(filePath)) || METADATA_FILES.has(normalizePath(filePath)),
      });
    } catch {
      // File disappeared while inventory was being built.
    }
  }
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

async function listWorkspaceFiles(workspacePath: string): Promise<string[]> {
  const gitFiles = await listGitFiles(workspacePath);
  const files = new Set<string>(gitFiles ?? []);
  for (const file of await listFilesRecursively(workspacePath, workspacePath)) {
    files.add(file);
  }
  return [...files].filter((file) => !isExcludedPath(file)).sort((a, b) => a.localeCompare(b));
}

async function listGitFiles(workspacePath: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: workspacePath, windowsHide: true, timeout: 10_000 },
    );
    return stdout
      .split('\0')
      .map((file) => normalizePath(file.trim()))
      .filter((file) => file.length > 0 && !isExcludedPath(file));
  } catch {
    return null;
  }
}

async function listFilesRecursively(root: string, current: string): Promise<string[]> {
  let entries: Array<import('node:fs').Dirent>;
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = normalizePath(path.relative(root, absolute));
    if (entry.isDirectory()) {
      if (isExcludedPath(relative)) continue;
      files.push(...await listFilesRecursively(root, absolute));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

async function readTextFile(filePath: string, maxFileBytes: number): Promise<string | null> {
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > maxFileBytes) return null;

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(filePath);
  } catch {
    return null;
  }
  if (buffer.subarray(0, 8192).includes(0)) return null;
  return buffer.toString('utf8');
}

function scoreFile(
  file: WorkspaceInventoryFile,
  content: string,
  terms: string[],
): { score: number; reasons: string[] } {
  const pathLower = file.path.toLowerCase();
  const baseLower = path.basename(file.path).toLowerCase();
  const contentLower = content.toLowerCase();
  let score = file.metadata ? 1 : 0;
  const reasons = new Set<string>();

  for (const term of terms) {
    if (pathLower.includes(term)) {
      score += 8;
      reasons.add(`path:${term}`);
    }
    if (baseLower.includes(term)) {
      score += 4;
      reasons.add(`name:${term}`);
    }
    const contentHits = countOccurrences(contentLower, term);
    if (contentHits > 0) {
      score += Math.min(contentHits, 5);
      reasons.add(`content:${term}`);
    }
  }

  return { score, reasons: [...reasons] };
}

function extractSnippet(
  content: string,
  terms: string[],
  maxSnippetLines: number,
): { text: string; startLine: number; endLine: number } {
  const rawLines = content.split(/\r?\n/);
  const lines = rawLines.length > 0 && rawLines[rawLines.length - 1] === ''
    ? rawLines.slice(0, -1)
    : rawLines;
  const matchIndex = lines.findIndex((line) => {
    const lower = line.toLowerCase();
    return terms.some((term) => lower.includes(term));
  });
  const start = Math.max(matchIndex >= 0 ? matchIndex - 3 : 0, 0);
  const end = Math.min(start + Math.max(maxSnippetLines, 1), lines.length);
  return {
    text: lines.slice(start, end).join('\n'),
    startLine: start + 1,
    endLine: end,
  };
}

function formatWorkspaceContextBlock(
  query: string,
  selected: Array<{
    file: WorkspaceInventoryFile;
    score: number;
    reasons: string[];
    snippet: { text: string; startLine: number; endLine: number };
  }>,
): string {
  const lines: string[] = [
    '[Workspace context from @codebase]',
    `Query: ${query}`,
    'Selected files:',
    ...selected.map((entry) =>
      `- ${entry.file.path} (score ${entry.score}; ${entry.reasons.join(', ') || 'metadata'})`
    ),
    '',
  ];

  for (const entry of selected) {
    lines.push(
      `[Context file: ${entry.file.path} lines ${entry.snippet.startLine}-${entry.snippet.endLine}]`,
      `\`\`\`${entry.file.language}`,
      entry.snippet.text,
      '```',
      '[/Context file]',
      '',
    );
  }

  lines.push('[/Workspace context]');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function emptyWorkspaceContextResult(
  enabled: boolean,
  query: string,
  diagnostics: string[],
): WorkspaceContextResult {
  return {
    enabled,
    query,
    block: '',
    attached: [],
    selected: [],
    diagnostics,
  };
}

function tokenize(query: string): string[] {
  const terms = query
    .toLowerCase()
    .replace(/@[a-z0-9_.\/-]+/g, ' ')
    .split(/[^a-z0-9_/-]+/g)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && !STOP_WORDS.has(term));
  return [...new Set(terms)];
}

function countOccurrences(value: string, term: string): number {
  let count = 0;
  let index = value.indexOf(term);
  while (index >= 0) {
    count++;
    index = value.indexOf(term, index + term.length);
  }
  return count;
}

function inferLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'ts';
    case '.js':
    case '.jsx':
      return 'js';
    case '.json':
      return 'json';
    case '.md':
      return 'md';
    case '.py':
      return 'python';
    case '.sh':
      return 'sh';
    case '.html':
      return 'html';
    case '.css':
      return 'css';
    case '.yml':
    case '.yaml':
      return 'yaml';
    default:
      return '';
  }
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function isExcludedPath(relativePath: string): boolean {
  const normalized = normalizePath(relativePath);
  for (const excludedPath of DEFAULT_EXCLUDED_DIR_PATHS) {
    if (normalized === excludedPath || normalized.startsWith(`${excludedPath}/`)) {
      return true;
    }
  }
  return normalized
    .split('/')
    .some((part) => DEFAULT_EXCLUDED_DIR_NAMES.has(part));
}
```

- [ ] **Step 4: Run the focused tests and verify they pass**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/workspaceContext.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit this slice**

Run:

```powershell
git add src/workspaceContext.ts tests/workspaceContext.test.ts
git commit -m "feat: add workspace context retrieval"
```

## Task 2: Add Workspace Context To Prompt Composition

**Files:**
- Modify: `src/composePrompt.ts`
- Modify: `tests/composePrompt.test.ts`

- [ ] **Step 1: Add failing prompt ordering coverage**

In `tests/composePrompt.test.ts`, replace the existing `"orders blocks: rules"` test with this exact test:

```ts
  it('orders blocks: rules -> autonomy -> context -> edit awareness -> workspace context -> files -> user text', () => {
    const out = composePrompt({
      rules: 'use pnpm',
      autonomyPolicy: '[Autonomy policy]\nproceed without confirmation\n[/Autonomy policy]',
      sharedContext: '[Conversation so far]\nuser: hi\n[/Conversation so far]',
      editAwareness: '[Edit coordination]\n- src/a.ts (claude)\n[/Edit coordination]',
      workspaceContext: '[Workspace context from @codebase]\nSelected files:\n- src/auth.ts\n[/Workspace context]',
      fileBlocks: '[File: a.ts]\nx\n[/File]',
      userText: 'review',
    });

    const idxRules = out.indexOf('use pnpm');
    const idxAutonomy = out.indexOf('[Autonomy policy]');
    const idxCtx = out.indexOf('[Conversation so far]');
    const idxEditAwareness = out.indexOf('[Edit coordination]');
    const idxWorkspaceContext = out.indexOf('[Workspace context from @codebase]');
    const idxFile = out.indexOf('[File: a.ts]');
    const idxUser = out.indexOf('review');

    expect(idxRules).toBeGreaterThan(-1);
    expect(idxAutonomy).toBeGreaterThan(idxRules);
    expect(idxCtx).toBeGreaterThan(idxAutonomy);
    expect(idxEditAwareness).toBeGreaterThan(idxCtx);
    expect(idxWorkspaceContext).toBeGreaterThan(idxEditAwareness);
    expect(idxFile).toBeGreaterThan(idxWorkspaceContext);
    expect(idxUser).toBeGreaterThan(idxFile);
  });
```

Also add this test after the existing `"omits edit coordination block"` test:

```ts
  it('omits workspace context when empty', () => {
    const out = composePrompt({
      rules: '',
      sharedContext: '',
      editAwareness: '',
      workspaceContext: '',
      fileBlocks: '',
      userText: 'hi',
    });
    expect(out).not.toContain('[Workspace context from @codebase]');
  });
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/composePrompt.test.ts
```

Expected: fail because `ComposePromptInput` does not accept or render `workspaceContext`.

- [ ] **Step 3: Update `src/composePrompt.ts`**

In `src/composePrompt.ts`, add `workspaceContext?: string;` to `ComposePromptInput` after `editAwareness?: string;`.

Then insert this block after the edit-awareness block and before the file-block block:

```ts
  if (input.workspaceContext?.trim().length) {
    parts.push(input.workspaceContext.trimEnd());
  }
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/composePrompt.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit this slice**

Run:

```powershell
git add src/composePrompt.ts tests/composePrompt.test.ts
git commit -m "feat: include workspace context in prompts"
```

## Task 3: Wire `@codebase` Through `VeyraSessionService`

**Files:**
- Modify: `src/veyraService.ts`
- Modify: `tests/veyraService.test.ts`

- [ ] **Step 1: Add failing service tests**

In `tests/veyraService.test.ts`, add this import:

```ts
import type { WorkspaceContextProvider } from '../src/workspaceContext.js';
```

Add this helper immediately above `function agentNoop`:

```ts
function fakeWorkspaceContextProvider(block: string): Pick<WorkspaceContextProvider, 'retrieve' | 'invalidate'> {
  return {
    invalidate: vi.fn(),
    retrieve: vi.fn(async (query: string) => ({
      enabled: true,
      query,
      block,
      attached: [{ path: 'src/auth/session.ts', lines: 4, truncated: true }],
      selected: [{
        path: 'src/auth/session.ts',
        score: 10,
        reasons: ['path:auth'],
        language: 'ts',
        startLine: 1,
        endLine: 4,
      }],
      diagnostics: [],
    })),
  };
}
```

Add these two tests inside `describe('VeyraSessionService', () => { ... })`:

```ts
  it('retrieves @codebase context and includes it in direct agent prompts', async () => {
    let codexPrompt = '';
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));
    const workspaceContextProvider = fakeWorkspaceContextProvider([
      '[Workspace context from @codebase]',
      'Selected files:',
      '- src/auth/session.ts',
      '[/Workspace context]',
    ].join('\n'));
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: agentNoop('claude'),
        codex: {
          id: 'codex',
          status: async () => 'ready',
          cancel: async () => {},
          async *send(prompt: string) {
            codexPrompt = prompt;
            yield { type: 'done' } as AgentChunk;
          },
        },
        gemini: agentNoop('gemini'),
      },
      { hangSeconds: 0, workspaceContextProvider: workspaceContextProvider as WorkspaceContextProvider },
    );

    const events: any[] = [];
    await service.dispatch(
      { text: '@codex review @codebase auth flow', source: 'native-chat', cwd: workspacePath },
      (event) => {
        events.push(event);
      },
    );

    expect(workspaceContextProvider.retrieve).toHaveBeenCalledWith('review auth flow');
    expect(codexPrompt).toContain('[Workspace context from @codebase]');
    expect(codexPrompt).toContain('- src/auth/session.ts');
    expect(codexPrompt).not.toContain('@codebase');
    const userMessage = events.find((event) => event.kind === 'user-message')?.message;
    expect(userMessage.attachedFiles).toEqual([{ path: 'src/auth/session.ts', lines: 4, truncated: true }]);
  });

  it('shares the same retrieved @codebase context across all agents in one workflow', async () => {
    const prompts = new Map<AgentId, string>();
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-service-'));
    const workspaceContextProvider = fakeWorkspaceContextProvider([
      '[Workspace context from @codebase]',
      'Selected files:',
      '- src/shared/router.ts',
      '[/Workspace context]',
    ].join('\n'));
    const agent = (id: AgentId): Agent => ({
      id,
      status: async () => 'ready',
      cancel: async () => {},
      async *send(prompt: string) {
        prompts.set(id, prompt);
        yield { type: 'done' } as AgentChunk;
      },
    });
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: agent('claude'),
        codex: agent('codex'),
        gemini: agent('gemini'),
      },
      { hangSeconds: 0, workspaceContextProvider: workspaceContextProvider as WorkspaceContextProvider },
    );

    await service.dispatch(
      { text: '@all debate @codebase routing design', source: 'panel', cwd: workspacePath },
      () => {},
    );

    expect(workspaceContextProvider.retrieve).toHaveBeenCalledTimes(1);
    expect(workspaceContextProvider.retrieve).toHaveBeenCalledWith('debate routing design');
    expect(prompts.get('claude')).toContain('src/shared/router.ts');
    expect(prompts.get('codex')).toContain('src/shared/router.ts');
    expect(prompts.get('gemini')).toContain('src/shared/router.ts');
  });
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/veyraService.test.ts
```

Expected: fail because `VeyraSessionOptions` does not accept `workspaceContextProvider` and the service does not parse `@codebase`.

- [ ] **Step 3: Update `src/veyraService.ts` imports and option types**

Add this import:

```ts
import { parseWorkspaceContextMention, type WorkspaceContextProvider } from './workspaceContext.js';
```

In `VeyraSessionOptions`, add:

```ts
  workspaceContextProvider?: WorkspaceContextProvider;
```

In the class fields, add:

```ts
  private workspaceContextProvider?: WorkspaceContextProvider;
```

In the constructor, add:

```ts
    this.workspaceContextProvider = options.workspaceContextProvider;
```

In `updateOptions`, add `workspaceContextProvider` to the `Pick` type and add this block:

```ts
    if ('workspaceContextProvider' in options) {
      this.workspaceContextProvider = options.workspaceContextProvider;
    }
```

- [ ] **Step 4: Update `runDispatchInner` to retrieve workspace context once**

In `runDispatchInner`, replace:

```ts
    const { filePaths, remainingText } = parseFileMentions(request.text);
    const embedResult = embedFiles(filePaths, this.workspacePath, { maxLines: this.fileEmbedMaxLines });
    const userMentions = userMentionsForRequest(request.text, request.forcedTarget);
```

with:

```ts
    const workspaceContextMention = parseWorkspaceContextMention(request.text);
    const { filePaths, remainingText } = parseFileMentions(workspaceContextMention.remainingText);
    const workspaceContextResult = workspaceContextMention.enabled && this.workspaceContextProvider
      ? await this.workspaceContextProvider.retrieve(remainingText)
      : {
          enabled: workspaceContextMention.enabled,
          query: remainingText,
          block: '',
          attached: [],
          selected: [],
          diagnostics: workspaceContextMention.enabled
            ? ['Workspace context provider is unavailable.']
            : [],
        };
    const embedResult = embedFiles(filePaths, this.workspacePath, { maxLines: this.fileEmbedMaxLines });
    const userMentions = userMentionsForRequest(request.text, request.forcedTarget);
    const attachedFiles = [...workspaceContextResult.attached, ...embedResult.attached];
```

In the `userMsg` object, replace:

```ts
      ...(embedResult.attached.length > 0 ? { attachedFiles: embedResult.attached } : {}),
```

with:

```ts
      ...(attachedFiles.length > 0 ? { attachedFiles } : {}),
```

Inside `composePromptForTarget`, add `workspaceContext: workspaceContextResult.block,` between `editAwareness,` and `fileBlocks: embedResult.embedded,`.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/veyraService.test.ts tests/composePrompt.test.ts tests/workspaceContext.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit this slice**

Run:

```powershell
git add src/veyraService.ts tests/veyraService.test.ts
git commit -m "feat: route codebase context through Veyra service"
```

## Task 4: Create Runtime Provider And File Watcher Invalidation

**Files:**
- Modify: `src/veyraRuntime.ts`
- Modify: `src/extension.ts`
- Modify: `tests/extension.test.ts`

- [ ] **Step 1: Add runtime expectations**

In `tests/extension.test.ts`, update the `mocks` object returned from the `vi.hoisted` callback. Add this property after `onDidChangeConfiguration`:

```ts
    createFileSystemWatcher: vi.fn(() => ({
      onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
      onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
      dispose: vi.fn(),
    })),
```

Inside the `reset()` method, add this line after `this.onDidChangeConfiguration.mockClear();`:

```ts
      this.createFileSystemWatcher.mockClear();
```

In the `vi.mock('vscode', ...)` workspace object, add this property after `onDidChangeConfiguration: mocks.onDidChangeConfiguration,`:

```ts
    createFileSystemWatcher: mocks.createFileSystemWatcher,
```

Add this test immediately after the existing `"registers the native VS Code integration surface"` test:

```ts
  it('registers a workspace file watcher for context invalidation', () => {
    activate(context() as any);

    expect(mocks.createFileSystemWatcher).toHaveBeenCalledWith('**/*');
    const watcher = mocks.createFileSystemWatcher.mock.results[0]?.value;
    expect(watcher.onDidCreate).toHaveBeenCalledTimes(1);
    expect(watcher.onDidChange).toHaveBeenCalledTimes(1);
    expect(watcher.onDidDelete).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/extension.test.ts
```

Expected: fail because activation does not create the watcher yet.

- [ ] **Step 3: Update `src/veyraRuntime.ts`**

Add this import:

```ts
import { WorkspaceContextProvider, type WorkspaceContextOptions } from './workspaceContext.js';
```

Add this helper:

```ts
export function readWorkspaceContextOptions(): WorkspaceContextOptions {
  const config = vscode.workspace.getConfiguration('veyra');
  return {
    maxFiles: config.get<number>('workspaceContext.maxFiles', 8),
    maxSnippetLines: config.get<number>('workspaceContext.maxSnippetLines', 80),
    maxFileBytes: config.get<number>('workspaceContext.maxFileBytes', 1_000_000),
  };
}
```

In `createVeyraSessionService`, add this option:

```ts
      workspaceContextProvider: new WorkspaceContextProvider(workspacePath, readWorkspaceContextOptions()),
```

Do not change `refreshVeyraSessionOptions` in this task.

- [ ] **Step 4: Update `src/extension.ts` invalidation**

In `src/veyraService.ts`, add this method immediately before `flush(): Promise<void>`:

```ts
  invalidateWorkspaceContext(): void {
    this.workspaceContextProvider?.invalidate();
  }
```

In `src/extension.ts`, add this block immediately after the `  };` line that closes the native registration factory at current line 153:

```ts
  const contextWatcher = vscode.workspace.createFileSystemWatcher('**/*');
  const invalidateWorkspaceContext = (): void => {
    nativeRegistration?.service.invalidateWorkspaceContext();
  };
  context.subscriptions.push(
    contextWatcher,
    contextWatcher.onDidCreate(invalidateWorkspaceContext),
    contextWatcher.onDidChange(invalidateWorkspaceContext),
    contextWatcher.onDidDelete(invalidateWorkspaceContext),
  );
```

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/extension.test.ts tests/veyraService.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit this slice**

Run:

```powershell
git add src/extension.ts src/veyraRuntime.ts src/veyraService.ts tests/extension.test.ts
git commit -m "feat: invalidate workspace context on file changes"
```

## Task 5: Add Settings And Documentation

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `tests/manifest.test.ts`

- [ ] **Step 1: Add manifest tests for settings and docs**

In `tests/manifest.test.ts`, add this test immediately after the existing `"contributes settings for explicit Codex and Gemini CLI bundle paths"` test:

```ts
  it('contributes workspace context settings documented in the README', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const properties = manifest.contributes.configuration.properties;
    expect(properties['veyra.workspaceContext.maxFiles']).toMatchObject({
      type: 'number',
      default: 8,
      minimum: 1,
    });
    expect(properties['veyra.workspaceContext.maxSnippetLines']).toMatchObject({
      type: 'number',
      default: 80,
      minimum: 1,
    });
    expect(properties['veyra.workspaceContext.maxFileBytes']).toMatchObject({
      type: 'number',
      default: 1000000,
      minimum: 1024,
    });

    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
    expect(readme).toContain('@codebase');
    expect(readme).toContain('veyra.workspaceContext.maxFiles');
    expect(readme).toContain('veyra.workspaceContext.maxSnippetLines');
    expect(readme).toContain('veyra.workspaceContext.maxFileBytes');
  });
```

- [ ] **Step 2: Run the manifest test and verify it fails**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/manifest.test.ts
```

Expected: fail because settings and docs are missing.

- [ ] **Step 3: Update `package.json` configuration**

Under `contributes.configuration.properties`, add these entries after `veyra.fileEmbedMaxLines`:

```json
        "veyra.workspaceContext.maxFiles": {
          "type": "number",
          "default": 8,
          "minimum": 1,
          "maximum": 25,
          "description": "Maximum number of files selected for @codebase workspace context."
        },
        "veyra.workspaceContext.maxSnippetLines": {
          "type": "number",
          "default": 80,
          "minimum": 1,
          "maximum": 500,
          "description": "Maximum lines included per selected @codebase context file snippet."
        },
        "veyra.workspaceContext.maxFileBytes": {
          "type": "number",
          "default": 1000000,
          "minimum": 1024,
          "maximum": 10485760,
          "description": "Maximum file size Veyra will read while retrieving @codebase context."
        },
```

- [ ] **Step 4: Update `README.md`**

In the "Using Native Chat" section, add this example to the code block:

```text
@veyra /review @codebase inspect the auth flow for correctness risks
```

After the paragraph about references and workflow prompts, add:

```md
Use `@codebase` when you want Veyra to retrieve relevant workspace files without naming them explicitly. The first version uses local lexical search over workspace files and project metadata; it does not upload or build a cloud index.
```

In the Settings list, add:

```md
- `veyra.workspaceContext.maxFiles`: max files selected for `@codebase` context.
- `veyra.workspaceContext.maxSnippetLines`: max snippet lines per selected `@codebase` file.
- `veyra.workspaceContext.maxFileBytes`: max file size considered during `@codebase` retrieval.
```

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/manifest.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit this slice**

Run:

```powershell
git add package.json README.md tests/manifest.test.ts
git commit -m "docs: document codebase context settings"
```

## Task 6: Extend Smoke Coverage For `@codebase`

**Files:**
- Modify: `src/veyraRuntime.ts`
- Modify: `src/nativeChat.ts`
- Modify: `scripts/run-vscode-smoke.mjs`
- Modify: `tests/vscodeSmokeScript.test.ts`

- [ ] **Step 1: Add a smoke marker expectation**

In `tests/vscodeSmokeScript.test.ts`, update the `completeSmokeResult.nativeChatResponses` object inside the `"requires the Extension Host smoke result to include executed command evidence"` test. Add this property after `'veyra.veyra'`:

```ts
        'veyra.veyra/codebase': '[smoke:codex] saw @codebase workspace context.',
```

Then add this assertion immediately after the existing `expect(validateSmokeResultContent(JSON.stringify(completeSmokeResult))).toEqual([]);` line:

```ts
    expect(validateSmokeResultContent(JSON.stringify({
      ...completeSmokeResult,
      nativeChatResponses: {
        ...completeSmokeResult.nativeChatResponses,
        'veyra.veyra/codebase': '',
      },
    }))).toContain('Missing native chat response evidence: veyra.veyra/codebase');
```

In the `"resets stale smoke workspace state before launching VS Code"` test, add this assertion immediately after `expect(existsSync(join(paths.workspaceDir, '.git'))).toBe(true);`:

```ts
      expect(existsSync(join(paths.workspaceDir, 'src', 'codebase-context-smoke.ts'))).toBe(true);
```

- [ ] **Step 2: Run the smoke script unit test and verify it fails**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/vscodeSmokeScript.test.ts
```

Expected: fail because the smoke runner has not required the new response marker and has not created the workspace context fixture file yet.

- [ ] **Step 3: Update smoke runner expectations and fixture setup**

In `scripts/run-vscode-smoke.mjs`, update the `node:fs` import from:

```js
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
```

to:

```js
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
```

In `requiredSmokeNativeChatResponseMarkers`, add this entry immediately after the `'veyra.veyra'` entry:

```js
  'veyra.veyra/codebase': [
    '[smoke:codex] saw @codebase workspace context.',
  ],
```

In `prepareSmokeDirectories`, add this block immediately after `mkdirSync(join(paths.workspaceDir, '.git'), { recursive: true });`:

```js
  mkdirSync(join(paths.workspaceDir, 'src'), { recursive: true });
  writeFileSync(
    join(paths.workspaceDir, 'src', 'codebase-context-smoke.ts'),
    'export const veyraSmokeCodebase = true;\n',
    'utf8',
  );
```

- [ ] **Step 4: Update smoke agents**

In `src/veyraRuntime.ts`, add:

```ts
const SMOKE_CODEBASE_MARKER = '[veyra-smoke-codebase]';
```

Add this function:

```ts
function smokeCodebaseContextMarker(agentId: AgentId, prompt: string): string | null {
  if (!prompt.trimEnd().endsWith(SMOKE_CODEBASE_MARKER)) return null;
  if (agentId === 'codex' && prompt.includes('[Workspace context from @codebase]')) {
    return '[smoke:codex] saw @codebase workspace context.';
  }
  return null;
}
```

Inside `SmokeAgent.send`, after `smokeModelOptionsContextMarker`, add:

```ts
    const codebaseContextMarker = smokeCodebaseContextMarker(this.id, prompt);
    if (codebaseContextMarker) {
      yield {
        type: 'text',
        text: codebaseContextMarker,
      };
    }
```

- [ ] **Step 5: Add a native chat smoke request**

In `src/nativeChat.ts`, add this request to the `nativeChatSmokeResponses` `requests` array immediately after the `'veyra.veyra'` request:

```ts
    {
      key: 'veyra.veyra/codebase',
      participantId: 'veyra.veyra',
      prompt: '@codebase Veyra native chat codebase smoke request. [veyra-smoke-codebase]',
    },
```

- [ ] **Step 6: Run smoke unit tests**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/vscodeSmokeScript.test.ts tests/veyraRuntime.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit this slice**

Run:

```powershell
git add src/veyraRuntime.ts src/nativeChat.ts scripts/run-vscode-smoke.mjs tests/vscodeSmokeScript.test.ts tests/veyraRuntime.test.ts
git commit -m "test: cover codebase context in smoke flow"
```

## Task 7: Final Verification

**Files:**
- Modify only if verification exposes a concrete failure from the prior tasks.

- [ ] **Step 1: Run focused feature verification**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/workspaceContext.test.ts tests/composePrompt.test.ts tests/veyraService.test.ts tests/nativeChat.test.ts tests/languageModelProvider.test.ts tests/manifest.test.ts tests/vscodeSmokeScript.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 2: Run package and build verification**

Run:

```powershell
npm run typecheck
npm run build
npm run verify:package
```

Expected: all commands pass.

- [ ] **Step 3: Run full local verification**

Run:

```powershell
npm run verify
```

Expected: pass.

- [ ] **Step 4: Run Extension Host smoke verification**

Run:

```powershell
npm run test:vscode-smoke
```

Expected: pass and `.vscode-test/smoke-result.json` includes the new `veyra.veyra/codebase` smoke response marker.

- [ ] **Step 5: Check whitespace**

Run:

```powershell
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 6: Commit verification fixes when verification changed files**

If the verification steps required fixes, commit only those fixes:

```powershell
git add <fixed-files>
git commit -m "fix: stabilize codebase context verification"
```

When verification does not require fixes, leave the working tree unchanged after Step 5.

## Self-Review Checklist

- [ ] `@codebase` works through the shared `VeyraSessionService`, so panel, native chat, and Language Model provider inherit it.
- [ ] Retrieval is lexical and local only.
- [ ] Retrieved context is clearly marked with `[Workspace context from @codebase]`.
- [ ] Explicit `@file` attachments still work and remain separate from retrieved workspace context.
- [ ] File watcher invalidation clears the provider cache.
- [ ] New settings are documented and tested.
- [ ] No diff preview, checkpoint, autocomplete, browser, embedding, or Git hosting work has been included in this plan.
