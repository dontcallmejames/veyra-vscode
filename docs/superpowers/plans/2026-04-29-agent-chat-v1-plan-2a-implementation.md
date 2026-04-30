# Agent Chat v1 — Plan 2a: UI & Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the usable VSCode UI on top of Plan 1's headless library — a Preact webview chat panel, per-workspace persistence, real `Agent.status()` checks, and basic error/health surfaces. Driven by `@mention` only (facilitator is Plan 2b).

**Architecture:** Three-layer addition to existing code: (1) a Preact app bundled separately to `dist/webview.js`, (2) a `ChatPanel` extension-host bridge owning the webview lifecycle and postMessage protocol both directions, (3) small additions to the existing headless foundation — `MessageRouter.onFloorChange` / `onStatusChange`, real `Agent.status()` impls, `parseMentions` empty-input guard. Persistence uses per-workspace JSON with debounced atomic writes.

**Tech Stack:**
- TypeScript 5.x (strict)
- Preact 10.x (webview UI)
- esbuild (bundles both `extension.ts` and `webview/main.tsx`)
- vitest (unit tests; new `webviewState.test.ts`, `panel.test.ts`, `sessionStore.test.ts`, `statusChecks.test.ts`)
- VSCode Webview API (`WebviewPanel`, postMessage)

**Spec reference:** `docs/superpowers/specs/2026-04-29-agent-chat-v1-plan-2a-design.md`. Plan 1 foundation: `docs/superpowers/plans/2026-04-29-agent-chat-v1-plan-1-foundation.md`. v1 spec: `docs/superpowers/specs/2026-04-29-agent-chat-vscode-v1-design.md`.

---

## File structure produced by this plan

```
src/
├── extension.ts                        # MODIFIED: register agentChat.openPanel command
├── panel.ts                            # NEW: ChatPanel class (webview lifecycle + postMessage)
├── sessionStore.ts                     # NEW: per-workspace JSON load/save
├── statusChecks.ts                     # NEW: real Agent.status() implementations
├── ulid.ts                             # NEW: small inline ULID helper
├── shared/
│   └── protocol.ts                     # NEW: FromExtension / FromWebview / Session / etc.
├── messageRouter.ts                    # MODIFIED: onFloorChange + onStatusChange + initial routing-needed logic
├── mentions.ts                         # MODIFIED: empty-input guard
├── agents/                             # MODIFIED: status() impls call statusChecks.ts
│   ├── claude.ts
│   ├── codex.ts
│   └── gemini.ts
└── webview/                            # NEW (entire directory)
    ├── index.html
    ├── main.tsx
    ├── App.tsx
    ├── state.ts                        # pure reducer (testable)
    ├── styles.css
    └── components/
        ├── MessageList.tsx
        ├── UserBubble.tsx
        ├── AgentBubble.tsx
        ├── ToolCallCard.tsx
        ├── SystemNotice.tsx
        ├── Composer.tsx
        ├── MentionAutocomplete.tsx
        ├── FloorIndicator.tsx
        └── HealthStrip.tsx

tests/
├── sessionStore.test.ts                # NEW
├── statusChecks.test.ts                # NEW
├── panel.test.ts                       # NEW
├── webviewState.test.ts                # NEW
├── mentions.test.ts                    # MODIFIED: +empty/whitespace tests
└── messageRouter.test.ts               # MODIFIED: +floor-change + status-change tests
```

---

## Phase A — Plan 1 deferred items

### Task A1: parseMentions empty-input guard

**Files:**
- Modify: `src/mentions.ts`
- Modify: `tests/mentions.test.ts`

- [ ] **Step 1: Add failing tests**

Open `tests/mentions.test.ts` and add two tests inside the existing `describe('parseMentions', ...)`:

```typescript
  it('handles empty string', () => {
    expect(parseMentions('')).toEqual({
      targets: [],
      remainingText: '',
    });
  });

  it('handles whitespace-only input', () => {
    expect(parseMentions('   \n  ')).toEqual({
      targets: [],
      remainingText: '',
    });
  });
```

- [ ] **Step 2: Run tests; expect 2 failures**

Run: `npm test -- tests/mentions.test.ts`

Expected: 10 prior tests pass; 2 new tests may already pass (the existing impl coincidentally handles empty by hitting the `!token.startsWith('@')` early break) OR fail. Verify behavior; if both already pass, the guard is implicit but the tests serve as regression — leave them and proceed to Step 5 (no impl change needed). If either fails, continue to Step 3.

- [ ] **Step 3: Add explicit guard in `src/mentions.ts`**

In `parseMentions`, at the very top:

```typescript
export function parseMentions(input: string): ParsedMentions {
  const trimmed = input.trim();
  if (trimmed === '') {
    return { targets: [], remainingText: '' };
  }
  const tokens = input.split(/\s+/);
  // ... rest unchanged
```

- [ ] **Step 4: Run tests; expect all 12 to pass**

Run: `npm test -- tests/mentions.test.ts`
Expected: 12/12.

- [ ] **Step 5: Commit**

```bash
git add tests/mentions.test.ts src/mentions.ts
git commit -m "feat(mentions): explicit empty/whitespace input guard"
```

---

### Task A2: MessageRouter floor-change + status-change subscriptions

The webview's `FloorIndicator` and `HealthStrip` need to subscribe to changes. The router currently exposes neither. Add both, plus refactor the constructor signature minimally so we can pass the agents and not break Plan 1's tests.

**Files:**
- Modify: `src/messageRouter.ts`
- Modify: `tests/messageRouter.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tests/messageRouter.test.ts` inside the existing `describe`:

```typescript
  it('onFloorChange fires for single-agent dispatch', async () => {
    const claude = fakeAgent('claude', [
      { type: 'text', text: 'hi' },
      { type: 'done' },
    ]);
    const codex = fakeAgent('codex', []);
    const gemini = fakeAgent('gemini', []);
    const router = new MessageRouter({ claude, codex, gemini });

    const events: (AgentId | null)[] = [];
    router.onFloorChange((h) => events.push(h));

    for await (const _ of router.handle('@claude hi')) { /* drain */ }

    expect(events).toEqual(['claude', null]);
  });

  it('onFloorChange fires once per agent during @all dispatch', async () => {
    const claude = fakeAgent('claude', [{ type: 'done' }]);
    const codex = fakeAgent('codex', [{ type: 'done' }]);
    const gemini = fakeAgent('gemini', [{ type: 'done' }]);
    const router = new MessageRouter({ claude, codex, gemini });

    const events: (AgentId | null)[] = [];
    router.onFloorChange((h) => events.push(h));

    for await (const _ of router.handle('@all hi')) { /* drain */ }

    expect(events).toEqual([
      'claude', null,
      'codex', null,
      'gemini', null,
    ]);
  });

  it('onStatusChange fires when an agents status check returns a new value', async () => {
    const claude = fakeAgent('claude', []);
    const codex = fakeAgent('codex', []);
    const gemini = fakeAgent('gemini', []);
    const router = new MessageRouter({ claude, codex, gemini });

    const events: { agentId: AgentId; status: string }[] = [];
    router.onStatusChange((agentId, status) => events.push({ agentId, status }));

    router.notifyStatusChange('codex', 'unauthenticated');
    router.notifyStatusChange('codex', 'unauthenticated'); // duplicate, should not fire

    expect(events).toEqual([
      { agentId: 'codex', status: 'unauthenticated' },
    ]);
  });
```

- [ ] **Step 2: Run tests; expect failures**

Run: `npm test -- tests/messageRouter.test.ts`
Expected: 4 prior tests pass, 3 new tests fail (`onFloorChange`/`onStatusChange`/`notifyStatusChange` not defined).

- [ ] **Step 3: Update `src/messageRouter.ts`**

```typescript
import { parseMentions } from './mentions.js';
import { FloorManager } from './floor.js';
import type { Agent } from './agents/types.js';
import type { AgentChunk, AgentId, AgentStatus } from './types.js';

export interface AgentRegistry {
  claude: Agent;
  codex: Agent;
  gemini: Agent;
}

export type RouterEvent =
  | { kind: 'dispatch-start'; agentId: AgentId }
  | { kind: 'chunk'; agentId: AgentId; chunk: AgentChunk }
  | { kind: 'dispatch-end'; agentId: AgentId }
  | { kind: 'routing-needed'; text: string };

type FloorListener = (holder: AgentId | null) => void;
type StatusListener = (agentId: AgentId, status: AgentStatus) => void;

export class MessageRouter {
  private floor = new FloorManager();
  private floorListeners = new Set<FloorListener>();
  private statusListeners = new Set<StatusListener>();
  private lastStatus: Partial<Record<AgentId, AgentStatus>> = {};

  constructor(private agents: AgentRegistry) {
    this.floor.onChange((holder) => {
      for (const l of this.floorListeners) l(holder);
    });
  }

  onFloorChange(listener: FloorListener): () => void {
    this.floorListeners.add(listener);
    return () => this.floorListeners.delete(listener);
  }

  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Called externally (by ChatPanel after running statusChecks) to broadcast a change. */
  notifyStatusChange(agentId: AgentId, status: AgentStatus): void {
    if (this.lastStatus[agentId] === status) return;
    this.lastStatus[agentId] = status;
    for (const l of this.statusListeners) l(agentId, status);
  }

  async *handle(input: string): AsyncIterable<RouterEvent> {
    const { targets, remainingText } = parseMentions(input);

    if (targets.length === 0) {
      yield { kind: 'routing-needed', text: remainingText || input };
      return;
    }

    for (const targetId of targets) {
      const handle = await this.floor.acquire(targetId);
      try {
        yield { kind: 'dispatch-start', agentId: targetId };
        const agent = this.agents[targetId];
        try {
          for await (const chunk of agent.send(remainingText)) {
            yield { kind: 'chunk', agentId: targetId, chunk };
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          yield { kind: 'chunk', agentId: targetId, chunk: { type: 'error', message } };
          yield { kind: 'chunk', agentId: targetId, chunk: { type: 'done' } };
        }
        yield { kind: 'dispatch-end', agentId: targetId };
      } finally {
        handle.release();
      }
    }
  }
}
```

