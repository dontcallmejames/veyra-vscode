# Agent Chat v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Agent Chat truly multi-agent by sharing the conversation transcript across Claude, Codex, and Gemini, plus four supporting features (`@file` mentions, `agentchat.md` workspace rules, file decoration badges, opt-in commit signature tagging).

**Architecture:** A pure-function send-time pipeline composes each agent's prompt from optional workspace rules + sliding-window shared transcript + embedded `@file` blocks + the user's text. The `Agent.send()` interface is unchanged; agents still receive a single string. Two bolt-on subsystems (file decoration badges via `FileDecorationProvider`; commit attribution via a sentinel-file + opt-in `prepare-commit-msg` hook) are independent of the prompt pipeline.

**Tech Stack:** TypeScript, Preact 10 (webview), Claude Agent SDK (in-process), Codex CLI / Gemini CLI (wrapped subprocesses), vitest, esbuild, VS Code extension API.

**Spec:** `docs/superpowers/specs/2026-05-05-agent-chat-v2-design.md`

---

## Task ordering

Phase 1 — Foundation pure functions (no integration):
1. Protocol & types
2. `sharedContext.ts`
3. `workspaceRules.ts`
4. `fileMentions.ts`
5. `composePrompt.ts`

Phase 2 — Pipeline integration:
6. `facilitator.ts` accepts shared context
7. `messageRouter.ts` rebuilds context per target + passes to facilitator
8. `panel.ts` wires composition pipeline + persists `attachedFiles`

Phase 3 — File decoration badges:
9. Per-adapter `getEditedPath` helpers
10. `fileBadges.ts` provider + `workspaceState` bookkeeping
11. `panel.ts` emits `file-edited` on successful tool-results

Phase 4 — Commit signature tagging:
12. `commitHook.ts` sentinel writer wired to dispatch lifecycle
13. `commitHook.ts` install / uninstall / snippet + hook-manager detection

Phase 5 — VS Code surface:
14. `package.json` settings + commands; `extension.ts` registers decoration provider + commands
15. Webview UI: composer `@file` chip, `UserBubble` attachment list, `HealthStrip` rules chip
16. Bootstrap nudges: `agentchat.md` tip + commit hook install dialog

Phase 6 — Verification:
17. Integration snapshot test
18. Manual smoke pass

---

## Conventions

- Every code block in this plan is the **complete content** of the file or function in question. The implementer may copy verbatim. Where a file is being modified rather than created, the diff context is shown explicitly.
- Run `npm test` (vitest) and `npm run build` (esbuild) before each commit. Both must pass — no committing red.
- Commit messages follow the v1 convention (`feat(scope): summary` / `fix(scope): summary` / etc.) with the `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer.
- Use forward slashes in file paths even on Windows; both vitest and the editor accept them.
- All test files live under `tests/`; mirror source structure (`src/foo.ts` → `tests/foo.test.ts`).

---

### Task 1: Protocol & type additions

**Files:**
- Modify: `src/shared/protocol.ts`

- [ ] **Step 1: Add `attachedFiles` to `UserMessage`.**

In `src/shared/protocol.ts`, locate the `UserMessage` type and add the optional field:

```ts
export type AttachedFile = {
  path: string;     // workspace-relative or absolute as resolved at send time
  lines: number;
  truncated: boolean;
};

export type UserMessage = {
  id: string;
  role: 'user';
  text: string;
  timestamp: number;
  mentions?: AgentId[];
  attachedFiles?: AttachedFile[];
};
```

- [ ] **Step 2: Add `file-edited` to `FromExtension`.**

In the same file, append a new variant to the `FromExtension` union:

```ts
export type FromExtension =
  | { kind: 'init'; session: Session; status: Record<AgentId, AgentStatus>; settings: Settings }
  | { kind: 'message-started'; id: string; agentId: AgentId; timestamp: number }
  | { kind: 'message-chunk'; id: string; chunk: AgentChunk }
  | { kind: 'message-finalized'; message: AgentMessage }
  | { kind: 'system-message'; message: SystemMessage }
  | { kind: 'floor-changed'; holder: AgentId | null }
  | { kind: 'status-changed'; agentId: AgentId; status: AgentStatus }
  | { kind: 'settings-changed'; settings: Settings }
  | { kind: 'user-message-appended'; message: UserMessage }
  | { kind: 'file-edited'; path: string; agentId: AgentId; timestamp: number };
```

- [ ] **Step 3: Verify build passes.**

```
npm run build
```

Expected: both `dist/extension.js` and `dist/webview.js` build with no TypeScript errors. Existing tests still pass (`npm test`).

- [ ] **Step 4: Commit.**

```
git add src/shared/protocol.ts
git commit -m "$(printf 'feat(protocol): add UserMessage.attachedFiles + file-edited event\n\nv2 prep: optional fields, no migration required (Session version stays 1).\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: `sharedContext.ts`

**Files:**
- Create: `src/sharedContext.ts`
- Create: `tests/sharedContext.test.ts`

- [ ] **Step 1: Write the failing tests.**

Create `tests/sharedContext.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests; expect them to fail with module-not-found.**

```
npm test -- sharedContext
```

Expected: vitest reports `Cannot find module '../src/sharedContext.js'` for every test.

- [ ] **Step 3: Implement `buildSharedContext`.**

Create `src/sharedContext.ts`:

```ts
import type { Session, SessionMessage } from './shared/protocol.js';

export interface BuildSharedContextOptions {
  window: number;
}

export function buildSharedContext(session: Session, opts: BuildSharedContextOptions): string {
  const eligible = session.messages.filter(isEligible);
  if (eligible.length === 0) return '';

  const trimmed = eligible.length > opts.window;
  const slice = trimmed ? eligible.slice(eligible.length - opts.window) : eligible;

  const header = trimmed
    ? '[Conversation so far — earlier messages omitted]'
    : '[Conversation so far]';

  const lines = slice.map(formatMessage);
  return [header, ...lines, '[/Conversation so far]'].join('\n');
}

function isEligible(m: SessionMessage): boolean {
  if (m.role === 'user') return true;
  if (m.role === 'agent') return m.status === 'complete' || m.status === 'errored';
  return false; // system messages excluded
}

function formatMessage(m: SessionMessage): string {
  if (m.role === 'user') return `user: ${m.text}`;
  if (m.role === 'agent') return `${m.agentId}: ${m.text}`;
  return ''; // unreachable; isEligible filtered this
}
```

- [ ] **Step 4: Run tests; expect them to pass.**

```
npm test -- sharedContext
```

Expected: all 10 cases pass.

- [ ] **Step 5: Commit.**

```
git add src/sharedContext.ts tests/sharedContext.test.ts
git commit -m "$(printf 'feat(v2): buildSharedContext serializer\n\nPure function turning a Session into a labeled-line preamble for\nagent prompts. Strips tool events, system messages, cancelled\nresponses, and applies a sliding window with an omitted-earlier\nprefix when trimmed.\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: `workspaceRules.ts`

**Files:**
- Create: `src/workspaceRules.ts`
- Create: `tests/workspaceRules.test.ts`

- [ ] **Step 1: Write the failing tests.**

Create `tests/workspaceRules.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readWorkspaceRules } from '../src/workspaceRules.js';

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

beforeEach(() => {
  fsState.clear();
});

describe('readWorkspaceRules', () => {
  it('returns empty string when agentchat.md missing', () => {
    expect(readWorkspaceRules('/fake/ws')).toBe('');
  });

  it('returns file contents verbatim when present', () => {
    fsState.set('/fake/ws/agentchat.md', '# Rules\n\n- always pnpm\n');
    expect(readWorkspaceRules('/fake/ws')).toBe('# Rules\n\n- always pnpm\n');
  });

  it('re-reads on each call (no caching)', () => {
    fsState.set('/fake/ws/agentchat.md', 'first');
    expect(readWorkspaceRules('/fake/ws')).toBe('first');
    fsState.set('/fake/ws/agentchat.md', 'second');
    expect(readWorkspaceRules('/fake/ws')).toBe('second');
  });

  it('returns empty string when file exceeds 10MB ceiling', () => {
    fsState.set('/fake/ws/agentchat.md', 'x'.repeat(11 * 1024 * 1024));
    expect(readWorkspaceRules('/fake/ws')).toBe('');
  });
});
```

- [ ] **Step 2: Run tests; expect them to fail.**

```
npm test -- workspaceRules
```

Expected: 4 failures, all module-not-found.

- [ ] **Step 3: Implement.**

Create `src/workspaceRules.ts`:

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';

const MAX_BYTES = 10 * 1024 * 1024;