The router was already using `FloorManager.onChange` indirectly; this surfaces it through a stable `onFloorChange` API and adds `onStatusChange` + `notifyStatusChange` for the HealthStrip.

- [ ] **Step 4: Run tests; expect all to pass**

Run: `npm test -- tests/messageRouter.test.ts`
Expected: 7/7.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: all prior tests still pass plus the 5 new ones (mentions +2, router +3) = 35/35.

- [ ] **Step 6: Commit**

```bash
git add src/messageRouter.ts tests/messageRouter.test.ts
git commit -m "feat(router): add onFloorChange + onStatusChange subscriptions"
```

---

## Phase B — Status checks

### Task B1: statusChecks module

**Files:**
- Create: `src/statusChecks.ts`
- Create: `tests/statusChecks.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/statusChecks.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkClaude, checkCodex, checkGemini, clearStatusCache } from '../src/statusChecks.js';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
const mockedExistsSync = existsSync as unknown as ReturnType<typeof vi.fn>;
const mockedExecSync = execSync as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearStatusCache();
  mockedExistsSync.mockReset();
  mockedExecSync.mockReset();
});

describe('checkClaude', () => {
  it('returns ready when credentials exist', async () => {
    mockedExistsSync.mockReturnValue(true);
    expect(await checkClaude()).toBe('ready');
  });

  it('returns unauthenticated when credentials missing', async () => {
    mockedExistsSync.mockReturnValue(false);
    expect(await checkClaude()).toBe('unauthenticated');
  });
});

describe('checkCodex', () => {
  it('returns not-installed when bundle path resolution throws', async () => {
    mockedExecSync.mockImplementation(() => { throw new Error('npm not found'); });
    // Override platform to win32 for this test path
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(await checkCodex()).toBe('not-installed');
    } finally {
      Object.defineProperty(process, 'platform', { value: orig });
    }
  });

  it('returns unauthenticated when bundle exists but auth.json missing', async () => {
    mockedExecSync.mockReturnValue('/fake/npm/root\n');
    // existsSync is called twice: once for bundle, once for auth file
    mockedExistsSync.mockImplementation((p: any) =>
      String(p).includes('codex.js') ? true : false
    );
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    expect(await checkCodex()).toBe('unauthenticated');
  });

  it('returns ready when both bundle and auth exist', async () => {
    mockedExecSync.mockReturnValue('/fake/npm/root\n');
    mockedExistsSync.mockReturnValue(true);
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    expect(await checkCodex()).toBe('ready');
  });
});

describe('checkGemini', () => {
  it('returns ready when bundle and oauth_creds exist', async () => {
    mockedExecSync.mockReturnValue('/fake/npm/root\n');
    mockedExistsSync.mockReturnValue(true);
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    expect(await checkGemini()).toBe('ready');
  });

  it('returns unauthenticated when oauth_creds missing', async () => {
    mockedExecSync.mockReturnValue('/fake/npm/root\n');
    mockedExistsSync.mockImplementation((p: any) =>
      String(p).includes('gemini.js') ? true : false
    );
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    expect(await checkGemini()).toBe('unauthenticated');
  });
});

describe('cache', () => {
  it('returns the cached value within 30 seconds', async () => {
    mockedExistsSync.mockReturnValue(true);
    await checkClaude();
    mockedExistsSync.mockReturnValue(false);
    expect(await checkClaude()).toBe('ready'); // cached, didn't re-check
  });

  it('clearStatusCache forces re-check', async () => {
    mockedExistsSync.mockReturnValue(true);
    await checkClaude();
    mockedExistsSync.mockReturnValue(false);
    clearStatusCache();
    expect(await checkClaude()).toBe('unauthenticated');
  });
});
```

- [ ] **Step 2: Run tests; expect failures**

Run: `npm test -- tests/statusChecks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/statusChecks.ts
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentId, AgentStatus } from './types.js';

const CACHE_TTL_MS = 30_000;
const cache = new Map<AgentId, { status: AgentStatus; expiresAt: number }>();

export function clearStatusCache(): void {
  cache.clear();
}

async function memoize(agentId: AgentId, check: () => Promise<AgentStatus>): Promise<AgentStatus> {
  const entry = cache.get(agentId);
  const now = Date.now();
  if (entry && entry.expiresAt > now) return entry.status;
  const status = await check();
  cache.set(agentId, { status, expiresAt: now + CACHE_TTL_MS });
  return status;
}

export async function checkClaude(): Promise<AgentStatus> {
  return memoize('claude', async () => {
    const credPath = join(homedir(), '.claude', '.credentials.json');
    if (!existsSync(credPath)) return 'unauthenticated';
    return 'ready';
  });
}

export async function checkCodex(): Promise<AgentStatus> {
  return memoize('codex', async () => {
    const bundle = resolveCodexBundle();
    if (bundle === null) return 'not-installed';
    if (bundle && !existsSync(bundle)) return 'not-installed';
    const authPath = join(homedir(), '.codex', 'auth.json');
    if (!existsSync(authPath)) return 'unauthenticated';
    return 'ready';
  });
}

export async function checkGemini(): Promise<AgentStatus> {
  return memoize('gemini', async () => {
    const bundle = resolveGeminiBundle();
    if (bundle === null) return 'not-installed';
    if (bundle && !existsSync(bundle)) return 'not-installed';
    const authPath = join(homedir(), '.gemini', 'oauth_creds.json');
    if (!existsSync(authPath)) return 'unauthenticated';
    return 'ready';
  });
}

function resolveCodexBundle(): string | null {
  if (process.platform !== 'win32') {
    // POSIX: assume on PATH; install check is whether spawn would succeed.
    // Cheap proxy: if `which codex` is on PATH, treat as installed.
    try {
      execSync('which codex', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return ''; // installed; no bundle path needed
    } catch {
      return null;
    }
  }
  try {
    const npmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return join(npmRoot, '@openai', 'codex', 'bin', 'codex.js');
  } catch {
    return null;
  }
}

function resolveGeminiBundle(): string | null {
  if (process.platform !== 'win32') {
    try {
      execSync('which gemini', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return '';
    } catch {
      return null;
    }
  }
  try {
    const npmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return join(npmRoot, '@google', 'gemini-cli', 'bundle', 'gemini.js');
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests; expect 8/8 pass**

Run: `npm test -- tests/statusChecks.test.ts`
Expected: 8/8.

- [ ] **Step 5: Commit**

```bash
git add src/statusChecks.ts tests/statusChecks.test.ts
git commit -m "feat(statusChecks): real Agent.status() implementations with 30s cache"
```

---

### Task B2: Wire status checks into agent adapters

Replace each adapter's `async status() { return 'ready' }` with a call to the appropriate function from `statusChecks.ts`.

**Files:**
- Modify: `src/agents/claude.ts`
- Modify: `src/agents/codex.ts`
- Modify: `src/agents/gemini.ts`

- [ ] **Step 1: Update each adapter**

In `src/agents/claude.ts`:
```typescript
import { checkClaude } from '../statusChecks.js';
// ...
  async status(): Promise<AgentStatus> {
    return checkClaude();
  }
```

In `src/agents/codex.ts`:
```typescript
import { checkCodex } from '../statusChecks.js';
// ...
  async status(): Promise<AgentStatus> {
    return checkCodex();
  }
```

In `src/agents/gemini.ts`:
```typescript
import { checkGemini } from '../statusChecks.js';
// ...
  async status(): Promise<AgentStatus> {
    return checkGemini();
  }
```

- [ ] **Step 2: Verify typecheck and tests still pass**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass. The existing adapter tests don't exercise `status()` so no regressions.

- [ ] **Step 3: Commit**

```bash
git add src/agents/claude.ts src/agents/codex.ts src/agents/gemini.ts
git commit -m "feat(agents): wire status() to real statusChecks implementations"
```

---

## Phase C — Persistence

### Task C1: Shared protocol types + ULID helper

**Files:**
- Create: `src/shared/protocol.ts`
- Create: `src/ulid.ts`

- [ ] **Step 1: Write `src/ulid.ts`**

```typescript
// Tiny ULID-like ID generator — sortable by creation time, no external dep.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(): string {
  const time = Date.now();
  let timeStr = '';
  let t = time;
  for (let i = 0; i < 10; i++) {
    timeStr = ALPHABET[t & 31] + timeStr;
    t = Math.floor(t / 32);
  }
  let randStr = '';
  for (let i = 0; i < 16; i++) {
    randStr += ALPHABET[Math.floor(Math.random() * 32)];
  }
  return timeStr + randStr;
}
```

- [ ] **Step 2: Write `src/shared/protocol.ts`**

```typescript
import type { AgentChunk, AgentId, AgentStatus } from '../types.js';

// === Persisted message types ===

export type ToolEvent =
  | { kind: 'call'; name: string; input: unknown; timestamp: number }
  | { kind: 'result'; name: string; output: unknown; timestamp: number };