export function readWorkspaceRules(workspacePath: string): string {
  const file = path.join(workspacePath, 'agentchat.md');
  try {
    if (!fs.existsSync(file)) return '';
    const stat = fs.statSync(file);
    if (stat.size > MAX_BYTES) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
```

- [ ] **Step 4: Run tests; expect them to pass.**

```
npm test -- workspaceRules
```

Expected: 4 passes.

- [ ] **Step 5: Commit.**

```
git add src/workspaceRules.ts tests/workspaceRules.test.ts
git commit -m "$(printf 'feat(v2): readWorkspaceRules for agentchat.md\n\nSync fs read with 10MB ceiling, re-reads on every call so live\nedits take effect on the next message.\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

### Task 4: `fileMentions.ts` — parser + reader + truncation

**Files:**
- Create: `src/fileMentions.ts`
- Create: `tests/fileMentions.test.ts`

- [ ] **Step 1: Write the failing tests.**

Create `tests/fileMentions.test.ts`:

```ts
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

  it('mid-sentence @path is still parsed (file mentions are not position-restricted)', () => {
    const r = parseFileMentions('please review @src/auth.ts thanks');
    expect(r.filePaths).toEqual(['src/auth.ts']);
  });

  it('handles agent mention + file mention together', () => {
    const r = parseFileMentions('@claude review @src/auth.ts');
    expect(r.filePaths).toEqual(['src/auth.ts']);
    expect(r.remainingText).toBe('@claude review');
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
    expect(r.embedded).toContain('[File: big.ts — first 100 of 1000 lines]');
    expect(r.embedded).toContain('[/File — truncated; use the Read tool to fetch the rest]');
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
});
```

- [ ] **Step 2: Run tests; expect them to fail.**

```
npm test -- fileMentions
```

Expected: all cases fail with module-not-found.

- [ ] **Step 3: Implement.**

Create `src/fileMentions.ts`:

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';

// Tokens that look like agent mentions, NOT files. Mirror src/mentions.ts.
const AGENT_TOKENS = new Set(['claude', 'gpt', 'codex', 'chatgpt', 'gemini', 'all']);

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const BINARY_DETECT_BYTES = 8 * 1024;

export interface ParsedFileMentions {
  filePaths: string[];
  remainingText: string;
}

export interface AttachedFile {
  path: string;
  lines: number;
  truncated: boolean;
}

export interface EmbedError {
  path: string;
  reason: string;
}

export interface EmbedResult {
  embedded: string;
  attached: AttachedFile[];
  errors: EmbedError[];
}

export interface EmbedOptions {
  maxLines: number;
}

/** Distinguishes a file token from an agent token. */
function looksLikeFile(token: string): boolean {
  // Agent mentions are bare names with no slash and no dot.
  if (AGENT_TOKENS.has(token.toLowerCase())) return false;
  return token.includes('/') || token.includes('.');
}

export function parseFileMentions(input: string): ParsedFileMentions {
  const tokens = input.split(/\s+/);
  const filePaths: string[] = [];
  const remaining: string[] = [];

  for (const token of tokens) {
    if (token.startsWith('@') && looksLikeFile(token.slice(1))) {
      filePaths.push(token.slice(1));
    } else if (token.length > 0) {
      remaining.push(token);
    }
  }

  return { filePaths, remainingText: remaining.join(' ').trim() };
}

export function embedFiles(
  paths: string[],
  workspacePath: string,
  opts: EmbedOptions,
): EmbedResult {
  if (paths.length === 0) {
    return { embedded: '', attached: [], errors: [] };
  }

  const blocks: string[] = [];
  const attached: AttachedFile[] = [];
  const errors: EmbedError[] = [];

  for (const p of paths) {
    const result = embedOne(p, workspacePath, opts.maxLines);
    if ('error' in result) {
      errors.push({ path: p, reason: result.error });
    } else {
      blocks.push(result.block);
      attached.push(result.attached);
    }
  }

  return { embedded: blocks.join('\n\n'), attached, errors };
}

function embedOne(
  rawPath: string,
  workspacePath: string,
  maxLines: number,
): { block: string; attached: AttachedFile } | { error: string } {
  const absolute = path.isAbsolute(rawPath) ? rawPath : path.join(workspacePath, rawPath);
  const resolvedWorkspace = path.resolve(workspacePath);
  const resolvedFile = path.resolve(absolute);

  if (!resolvedFile.startsWith(resolvedWorkspace + path.sep) && resolvedFile !== resolvedWorkspace) {
    return { error: 'Path escapes workspace' };
  }

  if (!fs.existsSync(resolvedFile)) {
    return { error: 'File not found' };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedFile);
  } catch {
    return { error: 'Could not stat file' };
  }

  if (stat.size > MAX_FILE_BYTES) {
    return { error: 'File too large' };
  }

  let raw: Buffer | string;
  try {
    raw = fs.readFileSync(resolvedFile);
  } catch (err) {
    return { error: `Read failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const buf = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw;
  const head = buf.subarray(0, BINARY_DETECT_BYTES);
  if (head.includes(0)) {
    return { error: 'Binary file' };
  }

  const text = buf.toString('utf8');
  const allLines = text.split(/\r?\n/);
  const truncated = allLines.length > maxLines;
  const usedLines = truncated ? allLines.slice(0, maxLines) : allLines;

  const header = truncated
    ? `[File: ${rawPath} — first ${maxLines} of ${allLines.length} lines]`
    : `[File: ${rawPath}]`;
  const footer = truncated
    ? '[/File — truncated; use the Read tool to fetch the rest]'
    : '[/File]';
  const lang = inferLang(rawPath);
  const fence = '```';
  const block = [header, `${fence}${lang}`, usedLines.join('\n'), fence, footer].join('\n');

  return {
    block,
    attached: { path: rawPath, lines: usedLines.length, truncated },
  };
}

function inferLang(p: string): string {
  const ext = path.extname(p).toLowerCase();
  switch (ext) {
    case '.ts': case '.tsx': return 'ts';
    case '.js': case '.jsx': return 'js';
    case '.json': return 'json';
    case '.md': return 'md';
    case '.py': return 'python';
    case '.sh': return 'sh';
    case '.html': return 'html';
    case '.css': return 'css';
    case '.yml': case '.yaml': return 'yaml';
    default: return '';
  }
}
```

- [ ] **Step 4: Run tests; expect them to pass.**

```
npm test -- fileMentions
```

Expected: all 13 cases pass.

- [ ] **Step 5: Commit.**

```
git add src/fileMentions.ts tests/fileMentions.test.ts
git commit -m "$(printf 'feat(v2): @file mention parser + embedFiles\n\nDistinguishes file paths from agent names; reads file content with\npath-traversal protection, byte ceiling, binary detection, and\nline-cap truncation marker.\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

### Task 5: `composePrompt.ts`

**Files:**
- Create: `src/composePrompt.ts`
- Create: `tests/composePrompt.test.ts`

- [ ] **Step 1: Write the failing tests.**

Create `tests/composePrompt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { composePrompt } from '../src/composePrompt.js';

describe('composePrompt', () => {
  it('returns just user text when all other inputs empty', () => {
    expect(composePrompt({ rules: '', sharedContext: '', fileBlocks: '', userText: 'hello' }))
      .toBe('hello');
  });

  it('orders blocks: rules → context → files → user text', () => {
    const out = composePrompt({
      rules: 'use pnpm',
      sharedContext: '[Conversation so far]\nuser: hi\n[/Conversation so far]',
      fileBlocks: '[File: a.ts]\nx\n[/File]',
      userText: 'review',
    });

    const idxRules = out.indexOf('use pnpm');
    const idxCtx = out.indexOf('[Conversation so far]');
    const idxFile = out.indexOf('[File: a.ts]');
    const idxUser = out.indexOf('review');

    expect(idxRules).toBeGreaterThan(-1);
    expect(idxCtx).toBeGreaterThan(idxRules);
    expect(idxFile).toBeGreaterThan(idxCtx);
    expect(idxUser).toBeGreaterThan(idxFile);
  });

  it('wraps rules in [Workspace rules] markers', () => {
    const out = composePrompt({ rules: 'always pnpm', sharedContext: '', fileBlocks: '', userText: 'x' });
    expect(out).toContain('[Workspace rules from agentchat.md]');
    expect(out).toContain('always pnpm');
    expect(out).toContain('[/Workspace rules]');
  });

  it('omits rules block when rules empty', () => {
    const out = composePrompt({ rules: '', sharedContext: '[Conversation so far]\nx\n[/Conversation so far]', fileBlocks: '', userText: 'hi' });
    expect(out).not.toContain('[Workspace rules');
  });

  it('omits context block when shared context empty', () => {
    const out = composePrompt({ rules: 'r', sharedContext: '', fileBlocks: '', userText: 'hi' });
    expect(out).not.toContain('[Conversation so far');
  });

  it('omits file block when fileBlocks empty', () => {
    const out = composePrompt({ rules: '', sharedContext: '', fileBlocks: '', userText: 'hi' });
    expect(out).not.toContain('[File:');
  });

  it('separates each present block with a blank line', () => {
    const out = composePrompt({
      rules: 'r',
      sharedContext: '[Conversation so far]\nx\n[/Conversation so far]',
      fileBlocks: '[File: a]\ny\n[/File]',
      userText: 'go',
    });
    // Expect double-newlines between blocks
    expect(out.split('\n\n').length).toBeGreaterThanOrEqual(4);
  });
});
```

- [ ] **Step 2: Run tests; expect them to fail.**

```
npm test -- composePrompt
```

Expected: 7 module-not-found failures.

- [ ] **Step 3: Implement.**

Create `src/composePrompt.ts`:

```ts
export interface ComposePromptInput {
  rules: string;        // raw agentchat.md content; '' if absent
  sharedContext: string; // output of buildSharedContext; '' if empty
  fileBlocks: string;    // EmbedResult.embedded; '' if no files
  userText: string;      // user's natural-language ask, with @path tokens removed
}

export function composePrompt(input: ComposePromptInput): string {
  const parts: string[] = [];

  if (input.rules.trim().length > 0) {
    parts.push(['[Workspace rules from agentchat.md]', input.rules.trimEnd(), '[/Workspace rules]'].join('\n'));
  }
  if (input.sharedContext.trim().length > 0) {
    parts.push(input.sharedContext.trimEnd());
  }
  if (input.fileBlocks.trim().length > 0) {
    parts.push(input.fileBlocks.trimEnd());
  }
  parts.push(input.userText);

  return parts.join('\n\n');
}
```

- [ ] **Step 4: Run tests; expect them to pass.**

```
npm test -- composePrompt
```

Expected: 7 passes.

- [ ] **Step 5: Commit.**

```
git add src/composePrompt.ts tests/composePrompt.test.ts
git commit -m "$(printf 'feat(v2): composePrompt assembler\n\nOrders rules → shared context → file blocks → user text;\nomits each section independently when empty.\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

### Task 6: `facilitator.ts` accepts shared context

**Files:**
- Modify: `src/facilitator.ts`
- Modify: `tests/facilitator.test.ts` (existing) — add cases asserting the new arg is forwarded

- [ ] **Step 1: Add test asserting shared context is included.**

Open `tests/facilitator.test.ts`. Find the existing setup that mocks `query` from `@anthropic-ai/claude-agent-sdk`. Add a new test verifying the shared context is incorporated. Append at the end of the existing `describe('chooseFacilitatorAgent', ...)` block (replace the closing `});` with the additions then close):

```ts
  it('passes shared context to the SDK call when provided', async () => {
    let capturedSystemPrompt = '';
    let capturedPrompt = '';
    queryMock.mockImplementation(({ prompt, options }: { prompt: string; options: { systemPrompt: string } }) => {
      capturedSystemPrompt = options.systemPrompt;
      capturedPrompt = prompt;
      return (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: '{"agent":"claude","reason":"r"}' }] } };
      })();
    });

    await chooseFacilitatorAgent('what next', READY_ALL, '[Conversation so far]\nuser: prior\n[/Conversation so far]');

    expect(capturedSystemPrompt).toContain('Conversation so far');
    expect(capturedPrompt).toBe('what next');
  });
```

If `tests/facilitator.test.ts` doesn't already export a `queryMock` and `READY_ALL`, structure the test to mirror the existing patterns in that file (the `queryMock` setup will already be present from v1's facilitator tests; reuse it).

- [ ] **Step 2: Run; expect failure.**

```
npm test -- facilitator
```

Expected: the new test fails — `chooseFacilitatorAgent` rejects a third positional argument or doesn't include the context in the system prompt.

- [ ] **Step 3: Update `chooseFacilitatorAgent` signature.**

Modify `src/facilitator.ts`. Replace the existing exports with:

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentId, AgentStatus } from './types.js';

const ROUTING_ERROR = 'Routing unavailable; please prefix with @claude / @gpt / @gemini / @all';
const NO_AGENTS_ERROR = 'No agents currently authenticated; check the health pills';

export type FacilitatorDecision =
  | { agent: AgentId; reason: string }
  | { error: string };

export type FacilitatorFn = (
  userMessage: string,
  availability: Record<AgentId, AgentStatus>,
  sharedContext?: string,
) => Promise<FacilitatorDecision>;

const PROFILES: Record<AgentId, string> = {
  claude: 'code reasoning, refactors, code review, planning, design discussion',
  codex: 'execution — running tests, scripts, terminal commands, file edits',
  gemini: 'research, current events, large-context document reading',
};

export const chooseFacilitatorAgent: FacilitatorFn = async (
  userMessage,
  availability,
  sharedContext = '',
) => {
  const available = (Object.entries(availability) as Array<[AgentId, AgentStatus]>)
    .filter(([, status]) => status === 'ready' || status === 'busy')
    .map(([id]) => id);

  if (available.length === 0) {
    return { error: NO_AGENTS_ERROR };
  }

  const profileLines = available.map((id) => `- ${id}: ${PROFILES[id]}`).join('\n');

  const systemPromptParts = [
    "You are a routing assistant for a multi-agent chat tool. Pick the single best agent for the user's message and explain your choice in 4-8 words.",
    '',
    'Available agents:',
    profileLines,
    '',
  ];
  if (sharedContext.trim().length > 0) {
    systemPromptParts.push('Recent conversation context (for follow-up routing):');
    systemPromptParts.push(sharedContext);
    systemPromptParts.push('');
  }
  systemPromptParts.push('Respond with EXACTLY this JSON shape and nothing else:');
  systemPromptParts.push(
    '{ "agent": "<one of: ' + available.join(' | ') + '>", "reason": "<brief reason>" }',
  );

  const systemPrompt = systemPromptParts.join('\n');

  let responseText = '';
  try {
    const stream = query({
      prompt: userMessage,
      options: { systemPrompt },
    });
    for await (const event of stream as AsyncIterable<unknown>) {
      const e = event as { type?: string; message?: { content?: Array<Record<string, unknown>> } };
      if (e.type === 'assistant') {
        for (const item of e.message?.content ?? []) {
          if (item.type === 'text' && typeof item.text === 'string') {
            responseText += item.text as string;
          }
        }
      }
    }
  } catch {
    return { error: ROUTING_ERROR };
  }

  const cleaned = responseText
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { error: ROUTING_ERROR };
  }

  if (
    typeof parsed !== 'object' || parsed === null ||
    typeof (parsed as { agent?: unknown }).agent !== 'string' ||
    typeof (parsed as { reason?: unknown }).reason !== 'string'
  ) {
    return { error: ROUTING_ERROR };
  }

  const decision = parsed as { agent: string; reason: string };
  if (!available.includes(decision.agent as AgentId)) {
    return { error: ROUTING_ERROR };
  }

  return { agent: decision.agent as AgentId, reason: decision.reason };
};
```