export type UserMessage = {
  id: string;
  role: 'user';
  text: string;
  timestamp: number;
  mentions?: AgentId[];
};

export type AgentMessage = {
  id: string;
  role: 'agent';
  agentId: AgentId;
  text: string;
  toolEvents: ToolEvent[];
  timestamp: number;
  status: 'complete' | 'cancelled' | 'errored';
  error?: string;
};

export type SystemMessage = {
  id: string;
  role: 'system';
  kind: 'routing-needed' | 'error';
  text: string;
  timestamp: number;
};

export type SessionMessage = UserMessage | AgentMessage | SystemMessage;

export type Session = {
  version: 1;
  messages: SessionMessage[];
};

// === Webview-only in-progress shape (not persisted) ===

export type InProgressMessage = {
  id: string;
  role: 'agent';
  agentId: AgentId;
  text: string;
  toolEvents: ToolEvent[];
  timestamp: number;
};

// === Settings ===

export type Settings = {
  toolCallRenderStyle: 'verbose' | 'compact' | 'hidden';
};

export const DEFAULT_SETTINGS: Settings = {
  toolCallRenderStyle: 'compact',
};

// === postMessage protocol ===

export type FromExtension =
  | { kind: 'init'; session: Session; status: Record<AgentId, AgentStatus>; settings: Settings }
  | { kind: 'message-started'; id: string; agentId: AgentId; timestamp: number }
  | { kind: 'message-chunk'; id: string; chunk: AgentChunk }
  | { kind: 'message-finalized'; message: AgentMessage }
  | { kind: 'system-message'; message: SystemMessage }
  | { kind: 'floor-changed'; holder: AgentId | null }
  | { kind: 'status-changed'; agentId: AgentId; status: AgentStatus }
  | { kind: 'settings-changed'; settings: Settings };

export type FromWebview =
  | { kind: 'send'; text: string }
  | { kind: 'cancel' }
  | { kind: 'reload-status' }
  | { kind: 'open-external'; url: string };
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/shared/protocol.ts src/ulid.ts
git commit -m "feat: define shared protocol types + ULID helper"
```

---

### Task C2: SessionStore

**Files:**
- Create: `src/sessionStore.ts`
- Create: `tests/sessionStore.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/sessionStore.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionStore } from '../src/sessionStore.js';
import type { Session, UserMessage } from '../src/shared/protocol.js';

const fsState = new Map<string, string>();

vi.mock('node:fs', () => ({
  existsSync: (p: string) => fsState.has(String(p)),
  readFileSync: (p: string) => {
    const v = fsState.get(String(p));
    if (v === undefined) throw new Error('ENOENT');
    return v;
  },
  promises: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn(async (p: string, content: string) => fsState.set(String(p), content)),
    rename: vi.fn(async (from: string, to: string) => {
      const v = fsState.get(String(from));
      if (v !== undefined) {
        fsState.set(String(to), v);
        fsState.delete(String(from));
      }
    }),
  },
}));

beforeEach(() => {
  fsState.clear();
  vi.useFakeTimers();
});

const FOLDER = '/fake/workspace';
const FILE = '/fake/workspace/.vscode/agent-chat/sessions.json';

const sampleUser: UserMessage = {
  id: 'u1',
  role: 'user',
  text: 'hello',
  timestamp: 1000,
};

describe('SessionStore', () => {
  it('returns an empty session when file does not exist', async () => {
    const store = new SessionStore(FOLDER);
    const session = await store.load();
    expect(session).toEqual({ version: 1, messages: [] });
  });

  it('appendUser schedules a debounced write', async () => {
    const store = new SessionStore(FOLDER);
    await store.load();
    store.appendUser(sampleUser);
    expect(fsState.has(FILE)).toBe(false);
    vi.advanceTimersByTime(200);
    await Promise.resolve(); // let the queued write settle
    expect(fsState.has(FILE)).toBe(true);
    const parsed = JSON.parse(fsState.get(FILE)!) as Session;
    expect(parsed.messages).toEqual([sampleUser]);
  });

  it('flush writes synchronously', async () => {
    const store = new SessionStore(FOLDER);
    await store.load();
    store.appendUser(sampleUser);
    await store.flush();
    expect(fsState.has(FILE)).toBe(true);
  });

  it('round-trips: write, reload, equal', async () => {
    const store1 = new SessionStore(FOLDER);
    await store1.load();
    store1.appendUser(sampleUser);
    await store1.flush();

    const store2 = new SessionStore(FOLDER);
    const reloaded = await store2.load();
    expect(reloaded.messages).toEqual([sampleUser]);
  });

  it('returns empty session and warns when JSON is corrupted', async () => {
    fsState.set(FILE, '{not valid json');
    const store = new SessionStore(FOLDER);
    const session = await store.load();
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]).toMatchObject({
      role: 'system',
      kind: 'error',
      text: expect.stringContaining('corrupted'),
    });
  });

  it('coalesces multiple appends into one write', async () => {
    const store = new SessionStore(FOLDER);
    await store.load();
    store.appendUser({ ...sampleUser, id: 'u1' });
    store.appendUser({ ...sampleUser, id: 'u2' });
    store.appendUser({ ...sampleUser, id: 'u3' });
    vi.advanceTimersByTime(200);
    await Promise.resolve();
    const parsed = JSON.parse(fsState.get(FILE)!) as Session;
    expect(parsed.messages).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run tests; expect failures**

Run: `npm test -- tests/sessionStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/sessionStore.ts
import { existsSync, readFileSync, promises as fsp } from 'node:fs';
import { join, dirname } from 'node:path';
import { ulid } from './ulid.js';
import type {
  Session, SessionMessage, UserMessage, AgentMessage, SystemMessage,
} from './shared/protocol.js';

const DEBOUNCE_MS = 200;
const SESSIONS_SUBPATH = '.vscode/agent-chat/sessions.json';

export class SessionStore {
  private session: Session = { version: 1, messages: [] };
  private writeTimer: NodeJS.Timeout | null = null;
  private writePromise: Promise<void> | null = null;
  private filePath: string;

  constructor(workspaceFolder: string) {
    this.filePath = join(workspaceFolder, SESSIONS_SUBPATH);
  }

  async load(): Promise<Session> {
    if (!existsSync(this.filePath)) {
      this.session = { version: 1, messages: [] };
      return this.session;
    }
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Session;
      if (parsed.version !== 1 || !Array.isArray(parsed.messages)) {
        throw new Error('schema mismatch');
      }
      this.session = parsed;
    } catch (err) {
      this.session = {
        version: 1,
        messages: [
          {
            id: ulid(),
            role: 'system',
            kind: 'error',
            text: `Existing session file was corrupted and could not be loaded; starting fresh. (${err instanceof Error ? err.message : String(err)})`,
            timestamp: Date.now(),
          },
        ],
      };
      this.scheduleWrite();
    }
    return this.session;
  }

  appendUser(msg: UserMessage): void {
    this.session.messages.push(msg);
    this.scheduleWrite();
  }

  appendAgent(msg: AgentMessage): void {
    this.session.messages.push(msg);
    this.scheduleWrite();
  }

  appendSystem(msg: SystemMessage): void {
    this.session.messages.push(msg);
    this.scheduleWrite();
  }

  async flush(): Promise<void> {
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    await this.write();
  }

  private scheduleWrite(): void {
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer);
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.writePromise = this.write();
    }, DEBOUNCE_MS);
  }

  private async write(): Promise<void> {
    const dir = dirname(this.filePath);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = this.filePath + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(this.session, null, 2), 'utf8');
    await fsp.rename(tmp, this.filePath);
  }

  // Helper for the .gitignore prompt task — exposes whether the directory was
  // newly created on this run.
  isFirstSession(): boolean {
    return this.session.messages.length === 0;
  }
}
```

- [ ] **Step 4: Run tests; expect 6/6 pass**

Run: `npm test -- tests/sessionStore.test.ts`
Expected: 6/6.

- [ ] **Step 5: Commit**

```bash
git add src/sessionStore.ts tests/sessionStore.test.ts
git commit -m "feat(session): SessionStore with debounced atomic per-workspace JSON persistence"
```

---

## Phase D — Webview build setup

### Task D1: Preact + esbuild webview entry + shell

**Files:**
- Modify: `package.json`
- Modify: `esbuild.config.mjs`
- Create: `src/webview/index.html`
- Create: `src/webview/main.tsx`
- Create: `src/webview/styles.css`
- Modify: `tsconfig.json`

- [ ] **Step 1: Install Preact**

Run: `npm install preact`

- [ ] **Step 2: Update `tsconfig.json` for JSX**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowSyntheticDefaultImports": true,
    "isolatedModules": true,
    "outDir": "./dist",
    "rootDir": ".",
    "lib": ["ES2022", "DOM"],
    "types": ["node", "vscode"],
    "jsx": "preserve",
    "jsxImportSource": "preact"
  },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

(Adds `DOM` to `lib`, `jsx: preserve` and `jsxImportSource: preact`.)

- [ ] **Step 3: Update `esbuild.config.mjs` for two entry points**

```javascript
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

const webviewConfig = {
  entryPoints: ['src/webview/main.tsx'],
  bundle: true,
  outfile: 'dist/webview.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  jsx: 'automatic',
  jsxImportSource: 'preact',
  loader: { '.css': 'text' },
  logLevel: 'info',
};

if (watch) {
  const ctx1 = await esbuild.context(extensionConfig);
  const ctx2 = await esbuild.context(webviewConfig);
  await Promise.all([ctx1.watch(), ctx2.watch()]);
} else {
  await Promise.all([
    esbuild.build(extensionConfig),
    esbuild.build(webviewConfig),
  ]);
}
```

- [ ] **Step 4: Write `src/webview/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-{{NONCE}}'; style-src 'unsafe-inline' {{CSP_SOURCE}};" />
  <title>Agent Chat</title>
  <style>
    body { margin: 0; padding: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    #root { height: 100vh; display: flex; flex-direction: column; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="{{NONCE}}" src="{{WEBVIEW_JS_URI}}"></script>
</body>
</html>
```

(`{{NONCE}}`, `{{CSP_SOURCE}}`, `{{WEBVIEW_JS_URI}}` are placeholders that ChatPanel will substitute when serving the HTML.)

- [ ] **Step 5: Write `src/webview/main.tsx`**

```typescript
import { render, h } from 'preact';
import { App } from './App.js';
import './styles.css';

const root = document.getElementById('root');
if (root) {
  render(h(App, {}), root);
}
```

- [ ] **Step 6: Write `src/webview/styles.css`**

```css
:root {
  --bubble-bg: var(--vscode-editorWidget-background, rgba(255,255,255,0.05));
  --border: var(--vscode-widget-border, rgba(255,255,255,0.15));
  --user-bg: var(--vscode-list-activeSelectionBackground, rgba(74,158,255,0.2));
  --error-bg: rgba(255, 80, 80, 0.1);
  --error-border: rgba(255, 80, 80, 0.4);
  --ok-color: #6dd47e;
  --error-color: #ff7070;
}

body {
  font-size: var(--vscode-font-size, 13px);
}

.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.floor-bar {
  padding: 6px 12px;
  font-size: 12px;
  border-bottom: 1px solid var(--border);
  background: rgba(255,255,255,0.02);
  display: flex;
  align-items: center;
  gap: 8px;
}

.message-list {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.bubble {
  max-width: 75%;
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--bubble-bg);
  border: 1px solid var(--border);
  white-space: pre-wrap;
  word-wrap: break-word;
}
.bubble.user {
  align-self: flex-end;
  background: var(--user-bg);
}
.bubble.agent { align-self: flex-start; }
.bubble.streaming::after {
  content: '\2588';
  display: inline-block;
  margin-left: 2px;
  animation: blink 1s steps(2) infinite;
}
@keyframes blink {
  to { opacity: 0; }
}

.system-notice {
  align-self: center;
  padding: 6px 12px;
  border-radius: 6px;
  background: rgba(255,255,255,0.04);
  border: 1px dashed var(--border);
  font-size: 12px;
  font-style: italic;
}
.system-notice.error {
  background: var(--error-bg);
  border-color: var(--error-border);
  color: var(--error-color);
}

.tool-card {
  margin-top: 6px;
  padding: 6px 10px;
  background: rgba(0,0,0,0.2);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px;
}
.tool-card-head {
  display: flex;
  justify-content: space-between;
  cursor: pointer;
  user-select: none;
}
.tool-card.verbose .tool-card-body,
.tool-card.expanded .tool-card-body {
  margin-top: 4px;
  white-space: pre-wrap;
  opacity: 0.85;
}
.tool-card.compact:not(.expanded) .tool-card-body { display: none; }
.tool-card.hidden { display: none; }

.composer {
  border-top: 1px solid var(--border);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  position: relative;
}
.composer textarea {
  flex: 1;
  resize: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--vscode-input-background, rgba(0,0,0,0.3));
  color: var(--vscode-input-foreground);
  padding: 8px;
  font: inherit;
  min-height: 36px;
  max-height: 200px;
}
.composer-row {
  display: flex;
  gap: 6px;
}
.composer button {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: 1px solid var(--vscode-button-border, transparent);
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
}
.composer button.cancel {
  background: var(--vscode-errorForeground, #ff7070);
  color: white;
}

.health-strip {
  display: flex;
  gap: 8px;
  font-size: 11px;
  opacity: 0.85;
}
.health-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border-radius: 99px;
  background: rgba(255,255,255,0.05);
  border: 1px solid var(--border);
  cursor: default;
}
.health-pill.ok { color: var(--ok-color); border-color: rgba(109,212,126,0.4); }
.health-pill.error { color: var(--error-color); border-color: rgba(255,112,112,0.4); cursor: pointer; }

.mention-popover {
  position: absolute;
  bottom: 100%;
  left: 8px;
  background: var(--vscode-editorWidget-background, #2a2a2a);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 12px;
  min-width: 200px;
  margin-bottom: 4px;
  z-index: 10;
}
.mention-item { padding: 6px 10px; cursor: pointer; }
.mention-item.active { background: var(--vscode-list-activeSelectionBackground); }

.pulse-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--ok-color);
  animation: pulse 1.6s infinite;
}
@keyframes pulse {
  0% { box-shadow: 0 0 0 0 rgba(109,212,126,0.6); }
  100% { box-shadow: 0 0 0 8px rgba(109,212,126,0); }
}
```

- [ ] **Step 7: Stub `src/webview/App.tsx` so the build succeeds**

```typescript
import { h } from 'preact';

export function App() {
  return <div class="app">Agent Chat (loading…)</div>;
}
```

- [ ] **Step 8: Run typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: typecheck clean; build produces both `dist/extension.js` and `dist/webview.js`.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json esbuild.config.mjs tsconfig.json src/webview/
git commit -m "feat(webview): add Preact + esbuild webview bundle setup"
```

---

## Phase E — Webview state

### Task E1: state.ts pure reducer

**Files:**
- Create: `src/webview/state.ts`
- Create: `tests/webviewState.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/webviewState.test.ts
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
});
```

- [ ] **Step 2: Run tests; expect failures**

Run: `npm test -- tests/webviewState.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/webview/state.ts`**

```typescript
import type {
  Session, InProgressMessage, FromExtension, Settings,
} from '../shared/protocol.js';
import { DEFAULT_SETTINGS } from '../shared/protocol.js';
import type { AgentId, AgentStatus } from '../types.js';

export type WebviewState = {
  session: Session;
  inProgress: Map<string, InProgressMessage>;
  status: Record<AgentId, AgentStatus>;
  settings: Settings;
  floorHolder: AgentId | null;
};

export function initialState(): WebviewState {
  return {
    session: { version: 1, messages: [] },
    inProgress: new Map(),
    status: { claude: 'ready', codex: 'ready', gemini: 'ready' },
    settings: DEFAULT_SETTINGS,
    floorHolder: null,
  };
}

export function reduce(state: WebviewState, event: FromExtension): WebviewState {
  switch (event.kind) {
    case 'init':
      return {
        ...state,
        session: event.session,
        status: event.status,
        settings: event.settings,
      };

    case 'message-started': {
      const next = new Map(state.inProgress);
      next.set(event.id, {
        id: event.id,
        role: 'agent',
        agentId: event.agentId,
        text: '',
        toolEvents: [],
        timestamp: event.timestamp,
      });
      return { ...state, inProgress: next };
    }

    case 'message-chunk': {
      const existing = state.inProgress.get(event.id);
      if (!existing) return state;
      const updated = applyChunk(existing, event.chunk);
      if (updated === existing) return state;
      const next = new Map(state.inProgress);
      next.set(event.id, updated);
      return { ...state, inProgress: next };
    }

    case 'message-finalized': {
      const next = new Map(state.inProgress);
      next.delete(event.message.id);
      return {
        ...state,
        inProgress: next,
        session: {
          ...state.session,
          messages: [...state.session.messages, event.message],
        },
      };
    }

    case 'system-message':
      return {
        ...state,
        session: {
          ...state.session,
          messages: [...state.session.messages, event.message],
        },
      };

    case 'floor-changed':
      return { ...state, floorHolder: event.holder };

    case 'status-changed':
      return {
        ...state,
        status: { ...state.status, [event.agentId]: event.status },
      };

    case 'settings-changed':
      return { ...state, settings: event.settings };
  }
}

function applyChunk(msg: InProgressMessage, chunk: import('../types.js').AgentChunk): InProgressMessage {
  switch (chunk.type) {
    case 'text':
      return { ...msg, text: msg.text + chunk.text };
    case 'tool-call':
      return {
        ...msg,
        toolEvents: [...msg.toolEvents, { kind: 'call', name: chunk.name, input: chunk.input, timestamp: Date.now() }],
      };
    case 'tool-result':
      return {
        ...msg,
        toolEvents: [...msg.toolEvents, { kind: 'result', name: chunk.name, output: chunk.output, timestamp: Date.now() }],
      };
    case 'error':
    case 'done':
      return msg;
  }
}
```

- [ ] **Step 4: Run tests; expect 10/10**

Run: `npm test -- tests/webviewState.test.ts`
Expected: 10/10.

- [ ] **Step 5: Commit**

```bash
git add src/webview/state.ts tests/webviewState.test.ts
git commit -m "feat(webview): pure state reducer for postMessage events"
```

---

## Phase F — Webview components

Component tasks have no automated tests (per the plan's testing approach). Each task: write the component, run `npm run build`, verify the build is clean. Visual verification happens at the end of the plan via the manual smoke pass.

### Task F1: App + MessageList + UserBubble + AgentBubble

**Files:**
- Modify: `src/webview/App.tsx`
- Create: `src/webview/components/MessageList.tsx`
- Create: `src/webview/components/UserBubble.tsx`
- Create: `src/webview/components/AgentBubble.tsx`

- [ ] **Step 1: Replace `src/webview/App.tsx`**

```typescript
import { h } from 'preact';
import { useEffect, useReducer } from 'preact/hooks';
import { initialState, reduce } from './state.js';
import { MessageList } from './components/MessageList.js';
import type { FromExtension, FromWebview } from '../shared/protocol.js';