- [ ] **Step 4: Run; expect pass.**

```
npm test -- facilitator
```

Expected: all existing facilitator tests still pass + the new shared-context test passes.

- [ ] **Step 5: Commit.**

```
git add src/facilitator.ts tests/facilitator.test.ts
git commit -m "$(printf 'feat(v2): facilitator accepts shared context\n\nNew optional sharedContext argument is interpolated into the system\nprompt so smart routing can handle follow-ups like \"@gpt continue\nfrom there\". Backwards compatible: existing callers still work.\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

### Task 7: `messageRouter.ts` rebuilds context per target

**Files:**
- Modify: `src/messageRouter.ts`
- Modify: `tests/messageRouter.test.ts` — extend with `@all` rebuild test

The router currently calls `agent.send(promptText, opts)`. We change `handle()` to accept a `composePrompt` callback that rebuilds the prompt for each target — letting the panel inject fresh shared context between agents in an `@all` dispatch.

- [ ] **Step 1: Add tests for per-target prompt composition + facilitator argument.**

Open `tests/messageRouter.test.ts`. Add:

```ts
describe('per-target prompt composition (v2)', () => {
  it('calls composePromptForTarget once per target before agent.send', async () => {
    const calls: string[] = [];
    const fakeAgent = (id: AgentId): Agent => ({
      id,
      status: async () => 'ready',
      send: async function* (prompt: string) {
        calls.push(`${id}:${prompt}`);
        yield { type: 'text', text: `from-${id}` };
        yield { type: 'done' };
      },
      cancel: async () => { /* noop */ },
    });
    const agents: AgentRegistry = {
      claude: fakeAgent('claude'),
      codex: fakeAgent('codex'),
      gemini: fakeAgent('gemini'),
    };
    const router = new MessageRouter(agents);

    const composer = vi.fn((targetId: AgentId, baseText: string) => `[${targetId}-prompt] ${baseText}`);

    const events: RouterEvent[] = [];
    for await (const ev of router.handle('@all hi', { composePromptForTarget: composer })) {
      events.push(ev);
    }

    expect(composer).toHaveBeenCalledTimes(3);
    expect(composer).toHaveBeenCalledWith('claude', 'hi');
    expect(composer).toHaveBeenCalledWith('codex', 'hi');
    expect(composer).toHaveBeenCalledWith('gemini', 'hi');
    expect(calls).toContain('claude:[claude-prompt] hi');
    expect(calls).toContain('codex:[codex-prompt] hi');
    expect(calls).toContain('gemini:[gemini-prompt] hi');
  });

  it('forwards sharedContext to facilitator', async () => {
    const fakeAgent = (id: AgentId): Agent => ({
      id,
      status: async () => 'ready',
      send: async function* () { yield { type: 'done' }; },
      cancel: async () => { /* noop */ },
    });
    const facilitator = vi.fn(async (text, status, ctx) => ({ agent: 'claude' as AgentId, reason: 'r' }));

    const router = new MessageRouter(
      { claude: fakeAgent('claude'), codex: fakeAgent('codex'), gemini: fakeAgent('gemini') },
      facilitator as FacilitatorFn,
    );

    for await (const _ of router.handle('plain text', {
      composePromptForTarget: (_id, t) => t,
      sharedContextForFacilitator: '[Conversation so far]\nuser: prior\n[/Conversation so far]',
    })) { /* drain */ }

    expect(facilitator).toHaveBeenCalledWith(
      'plain text',
      expect.any(Object),
      '[Conversation so far]\nuser: prior\n[/Conversation so far]',
    );
  });
});
```

(Imports at the top of the file may need `vi` and the `FacilitatorFn` type.)

- [ ] **Step 2: Run; expect failure.**

```
npm test -- messageRouter
```

Expected: new tests fail — `handle()` doesn't accept `composePromptForTarget` / `sharedContextForFacilitator`.

- [ ] **Step 3: Modify `MessageRouter.handle` signature.**

Edit `src/messageRouter.ts`. Replace the body of `handle()`:

```ts
  async *handle(
    input: string,
    opts: SendOptions & {
      composePromptForTarget?: (targetId: AgentId, baseText: string) => string;
      sharedContextForFacilitator?: string;
    } = {},
  ): AsyncIterable<RouterEvent> {
    const { targets, remainingText } = parseMentions(input);

    let dispatchTargets = targets;
    let promptText = remainingText;

    if (dispatchTargets.length === 0) {
      if (!this.facilitator) {
        yield { kind: 'routing-needed', text: remainingText || input };
        return;
      }
      const status: Record<AgentId, AgentStatus> = {
        claude: this.lastStatus.claude ?? 'ready',
        codex: this.lastStatus.codex ?? 'ready',
        gemini: this.lastStatus.gemini ?? 'ready',
      };
      const text = remainingText || input;
      const decision = await this.facilitator(text, status, opts.sharedContextForFacilitator);
      if ('error' in decision) {
        yield { kind: 'routing-needed', text: decision.error };
        return;
      }
      yield { kind: 'facilitator-decision', agentId: decision.agent, reason: decision.reason };
      dispatchTargets = [decision.agent];
      promptText = text;
    }

    const handlePromises = dispatchTargets.map((id) => this.floor.acquire(id));

    for (let i = 0; i < dispatchTargets.length; i++) {
      const handle = await handlePromises[i];
      if (handle.noop) continue;

      const ac = new AbortController();
      this.activeControllers.add(ac);

      const targetId = dispatchTargets[i];
      let watchdogFired = false;
      const watchdog = this.watchdogMs > 0 ? setTimeout(() => {
        watchdogFired = true;
        ac.abort();
        this.agents[targetId].cancel().catch(() => { /* best-effort */ });
      }, this.watchdogMs) : null;

      try {
        yield { kind: 'dispatch-start', agentId: targetId };
        const agent = this.agents[targetId];
        // V2: rebuild prompt fresh for each target so later @all members see prior replies.
        const finalPrompt = opts.composePromptForTarget
          ? opts.composePromptForTarget(targetId, promptText)
          : promptText;
        try {
          for await (const chunk of withAbort(agent.send(finalPrompt, opts), ac.signal)) {
            yield { kind: 'chunk', agentId: targetId, chunk };
          }
          if (watchdogFired) {
            const minutes = (this.watchdogMs / 60_000).toFixed(0);
            const minutesText = minutes === '0' ? `${(this.watchdogMs / 1000).toFixed(0)} seconds` : `${minutes} minutes`;
            yield { kind: 'chunk', agentId: targetId, chunk: { type: 'error', message: `Watchdog: ${targetId} held the floor for over ${minutesText}; releasing.` } };
            yield { kind: 'chunk', agentId: targetId, chunk: { type: 'done' } };
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          yield { kind: 'chunk', agentId: targetId, chunk: { type: 'error', message } };
          yield { kind: 'chunk', agentId: targetId, chunk: { type: 'done' } };
        }
        yield { kind: 'dispatch-end', agentId: targetId };
      } finally {
        if (watchdog) clearTimeout(watchdog);
        this.activeControllers.delete(ac);
        handle.release();
      }
    }
  }
```

The `withAbort` helper, `FloorListener`, `StatusListener`, and constructor are unchanged.

- [ ] **Step 4: Run; expect pass.**

```
npm test -- messageRouter
```

Expected: all existing 14 tests still pass + 2 new pass.

- [ ] **Step 5: Commit.**

```
git add src/messageRouter.ts tests/messageRouter.test.ts
git commit -m "$(printf 'feat(v2): router rebuilds prompt per target + threads facilitator context\n\nhandle() accepts optional composePromptForTarget callback and\nsharedContextForFacilitator string. The composer fires once per\ntarget after dispatch-start so successive @all members see fresh\ncontext containing prior agents replies.\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

### Task 8: `panel.ts` wires composition pipeline + persists `attachedFiles`

**Files:**
- Modify: `src/panel.ts`
- Modify: `tests/panel.test.ts` — add a test asserting the composition is invoked end-to-end

- [ ] **Step 1: Add the wiring inside `dispatchUserMessage`.**

In `src/panel.ts`, change the imports at the top to include the new modules:

```ts
import { buildSharedContext } from './sharedContext.js';
import { readWorkspaceRules } from './workspaceRules.js';
import { parseFileMentions, embedFiles } from './fileMentions.js';
import { composePrompt } from './composePrompt.js';
```

Update `dispatchUserMessage` to:
1. Parse file mentions from the incoming text
2. Embed files (capturing attached + errors)
3. Persist `attachedFiles` on the user message
4. Surface embed errors as system messages
5. Pass `composePromptForTarget` and `sharedContextForFacilitator` to the router
6. Strip @path tokens from the prompt sent to agents but keep them in the persisted user message text

Replace the existing `dispatchUserMessage` body with:

```ts
  private async dispatchUserMessage(text: string): Promise<void> {
    const fileEmbedMaxLines = vscode.workspace.getConfiguration('agentChat').get<number>('fileEmbedMaxLines', 500);
    const sharedContextWindow = vscode.workspace.getConfiguration('agentChat').get<number>('sharedContextWindow', 25);

    const { filePaths, remainingText } = parseFileMentions(text);
    const embedResult = embedFiles(filePaths, this.workspacePath, { maxLines: fileEmbedMaxLines });

    const userMsg: UserMessage = {
      id: ulid(),
      role: 'user',
      text,
      timestamp: Date.now(),
      ...(embedResult.attached.length > 0 ? { attachedFiles: embedResult.attached } : {}),
    };
    if (this.store.isFirstSession()) {
      await this.maybeShowGitignorePrompt(this.workspacePath);
    }
    this.store.appendUser(userMsg);
    this.send({ kind: 'user-message-appended', message: userMsg });

    for (const e of embedResult.errors) {
      const sys: SystemMessage = {
        id: ulid(),
        role: 'system',
        kind: 'error',
        text: `${e.path}: ${e.reason}`,
        timestamp: Date.now(),
      };
      this.store.appendSystem(sys);
      this.send({ kind: 'system-message', message: sys });
    }

    const inProgressByAgent = new Map<AgentId, { id: string; text: string; toolEvents: any[]; agentId: AgentId; timestamp: number; error?: string; cancelled?: boolean }>();
    this.currentDispatchInProgress = inProgressByAgent;

    const hangSec = this.hangSec;
    let lastChunkAt = Date.now();
    let activeAgentForHang: AgentId | null = null;
    const hangCheckTimer = hangSec > 0 ? setInterval(() => {
      if (activeAgentForHang === null) return;
      if (Date.now() - lastChunkAt >= hangSec * 1000) {
        const sys: SystemMessage = {
          id: ulid(),
          role: 'system',
          kind: 'error',
          text: `${activeAgentForHang} hasn't responded for ${hangSec}s — keep waiting or cancel?`,
          timestamp: Date.now(),
        };
        this.store.appendSystem(sys);
        this.send({ kind: 'system-message', message: sys });
        lastChunkAt = Date.now();
      }
    }, 1000) : null;

    const composePromptForTarget = (_targetId: AgentId, baseText: string): string => {
      // Rebuild fresh on each call so successive @all members see updated transcript.
      const session = this.store.snapshot();
      const sharedContext = buildSharedContext(session, { window: sharedContextWindow });
      const rules = readWorkspaceRules(this.workspacePath);
      return composePrompt({
        rules,
        sharedContext,
        fileBlocks: embedResult.embedded,
        userText: baseText,
      });
    };

    const sharedContextForFacilitator = buildSharedContext(
      this.store.snapshot(),
      { window: sharedContextWindow },
    );

    try {
      for await (const event of this.router.handle(
        // remainingText has @<path> tokens stripped but @claude/@gpt/@gemini/@all preserved
        // (parseFileMentions skips agent tokens). Router's parseMentions handles the rest.
        remainingText,
        {
          cwd: this.workspacePath,
          composePromptForTarget,
          sharedContextForFacilitator,
        },
      )) {
        if (event.kind === 'facilitator-decision') {
          const sys: SystemMessage = {
            id: ulid(),
            role: 'system',
            kind: 'facilitator-decision',
            text: '',
            timestamp: Date.now(),
            agentId: event.agentId,
            reason: event.reason,
          };
          this.store.appendSystem(sys);
          this.send({ kind: 'system-message', message: sys });
          continue;
        }
        if (event.kind === 'routing-needed') {
          const sys: SystemMessage = {
            id: ulid(),
            role: 'system',
            kind: 'routing-needed',
            text: 'Please prefix with @claude / @gpt / @gemini / @all to route this message.',
            timestamp: Date.now(),
          };
          this.store.appendSystem(sys);
          this.send({ kind: 'system-message', message: sys });
          continue;
        }
        if (event.kind === 'dispatch-start') {
          const id = ulid();
          const ts = Date.now();
          inProgressByAgent.set(event.agentId, { id, text: '', toolEvents: [], agentId: event.agentId, timestamp: ts });
          this.send({ kind: 'message-started', id, agentId: event.agentId, timestamp: ts });
          activeAgentForHang = event.agentId;
          lastChunkAt = Date.now();
          continue;
        }
        if (event.kind === 'chunk') {
          const ip = inProgressByAgent.get(event.agentId);
          if (!ip) continue;
          if (event.chunk.type === 'text') ip.text += event.chunk.text;
          else if (event.chunk.type === 'tool-call') ip.toolEvents.push({ kind: 'call', name: event.chunk.name, input: event.chunk.input, timestamp: Date.now() });
          else if (event.chunk.type === 'tool-result') ip.toolEvents.push({ kind: 'result', name: event.chunk.name, output: event.chunk.output, timestamp: Date.now() });
          else if (event.chunk.type === 'error') ip.error = event.chunk.message;
          lastChunkAt = Date.now();
          this.send({ kind: 'message-chunk', id: ip.id, chunk: event.chunk });
          continue;
        }
        if (event.kind === 'dispatch-end') {
          const ip = inProgressByAgent.get(event.agentId);
          if (!ip) continue;
          const status: AgentMessage['status'] =
            ip.cancelled ? 'cancelled' : (ip.error ? 'errored' : 'complete');
          const finalized: AgentMessage = {
            id: ip.id,
            role: 'agent',
            agentId: ip.agentId,
            text: ip.text,
            toolEvents: ip.toolEvents,
            timestamp: ip.timestamp,
            status,
            ...(ip.error ? { error: ip.error } : {}),
          };
          this.store.appendAgent(finalized);
          this.send({ kind: 'message-finalized', message: finalized });
          inProgressByAgent.delete(event.agentId);
          activeAgentForHang = null;
        }
      }
    } finally {
      if (hangCheckTimer) clearInterval(hangCheckTimer);
      this.currentDispatchInProgress = null;
    }
  }