declare const acquireVsCodeApi: () => { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

export function send(msg: FromWebview): void {
  vscode.postMessage(msg);
}

export function App() {
  const [state, dispatch] = useReducer(reduce, initialState());

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      dispatch(e.data as FromExtension);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  return (
    <div class="app">
      <MessageList session={state.session} inProgress={state.inProgress} settings={state.settings} />
    </div>
  );
}
```

- [ ] **Step 2: Write `src/webview/components/MessageList.tsx`**

```typescript
import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { UserBubble } from './UserBubble.js';
import { AgentBubble } from './AgentBubble.js';
import type { Session, InProgressMessage, Settings } from '../../shared/protocol.js';

interface Props {
  session: Session;
  inProgress: Map<string, InProgressMessage>;
  settings: Settings;
}

export function MessageList({ session, inProgress, settings }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session.messages.length, inProgress.size]);

  // Merge persisted history + in-progress, ordered by timestamp
  const items = [
    ...session.messages.map((m) => ({ kind: 'persisted', message: m, ts: m.timestamp })),
    ...Array.from(inProgress.values()).map((m) => ({ kind: 'in-progress', message: m, ts: m.timestamp })),
  ].sort((a, b) => a.ts - b.ts);

  return (
    <div class="message-list" ref={listRef}>
      {items.map((item) => {
        if (item.kind === 'in-progress') {
          return <AgentBubble key={item.message.id} message={item.message} streaming={true} settings={settings} />;
        }
        const m = item.message;
        if (m.role === 'user') return <UserBubble key={m.id} message={m} />;
        if (m.role === 'agent') return <AgentBubble key={m.id} message={m} streaming={false} settings={settings} />;
        // system messages — Task F3 component will replace this; for F1, render a simple div.
        return <div key={m.id} class={`system-notice ${m.kind === 'error' ? 'error' : ''}`}>{m.text}</div>;
      })}
    </div>
  );
}
```

- [ ] **Step 3: Write `src/webview/components/UserBubble.tsx`**

```typescript
import { h } from 'preact';
import type { UserMessage } from '../../shared/protocol.js';

export function UserBubble({ message }: { message: UserMessage }) {
  return <div class="bubble user">{message.text}</div>;
}
```

- [ ] **Step 4: Write `src/webview/components/AgentBubble.tsx`**

```typescript
import { h } from 'preact';
import type { AgentMessage, InProgressMessage, Settings } from '../../shared/protocol.js';
import { ToolCallCard } from './ToolCallCard.js';

interface Props {
  message: AgentMessage | InProgressMessage;
  streaming: boolean;
  settings: Settings;
}

export function AgentBubble({ message, streaming, settings }: Props) {
  const status = 'status' in message ? message.status : null;
  const error = 'error' in message ? message.error : undefined;
  const classes = ['bubble', 'agent', `agent-${message.agentId}`];
  if (streaming) classes.push('streaming');

  return (
    <div class={classes.join(' ')}>
      <div class="role" style="font-size:10px;text-transform:uppercase;opacity:0.6;margin-bottom:3px">
        {message.agentId}
      </div>
      <div>{message.text}</div>
      {message.toolEvents.length > 0 && (
        <div>
          {message.toolEvents.map((e, i) => (
            <ToolCallCard key={i} event={e} renderStyle={settings.toolCallRenderStyle} />
          ))}
        </div>
      )}
      {status === 'cancelled' && <div style="font-style:italic;opacity:0.6;margin-top:4px">[Cancelled]</div>}
      {status === 'errored' && error && <div style="color:var(--error-color);margin-top:4px">{error}</div>}
    </div>
  );
}
```

- [ ] **Step 5: Stub `src/webview/components/ToolCallCard.tsx` so build passes**

```typescript
import { h } from 'preact';
import type { ToolEvent, Settings } from '../../shared/protocol.js';

interface Props {
  event: ToolEvent;
  renderStyle: Settings['toolCallRenderStyle'];
}

export function ToolCallCard({ event, renderStyle }: Props) {
  if (renderStyle === 'hidden') return null;
  return <div class="tool-card compact"><div class="tool-card-head">{event.kind} {event.name}</div></div>;
}
```

(Task F2 fleshes this out.)

- [ ] **Step 6: Run typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: clean. `dist/webview.js` exists.

- [ ] **Step 7: Commit**

```bash
git add src/webview/App.tsx src/webview/components/
git commit -m "feat(webview): App + MessageList + UserBubble + AgentBubble"
```

---

### Task F2: ToolCallCard with three render modes

**Files:**
- Modify: `src/webview/components/ToolCallCard.tsx`

- [ ] **Step 1: Replace `src/webview/components/ToolCallCard.tsx`**

```typescript
import { h } from 'preact';
import { useState } from 'preact/hooks';
import type { ToolEvent, Settings } from '../../shared/protocol.js';

interface Props {
  event: ToolEvent;
  renderStyle: Settings['toolCallRenderStyle'];
}