```

Note: no helper to reconstruct head mentions is needed. `parseFileMentions` only strips `@<path>` tokens (those that look like file paths) and leaves `@claude`/`@gpt`/`@gemini`/`@all` in `remainingText`. The router's existing `parseMentions` then peels the agent mentions off the head as it always has.

- [ ] **Step 2: Add `snapshot()` method to `SessionStore` if it doesn't exist.**

Read `src/sessionStore.ts`. If it doesn't expose `snapshot(): Session`, add it. The implementation returns the in-memory session deeply enough that callers can iterate `.messages` safely:

```ts
  snapshot(): Session {
    return { version: this.session.version, messages: [...this.session.messages] };
  }
```

(The existing `appendUser`, `appendAgent`, `appendSystem` already mutate the in-memory session; this exposes a read view.)

- [ ] **Step 3: Add panel test asserting `attachedFiles` is persisted and embed errors surface.**

Open `tests/panel.test.ts`. Add a test inside the existing `describe('ChatPanel', ...)` block:

```ts
  it('persists attachedFiles + surfaces embed errors when @file used', async () => {
    fsState.set('/fake/ws/foo.ts', 'export const x = 1;\n');
    const sentMessages: FromExtension[] = [];
    panelMock.webview.postMessage = (m: FromExtension) => { sentMessages.push(m); return Promise.resolve(true); };

    const panel = await openPanelWithAgents();
    await panel.dispatchUserMessageForTest('@claude review @foo.ts and @missing.ts');

    const userAppended = sentMessages.find((m) => m.kind === 'user-message-appended');
    expect(userAppended?.kind === 'user-message-appended' && userAppended.message.attachedFiles)
      .toEqual([{ path: 'foo.ts', lines: 1, truncated: false }]);

    const errSys = sentMessages.find((m) => m.kind === 'system-message' && m.message.text.includes('missing.ts'));
    expect(errSys).toBeDefined();
  });
```

(`openPanelWithAgents` and `dispatchUserMessageForTest` should follow the existing v1 panel test scaffolding — they already exist or are easily extracted from `tests/panel.test.ts` for this round-trip pattern. If the test file has no exposure for `dispatchUserMessage`, expose a `__forTest_dispatchUserMessage(text)` method on `ChatPanel` guarded by an `if (process.env.NODE_ENV !== 'test') return;` check, or use existing test helper methods that v1 already established.)

- [ ] **Step 4: Run all tests; expect new test passes + 0 existing regressions.**

```
npm test
npm run build
```

Expected: 83 v1 tests + new v2 tests all pass. Build clean.

- [ ] **Step 5: Commit.**

```
git add src/panel.ts src/sessionStore.ts tests/panel.test.ts
git commit -m "$(printf 'feat(v2): wire composition pipeline into ChatPanel\n\ndispatchUserMessage now: parses @file mentions, embeds files,\npersists attachedFiles on UserMessage, surfaces embed errors,\nbuilds sharedContext + rules + composes prompts per target via the\nrouters new callback. Adds SessionStore.snapshot() for the\ncomposer to read latest persisted state.\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

### Task 9: Per-adapter `getEditedPath` helpers

**Files:**
- Modify: `src/agents/claude.ts`
- Modify: `src/agents/codex.ts`
- Modify: `src/agents/gemini.ts`
- Create: `tests/agents/getEditedPath.test.ts`

This task adds a single helper exported from each adapter. The helper takes a tool name + input and returns an absolute path to the file the tool wrote, or `null` if the tool isn't a write or the input shape doesn't match. Conservative defaults; unknown shapes return `null`.

- [ ] **Step 1: Write the failing tests.**

Create `tests/agents/getEditedPath.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
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
```

- [ ] **Step 2: Run; expect failure (no helpers exported).**

```
npm test -- getEditedPath
```

Expected: all imports fail.

- [ ] **Step 3: Add `getEditedPath` to each adapter.**

In `src/agents/claude.ts`, append (outside the class):

```ts
const CLAUDE_WRITE_TOOLS: Record<string, string[]> = {
  Edit: ['file_path'],
  Write: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'],
};

export function getEditedPath(toolName: string, input: unknown): string | null {
  const fields = CLAUDE_WRITE_TOOLS[toolName];
  if (!fields) return null;
  if (typeof input !== 'object' || input === null) return null;
  const obj = input as Record<string, unknown>;
  for (const f of fields) {
    if (typeof obj[f] === 'string') return obj[f] as string;
  }
  return null;
}
```

In `src/agents/codex.ts`, append:

```ts
const CODEX_WRITE_TOOLS = new Set(['apply_patch', 'write_file', 'update_file']);

export function getEditedPath(toolName: string, input: unknown): string | null {
  if (!CODEX_WRITE_TOOLS.has(toolName)) return null;
  if (typeof input !== 'object' || input === null) return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.path === 'string') return obj.path;
  if (typeof obj.file_path === 'string') return obj.file_path as string;
  return null;
}
```

In `src/agents/gemini.ts`, append:

```ts
const GEMINI_WRITE_TOOLS = new Set(['write_file', 'replace']);

export function getEditedPath(toolName: string, input: unknown): string | null {
  if (!GEMINI_WRITE_TOOLS.has(toolName)) return null;
  if (typeof input !== 'object' || input === null) return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.file_path === 'string') return obj.file_path as string;
  if (typeof obj.path === 'string') return obj.path as string;
  return null;
}
```

- [ ] **Step 4: Run; expect pass.**

```
npm test -- getEditedPath
```

Expected: 13 passes.

- [ ] **Step 5: Commit.**

```
git add src/agents/claude.ts src/agents/codex.ts src/agents/gemini.ts tests/agents/getEditedPath.test.ts
git commit -m "$(printf 'feat(v2): per-adapter getEditedPath helpers\n\nEach adapter exports a helper that maps (toolName, input) to an\nabsolute path for write-class tool calls, or null. Used by\nfileBadges to build the FileEditRecord. Unknown shapes silently\nreturn null so unfamiliar tools dont break decoration.\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

### Task 10: `fileBadges.ts` — provider + workspaceState bookkeeping

**Files:**
- Create: `src/fileBadges.ts`
- Create: `tests/fileBadges.test.ts`

This module owns:
1. The `FileEditRecord[]` array stored in `context.workspaceState['agentChat.fileEdits']`
2. A `recordEdit(state, path, agentId, now)` pure function used by the panel
3. A 24h prune
4. A `FileDecorationProvider` that VS Code calls to render the badge
5. An event emitter so the provider re-fires `onDidChange` when records update

- [ ] **Step 1: Write the failing tests.**

Create `tests/fileBadges.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
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
```

- [ ] **Step 2: Run; expect failure.**

```
npm test -- fileBadges
```

Expected: all module-not-found.

- [ ] **Step 3: Implement.**

Create `src/fileBadges.ts`:

```ts
import * as vscode from 'vscode';
import type { AgentId } from './types.js';

export type FileEditRecord = {
  path: string;       // absolute
  agentId: AgentId;
  editedAt: number;   // ms epoch
  alsoBy: AgentId[];
};

const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

const AGENT_COLORS: Record<AgentId, string> = {
  claude: 'agentChat.claudeColor',
  codex: 'agentChat.codexColor',
  gemini: 'agentChat.geminiColor',
};

export function recordEdit(
  state: FileEditRecord[],
  filePath: string,
  agentId: AgentId,
  now: number,
): FileEditRecord[] {
  const next = state.map((r) => ({ ...r, alsoBy: [...r.alsoBy] }));
  const existing = next.find((r) => r.path === filePath);
  if (!existing) {
    next.push({ path: filePath, agentId, editedAt: now, alsoBy: [] });
    return next;
  }
  if (existing.agentId !== agentId) {
    if (!existing.alsoBy.includes(existing.agentId)) {
      existing.alsoBy = [...existing.alsoBy.filter((a) => a !== agentId), existing.agentId];
    }
  }
  existing.agentId = agentId;
  existing.editedAt = now;
  return next;
}

export function pruneStale(state: FileEditRecord[], now: number): FileEditRecord[] {
  return state.filter((r) => now - r.editedAt < TWENTY_FOUR_HOURS);
}

const STATE_KEY = 'agentChat.fileEdits';

export class FileBadgesController implements vscode.FileDecorationProvider {
  private records: FileEditRecord[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  constructor(private context: vscode.ExtensionContext) {
    const stored = context.workspaceState.get<FileEditRecord[]>(STATE_KEY) ?? [];
    this.records = pruneStale(stored, Date.now());
    if (this.records.length !== stored.length) {
      void context.workspaceState.update(STATE_KEY, this.records);
    }
  }

  registerEdit(filePath: string, agentId: AgentId): void {
    const now = Date.now();
    const next = pruneStale(recordEdit(this.records, filePath, agentId, now), now);
    this.records = next;
    void this.context.workspaceState.update(STATE_KEY, next);
    this._onDidChange.fire(vscode.Uri.file(filePath));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') return undefined;
    const record = this.records.find((r) => r.path === uri.fsPath);
    if (!record) return undefined;
    const minutesAgo = Math.floor((Date.now() - record.editedAt) / 60_000);
    const tooltip = record.alsoBy.length > 0
      ? `Last edited by ${record.agentId} ${minutesAgo}m ago (also: ${record.alsoBy.join(', ')})`
      : `Edited by ${record.agentId} ${minutesAgo}m ago`;
    return {
      badge: '●',
      tooltip,
      color: new vscode.ThemeColor(AGENT_COLORS[record.agentId]),
    };
  }
}
```

- [ ] **Step 4: Run; expect pass.**

```
npm test -- fileBadges
```

Expected: 6 passes.

- [ ] **Step 5: Commit.**

```
git add src/fileBadges.ts tests/fileBadges.test.ts
git commit -m "$(printf 'feat(v2): file decoration badges\n\nFileBadgesController owns FileEditRecord[] in workspaceState,\nprovides FileDecorationProvider for the explorer, prunes records\nolder than 24h on construction, and exposes registerEdit() for the\npanel to call on successful write tool-results.\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

### Task 11: `panel.ts` emits `file-edited` on tool-result success

**Files:**
- Modify: `src/panel.ts` — wire badge controller into the dispatch loop
- Modify: `tests/panel.test.ts` — verify `file-edited` event fires once per write tool-result

The badge controller is constructed in `extension.ts` (Task 14) and passed into the panel. For now, plumb the panel to accept it via the constructor.

- [ ] **Step 1: Write the failing test.**

Add to `tests/panel.test.ts`:

```ts
  it('emits file-edited event when an agent successfully writes a file', async () => {
    const sentMessages: FromExtension[] = [];
    panelMock.webview.postMessage = (m: FromExtension) => { sentMessages.push(m); return Promise.resolve(true); };

    const fakeAgents: AgentRegistry = {
      claude: makeFakeAgent('claude', [
        { type: 'tool-call', name: 'Edit', input: { file_path: '/abs/foo.ts', new_string: 'x', old_string: 'y' } },
        { type: 'tool-result', name: 'Edit', output: 'OK' },
        { type: 'text', text: 'done' },
        { type: 'done' },
      ]),
      codex: makeFakeAgent('codex', [{ type: 'done' }]),
      gemini: makeFakeAgent('gemini', [{ type: 'done' }]),
    };
    const badgeController = { registerEdit: vi.fn() };

    const panel = await openPanelWithAgents(fakeAgents, { badgeController });
    await panel.dispatchUserMessageForTest('@claude edit foo');

    expect(badgeController.registerEdit).toHaveBeenCalledTimes(1);
    expect(badgeController.registerEdit).toHaveBeenCalledWith('/abs/foo.ts', 'claude');
    const fileEdited = sentMessages.find((m) => m.kind === 'file-edited');
    expect(fileEdited).toEqual({ kind: 'file-edited', path: '/abs/foo.ts', agentId: 'claude', timestamp: expect.any(Number) });
  });
```

(`makeFakeAgent` is the existing helper in v1's panel test or follows the same shape used by Task 7's router test.)

- [ ] **Step 2: Run; expect failure.**

```
npm test -- panel
```

Expected: panel constructor doesn't accept `badgeController`, and `registerEdit` is never called.

- [ ] **Step 3: Modify the panel constructor and tool-result handling.**

In `src/panel.ts`:

Add to imports:
```ts
import type { FileBadgesController } from './fileBadges.js';
import { getEditedPath as getClaudeEditedPath } from './agents/claude.js';
import { getEditedPath as getCodexEditedPath } from './agents/codex.js';
import { getEditedPath as getGeminiEditedPath } from './agents/gemini.js';
```

Add a small dispatcher near the top of the file:
```ts
function getEditedPathForAgent(agentId: AgentId, toolName: string, input: unknown): string | null {
  if (agentId === 'claude') return getClaudeEditedPath(toolName, input);
  if (agentId === 'codex') return getCodexEditedPath(toolName, input);
  if (agentId === 'gemini') return getGeminiEditedPath(toolName, input);
  return null;
}
```

Update `ChatPanel.show` to accept an optional `badgeController` and pass it through. Update the constructor signature:

```ts
  static async show(
    context: vscode.ExtensionContext,
    agentsOverride?: AgentRegistry,
    badgeController?: FileBadgesController,
  ): Promise<void> {
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal();
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showErrorMessage('Agent Chat requires an open workspace folder.');
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'agentChat',
      'Agent Chat',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
      }
    );
    const agents = agentsOverride ?? {
      claude: new ClaudeAgent(),
      codex: new CodexAgent(),
      gemini: new GeminiAgent(),
    };
    ChatPanel.current = new ChatPanel(panel, context, folder.uri.fsPath, agents, badgeController);
    await ChatPanel.current.initialize();
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private context: vscode.ExtensionContext,
    private workspacePath: string,
    agents: AgentRegistry,
    private badgeController?: FileBadgesController,
  ) {
    // ...existing body unchanged
  }
```

In the dispatch loop where we already do `else if (event.chunk.type === 'tool-result') ...`, add:

```ts
          else if (event.chunk.type === 'tool-result') {
            ip.toolEvents.push({ kind: 'result', name: event.chunk.name, output: event.chunk.output, timestamp: Date.now() });
            // Find the matching pending tool-call to recover input — we already pushed call before result.
            const pendingCall = ip.toolEvents.findLast(
              (e: any) => e.kind === 'call' && e.name === event.chunk.name,
            ) as any;
            if (pendingCall && this.badgeController) {
              const editedPath = getEditedPathForAgent(event.agentId, event.chunk.name, pendingCall.input);
              if (editedPath) {
                this.badgeController.registerEdit(editedPath, event.agentId);
                this.send({ kind: 'file-edited', path: editedPath, agentId: event.agentId, timestamp: Date.now() });
              }
            }
          }
```

(`findLast` is supported in TS's lib.es2023; if your `tsconfig` is older, use a manual reverse scan.)

- [ ] **Step 4: Run all tests; expect pass.**

```
npm test
npm run build
```

Expected: all tests pass, build clean.

- [ ] **Step 5: Commit.**

```
git add src/panel.ts tests/panel.test.ts
git commit -m "$(printf 'feat(v2): panel emits file-edited and registers badge on writes\n\nWhen a successful tool-result arrives for a write-class tool the\npanel asks the agents getEditedPath helper for the path, calls\nbadgeController.registerEdit, and posts a file-edited event for\nthe webview.\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

### Task 12: `commitHook.ts` — sentinel writer wired to dispatch lifecycle

**Files:**
- Create: `src/commitHook.ts`
- Create: `tests/commitHook.test.ts` (sentinel-writer cases only; install logic is in Task 13)
- Modify: `src/panel.ts` — call sentinel writer on dispatch start/end

- [ ] **Step 1: Write the failing tests for the sentinel writer.**

Create `tests/commitHook.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SentinelWriter } from '../src/commitHook.js';

const fsState = new Map<string, string>();

vi.mock('node:fs', () => ({
  existsSync: (p: string) => fsState.has(String(p)),
  writeFileSync: (p: string, content: string) => fsState.set(String(p), content),
  unlinkSync: (p: string) => { fsState.delete(String(p)); },
  mkdirSync: vi.fn(),
}));

beforeEach(() => {
  fsState.clear();
});

describe('SentinelWriter', () => {
  const ws = '/fake/ws';
  const sentinelPath = '/fake/ws/.vscode/agent-chat/active-dispatch';

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
    w.dispatchEnd('claude'); // should not throw
    expect(fsState.has(sentinelPath)).toBe(false);
  });
});
```

- [ ] **Step 2: Run; expect failure.**

```
npm test -- commitHook
```

Expected: module-not-found.

- [ ] **Step 3: Implement the sentinel writer.**

Create `src/commitHook.ts`:

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentId } from './types.js';

const SENTINEL_DIR_REL = path.join('.vscode', 'agent-chat');
const SENTINEL_NAME = 'active-dispatch';

export interface SentinelWriterOptions {
  enabled?: boolean;
}

export class SentinelWriter {
  private active = new Set<AgentId>();
  private latest: AgentId | null = null;
  private readonly enabled: boolean;
  private readonly dir: string;
  private readonly file: string;

  constructor(workspacePath: string, options: SentinelWriterOptions = {}) {
    this.enabled = options.enabled !== false;
    this.dir = path.join(workspacePath, SENTINEL_DIR_REL);
    this.file = path.join(this.dir, SENTINEL_NAME);
  }

  dispatchStart(agentId: AgentId): void {
    if (!this.enabled) return;
    this.active.add(agentId);
    this.latest = agentId;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, `${agentId}\n`);
    } catch {
      // best-effort; if we can't write the sentinel, the hook just won't tag this commit
    }
  }

  dispatchEnd(agentId: AgentId): void {
    if (!this.enabled) return;
    this.active.delete(agentId);
    if (this.active.size === 0) {
      this.latest = null;
      try {
        if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
      } catch {
        // best-effort
      }
    } else {
      // Pick any remaining agent as the latest. Order isn't critical; floor manager
      // serializes dispatches so usually only one is active at a time.
      const remaining = this.active.values().next().value;
      if (remaining) {
        this.latest = remaining;
        try {
          fs.writeFileSync(this.file, `${remaining}\n`);
        } catch {
          // best-effort
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run; expect pass.**

```
npm test -- commitHook
```

Expected: 5 passes.

- [ ] **Step 5: Wire `SentinelWriter` into the panel dispatch loop.**

In `src/panel.ts`, add to imports:

```ts
import { SentinelWriter } from './commitHook.js';
```

In the constructor, instantiate:

```ts
    this.sentinel = new SentinelWriter(workspacePath, {
      enabled: vscode.workspace.getConfiguration('agentChat').get<boolean>('commitSignature.enabled', true),
    });