export function ToolCallCard({ event, renderStyle }: Props) {
  const [expanded, setExpanded] = useState(false);
  if (renderStyle === 'hidden') return null;

  const verb = event.kind === 'call' ? '→' : '←';
  const summary = `${verb} ${event.name}`;
  const detail = event.kind === 'call' ? event.input : event.output;
  const detailStr = detail === undefined ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2));

  const classes = ['tool-card', renderStyle];
  if (expanded) classes.push('expanded');

  if (renderStyle === 'verbose') {
    return (
      <div class="tool-card verbose">
        <div class="tool-card-head"><span>{summary}</span></div>
        {detailStr && <div class="tool-card-body">{detailStr}</div>}
      </div>
    );
  }

  // compact mode
  return (
    <div class={classes.join(' ')}>
      <div class="tool-card-head" onClick={() => setExpanded(!expanded)}>
        <span>{summary}</span>
        <span style="opacity:0.5">{expanded ? '▾' : '▸'}</span>
      </div>
      {expanded && detailStr && <div class="tool-card-body">{detailStr}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/webview/components/ToolCallCard.tsx
git commit -m "feat(webview): ToolCallCard with verbose/compact/hidden render modes"
```

---

### Task F3: SystemNotice

**Files:**
- Create: `src/webview/components/SystemNotice.tsx`
- Modify: `src/webview/components/MessageList.tsx`

- [ ] **Step 1: Write `src/webview/components/SystemNotice.tsx`**

```typescript
import { h } from 'preact';
import type { SystemMessage } from '../../shared/protocol.js';

export function SystemNotice({ message }: { message: SystemMessage }) {
  const classes = ['system-notice'];
  if (message.kind === 'error') classes.push('error');
  return <div class={classes.join(' ')}>{message.text}</div>;
}
```

- [ ] **Step 2: Update `MessageList.tsx` to use `SystemNotice`**

In the `items.map` switch, replace the inline system-notice div with:

```typescript
        if (m.role === 'system') return <SystemNotice key={m.id} message={m} />;
```

And add the import at the top: `import { SystemNotice } from './SystemNotice.js';`

- [ ] **Step 3: Build and commit**

Run: `npm run build`
```bash
git add src/webview/components/
git commit -m "feat(webview): SystemNotice component (routing-needed + error)"
```

---

### Task F4: Composer + cancel

**Files:**
- Create: `src/webview/components/Composer.tsx`
- Modify: `src/webview/App.tsx`

- [ ] **Step 1: Write `src/webview/components/Composer.tsx`**

```typescript
import { h } from 'preact';
import { useState, useRef } from 'preact/hooks';
import type { AgentId, AgentStatus } from '../../types.js';
import type { FromWebview } from '../../shared/protocol.js';
import { HealthStrip } from './HealthStrip.js';

interface Props {
  send: (msg: FromWebview) => void;
  floorHolder: AgentId | null;
  status: Record<AgentId, AgentStatus>;
}

export function Composer({ send, floorHolder, status }: Props) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = () => {
    if (!text.trim()) return;
    send({ kind: 'send', text });
    setText('');
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isFloorHeld = floorHolder !== null;

  return (
    <div class="composer">
      <textarea
        ref={textareaRef}
        value={text}
        placeholder="Type @ to mention an agent…"
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={handleKeyDown}
      />
      <div class="composer-row">
        <HealthStrip status={status} send={send} />
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

- [ ] **Step 2: Stub `HealthStrip.tsx` so the build passes**

Create `src/webview/components/HealthStrip.tsx`:
```typescript
import { h } from 'preact';
import type { AgentId, AgentStatus } from '../../types.js';
import type { FromWebview } from '../../shared/protocol.js';

export function HealthStrip({ status, send }: { status: Record<AgentId, AgentStatus>; send: (m: FromWebview) => void }) {
  return <div class="health-strip">{JSON.stringify(status)}</div>;
}
```

(Task F6 fleshes out HealthStrip.)

- [ ] **Step 3: Update `App.tsx` to render `Composer`**

```typescript
import { h } from 'preact';
import { useEffect, useReducer } from 'preact/hooks';
import { initialState, reduce } from './state.js';
import { MessageList } from './components/MessageList.js';
import { Composer } from './components/Composer.js';
import type { FromExtension, FromWebview } from '../shared/protocol.js';

declare const acquireVsCodeApi: () => { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();
const send = (msg: FromWebview) => vscode.postMessage(msg);

export function App() {
  const [state, dispatch] = useReducer(reduce, initialState());

  useEffect(() => {
    const handler = (e: MessageEvent) => dispatch(e.data as FromExtension);
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  return (
    <div class="app">
      <MessageList session={state.session} inProgress={state.inProgress} settings={state.settings} />
      <Composer send={send} floorHolder={state.floorHolder} status={state.status} />
    </div>
  );
}
```

- [ ] **Step 4: Build and commit**

Run: `npm run build`
```bash
git add src/webview/
git commit -m "feat(webview): Composer with send/cancel + HealthStrip stub"
```

---

### Task F5: MentionAutocomplete

**Files:**
- Create: `src/webview/components/MentionAutocomplete.tsx`
- Modify: `src/webview/components/Composer.tsx`

- [ ] **Step 1: Write `src/webview/components/MentionAutocomplete.tsx`**

```typescript
import { h } from 'preact';
import { useEffect } from 'preact/hooks';

const ITEMS = [
  { token: '@claude', desc: 'code reasoning' },
  { token: '@gpt', desc: 'execution & tests' },
  { token: '@gemini', desc: 'research' },
  { token: '@all', desc: 'broadcast to all three' },
];

interface Props {
  filter: string;
  activeIndex: number;
  onPick: (token: string) => void;
}

export function MentionAutocomplete({ filter, activeIndex, onPick }: Props) {
  const filtered = ITEMS.filter((i) => i.token.toLowerCase().includes(filter.toLowerCase()));
  if (filtered.length === 0) return null;
  return (
    <div class="mention-popover">
      {filtered.map((item, i) => (
        <div
          class={`mention-item ${i === activeIndex ? 'active' : ''}`}
          onMouseDown={(e) => { e.preventDefault(); onPick(item.token); }}
        >
          <span>{item.token}</span>
          <span style="opacity:0.6;font-size:11px;margin-left:6px">{item.desc}</span>
        </div>
      ))}
    </div>
  );
}

export const MENTION_ITEMS = ITEMS;
```

- [ ] **Step 2: Update `Composer.tsx` to integrate autocomplete**

Replace the file:
```typescript
import { h } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import type { AgentId, AgentStatus } from '../../types.js';
import type { FromWebview } from '../../shared/protocol.js';
import { HealthStrip } from './HealthStrip.js';
import { MentionAutocomplete, MENTION_ITEMS } from './MentionAutocomplete.js';

interface Props {
  send: (msg: FromWebview) => void;
  floorHolder: AgentId | null;
  status: Record<AgentId, AgentStatus>;
}

export function Composer({ send, floorHolder, status }: Props) {
  const [text, setText] = useState('');
  const [autocomplete, setAutocomplete] = useState<{ open: boolean; filter: string; activeIndex: number }>({
    open: false, filter: '', activeIndex: 0,
  });
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Open autocomplete when last token starts with `@`
  useEffect(() => {
    const lastToken = text.split(/\s+/).at(-1) ?? '';
    if (lastToken.startsWith('@') && lastToken.length >= 1) {
      setAutocomplete((a) => ({ ...a, open: true, filter: lastToken, activeIndex: 0 }));
    } else if (autocomplete.open) {
      setAutocomplete((a) => ({ ...a, open: false }));
    }
  }, [text]);

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
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAutocomplete((a) => ({ ...a, activeIndex: (a.activeIndex + 1) % filtered.length }));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAutocomplete((a) => ({ ...a, activeIndex: (a.activeIndex - 1 + filtered.length) % filtered.length }));
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        pickMention(filtered[autocomplete.activeIndex].token);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setAutocomplete((a) => ({ ...a, open: false }));
        return;
      }
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
        placeholder="Type @ to mention an agent…"
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={handleKeyDown}
      />
      <div class="composer-row">
        <HealthStrip status={status} send={send} />
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

- [ ] **Step 3: Build and commit**

Run: `npm run build`
```bash
git add src/webview/components/
git commit -m "feat(webview): MentionAutocomplete with arrow-key navigation"
```

---

### Task F6: FloorIndicator + HealthStrip

**Files:**
- Create: `src/webview/components/FloorIndicator.tsx`
- Modify: `src/webview/components/HealthStrip.tsx`
- Modify: `src/webview/App.tsx`

- [ ] **Step 1: Write `src/webview/components/FloorIndicator.tsx`**

```typescript
import { h } from 'preact';
import type { AgentId } from '../../types.js';

export function FloorIndicator({ holder }: { holder: AgentId | null }) {
  if (holder === null) {
    return <div class="floor-bar" style="opacity:0.55"><span>Idle</span></div>;
  }
  return (
    <div class="floor-bar">
      <span class="pulse-dot"></span>
      <span><strong>{holder}</strong> has the floor…</span>
    </div>
  );
}
```

- [ ] **Step 2: Replace `src/webview/components/HealthStrip.tsx`**

```typescript
import { h } from 'preact';
import { useState } from 'preact/hooks';
import type { AgentId, AgentStatus } from '../../types.js';
import type { FromWebview } from '../../shared/protocol.js';

const FIX_INSTRUCTIONS: Record<AgentId, Record<Exclude<AgentStatus, 'ready' | 'busy'>, string>> = {
  claude: {
    'unauthenticated': 'Run `claude /login` in a terminal.',
    'not-installed': 'Install Claude Code: `npm i -g @anthropic-ai/claude-code` then run `claude /login`.',
  },
  codex: {
    'unauthenticated': 'Run `codex login` in a terminal.',
    'not-installed': 'Install Codex CLI: `npm i -g @openai/codex` then run `codex login`.',
  },
  gemini: {
    'unauthenticated': 'Run `gemini` in a terminal and complete the OAuth flow.',
    'not-installed': 'Install Gemini CLI: `npm i -g @google/gemini-cli` then run `gemini`.',
  },
};

interface Props {
  status: Record<AgentId, AgentStatus>;
  send: (msg: FromWebview) => void;
}

export function HealthStrip({ status, send }: Props) {
  const [popoverFor, setPopoverFor] = useState<AgentId | null>(null);

  const labels: Record<AgentId, string> = {
    claude: 'Claude',
    codex: 'GPT',
    gemini: 'Gemini',
  };

  const agents: AgentId[] = ['claude', 'codex', 'gemini'];

  return (
    <div class="health-strip">
      {agents.map((id) => {
        const s = status[id];
        const ok = s === 'ready' || s === 'busy';
        const classes = ['health-pill', ok ? 'ok' : 'error'];
        return (
          <div key={id} style="position:relative">
            <span
              class={classes.join(' ')}
              onClick={() => {
                if (!ok) {
                  setPopoverFor(popoverFor === id ? null : id);
                  send({ kind: 'reload-status' });
                }
              }}
            >
              {labels[id]} {ok ? '✓' : '✗'}
            </span>
            {popoverFor === id && !ok && s !== 'busy' && (
              <div style="position:absolute;bottom:100%;left:0;background:var(--vscode-editorWidget-background);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:11px;width:240px;margin-bottom:4px;z-index:10">
                {FIX_INSTRUCTIONS[id][s as 'unauthenticated' | 'not-installed']}
                <div style="text-align:right;margin-top:6px">
                  <span style="cursor:pointer;color:var(--vscode-textLink-foreground)" onClick={() => setPopoverFor(null)}>Close</span>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Update `App.tsx` to render `FloorIndicator`**

Add the import and render it above `MessageList`:

```typescript
import { FloorIndicator } from './components/FloorIndicator.js';
// ...
  return (
    <div class="app">
      <FloorIndicator holder={state.floorHolder} />
      <MessageList session={state.session} inProgress={state.inProgress} settings={state.settings} />
      <Composer send={send} floorHolder={state.floorHolder} status={state.status} />
    </div>
  );
```

- [ ] **Step 4: Build and commit**

Run: `npm run build`
```bash
git add src/webview/
git commit -m "feat(webview): FloorIndicator + full HealthStrip with fix-instructions popover"
```

---

## Phase G — Extension host bridge

### Task G1: ChatPanel skeleton + extension.ts command

**Files:**
- Create: `src/panel.ts`
- Modify: `src/extension.ts`

- [ ] **Step 1: Write `src/panel.ts`**

```typescript
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ulid } from './ulid.js';
import { MessageRouter } from './messageRouter.js';
import { ClaudeAgent } from './agents/claude.js';
import { CodexAgent } from './agents/codex.js';
import { GeminiAgent } from './agents/gemini.js';
import { SessionStore } from './sessionStore.js';
import { checkClaude, checkCodex, checkGemini, clearStatusCache } from './statusChecks.js';
import type {
  FromExtension, FromWebview, Settings, AgentMessage, UserMessage, SystemMessage,
} from './shared/protocol.js';
import type { AgentId, AgentStatus } from './types.js';

export class ChatPanel {
  private static current: ChatPanel | undefined;
  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private router: MessageRouter;
  private store: SessionStore;
  private extensionUri: vscode.Uri;

  static async show(context: vscode.ExtensionContext): Promise<void> {
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
    ChatPanel.current = new ChatPanel(panel, context.extensionUri, folder.uri.fsPath);
    await ChatPanel.current.initialize();
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, workspacePath: string) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    const claude = new ClaudeAgent();
    const codex = new CodexAgent();
    const gemini = new GeminiAgent();
    this.router = new MessageRouter({ claude, codex, gemini });
    this.store = new SessionStore(workspacePath);

    this.panel.webview.html = this.renderHtml();
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((m: FromWebview) => this.handleFromWebview(m)),
    );
  }

  private async initialize(): Promise<void> {
    const session = await this.store.load();
    const status: Record<AgentId, AgentStatus> = {
      claude: await checkClaude(),
      codex: await checkCodex(),
      gemini: await checkGemini(),
    };
    const settings = this.readSettings();
    this.send({ kind: 'init', session, status, settings });

    this.disposables.push(
      this.router.onFloorChange((holder) => this.send({ kind: 'floor-changed', holder })),
      this.router.onStatusChange((agentId, s) => this.send({ kind: 'status-changed', agentId, status: s })),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('agentChat')) {
          this.send({ kind: 'settings-changed', settings: this.readSettings() });
        }
      }),
    );
  }

  private send(msg: FromExtension): void {
    this.panel.webview.postMessage(msg);
  }

  private readSettings(): Settings {
    const config = vscode.workspace.getConfiguration('agentChat');
    return {
      toolCallRenderStyle: config.get<Settings['toolCallRenderStyle']>('toolCallRenderStyle', 'compact'),
    };
  }

  // Stubbed in G1; G2 wires this up
  private async handleFromWebview(_msg: FromWebview): Promise<void> {
    // intentionally empty for G1
  }

  private renderHtml(): string {
    const htmlPath = path.join(this.extensionUri.fsPath, 'src', 'webview', 'index.html');
    const jsUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js')
    );
    const nonce = ulid();
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html
      .replace(/{{NONCE}}/g, nonce)
      .replace(/{{CSP_SOURCE}}/g, this.panel.webview.cspSource)
      .replace(/{{WEBVIEW_JS_URI}}/g, jsUri.toString());
    return html;
  }

  dispose(): void {
    this.store.flush().catch(() => { /* best-effort */ });
    ChatPanel.current = undefined;
    this.disposables.forEach((d) => d.dispose());
    this.panel.dispose();
  }
}
```

- [ ] **Step 2: Update `src/extension.ts`**

```typescript
import * as vscode from 'vscode';
import { ChatPanel } from './panel.js';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('agentChat.openPanel', () => ChatPanel.show(context)),
  );
}

export function deactivate(): void {
  // no-op
}
```

- [ ] **Step 3: Add settings contribution to `package.json`**

Inside `contributes`:

```json
"configuration": {
  "title": "Agent Chat",
  "properties": {
    "agentChat.toolCallRenderStyle": {
      "type": "string",
      "enum": ["verbose", "compact", "hidden"],
      "default": "compact",
      "description": "How tool calls (file reads, edits, terminal commands) are displayed in the chat."
    }
  }
}
```

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/panel.ts src/extension.ts package.json
git commit -m "feat(panel): ChatPanel skeleton with init flow + agentChat.openPanel command"
```

---

### Task G2: ChatPanel handle FromWebview + dispatch user messages

**Files:**
- Modify: `src/panel.ts`
- Create: `tests/panel.test.ts`

This task adds the `send` / `cancel` / `reload-status` / `open-external` handling and wires user messages through the MessageRouter.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/panel.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist a fake vscode module before importing ChatPanel.
vi.mock('vscode', () => {
  const messages: any[] = [];
  const onDidReceive = { handler: undefined as any };
  const onDidDispose = { handler: undefined as any };
  const fakePanel = {
    webview: {
      postMessage: vi.fn((m: any) => messages.push(m)),
      onDidReceiveMessage: vi.fn((h: any) => { onDidReceive.handler = h; return { dispose: vi.fn() }; }),
      asWebviewUri: vi.fn((u: any) => u),
      cspSource: 'vscode-webview:',
      html: '',
    },
    onDidDispose: vi.fn((h: any) => { onDidDispose.handler = h; return { dispose: vi.fn() }; }),
    reveal: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    Uri: { joinPath: (...args: any[]) => args.join('/'), file: (p: string) => ({ fsPath: p }) },
    ViewColumn: { One: 1 },
    window: {
      createWebviewPanel: vi.fn(() => fakePanel),
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/fake/workspace' } }],
      getConfiguration: vi.fn(() => ({ get: (_k: string, dflt: any) => dflt })),
      onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    },
    __test: { messages, onDidReceive, fakePanel },
  };
});

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue('<html><body><div id="root"></div><script src="{{WEBVIEW_JS_URI}}"></script></body></html>'),
  promises: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock the agent SDK and child_process so adapters don't try to run anything
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: vi.fn(), execSync: vi.fn(() => '/fake/npm/root\n') }));

import { ChatPanel } from '../src/panel.js';
import * as vscode from 'vscode';

const ctx = {
  extensionUri: { fsPath: '/fake/ext' },
  subscriptions: [] as any[],
} as unknown as import('vscode').ExtensionContext;

describe('ChatPanel', () => {
  beforeEach(() => {
    (vscode as any).__test.messages.length = 0;
  });

  it('show() creates the panel and posts an init message', async () => {
    await ChatPanel.show(ctx);
    const msgs = (vscode as any).__test.messages;
    expect(msgs[0].kind).toBe('init');
    expect(msgs[0].session.messages).toEqual([]);
    expect(msgs[0].status).toMatchObject({ claude: expect.any(String), codex: expect.any(String), gemini: expect.any(String) });
    expect(msgs[0].settings.toolCallRenderStyle).toBe('compact');
  });

  it('reload-status from webview re-checks and posts status-changed events', async () => {
    await ChatPanel.show(ctx);
    const before = (vscode as any).__test.messages.length;
    const onDidReceive = (vscode as any).__test.onDidReceive.handler;
    await onDidReceive({ kind: 'reload-status' });
    const after = (vscode as any).__test.messages.slice(before);
    const statusChanged = after.filter((m: any) => m.kind === 'status-changed');
    expect(statusChanged.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests; expect failures**

Run: `npm test -- tests/panel.test.ts`
Expected: FAIL — `ChatPanel.show` doesn't expose the right behavior yet (because G1 only stubs `handleFromWebview`).

- [ ] **Step 3: Update `handleFromWebview` and add helpers in `src/panel.ts`**

Replace the empty `handleFromWebview` with:

```typescript
  private async handleFromWebview(msg: FromWebview): Promise<void> {
    switch (msg.kind) {
      case 'send':
        await this.dispatchUserMessage(msg.text);
        break;
      case 'cancel':
        // Cancel the active agent if any. Plan 1's adapters all expose cancel().
        // We don't track which one is currently dispatching here; fire all three —
        // only the active one has a non-no-op cancel.
        await Promise.all([
          this.router['agents'].claude.cancel(),
          this.router['agents'].codex.cancel(),
          this.router['agents'].gemini.cancel(),
        ]);
        break;
      case 'reload-status':
        clearStatusCache();
        const fresh: Record<AgentId, AgentStatus> = {
          claude: await checkClaude(),
          codex: await checkCodex(),
          gemini: await checkGemini(),
        };
        for (const id of ['claude', 'codex', 'gemini'] as AgentId[]) {
          this.send({ kind: 'status-changed', agentId: id, status: fresh[id] });
          this.router.notifyStatusChange(id, fresh[id]);
        }
        break;
      case 'open-external':
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
    }
  }

  private async dispatchUserMessage(text: string): Promise<void> {
    const userMsg: UserMessage = {
      id: ulid(),
      role: 'user',
      text,
      timestamp: Date.now(),
    };
    this.store.appendUser(userMsg);
    // Webview already shows it locally on send; we don't echo it back.
    // (If we wanted to be authoritative, we'd push a 'message-appended' event here.)

    // Build the in-progress message states + drive the router.
    const inProgressByAgent = new Map<AgentId, { id: string; text: string; toolEvents: any[]; agentId: AgentId; timestamp: number; error?: string; cancelled?: boolean }>();

    for await (const event of this.router.handle(text)) {
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
        continue;
      }
      if (event.kind === 'chunk') {
        const ip = inProgressByAgent.get(event.agentId);
        if (!ip) continue;
        // Mirror state on the extension side so we can persist a final AgentMessage.
        if (event.chunk.type === 'text') ip.text += event.chunk.text;
        else if (event.chunk.type === 'tool-call') ip.toolEvents.push({ kind: 'call', name: event.chunk.name, input: event.chunk.input, timestamp: Date.now() });
        else if (event.chunk.type === 'tool-result') ip.toolEvents.push({ kind: 'result', name: event.chunk.name, output: event.chunk.output, timestamp: Date.now() });
        else if (event.chunk.type === 'error') ip.error = event.chunk.message;
        // Forward to webview
        this.send({ kind: 'message-chunk', id: ip.id, chunk: event.chunk });
        continue;
      }
      if (event.kind === 'dispatch-end') {
        const ip = inProgressByAgent.get(event.agentId);
        if (!ip) continue;
        const finalized: AgentMessage = {
          id: ip.id,
          role: 'agent',
          agentId: ip.agentId,
          text: ip.text,
          toolEvents: ip.toolEvents,
          timestamp: ip.timestamp,
          status: ip.error ? 'errored' : 'complete',
          ...(ip.error ? { error: ip.error } : {}),
        };
        this.store.appendAgent(finalized);
        this.send({ kind: 'message-finalized', message: finalized });
        inProgressByAgent.delete(event.agentId);
      }
    }
  }
```

(Note the `this.router['agents']` accesses — TypeScript will complain about `private`. Either expose a `cancelAll()` method on `MessageRouter` or use a type cast. Cleanest: add a `cancelAll()` method to `MessageRouter`.)

- [ ] **Step 4: Add `cancelAll()` to `MessageRouter`**

In `src/messageRouter.ts`, inside the class:

```typescript
  async cancelAll(): Promise<void> {
    await Promise.all([
      this.agents.claude.cancel(),
      this.agents.codex.cancel(),
      this.agents.gemini.cancel(),
    ]);
  }
```

Then in `panel.ts`'s cancel branch:

```typescript
      case 'cancel':
        await this.router.cancelAll();
        break;
```

- [ ] **Step 5: Run tests; expect 2/2 pass**

Run: `npm test -- tests/panel.test.ts`
Expected: 2/2.

- [ ] **Step 6: Run full suite**

Run: `npm test`
Expected: all unit tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/panel.ts src/messageRouter.ts tests/panel.test.ts
git commit -m "feat(panel): handle FromWebview + dispatch user messages through router"
```

---

### Task G3: Echo user messages + persist user input

The webview currently doesn't echo the user's message back from the extension; the user-side echo is local-only. To support reload (where local state is gone), persist + echo.

**Files:**
- Modify: `src/panel.ts`
- Modify: `src/webview/state.ts`
- Modify: `tests/webviewState.test.ts`

- [ ] **Step 1: Add a new event kind `user-message-appended` to `src/shared/protocol.ts`**

Add to `FromExtension`:
```typescript
  | { kind: 'user-message-appended'; message: UserMessage }
```

- [ ] **Step 2: Handle it in the reducer**

In `src/webview/state.ts`'s `reduce` switch, add:

```typescript
    case 'user-message-appended':
      return {
        ...state,
        session: {
          ...state.session,
          messages: [...state.session.messages, event.message],
        },
      };
```

- [ ] **Step 3: Add a reducer test**

In `tests/webviewState.test.ts`, append:

```typescript
  it('user-message-appended adds to session.messages', () => {
    const state = reduce(initialState(), {
      kind: 'user-message-appended',
      message: { id: 'u1', role: 'user', text: 'hi', timestamp: 1 },
    });
    expect(state.session.messages).toEqual([{ id: 'u1', role: 'user', text: 'hi', timestamp: 1 }]);
  });
```

- [ ] **Step 4: Update `panel.ts` `dispatchUserMessage` to send the user echo**

After `this.store.appendUser(userMsg);`:
```typescript
    this.send({ kind: 'user-message-appended', message: userMsg });
```

- [ ] **Step 5: Update Composer in `src/webview/components/Composer.tsx` to NOT optimistically add the user message locally**

Today the user echoes optimistically; with this change, the extension is the source of truth. The local `setText('')` after send is fine. No render-side change needed unless the Composer was managing its own optimistic copy — it isn't.

(Verify by reading Composer.tsx — should be fine.)

- [ ] **Step 6: Run tests; expect all to pass**

Run: `npm test`
Expected: all pass including the new reducer test.

- [ ] **Step 7: Build and commit**

Run: `npm run build`

```bash
git add src/shared/protocol.ts src/panel.ts src/webview/state.ts tests/webviewState.test.ts
git commit -m "feat(panel): persist + echo user messages so reload restores them"
```

---

## Phase H — .gitignore prompt + smoke pass

### Task H1: .gitignore prompt on first session creation

**Files:**
- Modify: `src/panel.ts`

- [ ] **Step 1: Add the prompt logic to `panel.ts`**

Add this method to `ChatPanel`:

```typescript
  private async maybeShowGitignorePrompt(workspacePath: string): Promise<void> {
    const stateKey = 'agentChat.gitignorePromptDismissed';
    if ((this.context as any).workspaceState.get(stateKey)) return;

    const gitignorePath = path.join(workspacePath, '.gitignore');
    let gitignore = '';
    if (fs.existsSync(gitignorePath)) {
      gitignore = fs.readFileSync(gitignorePath, 'utf8');
    }
    const alreadyCovered =
      gitignore.split(/\r?\n/).some((line) => {
        const trimmed = line.trim();
        return trimmed === '.vscode/' ||
               trimmed === '.vscode/agent-chat/' ||
               trimmed === '.vscode/agent-chat';
      });
    if (alreadyCovered) return;

    const choice = await vscode.window.showInformationMessage(
      'Agent Chat stores session history in .vscode/agent-chat/. Add to .gitignore?',
      'Add to .gitignore',
      'Not now',
      "Don't ask again",
    );
    if (choice === 'Add to .gitignore') {
      const additionalLines = (gitignore.length > 0 && !gitignore.endsWith('\n') ? '\n' : '')
        + '\n# Agent Chat session history\n.vscode/agent-chat/\n';
      fs.appendFileSync(gitignorePath, additionalLines, 'utf8');
    } else if (choice === "Don't ask again") {
      await (this.context as any).workspaceState.update(stateKey, true);
    }
  }
```

This requires `ChatPanel` to hold a reference to the `ExtensionContext`. Update the constructor signature and `show()`:

```typescript
  static async show(context: vscode.ExtensionContext): Promise<void> {
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal();
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showErrorMessage('Agent Chat requires an open workspace folder.');
      return;
    }
    const panel = vscode.window.createWebviewPanel(/* ... */);
    ChatPanel.current = new ChatPanel(panel, context, folder.uri.fsPath);
    await ChatPanel.current.initialize();
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private context: vscode.ExtensionContext,
    private workspacePath: string,
  ) {
    this.panel = panel;
    this.extensionUri = context.extensionUri;
    /* ... */
  }
```

(Adjust referencing fields — `this.extensionUri` becomes `this.context.extensionUri`.)

- [ ] **Step 2: Call the prompt on first user message**

In `dispatchUserMessage`, before `this.store.appendUser(userMsg)`:

```typescript
    if (this.store.isFirstSession()) {
      await this.maybeShowGitignorePrompt(this.workspacePath);
    }
```

- [ ] **Step 3: Build, typecheck, smoke**

Run: `npm run typecheck && npm run build && npm test`
Expected: clean. Existing panel tests still pass (the prompt is gated by workspaceState which is mocked to return `undefined` → would actually fire; but the mock's `showInformationMessage` returns `undefined` so no destructive action happens).

- [ ] **Step 4: Commit**

```bash
git add src/panel.ts
git commit -m "feat(panel): .gitignore prompt on first user message"
```

---

### Task H2: Manual smoke pass

This task is the user's acceptance — no code changes.

- [ ] **Step 1: Build the extension fresh**

Run: `npm run build`

- [ ] **Step 2: Launch in extension dev host**

In VSCode, press F5 (uses the existing `.vscode/launch.json` from Plan 1). A new VSCode window opens with the extension loaded.

- [ ] **Step 3: Walk the success criteria from the spec § 2.4**

In the dev host:

1. Open a fresh test workspace.
2. Run `Agent Chat: Open Panel` from the command palette → empty chat appears, three agents marked ✓ in HealthStrip.
3. Send `@claude hello` → streaming reply appears, `█` cursor while streaming, persists.
4. Send `@all hi` → Claude / Codex / Gemini reply sequentially; FloorIndicator updates each turn.
5. Reload the dev host window (Developer: Reload Window) → reopen panel → history restored.
6. Run `codex logout` (or rename `~/.codex/auth.json`); reopen panel → Codex ✗; click ✗ → fix instructions popover; send `@gpt foo` → inline auth error.
7. In settings, change `agentChat.toolCallRenderStyle` between verbose / compact / hidden → tool-call rendering switches without reload.
8. In a fresh git repo without a `.gitignore` covering `.vscode/`, send the first message → prompt appears; click `[Add to .gitignore]` → `.gitignore` updated.

- [ ] **Step 4: Note any issues**

If any step fails, file as a follow-up task. Don't try to fix on the spot — Plan 2a is "ship the surface, then iterate."

- [ ] **Step 5: Mark Plan 2a complete**

When all 8 succeed, Plan 2a is done. Move to Plan 2b design.

---

## Self-review checklist (already run)

**Spec coverage:**
- §2 In scope: webview chat panel → ✓ G1 + F1–F6; Preact app → ✓ D1; @mention autocomplete → ✓ F5; FloorIndicator → ✓ F6; HealthStrip with click-to-fix → ✓ F6; per-workspace persistence → ✓ C2; .gitignore prompt → ✓ H1; real Agent.status() → ✓ B1+B2; inline error notices → ✓ F3 (SystemNotice) + F1 (AgentBubble error rendering); setting → ✓ G1; deferred items: parseMentions guard → ✓ A1; MessageRouter onFloorChange/onStatusChange → ✓ A2.
- §4 protocol: every event kind in `FromExtension` and `FromWebview` is produced or consumed in some task.
- §5 components: every component has a corresponding task.
- §6 schema: types in C1; SessionStore round-trips them in C2.
- §7 status checks: B1 + B2.
- §8 testing: unit tests for all listed modules; webview component visual review at H2; live integration tests untouched.

**Placeholder scan:** No "TBD" / vague-instruction / "implement later" patterns. All `<...>`-style angle brackets in code are concrete TypeScript syntax.

**Type consistency:** `AgentId`, `AgentStatus`, `AgentChunk`, `Session`, `UserMessage`, `AgentMessage`, `SystemMessage`, `InProgressMessage`, `ToolEvent`, `Settings`, `FromExtension`, `FromWebview` are defined once (in `src/types.ts` from Plan 1 or `src/shared/protocol.ts` from C1) and referenced consistently. The new `user-message-appended` event in G3 is added to `FromExtension`.

**Plan 2b will cover:** facilitator agent (function calling Claude SDK with routing prompt + agent profiles), routing chips in chat, hang detection (60s no-output warning), watchdog (5min forced floor release with notice), periodic auto-recheck of agent status, mapSdkEvent Option-A pass-through cleanup, and the manual smoke pass for full v1.