```

(Add the field `private sentinel: SentinelWriter;` to the class body.)

In `dispatchUserMessage`, in the existing dispatch-event loop, call `dispatchStart` / `dispatchEnd`:

```ts
        if (event.kind === 'dispatch-start') {
          this.sentinel.dispatchStart(event.agentId);
          // ...existing dispatch-start handling
        }
        // ...
        if (event.kind === 'dispatch-end') {
          // ...existing dispatch-end handling
          this.sentinel.dispatchEnd(event.agentId);
        }
```

Also re-instantiate when `commitSignature.enabled` setting changes — extend the existing `onDidChangeConfiguration` handler:

```ts
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('agentChat')) {
          this.hangSec = this.readHangSeconds();
          this.sentinel = new SentinelWriter(this.workspacePath, {
            enabled: vscode.workspace.getConfiguration('agentChat').get<boolean>('commitSignature.enabled', true),
          });
          this.send({ kind: 'settings-changed', settings: this.readSettings() });
        }
      }),
```

- [ ] **Step 6: Build + run all tests.**

```
npm run build
npm test
```

Expected: all green.

- [ ] **Step 7: Commit.**

```
git add src/commitHook.ts src/panel.ts tests/commitHook.test.ts
git commit -m "$(printf 'feat(v2): SentinelWriter for commit-attribution hook\n\nWrites .vscode/agent-chat/active-dispatch with the active agent\nid on dispatch-start and removes it when all dispatches end.\nGuarded by agentChat.commitSignature.enabled. Floor manager keeps\n@all sequential so the file always points at the running agent.\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

### Task 13: `commitHook.ts` — install / uninstall / snippet + hook-manager detection

**Files:**
- Modify: `src/commitHook.ts`
- Modify: `tests/commitHook.test.ts`

- [ ] **Step 1: Write the failing tests for install/uninstall/detection.**

Append to `tests/commitHook.test.ts`:

```ts
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
    expect(fsState.get(hookPath)).toContain('AGENT-CHAT-MANAGED');
    expect(fsState.get(hookPath)).toContain('Co-Authored-By: Agent Chat');
  });

  it('refuses when a non-marker hook already exists', () => {
    fsState.set('/fake/ws/.git', 'directory-marker');
    fsState.set(hookPath, '#!/bin/sh\necho "user hook"\n');
    const result = installCommitHook(ws);
    expect(result.status).toBe('refused-existing');
  });

  it('overwrites an existing AGENT-CHAT-MANAGED hook (idempotent upgrade)', () => {
    fsState.set('/fake/ws/.git', 'directory-marker');
    fsState.set(hookPath, '#!/bin/sh\n# AGENT-CHAT-MANAGED\nold-content\n');
    const result = installCommitHook(ws);
    expect(result.status).toBe('installed');
    expect(fsState.get(hookPath)).toContain('Co-Authored-By: Agent Chat');
    expect(fsState.get(hookPath)).not.toContain('old-content');
  });

  it('refuses when a hook manager is detected', () => {
    fsState.set('/fake/ws/.git', 'directory-marker');
    fsState.set('/fake/ws/.husky', 'directory-marker');
    const result = installCommitHook(ws);
    expect(result.status).toBe('refused-hook-manager');
    expect(result.manager).toBe('husky');
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
    fsState.set(hookPath, '#!/bin/sh\n# AGENT-CHAT-MANAGED\n...');
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
  it('contains the AGENT-CHAT-MANAGED marker', () => {
    expect(COMMIT_HOOK_SNIPPET).toContain('AGENT-CHAT-MANAGED');
  });
  it('reads the active-dispatch sentinel', () => {
    expect(COMMIT_HOOK_SNIPPET).toContain('.vscode/agent-chat/active-dispatch');
  });
  it('is idempotent (greps before appending)', () => {
    expect(COMMIT_HOOK_SNIPPET).toContain('Co-Authored-By: Agent Chat');
    expect(COMMIT_HOOK_SNIPPET).toContain('grep -q');
  });
});
```

- [ ] **Step 2: Run; expect failure.**

```
npm test -- commitHook
```

Expected: new test cases fail because the new exports don't exist.

- [ ] **Step 3: Implement install/uninstall/detection.**

Append to `src/commitHook.ts`:

```ts
export const COMMIT_HOOK_SNIPPET = [
  '#!/bin/sh',
  '# AGENT-CHAT-MANAGED',
  '# Tags commits made during an Agent Chat dispatch with a Co-Authored-By trailer.',
  'SENTINEL=".vscode/agent-chat/active-dispatch"',
  'if [ -f "$SENTINEL" ]; then',
  '  AGENT_ID=$(cat "$SENTINEL" | tr -d \'[:space:]\')',
  '  if [ -n "$AGENT_ID" ]; then',
  '    if ! grep -q "Co-Authored-By: Agent Chat" "$1"; then',
  '      printf "\\nCo-Authored-By: Agent Chat (%s) <agent-chat@local>\\n" "$AGENT_ID" >> "$1"',
  '    fi',
  '  fi',
  'fi',
  '',
].join('\n');

export type HookManager = 'husky' | 'lefthook' | 'pre-commit' | 'simple-git-hooks';

export function detectHookManager(workspacePath: string): HookManager | null {
  if (fs.existsSync(path.join(workspacePath, '.husky'))) return 'husky';
  if (fs.existsSync(path.join(workspacePath, 'lefthook.yml'))) return 'lefthook';
  if (fs.existsSync(path.join(workspacePath, '.pre-commit-config.yaml'))) return 'pre-commit';
  const pkgPath = path.join(workspacePath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg && typeof pkg === 'object' && pkg['simple-git-hooks']) return 'simple-git-hooks';
    } catch {
      // ignore malformed package.json
    }
  }
  return null;
}

export type InstallResult =
  | { status: 'installed'; path: string }
  | { status: 'refused-no-git' }
  | { status: 'refused-existing' }
  | { status: 'refused-hook-manager'; manager: HookManager };

export function installCommitHook(workspacePath: string): InstallResult {
  if (!fs.existsSync(path.join(workspacePath, '.git'))) {
    return { status: 'refused-no-git' };
  }
  const manager = detectHookManager(workspacePath);
  if (manager) {
    return { status: 'refused-hook-manager', manager };
  }
  const hookDir = path.join(workspacePath, '.git', 'hooks');
  const hookPath = path.join(hookDir, 'prepare-commit-msg');

  if (fs.existsSync(hookPath)) {
    let existing = '';
    try {
      existing = fs.readFileSync(hookPath, 'utf8');
    } catch {
      return { status: 'refused-existing' };
    }
    if (!existing.includes('AGENT-CHAT-MANAGED')) {
      return { status: 'refused-existing' };
    }
  }

  try {
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(hookPath, COMMIT_HOOK_SNIPPET, { mode: 0o755 });
  } catch {
    return { status: 'refused-existing' };
  }
  return { status: 'installed', path: hookPath };
}

export type UninstallResult =
  | { status: 'removed' }
  | { status: 'refused-not-managed' }
  | { status: 'not-installed' };

export function uninstallCommitHook(workspacePath: string): UninstallResult {
  const hookPath = path.join(workspacePath, '.git', 'hooks', 'prepare-commit-msg');
  if (!fs.existsSync(hookPath)) return { status: 'not-installed' };
  let existing = '';
  try {
    existing = fs.readFileSync(hookPath, 'utf8');
  } catch {
    return { status: 'refused-not-managed' };
  }
  if (!existing.includes('AGENT-CHAT-MANAGED')) {
    return { status: 'refused-not-managed' };
  }
  try {
    fs.unlinkSync(hookPath);
  } catch {
    return { status: 'refused-not-managed' };
  }
  return { status: 'removed' };
}
```

Also extend the `vi.mock('node:fs', ...)` in `tests/commitHook.test.ts` to add `readFileSync`, `mkdirSync` if missing (the existing mock already has writeFileSync; add the others now if not present):

```ts
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
```

- [ ] **Step 4: Run; expect pass.**

```
npm test -- commitHook
```

Expected: all sentinel + install + uninstall + detect tests pass.

- [ ] **Step 5: Commit.**

```
git add src/commitHook.ts tests/commitHook.test.ts
git commit -m "$(printf 'feat(v2): commit hook install/uninstall + hook-manager detection\n\nInstaller writes a POSIX sh prepare-commit-msg hook tagged with\nAGENT-CHAT-MANAGED. Refuses overwriting user-authored hooks; refuses\nwhen husky/lefthook/pre-commit/simple-git-hooks detected. Uninstaller\nrespects the marker and refuses to remove user-authored hooks.\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

### Task 14: `package.json` settings + commands; `extension.ts` registers decoration provider + commands

**Files:**
- Modify: `package.json`
- Modify: `src/extension.ts`

- [ ] **Step 1: Add settings + commands to `package.json`.**

In `package.json`'s `contributes.configuration.properties`, add four entries (alongside the existing v1 ones):

```json
"agentChat.fileEmbedMaxLines": {
  "type": "number",
  "default": 500,
  "minimum": 1,
  "maximum": 10000,
  "description": "Maximum lines embedded per @file mention before truncating."
},
"agentChat.sharedContextWindow": {
  "type": "number",
  "default": 25,
  "minimum": 1,
  "maximum": 200,
  "description": "Number of recent user+agent messages included in cross-agent context."
},
"agentChat.fileBadges.enabled": {
  "type": "boolean",
  "default": true,
  "description": "Show colored dots in the file explorer for files recently edited by an agent."
},
"agentChat.commitSignature.enabled": {
  "type": "boolean",
  "default": true,
  "description": "Write the .vscode/agent-chat/active-dispatch sentinel during dispatches so the prepare-commit-msg hook can attribute commits."
}
```

In `contributes.commands`, add three:

```json
{ "command": "agentChat.installCommitHook", "title": "Agent Chat: Install commit hook" },
{ "command": "agentChat.uninstallCommitHook", "title": "Agent Chat: Uninstall commit hook" },
{ "command": "agentChat.showCommitHookSnippet", "title": "Agent Chat: Show commit hook snippet" }
```

In `contributes.colors`, add brand colors used by the decoration provider:

```json
{
  "id": "agentChat.claudeColor",
  "description": "Color used for Claude file decoration badges.",
  "defaults": { "dark": "#d97757", "light": "#d97757", "highContrast": "#d97757" }
},
{
  "id": "agentChat.codexColor",
  "description": "Color used for Codex file decoration badges.",
  "defaults": { "dark": "#10a37f", "light": "#10a37f", "highContrast": "#10a37f" }
},
{
  "id": "agentChat.geminiColor",
  "description": "Color used for Gemini file decoration badges.",
  "defaults": { "dark": "#4a8df0", "light": "#4a8df0", "highContrast": "#4a8df0" }
}
```

(If `contributes.colors` doesn't exist yet, add the array.)

- [ ] **Step 2: Update `src/extension.ts`.**

Replace the contents of `src/extension.ts` with:

```ts
import * as vscode from 'vscode';
import { ChatPanel } from './panel.js';
import { FileBadgesController } from './fileBadges.js';
import { installCommitHook, uninstallCommitHook, COMMIT_HOOK_SNIPPET, detectHookManager } from './commitHook.js';

export function activate(context: vscode.ExtensionContext): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  let badgeController: FileBadgesController | undefined;
  if (folder) {
    badgeController = new FileBadgesController(context);
    if (vscode.workspace.getConfiguration('agentChat').get<boolean>('fileBadges.enabled', true)) {
      context.subscriptions.push(
        vscode.window.registerFileDecorationProvider(badgeController),
      );
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('agentChat.openPanel', () =>
      ChatPanel.show(context, undefined, badgeController)),
    vscode.commands.registerCommand('agentChat.installCommitHook', async () => {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!ws) { vscode.window.showErrorMessage('Open a workspace folder first.'); return; }
      const result = installCommitHook(ws);
      if (result.status === 'installed') {
        vscode.window.showInformationMessage(`Installed Agent Chat commit hook at ${result.path}`);
      } else if (result.status === 'refused-hook-manager') {
        vscode.window.showWarningMessage(
          `Detected ${result.manager}. Add the Agent Chat trailer logic manually — run "Agent Chat: Show commit hook snippet" to copy it.`,
        );
      } else if (result.status === 'refused-existing') {
        vscode.window.showWarningMessage('A non-Agent-Chat prepare-commit-msg hook already exists; refusing to overwrite.');
      } else if (result.status === 'refused-no-git') {
        vscode.window.showErrorMessage('No .git directory at workspace root.');
      }
    }),
    vscode.commands.registerCommand('agentChat.uninstallCommitHook', async () => {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!ws) { vscode.window.showErrorMessage('Open a workspace folder first.'); return; }
      const result = uninstallCommitHook(ws);
      if (result.status === 'removed') {
        vscode.window.showInformationMessage('Removed Agent Chat commit hook.');
      } else if (result.status === 'refused-not-managed') {
        vscode.window.showWarningMessage('Existing prepare-commit-msg is not Agent-Chat-managed; refusing to remove.');
      } else {
        vscode.window.showInformationMessage('No Agent Chat commit hook installed.');
      }
    }),
    vscode.commands.registerCommand('agentChat.showCommitHookSnippet', async () => {
      const doc = await vscode.workspace.openTextDocument({
        content: COMMIT_HOOK_SNIPPET,
        language: 'shellscript',
      });
      await vscode.window.showTextDocument(doc);
    }),
  );
}

export function deactivate(): void {
  // no-op
}
```

- [ ] **Step 3: Build.**

```
npm run build
```

Expected: clean build.

- [ ] **Step 4: Commit.**

```
git add package.json src/extension.ts
git commit -m "$(printf 'feat(v2): register settings, commands, and decoration provider\n\nFour new agentChat.* settings, three commit-hook commands, three\nbrand color tokens, and the FileDecorationProvider registration.\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

### Task 15: Webview UI — composer chip, UserBubble attachment list, HealthStrip rules chip

**Files:**
- Modify: `src/webview/components/Composer.tsx`
- Modify: `src/webview/components/UserBubble.tsx`
- Modify: `src/webview/components/HealthStrip.tsx`
- Modify: `src/webview/styles.css`
- Modify: `src/webview/state.ts` — track an `agentchatMdPresent` flag forwarded from extension via init/file-edited (workspace setup detection)
- Modify: `src/shared/protocol.ts` — extend `init` and add `agentchat-md-changed` event

The simplest signal: include a `agentchatMdPresent: boolean` in the `init` event payload, and add a one-shot `agentchat-md-changed` event the panel posts when it detects a change.

- [ ] **Step 1: Extend protocol with rules-presence signal.**

Modify `src/shared/protocol.ts` `FromExtension`:

```ts
  | { kind: 'init'; session: Session; status: Record<AgentId, AgentStatus>; settings: Settings; agentchatMdPresent: boolean }
  | { kind: 'agentchat-md-changed'; present: boolean }
```

(Replace the existing `init` line and append the new variant.)

- [ ] **Step 2: Wire the signal in `src/panel.ts`.**

In the existing `initialize()` near where `init` is built, also include the boolean:

```ts
    const agentchatMdPresent = fs.existsSync(path.join(this.workspacePath, 'agentchat.md'));
    this.send({ kind: 'init', session, status, settings, agentchatMdPresent });
```

Add a `vscode.workspace.createFileSystemWatcher` for the rules file in `initialize()`:

```ts
    const rulesWatcher = vscode.workspace.createFileSystemWatcher('**/agentchat.md', false, true, false);
    const onRulesChange = () => {
      const present = fs.existsSync(path.join(this.workspacePath, 'agentchat.md'));
      this.send({ kind: 'agentchat-md-changed', present });
    };
    rulesWatcher.onDidCreate(onRulesChange);
    rulesWatcher.onDidDelete(onRulesChange);
    this.disposables.push(rulesWatcher);
```

- [ ] **Step 3: Update `Composer.tsx` to chip-highlight `@<path>` tokens.**

Replace the textarea + autocomplete rendering with a pre-rendered overlay so the chip shows. For v2.0 a minimal style suffices: the textarea is unchanged but a sibling preview line shows below the textarea listing detected `@path` tokens. Update `Composer.tsx`:

```tsx
import { h } from 'preact';
import { useState, useRef, useEffect, useMemo } from 'preact/hooks';
import type { AgentId, AgentStatus } from '../../types.js';
import type { FromWebview } from '../../shared/protocol.js';
import { HealthStrip } from './HealthStrip.js';
import { MentionAutocomplete, MENTION_ITEMS } from './MentionAutocomplete.js';

interface Props {
  send: (msg: FromWebview) => void;
  floorHolder: AgentId | null;
  status: Record<AgentId, AgentStatus>;
  agentchatMdPresent: boolean;
}

const AGENT_TOKENS = new Set(['@claude', '@gpt', '@codex', '@chatgpt', '@gemini', '@all']);

function detectFileMentions(text: string): string[] {
  const out: string[] = [];
  for (const t of text.split(/\s+/)) {
    if (!t.startsWith('@')) continue;
    if (AGENT_TOKENS.has(t.toLowerCase())) continue;
    const path = t.slice(1);
    if (path.includes('/') || path.includes('.')) out.push(path);
  }
  return out;
}

export function Composer({ send, floorHolder, status, agentchatMdPresent }: Props) {
  const [text, setText] = useState('');
  const [autocomplete, setAutocomplete] = useState<{ open: boolean; filter: string; activeIndex: number }>({
    open: false, filter: '', activeIndex: 0,
  });
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const lastToken = text.split(/\s+/).at(-1) ?? '';
    if (lastToken.startsWith('@') && lastToken.length >= 1 && !lastToken.includes('/') && !lastToken.includes('.')) {
      setAutocomplete((a) => ({ ...a, open: true, filter: lastToken, activeIndex: 0 }));
    } else if (autocomplete.open) {
      setAutocomplete((a) => ({ ...a, open: false }));
    }
  }, [text]);

  const filePaths = useMemo(() => detectFileMentions(text), [text]);

  const handleSend = () => {
    if (!text.trim()) return;
    send({ kind: 'send', text });
    setText('');
  };

  const pickMention = (token: string) => {
    const tokens = text.split(/\s+/);
    tokens.pop();
    tokens.push(token + ' ');
    setText(tokens.join(' '));
    setAutocomplete((a) => ({ ...a, open: false }));
    textareaRef.current?.focus();
  };

  const filtered = MENTION_ITEMS.filter((i) =>
    i.token.toLowerCase().includes(autocomplete.filter.toLowerCase())
  );

  const handleKeyDown = (e: KeyboardEvent) => {
    if (autocomplete.open && filtered.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setAutocomplete((a) => ({ ...a, activeIndex: (a.activeIndex + 1) % filtered.length })); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setAutocomplete((a) => ({ ...a, activeIndex: (a.activeIndex - 1 + filtered.length) % filtered.length })); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); pickMention(filtered[autocomplete.activeIndex].token); return; }
      if (e.key === 'Escape') { e.preventDefault(); setAutocomplete((a) => ({ ...a, open: false })); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isFloorHeld = floorHolder !== null;

  return (
    <div class="composer">
      {autocomplete.open && (
        <MentionAutocomplete filter={autocomplete.filter} activeIndex={autocomplete.activeIndex} onPick={pickMention} />
      )}
      <textarea
        ref={textareaRef}
        value={text}
        placeholder="Type @ to mention an agent or @path/to/file to attach…"
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={handleKeyDown}
      />
      {filePaths.length > 0 && (
        <div class="file-chip-row">
          {filePaths.map((p) => (
            <span class="file-chip" key={p}>📎 {p}</span>
          ))}
        </div>
      )}
      <div class="composer-row">
        <HealthStrip status={status} send={send} agentchatMdPresent={agentchatMdPresent} />
        <div style="flex:1" />
        {isFloorHeld && (
          <button class="cancel" onClick={() => send({ kind: 'cancel' })}>Cancel</button>
        )}
        <button onClick={handleSend} disabled={!text.trim()}>Send</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Update `UserBubble.tsx` to show attachments.**

Replace `src/webview/components/UserBubble.tsx`:

```tsx
import { h } from 'preact';
import type { UserMessage } from '../../shared/protocol.js';

export function UserBubble({ message }: { message: UserMessage }) {
  return (
    <div class="bubble user">
      <div>{message.text}</div>
      {message.attachedFiles && message.attachedFiles.length > 0 && (
        <div class="attached-files">
          {message.attachedFiles.map((f) => (
            <div class="attached-file" key={f.path}>
              📎 {f.path} ({f.lines} lines{f.truncated ? ', truncated' : ''})
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Update `HealthStrip.tsx` to show rules chip.**

Locate `src/webview/components/HealthStrip.tsx`. Add a rules chip alongside the existing pills. The chip is shown only when `agentchatMdPresent` is `true`. Add the prop and render:

```tsx
// Inside HealthStrip's props add:
//   agentchatMdPresent: boolean;
// And in the render, alongside the pills:

{agentchatMdPresent && (
  <span
    class="health-pill rules"
    title="agentchat.md present — rules pinned to all agent prompts"
    onClick={() => send({ kind: 'open-external', url: 'agentchat.md' })}
  >
    📋 rules
  </span>
)}
```

(`open-external` already exists in the v1 protocol; the panel handles it. For local files we may want a separate `open-file` event — for v2.0 it's enough to no-op or open via `vscode://file/...` URI.)

If a separate event is needed, add to `FromWebview`:
```ts
| { kind: 'open-workspace-file'; relativePath: string }
```
And in `panel.ts`:
```ts
      case 'open-workspace-file': {
        const fileUri = vscode.Uri.file(path.join(this.workspacePath, msg.relativePath));
        await vscode.window.showTextDocument(fileUri);
        break;
      }
```

Use `open-workspace-file` in HealthStrip:
```tsx
onClick={() => send({ kind: 'open-workspace-file', relativePath: 'agentchat.md' })}
```

- [ ] **Step 6: Add CSS for the new elements.**

Append to `src/webview/styles.css`:

```css
.file-chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 4px 0 0 0;
}
.file-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  font-size: 11px;
  font-family: var(--vscode-editor-font-family, monospace);
  background: rgba(255,255,255,0.05);
  border: 1px solid var(--border);
  border-radius: 4px;
  opacity: 0.85;
}
.attached-files {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 11px;
  opacity: 0.7;
  font-family: var(--vscode-editor-font-family, monospace);
}
.health-pill.rules {
  cursor: pointer;
  color: #ffce85;
  border-color: rgba(255, 184, 74, 0.45);
}
```

- [ ] **Step 7: Wire the new prop through the webview state.**

Locate `src/webview/state.ts`. The reducer takes `FromExtension` events. Add handling for the new `init` field and for `agentchat-md-changed`. The state shape gains `agentchatMdPresent: boolean`. Update its initial value, the `init` handler, and the new event handler. Update consumers (`App.tsx` or wherever `Composer` is rendered) to pass `agentchatMdPresent` down.

- [ ] **Step 8: Build and run tests; expect green.**

```
npm run build
npm test
```

- [ ] **Step 9: Commit.**

```
git add src/webview/components/Composer.tsx src/webview/components/UserBubble.tsx src/webview/components/HealthStrip.tsx src/webview/styles.css src/webview/state.ts src/shared/protocol.ts src/panel.ts
git commit -m "$(printf 'feat(v2): webview UI for @file chips, attachments, rules indicator\n\nComposer detects @path tokens and chip-renders them. UserBubble\nshows the attached file list under the message text. HealthStrip\ngains a clickable rules chip when agentchat.md is present, opening\nthe file in the editor.\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

### Task 16: Bootstrap nudges — `agentchat.md` tip + commit hook install dialog

**Files:**
- Modify: `src/panel.ts`

The existing gitignore prompt pattern (in `maybeShowGitignorePrompt`) is the template. Add two parallel methods.

- [ ] **Step 1: Add `maybeShowAgentchatMdTip`.**

In `src/panel.ts`, append:

```ts
  private async maybeShowAgentchatMdTip(): Promise<void> {
    const stateKey = 'agentChat.agentchatMdTipShown';
    if (this.context.workspaceState.get(stateKey)) return;
    if (fs.existsSync(path.join(this.workspacePath, 'agentchat.md'))) return;

    const choice = await vscode.window.showInformationMessage(
      'Tip: create agentchat.md at the workspace root to pin per-project instructions for all agents.',
      'Create now',
      "Don't show again",
    );
    if (choice === 'Create now') {
      const filePath = path.join(this.workspacePath, 'agentchat.md');
      const seed = '# agentchat.md\n\nWorkspace rules pinned to all agent prompts. Free-form Markdown.\n';
      fs.writeFileSync(filePath, seed, 'utf8');
      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc);
      await this.context.workspaceState.update(stateKey, true);
    } else if (choice === "Don't show again") {
      await this.context.workspaceState.update(stateKey, true);
    }
  }
```

- [ ] **Step 2: Add `maybeShowCommitHookPrompt`.**

```ts
  private async maybeShowCommitHookPrompt(): Promise<void> {
    const stateKey = 'agentChat.commitHookPromptDismissed';
    if (this.context.workspaceState.get(stateKey)) return;
    if (!fs.existsSync(path.join(this.workspacePath, '.git'))) return;

    const choice = await vscode.window.showInformationMessage(
      'Install commit hook to tag commits made by agents? Adds .git/hooks/prepare-commit-msg. Removable via "Agent Chat: Uninstall commit hook".',
      'Install',
      'Not now',
      "Don't ask again",
    );
    if (choice === 'Install') {
      await vscode.commands.executeCommand('agentChat.installCommitHook');
      await this.context.workspaceState.update(stateKey, true);
    } else if (choice === "Don't ask again") {
      await this.context.workspaceState.update(stateKey, true);
    }
  }
```

- [ ] **Step 3: Call both from `dispatchUserMessage` after the gitignore prompt.**

Replace the existing call:

```ts
    if (this.store.isFirstSession()) {
      await this.maybeShowGitignorePrompt(this.workspacePath);
      await this.maybeShowAgentchatMdTip();
      await this.maybeShowCommitHookPrompt();
    }
```

- [ ] **Step 4: Build + run all tests.**

```
npm run build
npm test
```

Expected: clean.

- [ ] **Step 5: Commit.**

```
git add src/panel.ts
git commit -m "$(printf 'feat(v2): one-shot bootstrap prompts for agentchat.md + commit hook\n\nAfter the existing gitignore prompt fires on first session, also\nask whether to seed an agentchat.md and whether to install the\ncommit-attribution hook. Both dismissible; both honor Dont ask\nagain via workspace state.\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

### Task 17: Integration snapshot test for the full prompt pipeline

**Files:**
- Create: `tests/integration/prompt-composition.test.ts`

This test feeds a realistic session through the panel pipeline (sharedContext + workspaceRules + embedFiles + composePrompt) and snapshot-matches the assembled prompt. It catches regressions if any block reorders, any header changes, or any included/excluded type changes.

- [ ] **Step 1: Write the test.**

Create `tests/integration/prompt-composition.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSharedContext } from '../../src/sharedContext.js';
import { readWorkspaceRules } from '../../src/workspaceRules.js';
import { embedFiles, parseFileMentions } from '../../src/fileMentions.js';
import { composePrompt } from '../../src/composePrompt.js';
import type { Session } from '../../src/shared/protocol.js';

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

describe('integration: full prompt composition', () => {
  it('produces the expected prompt for rules + 3-turn history + @file mention', () => {
    fsState.set('/fake/ws/agentchat.md', 'Always use pnpm.\n');
    fsState.set('/fake/ws/src/auth.ts', 'export const greet = () => "hi";\n');

    const session: Session = {
      version: 1,
      messages: [
        { id: 'u1', role: 'user', text: 'How do we handle auth?', timestamp: 100 },
        {
          id: 'a1', role: 'agent', agentId: 'claude', text: 'Use OAuth2 with PKCE.',
          toolEvents: [], timestamp: 200, status: 'complete',
        },
        { id: 'u2', role: 'user', text: '@gpt implement the route handlers', timestamp: 300 },
      ],
    };

    const userInput = '@gpt review @src/auth.ts please';
    const { filePaths, remainingText } = parseFileMentions(userInput);
    const embed = embedFiles(filePaths, '/fake/ws', { maxLines: 500 });
    const sharedCtx = buildSharedContext(session, { window: 25 });
    const rules = readWorkspaceRules('/fake/ws');

    const prompt = composePrompt({
      rules,
      sharedContext: sharedCtx,
      fileBlocks: embed.embedded,
      userText: remainingText,
    });

    expect(prompt).toMatchInlineSnapshot(`
"[Workspace rules from agentchat.md]
Always use pnpm.
[/Workspace rules]

[Conversation so far]
user: How do we handle auth?
claude: Use OAuth2 with PKCE.
user: @gpt implement the route handlers
[/Conversation so far]

[File: src/auth.ts]
\`\`\`ts
export const greet = () => \\"hi\\";

\`\`\`
[/File]

@gpt review please"
    `);
  });
});
```

- [ ] **Step 2: Run; expect snapshot to match (since this is a new snapshot, vitest writes it).**

```
npm test -- prompt-composition
```

Expected: 1 pass; the snapshot is captured. Verify the captured snapshot is what you actually want — re-read the test file post-run and confirm.

- [ ] **Step 3: Commit.**

```
git add tests/integration/prompt-composition.test.ts
git commit -m "$(printf 'test(v2): integration snapshot for full prompt pipeline\n\nAsserts rules + shared transcript + file embed + user text\nassemble in the documented order with the documented headers.\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

### Task 18: Manual smoke pass + final review

This task is performed by a human (or under human supervision). It runs through the success criteria from the spec and either passes or reports failures back into the loop.

**Setup:**
- Open Agent Chat in a fresh test workspace (e.g., a small repo created for this purpose).
- Confirm Claude / Codex / Gemini all show "ready" in the health strip.

- [ ] **Smoke 1: Empty session, single @claude.**

Send `@claude hi`. Inspect the prompt sent to Claude (via a temporary `console.error('CLAUDE PROMPT:', prompt)` in `src/agents/claude.ts` — remove after smoke). Expected: prompt is exactly `hi` with no preamble.

- [ ] **Smoke 2: Cross-agent visibility on follow-up.**

Send `@claude what's the time complexity of binary search?` Wait for reply.
Send `@gpt did you see what claude said? summarize it`.
Inspect Codex's prompt: should contain `claude: ...` (Claude's reply) and `user: did you see what claude said? summarize it`.

- [ ] **Smoke 3: @all sequential context build-up.**

Send `@all draft a one-sentence pitch for an AI chat tool`.
Verify each subsequent agent's prompt contains the prior agents' replies.

- [ ] **Smoke 4: agentchat.md live edit.**

Create `agentchat.md` with `Always use pnpm, never npm.` Send `@codex how would I install lodash?`. Codex should suggest pnpm.
Edit `agentchat.md` to `Always use bun, never npm or pnpm.` Send `@codex how do I install lodash now?`. Codex should suggest bun (live-update without panel reload).

- [ ] **Smoke 5: @file mention small.**

Create `src/foo.ts` with 10 lines. Send `@claude review @src/foo.ts`. Verify:
1. Claude's prompt contains `[File: src/foo.ts]` block with the file content.
2. The user bubble shows `📎 src/foo.ts (10 lines)`.

- [ ] **Smoke 6: @file mention truncated.**

Create `src/big.ts` with 600 lines. Send `@claude review @src/big.ts`.
Verify Claude's prompt has the truncation marker (`first 500 of 600 lines`) and Claude's reply may use the Read tool for the rest.

- [ ] **Smoke 7: Badge after agent edit.**

Send `@codex add a comment to the top of src/foo.ts`.
After completion, verify `src/foo.ts` shows a green dot in the file explorer; hover shows `Edited by codex Xm ago`.

- [ ] **Smoke 8: Commit hook install on husky workspace.**

In a test workspace with `.husky/`, run `Agent Chat: Install commit hook`. Expect a warning dialog about the hook manager.

- [ ] **Smoke 9: Commit hook install on clean repo + agent commit.**

In a clean test repo, run `Agent Chat: Install commit hook`. Expect success.
Send `@codex commit a tiny change` (or perform a commit during a dispatch manually).
Run `git log -1`. Expect `Co-Authored-By: Agent Chat (codex) <agent-chat@local>` trailer.
Run `Agent Chat: Uninstall commit hook`. Expect success; `.git/hooks/prepare-commit-msg` removed.

- [ ] **Smoke 10: commitSignature.enabled = false.**

Set `agentChat.commitSignature.enabled` to `false`. Confirm `.vscode/agent-chat/active-dispatch` is not created during a dispatch (check the file system during the dispatch). Manually run `git commit --allow-empty -m "test"` during the dispatch — verify no trailer is added.

- [ ] **Final review.**

After all smoke tests pass, dispatch the `code-review` skill (if available) on the v2 commit range:

```
git log --oneline main..HEAD
```

Or run the existing `/review` slash command.

- [ ] **Tag the release.**

```
git tag v2.0.0
git log --oneline v1.0.0..v2.0.0  # sanity check the diff
```

(Tagging is optional; user decides.)

---

## Self-review checklist (controller / planner only)

Before marking the plan complete:

- [ ] Spec coverage: every "In scope" bullet from the spec maps to one or more tasks above.
- [ ] No placeholders: search the plan for "TBD", "TODO", "implement later", "similar to" — none present.
- [ ] Type consistency: `FileEditRecord`, `AttachedFile`, `EmbedResult`, `SentinelWriter`, `FileBadgesController`, `composePrompt`, `buildSharedContext`, `readWorkspaceRules`, `parseFileMentions`, `embedFiles`, `getEditedPath` are referenced by the same name across all tasks.
- [ ] Settings: all four (`fileEmbedMaxLines`, `sharedContextWindow`, `fileBadges.enabled`, `commitSignature.enabled`) appear in `package.json` (Task 14) and are read by their consumers (Tasks 8, 12).
- [ ] Commands: all three (`installCommitHook`, `uninstallCommitHook`, `showCommitHookSnippet`) registered in `extension.ts` (Task 14) match the `package.json` entries.
- [ ] Protocol: `attachedFiles?` on `UserMessage` (Task 1) is consumed by `UserBubble` (Task 15) and produced in `dispatchUserMessage` (Task 8); `file-edited` event (Task 1) is produced in panel (Task 11).
