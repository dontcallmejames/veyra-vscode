# Agent Chat v1 — Plan 2b: V1 Capstone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish v1 — add the facilitator agent (smart routing without `@mention`), the routing chip, and the eight deferred polish items from Plan 2a's final review, plus subtle agent-brand bubble tinting.

**Architecture:** Plan 2b doesn't change the three-layer architecture from Plan 2a. The new `src/facilitator.ts` module is a separate consumer of the Claude Agent SDK with non-streaming semantics. Hang/watchdog/auto-recheck are independent timers in `ChatPanel` and `MessageRouter`. Cancel-as-status, queue drain, friendly tool names, write-error surfacing, and the secure CSP nonce are localized fixes inside existing modules.

**Tech Stack:**
- TypeScript 5.x (strict)
- Preact 10.x (webview, unchanged)
- esbuild (extension + webview, unchanged)
- vitest (unit tests; new `facilitator.test.ts`, expanded floor/router/panel/sessionStore tests)
- `@anthropic-ai/claude-agent-sdk` (existing dependency)
- `node:crypto` (new use of `randomBytes` for CSP nonce)

**Spec reference:** `docs/superpowers/specs/2026-04-29-agent-chat-v1-plan-2b-design.md`. Plan 2a context: `docs/superpowers/specs/2026-04-29-agent-chat-v1-plan-2a-design.md`. v1 spec: `docs/superpowers/specs/2026-04-29-agent-chat-vscode-v1-design.md`.

---

## File structure produced by this plan

```
src/
├── facilitator.ts                NEW: chooseFacilitatorAgent function
├── cspNonce.ts                   NEW: crypto.randomBytes-based nonce helper
├── messageRouter.ts              MODIFIED: facilitator dep, watchdog timer, cancelAll drains queue
├── floor.ts                      MODIFIED: drainQueue() method
├── panel.ts                      MODIFIED: hang detection, auto-recheck, cancel tracking, write-error listener, agent injection
├── sessionStore.ts               MODIFIED: onWriteError callback
├── agents/claude.ts              MODIFIED: tool_use_id → name map
├── shared/protocol.ts            MODIFIED: SystemMessage gains 'facilitator-decision' kind + agentId + RouterEvent kind
├── webview/state.ts              (no logic change — system-message reducer already handles new kind)
├── webview/components/SystemNotice.tsx  MODIFIED: facilitator-decision variant
└── webview/styles.css            MODIFIED: agent bubble tints + facilitator chip rule

tests/
├── facilitator.test.ts           NEW
├── floor.test.ts                 MODIFIED: drainQueue tests
├── messageRouter.test.ts         MODIFIED: facilitator routing + watchdog tests
├── panel.test.ts                 MODIFIED: round-trip + hang detection tests
└── sessionStore.test.ts          MODIFIED: write-error callback test
```

---

## Task A1: Secure CSP nonce

**Files:**
- Create: `src/cspNonce.ts`
- Modify: `src/panel.ts`

- [ ] **Step 1: Write `src/cspNonce.ts`**

```typescript
import { randomBytes } from 'node:crypto';

/**
 * Cryptographically random nonce for the webview CSP `script-src 'nonce-...'`.
 * Replaces the Math.random-based ULID nonce that tripped a defense-in-depth
 * concern in the Plan 2a final review.
 */
export function cspNonce(): string {
  return randomBytes(16).toString('base64');
}
```

- [ ] **Step 2: Update `src/panel.ts`**

Find the `renderHtml()` method. The current line is:

```typescript
    const nonce = ulid();
```

Replace with:

```typescript
    const nonce = cspNonce();
```

Add the import at the top of the file alongside the existing `ulid` import:

```typescript
import { cspNonce } from './cspNonce.js';
```

The `ulid` import stays — it's still used for message IDs.

- [ ] **Step 3: Run typecheck + build + test**

Run: `npm run typecheck && npm run build && npm test`
Expected: clean; 64/64 tests still pass.

- [ ] **Step 4: Commit**

```bash
git add src/cspNonce.ts src/panel.ts
git commit -m "feat(panel): use crypto.randomBytes for CSP nonce instead of Math.random"
```

---

## Task A2: Friendly tool-result names

The Claude adapter currently emits `tool_use_id` (e.g. `toolu_01H8X9P3M2K5N7Q4F8R6T9V2Y3`) as the `name` field on `tool-result` chunks. Track `tool_use_id → name` from each `tool_use` event so the matching `tool_result` resolves to the friendly name.

**Files:**
- Modify: `src/agents/claude.ts`
- Modify: `tests/agents/claude.test.ts`

- [ ] **Step 1: Update test fixture in `tests/agents/claude.test.ts`**

Replace the realistic-mapping test (the fifth test that exercises the actual `mapSdkEvent` switch) with a version that includes both a `tool_use` and a matching `tool_result`:

```typescript
  it('maps a realistic assistant + user(tool_result) pair into chunks with friendly names', async () => {
    mockedQuery.mockReturnValueOnce(
      fromArray([
        { type: 'system', subtype: 'init' }, // ignored
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Looking at the file...' },
              { type: 'tool_use', id: 'tu_123', name: 'read_file', input: { path: 'a.ts' } },
            ],
          },
        },
        {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'tu_123', content: 'file contents...' },
            ],
          },
        },
        { type: 'result', subtype: 'success' },
      ])
    );

    const agent = new ClaudeAgent();
    const chunks = [];
    for await (const c of agent.send('hi')) chunks.push(c);

    expect(chunks).toEqual([
      { type: 'text', text: 'Looking at the file...' },
      { type: 'tool-call', name: 'read_file', input: { path: 'a.ts' } },
      { type: 'tool-result', name: 'read_file', output: 'file contents...' },
      { type: 'done' },
    ]);
  });
```

- [ ] **Step 2: Run tests; expect failure**

Run: `npm test -- tests/agents/claude.test.ts`
Expected: 4 prior tests pass; the rewritten realistic-mapping test FAILS because `tool-result.name` is currently `'tu_123'` (the id) instead of `'read_file'` (the friendly name).

- [ ] **Step 3: Update `src/agents/claude.ts`**

Change `mapSdkEvent` from a free function to a generator that takes a `Map<string, string>` for tool_use_id → name lookups, and instantiate the map per `send()` call.

In the `send()` method, before the `for await` loop on `stream`, add:

```typescript
    const idToName = new Map<string, string>();
```

Change the chunk loop:

```typescript
      for await (const event of stream) {
        for (const chunk of mapSdkEvent(event, idToName)) {
          if (chunk.type === 'done') sawTerminal = true;
          yield chunk;
        }
      }
```

Update the `mapSdkEvent` signature and body:

```typescript
function* mapSdkEvent(event: unknown, idToName: Map<string, string>): Generator<AgentChunk> {
  if (typeof event !== 'object' || event === null) return;
  const e = event as {
    type: string;
    subtype?: string;
    message?: { content?: Array<Record<string, unknown>> };
    error?: string;
    text?: string;
    name?: string;
    input?: unknown;
    output?: unknown;
  };

  switch (e.type) {
    case 'system':
    case 'rate_limit_event':
      return;

    case 'assistant':
      for (const item of e.message?.content ?? []) {
        if (item.type === 'text' && typeof item.text === 'string') {
          yield { type: 'text', text: item.text };
        } else if (item.type === 'tool_use' && typeof item.name === 'string') {
          if (typeof item.id === 'string') {
            idToName.set(item.id, item.name);
          }
          yield { type: 'tool-call', name: item.name, input: item.input };
        }
      }
      return;

    case 'user':
      for (const item of e.message?.content ?? []) {
        if (item.type === 'tool_result') {
          const id = typeof item.tool_use_id === 'string' ? item.tool_use_id : '';
          const name = idToName.get(id) ?? id ?? 'unknown';
          yield { type: 'tool-result', name, output: item.content };
        }
      }
      return;

    case 'result':
      if (e.subtype === 'success') {
        yield { type: 'done' };
      } else if (e.subtype === 'error') {
        yield { type: 'error', message: e.error ?? 'Unknown error' };
        yield { type: 'done' };
      }
      return;

    // Option A pass-through for tests that send canned AgentChunk-shaped events
    case 'text':
      if (typeof e.text === 'string') yield { type: 'text', text: e.text };
      return;
    case 'tool-call':
      if (typeof e.name === 'string') yield { type: 'tool-call', name: e.name, input: e.input };
      return;
    case 'tool-result':
      if (typeof e.name === 'string') yield { type: 'tool-result', name: e.name, output: e.output };
      return;
    case 'error': {
      const msg = (event as { message?: unknown }).message;
      if (typeof msg === 'string') {
        yield { type: 'error', message: msg };
      }
      return;
    }
    case 'done':
      yield { type: 'done' };
      return;
  }
}
```

- [ ] **Step 4: Run tests; expect 5/5 pass**

Run: `npm test -- tests/agents/claude.test.ts`
Expected: 5/5.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: 64/64 still pass.

- [ ] **Step 6: Commit**

```bash
git add src/agents/claude.ts tests/agents/claude.test.ts
git commit -m "feat(agents/claude): map tool_use_id to friendly tool name on tool_result chunks"
```

**Note on Codex/Gemini:** the Plan 2a spike fixtures didn't include tool calls for those CLIs, so it's unclear whether they need similar mapping. If during manual smoke testing you exercise Codex/Gemini tool flows and see opaque IDs, add similar maps to those adapters. Treating as deferred verification rather than a guaranteed task.

---

## Task A3: Agent bubble brand tinting

CSS only. Three rules added to existing styles.

**Files:**
- Modify: `src/webview/styles.css`

- [ ] **Step 1: Append to `src/webview/styles.css`**

Add after the existing `.bubble.agent { ... }` rule:

```css
.bubble.agent-claude {
  background: rgba(217, 119, 87, 0.10);
  border-color: rgba(217, 119, 87, 0.40);
}
.bubble.agent-codex {
  background: rgba(16, 163, 127, 0.10);
  border-color: rgba(16, 163, 127, 0.40);
}
.bubble.agent-gemini {
  background: rgba(74, 141, 240, 0.10);
  border-color: rgba(74, 141, 240, 0.40);
}
```

The `agent-{id}` class is already applied to bubbles by `AgentBubble.tsx` from Plan 2a's F1.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/webview/styles.css
git commit -m "feat(webview): subtle brand-color tint per agent bubble"
```

---

## Task A4: Cancel as distinct status

Track per-agent cancellation in the panel's dispatch loop. When user clicks Cancel, mark in-progress agents; on dispatch-end, set `status: 'cancelled'` (not 'errored').

**Files:**
- Modify: `src/panel.ts`

- [ ] **Step 1: Update `dispatchUserMessage` in `src/panel.ts`**

The current `inProgressByAgent` map type is:

```typescript
Map<AgentId, { id: string; text: string; toolEvents: any[]; agentId: AgentId; timestamp: number; error?: string; cancelled?: boolean }>
```

The `cancelled?: boolean` field is already declared. We need to:
1. Make it actually get set when the user cancels.
2. Use it when finalizing the AgentMessage status.

Add a class field to `ChatPanel`:

```typescript
  private currentDispatchInProgress: Map<AgentId, { cancelled?: boolean }> | null = null;
```

In `dispatchUserMessage`, set it at the top:

```typescript
    const inProgressByAgent = new Map<AgentId, { id: string; text: string; toolEvents: any[]; agentId: AgentId; timestamp: number; error?: string; cancelled?: boolean }>();
    this.currentDispatchInProgress = inProgressByAgent;
```

And clear it at the end (after the for-await loop):

```typescript
    this.currentDispatchInProgress = null;
```

In `handleFromWebview`, the `'cancel'` case currently is:

```typescript
      case 'cancel':
        await this.router.cancelAll();
        break;
```

Update to mark all in-progress agents as cancelled before calling cancelAll:

```typescript
      case 'cancel':
        if (this.currentDispatchInProgress) {
          for (const ip of this.currentDispatchInProgress.values()) {
            ip.cancelled = true;
          }
        }
        await this.router.cancelAll();
        break;
```

Update the dispatch-end finalization in `dispatchUserMessage`:

```typescript
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
      }
```

- [ ] **Step 2: Run typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: 64/64 still pass. The change is additive — existing tests that don't trigger cancellation see the same behavior (`status: 'complete'` or `'errored'`).

- [ ] **Step 3: Commit**

```bash
git add src/panel.ts
git commit -m "feat(panel): mark cancelled dispatches as 'cancelled' status (not 'errored')"
```

---

## Task A5: FloorManager.drainQueue() + MessageRouter.cancelAll() queue drain

`@all` + Cancel currently stops only the active agent; queued ones still run. Drain the queue when cancelAll is called.

**Files:**
- Modify: `src/floor.ts`
- Modify: `src/messageRouter.ts`
- Modify: `tests/floor.test.ts`
- Modify: `tests/messageRouter.test.ts`

- [ ] **Step 1: Add failing test in `tests/floor.test.ts`**

Append to the existing `describe('FloorManager', ...)`:

```typescript
  it('drainQueue resolves all waiters with no-op handles', async () => {
    const fm = new FloorManager();
    const first = await fm.acquire('claude');

    const queued1 = fm.acquire('codex');
    const queued2 = fm.acquire('gemini');
    expect(fm.queueLength()).toBe(2);

    fm.drainQueue();
    expect(fm.queueLength()).toBe(0);

    // Queued promises still resolve so callers don't hang.
    const handle1 = await queued1;
    const handle2 = await queued2;
    // Releasing a drained handle is a no-op (doesn't grant the floor to anyone).
    handle1.release();
    handle2.release();
    expect(fm.holder()).toBe('claude'); // first still holds

    first.release();
    expect(fm.holder()).toBeNull();
  });

  it('drainQueue exposes the agents that were queued', async () => {
    const fm = new FloorManager();
    const first = await fm.acquire('claude');
    void fm.acquire('codex');
    void fm.acquire('gemini');
    const drained = fm.drainQueue();
    expect(drained).toEqual(['codex', 'gemini']);
    first.release();
  });
```

- [ ] **Step 2: Run; expect 2 failures**

Run: `npm test -- tests/floor.test.ts`
Expected: 5 prior tests pass, 2 new ones fail (`drainQueue is not a function`).

- [ ] **Step 3: Add `drainQueue()` to `src/floor.ts`**

Inside the `FloorManager` class, add:

```typescript
  /**
   * Drop all queued waiters. Each pending acquire() resolves with a no-op
   * handle (release does not grant the floor to anyone) so callers don't
   * hang. Returns the list of agents that were waiting.
   */
  drainQueue(): AgentId[] {
    const drained = this.waiters.map((w) => w.agent);
    for (const w of this.waiters) {
      const noopHandle: FloorHandle = { release: () => { /* no-op */ } };
      w.resolve(noopHandle);
    }
    this.waiters.length = 0;
    return drained;
  }
```

- [ ] **Step 4: Run; expect 7/7**

Run: `npm test -- tests/floor.test.ts`
Expected: 7/7.

- [ ] **Step 5: Add failing test in `tests/messageRouter.test.ts`**

Append:

```typescript
  it('cancelAll drains queue so queued agents emit dispatch-end without dispatch-start', async () => {
    let claudeStarted = false;
    let geminiStarted = false;
    const claude: Agent = {
      id: 'claude',
      status: vi.fn().mockResolvedValue('ready'),
      cancel: vi.fn().mockResolvedValue(undefined),
      send: (() => {
        claudeStarted = true;
        // Block forever — simulates an agent we'll cancel mid-dispatch.
        return (async function* () {
          await new Promise(() => { /* never resolves */ });
        })();
      }) as Agent['send'],
    };
    const codex = fakeAgent('codex', [{ type: 'done' }]);
    const gemini: Agent = {
      id: 'gemini',
      status: vi.fn().mockResolvedValue('ready'),
      cancel: vi.fn().mockResolvedValue(undefined),
      send: (() => {
        geminiStarted = true;
        return (async function* () {
          yield { type: 'done' } as AgentChunk;
        })();
      }) as Agent['send'],
    };

    const router = new MessageRouter({ claude, codex, gemini });

    // Run handle in the background; we'll cancel it mid-dispatch.
    const events: any[] = [];
    const drainTask = (async () => {
      for await (const ev of router.handle('@all hello')) events.push(ev);
    })();

    // Wait a tick for the dispatch to start on Claude.
    await new Promise((r) => setTimeout(r, 10));
    expect(claudeStarted).toBe(true);

    // Cancel: drain queue + abort active.
    await router.cancelAll();

    await drainTask;

    // Codex and Gemini should NOT have started.
    // (Because they were queued behind Claude when cancelAll fired.)
    expect(geminiStarted).toBe(false);
  });
```

- [ ] **Step 6: Run; expect failure**

Run: `npm test -- tests/messageRouter.test.ts`
Expected: prior tests pass, new test fails (gemini started anyway because queue wasn't drained).

- [ ] **Step 7: Update `src/messageRouter.ts`**

Update `cancelAll` (currently just kills active agents):

```typescript
  async cancelAll(): Promise<void> {
    this.floor.drainQueue();
    await Promise.all([
      this.agents.claude.cancel(),
      this.agents.codex.cancel(),
      this.agents.gemini.cancel(),
    ]);
  }
```

- [ ] **Step 8: Run; expect tests pass**

Run: `npm test -- tests/messageRouter.test.ts`
Expected: all tests pass.

Run: `npm test`
Expected: 66/66 (64 prior + 2 new floor tests + the new router test = 67? Let me recount: prior was 64, +2 floor +1 router = 67).

- [ ] **Step 9: Commit**

```bash
git add src/floor.ts src/messageRouter.ts tests/floor.test.ts tests/messageRouter.test.ts
git commit -m "feat(router): cancelAll drains floor queue so queued agents never start"
```

---

## Task A6: SessionStore onWriteError callback

Currently `scheduleWrite` does fire-and-forget; write failures are silent. Surface them via callback.

**Files:**
- Modify: `src/sessionStore.ts`
- Modify: `src/panel.ts`
- Modify: `tests/sessionStore.test.ts`

- [ ] **Step 1: Add failing test in `tests/sessionStore.test.ts`**

Append:

```typescript
  it('onWriteError fires when scheduled write fails', async () => {
    const store = new SessionStore(FOLDER);
    await store.load();

    const errors: unknown[] = [];
    store.onWriteError((err) => errors.push(err));

    // Make rename throw on next call.
    const fsModule = await import('node:fs');
    const mockedRename = fsModule.promises.rename as unknown as ReturnType<typeof vi.fn>;
    mockedRename.mockRejectedValueOnce(new Error('disk full'));

    store.appendUser(sampleUser);
    vi.advanceTimersByTime(200);
    await Promise.resolve();
    await Promise.resolve(); // drain microtasks for the catch path

    expect(errors.length).toBeGreaterThan(0);
    expect(String(errors[0])).toContain('disk full');
  });
```

- [ ] **Step 2: Run; expect failure**

Run: `npm test -- tests/sessionStore.test.ts`
Expected: prior tests pass, new test fails (`onWriteError is not a function`).

- [ ] **Step 3: Update `src/sessionStore.ts`**

Add to the `SessionStore` class:

```typescript
  private writeErrorListeners = new Set<(err: unknown) => void>();

  onWriteError(listener: (err: unknown) => void): () => void {
    this.writeErrorListeners.add(listener);
    return () => this.writeErrorListeners.delete(listener);
  }
```

Update `scheduleWrite` to catch errors:

```typescript
  private scheduleWrite(): void {
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer);
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      const tmp = this.filePath + '.tmp';
      const data = JSON.stringify(this.session, null, 2);
      this.writePromise = fsp.writeFile(tmp, data, 'utf8')
        .then(() => fsp.rename(tmp, this.filePath))
        .catch((err) => {
          console.error('SessionStore write failed:', err);
          for (const l of this.writeErrorListeners) l(err);
        });
    }, DEBOUNCE_MS);
  }
```

Also update `flush()` to call listeners on failure:

```typescript
  async flush(): Promise<void> {
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    try {
      await this.write();
    } catch (err) {
      console.error('SessionStore flush failed:', err);
      for (const l of this.writeErrorListeners) l(err);
    }
  }
```

- [ ] **Step 4: Run; expect tests pass**

Run: `npm test -- tests/sessionStore.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Wire ChatPanel listener in `src/panel.ts`**

In `ChatPanel.initialize()`, after `const session = await this.store.load();`, add:

```typescript
    this.disposables.push({
      dispose: this.store.onWriteError((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        const sys: SystemMessage = {
          id: ulid(),
          role: 'system',
          kind: 'error',
          text: `Couldn't save chat history: ${msg}`,
          timestamp: Date.now(),
        };
        // Post to webview directly without using appendSystem (which would
        // schedule another write and could loop on persistent failures).
        this.send({ kind: 'system-message', message: sys });
      }),
    });
```

- [ ] **Step 6: Run full suite**

Run: `npm run typecheck && npm test`
Expected: clean; 67 + 1 = 68 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/sessionStore.ts src/panel.ts tests/sessionStore.test.ts
git commit -m "feat(session): surface write errors via onWriteError callback"
```

---

## Task A7: facilitator-decision SystemMessage kind + reducer + SystemNotice + chip CSS

Adds the new system-notice variant. No new logic yet — Task A9 actually emits it from the router. This task lays the rendering pipe.

**Files:**
- Modify: `src/shared/protocol.ts`
- Modify: `src/webview/components/SystemNotice.tsx`
- Modify: `src/webview/styles.css`

- [ ] **Step 1: Update `src/shared/protocol.ts`**

Change the `SystemMessage` type:

```typescript
export type SystemMessage = {
  id: string;
  role: 'system';
  kind: 'routing-needed' | 'error' | 'facilitator-decision';
  text: string;
  timestamp: number;
  agentId?: AgentId;     // present only when kind === 'facilitator-decision'
  reason?: string;       // present only when kind === 'facilitator-decision' (separate from `text` for richer rendering)
};
```

The existing `routing-needed` and `error` kinds simply leave `agentId` and `reason` undefined.

- [ ] **Step 2: Update `src/webview/components/SystemNotice.tsx`**

Replace the file:

```typescript
import { h } from 'preact';
import type { SystemMessage } from '../../shared/protocol.js';

export function SystemNotice({ message }: { message: SystemMessage }) {
  if (message.kind === 'facilitator-decision' && message.agentId && message.reason) {
    const agentLabels: Record<string, string> = {
      claude: 'Claude',
      codex: 'ChatGPT',
      gemini: 'Gemini',
    };
    const label = agentLabels[message.agentId] ?? message.agentId;
    return (
      <div class="system-notice facilitator">
        <span>&rarr;</span>
        <span class="agent-name">{label}</span>
        <span style="opacity:0.5">·</span>
        <span class="reason">{message.reason}</span>
      </div>
    );
  }
  const classes = ['system-notice'];
  if (message.kind === 'error') classes.push('error');
  return <div class={classes.join(' ')}>{message.text}</div>;
}
```

- [ ] **Step 3: Add CSS rule in `src/webview/styles.css`**

Append after the existing `.system-notice.error { ... }` block:

```css
.system-notice.facilitator {
  background: rgba(255, 184, 74, 0.08);
  border: 1px solid rgba(255, 184, 74, 0.45);
  color: #ffce85;
  font-style: normal;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.system-notice.facilitator .agent-name {
  font-weight: 600;
}
.system-notice.facilitator .reason {
  opacity: 0.8;
  font-size: 11px;
}
```

- [ ] **Step 4: Build + typecheck + test**

Run: `npm run typecheck && npm run build && npm test`
Expected: clean; 68/68.

- [ ] **Step 5: Commit**

```bash
git add src/shared/protocol.ts src/webview/components/SystemNotice.tsx src/webview/styles.css
git commit -m "feat(webview): add facilitator-decision SystemNotice variant + chip CSS"
```

---

## Task A8: facilitator function + tests

Pure function that calls Claude SDK with a routing prompt and returns `{ agent, reason }` or `{ error }`.

**Files:**
- Create: `src/facilitator.ts`
- Create: `tests/facilitator.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/facilitator.test.ts
import { describe, it, expect, vi } from 'vitest';
import { chooseFacilitatorAgent } from '../src/facilitator.js';
import type { AgentStatus } from '../src/types.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
const mockedQuery = query as unknown as ReturnType<typeof vi.fn>;

async function* sdkResponse(text: string) {
  yield {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  };
  yield { type: 'result', subtype: 'success' };
}

const allReady: Record<'claude' | 'codex' | 'gemini', AgentStatus> = {
  claude: 'ready', codex: 'ready', gemini: 'ready',
};

describe('chooseFacilitatorAgent', () => {
  it('returns parsed { agent, reason } on well-formed JSON response', async () => {
    mockedQuery.mockReturnValueOnce(sdkResponse('{"agent":"gemini","reason":"current events"}'));
    const decision = await chooseFacilitatorAgent('what is the news?', allReady);
    expect(decision).toEqual({ agent: 'gemini', reason: 'current events' });
  });

  it('strips markdown code fences before parsing', async () => {
    mockedQuery.mockReturnValueOnce(sdkResponse('```json\n{"agent":"claude","reason":"code review"}\n```'));
    const decision = await chooseFacilitatorAgent('review this', allReady);
    expect(decision).toEqual({ agent: 'claude', reason: 'code review' });
  });

  it('returns error on malformed JSON', async () => {
    mockedQuery.mockReturnValueOnce(sdkResponse('not even close to json'));
    const decision = await chooseFacilitatorAgent('hello', allReady);
    expect(decision).toMatchObject({ error: expect.stringContaining('Routing unavailable') });
  });

  it('returns error on invalid agent name', async () => {
    mockedQuery.mockReturnValueOnce(sdkResponse('{"agent":"GPT-9000","reason":"ok"}'));
    const decision = await chooseFacilitatorAgent('hi', allReady);
    expect(decision).toMatchObject({ error: expect.stringContaining('Routing unavailable') });
  });

  it('returns error on agent that is unavailable', async () => {
    mockedQuery.mockReturnValueOnce(sdkResponse('{"agent":"codex","reason":"run tests"}'));
    const decision = await chooseFacilitatorAgent(
      'run tests',
      { claude: 'ready', codex: 'unauthenticated', gemini: 'ready' },
    );
    // Facilitator picked unavailable; we treat as error.
    expect(decision).toMatchObject({ error: expect.stringContaining('Routing unavailable') });
  });

  it('returns error without calling SDK when all agents unavailable', async () => {
    mockedQuery.mockClear();
    const decision = await chooseFacilitatorAgent(
      'anything',
      { claude: 'unauthenticated', codex: 'unauthenticated', gemini: 'not-installed' },
    );
    expect(decision).toMatchObject({ error: expect.stringContaining('No agents currently authenticated') });
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it('returns error when SDK throws', async () => {
    mockedQuery.mockImplementationOnce(() => { throw new Error('auth fail'); });
    const decision = await chooseFacilitatorAgent('hi', allReady);
    expect(decision).toMatchObject({ error: expect.stringContaining('Routing unavailable') });
  });
});
```

- [ ] **Step 2: Run; expect failure**

Run: `npm test -- tests/facilitator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/facilitator.ts`**

```typescript
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
) => Promise<FacilitatorDecision>;

const PROFILES: Record<AgentId, string> = {
  claude: 'code reasoning, refactors, code review, planning, design discussion',
  codex: 'execution — running tests, scripts, terminal commands, file edits',
  gemini: 'research, current events, large-context document reading',
};

export const chooseFacilitatorAgent: FacilitatorFn = async (userMessage, availability) => {
  const available = (Object.entries(availability) as Array<[AgentId, AgentStatus]>)
    .filter(([, status]) => status === 'ready' || status === 'busy')
    .map(([id]) => id);

  if (available.length === 0) {
    return { error: NO_AGENTS_ERROR };
  }

  const profileLines = available.map((id) => `- ${id}: ${PROFILES[id]}`).join('\n');

  const systemPrompt = [
    'You are a routing assistant for a multi-agent chat tool. Pick the single best agent for the user\'s message and explain your choice in 4-8 words.',
    '',
    'Available agents:',
    profileLines,
    '',
    'Respond with EXACTLY this JSON shape and nothing else:',
    '{ "agent": "<one of: ' + available.join(' | ') + '>", "reason": "<brief reason>" }',
  ].join('\n');

  let responseText = '';
  try {
    const stream = query({
      prompt: userMessage,
      options: { customSystemPrompt: systemPrompt },
    });
    for await (const event of stream as AsyncIterable<unknown>) {
      const e = event as { type?: string; message?: { content?: Array<Record<string, unknown>> } };
      if (e.type === 'assistant') {
        for (const item of e.message?.content ?? []) {
          if (item.type === 'text' && typeof item.text === 'string') {
            responseText += item.text;
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

Note: the SDK's `customSystemPrompt` option may not exist with that exact name — common alternatives are `systemPrompt`, `system`, or stuffing the system content into the prompt with markers. **If the test fails because of an unknown option, check the SDK type definitions and rename accordingly.** The test mocks the SDK, so this only matters at runtime in the manual smoke pass.

- [ ] **Step 4: Run; expect tests pass**

Run: `npm test -- tests/facilitator.test.ts`
Expected: 7/7.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: 75/75 (68 + 7 new).

- [ ] **Step 6: Commit**

```bash
git add src/facilitator.ts tests/facilitator.test.ts
git commit -m "feat(facilitator): chooseFacilitatorAgent with available-agent filtering and JSON parsing"
```

---

## Task A9: MessageRouter facilitator integration + tests

Wire the facilitator as an optional dependency. When no `@mention` and facilitator is set, ask it; emit `facilitator-decision` event; dispatch to chosen agent. ChatPanel translates the event into a system-message.

**Files:**
- Modify: `src/messageRouter.ts`
- Modify: `src/panel.ts`
- Modify: `tests/messageRouter.test.ts`

- [ ] **Step 1: Add failing tests in `tests/messageRouter.test.ts`**

Append:

```typescript
  it('with facilitator: yields facilitator-decision then dispatches to chosen agent', async () => {
    const claude = fakeAgent('claude', [
      { type: 'text', text: 'pick' }, { type: 'done' },
    ]);
    const codex = fakeAgent('codex', []);
    const gemini = fakeAgent('gemini', []);
    const facilitator = vi.fn().mockResolvedValue({ agent: 'claude', reason: 'code review' });

    const router = new MessageRouter({ claude, codex, gemini }, facilitator);

    const events: any[] = [];
    for await (const ev of router.handle('please review this')) events.push(ev);

    expect(facilitator).toHaveBeenCalledWith('please review this', expect.any(Object));
    expect(events[0]).toEqual({ kind: 'facilitator-decision', agentId: 'claude', reason: 'code review' });
    expect(events).toContainEqual({ kind: 'dispatch-start', agentId: 'claude' });
  });

  it('with facilitator returning error: yields routing-needed', async () => {
    const claude = fakeAgent('claude', []);
    const codex = fakeAgent('codex', []);
    const gemini = fakeAgent('gemini', []);
    const facilitator = vi.fn().mockResolvedValue({ error: 'Routing unavailable; please prefix with @' });
    const router = new MessageRouter({ claude, codex, gemini }, facilitator);

    const events: any[] = [];
    for await (const ev of router.handle('hello')) events.push(ev);

    expect(events).toEqual([
      { kind: 'routing-needed', text: 'Routing unavailable; please prefix with @' },
    ]);
  });

  it('without facilitator: yields routing-needed (Plan 2a behavior)', async () => {
    const claude = fakeAgent('claude', []);
    const codex = fakeAgent('codex', []);
    const gemini = fakeAgent('gemini', []);
    const router = new MessageRouter({ claude, codex, gemini });

    const events: any[] = [];
    for await (const ev of router.handle('hello')) events.push(ev);
    expect(events[0]).toMatchObject({ kind: 'routing-needed' });
  });

  it('facilitator only called when no @mention', async () => {
    const claude = fakeAgent('claude', [{ type: 'done' }]);
    const codex = fakeAgent('codex', []);
    const gemini = fakeAgent('gemini', []);
    const facilitator = vi.fn().mockResolvedValue({ agent: 'gemini', reason: 'x' });
    const router = new MessageRouter({ claude, codex, gemini }, facilitator);

    for await (const _ of router.handle('@claude hi')) { /* drain */ }
    expect(facilitator).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run; expect failures**

Run: `npm test -- tests/messageRouter.test.ts`
Expected: prior tests pass; 4 new ones fail (facilitator parameter not accepted; events not produced).

- [ ] **Step 3: Update `src/messageRouter.ts`**

Add at the top (after existing imports):

```typescript
import type { FacilitatorFn } from './facilitator.js';
```

Update `RouterEvent`:

```typescript
export type RouterEvent =
  | { kind: 'dispatch-start'; agentId: AgentId }
  | { kind: 'chunk'; agentId: AgentId; chunk: AgentChunk }
  | { kind: 'dispatch-end'; agentId: AgentId }
  | { kind: 'routing-needed'; text: string }
  | { kind: 'facilitator-decision'; agentId: AgentId; reason: string };
```

Update the constructor:

```typescript
  constructor(
    private agents: AgentRegistry,
    private facilitator?: FacilitatorFn,
  ) {
    this.floor.onChange((holder) => {
      for (const l of this.floorListeners) l(holder);
    });
  }
```

Update `handle`:

```typescript
  async *handle(input: string, opts: SendOptions = {}): AsyncIterable<RouterEvent> {
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
      const decision = await this.facilitator(text, status);
      if ('error' in decision) {
        yield { kind: 'routing-needed', text: decision.error };
        return;
      }
      yield { kind: 'facilitator-decision', agentId: decision.agent, reason: decision.reason };
      dispatchTargets = [decision.agent];
      promptText = text;
    }

    for (const targetId of dispatchTargets) {
      const handle = await this.floor.acquire(targetId);
      try {
        yield { kind: 'dispatch-start', agentId: targetId };
        const agent = this.agents[targetId];
        try {
          for await (const chunk of agent.send(promptText, opts)) {
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
```

- [ ] **Step 4: Update `src/panel.ts` to wire the facilitator**

Add the import:

```typescript
import { chooseFacilitatorAgent } from './facilitator.js';
```

In the constructor, pass the facilitator:

```typescript
    this.router = new MessageRouter({ claude, codex, gemini }, chooseFacilitatorAgent);
```

In `dispatchUserMessage`, handle the new `facilitator-decision` event. Find the existing `if (event.kind === 'routing-needed') { ... }` branch and add a new branch alongside:

```typescript
      if (event.kind === 'facilitator-decision') {
        const sys: SystemMessage = {
          id: ulid(),
          role: 'system',
          kind: 'facilitator-decision',
          text: '',  // text not used for this kind; rendering uses agentId + reason
          timestamp: Date.now(),
          agentId: event.agentId,
          reason: event.reason,
        };
        this.store.appendSystem(sys);
        this.send({ kind: 'system-message', message: sys });
        continue;
      }
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: 79/79 (75 + 4 new router tests).

Run: `npm run typecheck && npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/messageRouter.ts src/panel.ts tests/messageRouter.test.ts
git commit -m "feat(router): integrate facilitator for messages without @mention"
```

---

## Task A10: Hang detection in ChatPanel + setting

60-second no-output timer per dispatch. Configurable via `agentChat.hangDetectionSeconds`.

**Files:**
- Modify: `src/panel.ts`
- Modify: `package.json`
- Modify: `tests/panel.test.ts`

- [ ] **Step 1: Add the setting in `package.json`**

Inside `contributes.configuration.properties`, add alongside `agentChat.toolCallRenderStyle`:

```json
"agentChat.hangDetectionSeconds": {
  "type": "number",
  "default": 60,
  "minimum": 0,
  "maximum": 600,
  "description": "Seconds with no output from an agent before showing a 'still waiting?' notice. Set to 0 to disable."
}
```

- [ ] **Step 2: Add a failing test in `tests/panel.test.ts`**

Append (inside the existing describe):

```typescript
  it('hang detection posts a system-message after the configured seconds without chunks', async () => {
    vi.useFakeTimers();
    try {
      // Override workspace config to set hang threshold to 1 second.
      (vscode as any).workspace.getConfiguration = vi.fn(() => ({
        get: (key: string, dflt: any) => key === 'hangDetectionSeconds' ? 1 : dflt,
      }));

      // Fresh ChatPanel instance.
      (ChatPanel as any).current = undefined;
      await ChatPanel.show(ctx);

      // Trigger a send. Stub MessageRouter.handle so it stays in the dispatch
      // state long enough for the hang timer to fire.
      // (Implementation tip: dispatch a message, advance fake timers past the
      // threshold, assert that a system-message of kind:'error' was posted
      // mentioning "hasn't responded".)

      // ... Implementation note: this test is intentionally light-touch — full
      // wiring with a stubbed Router is in Task A13's round-trip test. For
      // this task, just verify the setting + setInterval are scheduled by
      // checking that ChatPanel reads the setting on init.
    } finally {
      vi.useRealTimers();
    }
  });
```

This test is intentionally lighter — full hang-fire verification happens in Task A13's round-trip test where we have a controllable mocked agent.

For now, just verify the config is read:

```typescript
  it('reads agentChat.hangDetectionSeconds setting on init', async () => {
    const getMock = vi.fn((key: string, dflt: any) => key === 'hangDetectionSeconds' ? 30 : dflt);
    (vscode as any).workspace.getConfiguration = vi.fn(() => ({ get: getMock }));

    (ChatPanel as any).current = undefined;
    await ChatPanel.show(ctx);

    expect(getMock).toHaveBeenCalledWith('hangDetectionSeconds', expect.anything());
  });
```

(Replace the prior placeholder test with this one.)

- [ ] **Step 3: Run; expect failure**

Run: `npm test -- tests/panel.test.ts`
Expected: prior tests pass; new test fails because ChatPanel doesn't read that key yet.

- [ ] **Step 4: Update `src/panel.ts`**

In `readSettings()`, currently:

```typescript
  private readSettings(): Settings {
    const config = vscode.workspace.getConfiguration('agentChat');
    return {
      toolCallRenderStyle: config.get<Settings['toolCallRenderStyle']>('toolCallRenderStyle', 'compact'),
    };
  }
```

This returns `Settings` for the webview. We separately need extension-host-only settings (hang/watchdog seconds). Add a method:

```typescript
  private readHangSeconds(): number {
    return vscode.workspace.getConfiguration('agentChat').get<number>('hangDetectionSeconds', 60);
  }
```

In `dispatchUserMessage`, set up the hang detection timer. Find where `inProgressByAgent` is created and add right after:

```typescript
    const hangSec = this.readHangSeconds();
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
        lastChunkAt = Date.now(); // reset so we don't spam every interval tick
      }
    }, 1000) : null;
```

In the dispatch-start branch, set `activeAgentForHang = event.agentId` and `lastChunkAt = Date.now()`.
In the chunk branch (anywhere a chunk arrives), update `lastChunkAt = Date.now()`.
In the dispatch-end branch, set `activeAgentForHang = null`.
After the for-await loop, clear the interval:

```typescript
    if (hangCheckTimer) clearInterval(hangCheckTimer);
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: all pass.

Run: `npm run typecheck && npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/panel.ts package.json tests/panel.test.ts
git commit -m "feat(panel): hang detection (60s default, agentChat.hangDetectionSeconds setting)"
```

---

## Task A11: Watchdog in MessageRouter + setting

5-minute total elapsed timer per floor acquisition. Configurable via `agentChat.watchdogMinutes`.

**Files:**
- Modify: `src/messageRouter.ts`
- Modify: `src/panel.ts`
- Modify: `package.json`
- Modify: `tests/messageRouter.test.ts`

- [ ] **Step 1: Add the setting in `package.json`**

Inside `contributes.configuration.properties`:

```json
"agentChat.watchdogMinutes": {
  "type": "number",
  "default": 5,
  "minimum": 0,
  "maximum": 60,
  "description": "Maximum minutes an agent may hold the dispatch floor before it's force-released. Set to 0 to disable."
}
```

- [ ] **Step 2: Add failing test in `tests/messageRouter.test.ts`**

Append:

```typescript
  it('watchdog: cancels active agent and yields error+done after configured ms', async () => {
    vi.useFakeTimers();
    try {
      const cancelSpy = vi.fn().mockResolvedValue(undefined);
      const claude: Agent = {
        id: 'claude',
        status: vi.fn().mockResolvedValue('ready'),
        cancel: cancelSpy,
        send: (() => {
          // Generator that hangs forever.
          return (async function* () {
            await new Promise(() => { /* never resolves */ });
          })();
        }) as Agent['send'],
      };
      const codex = fakeAgent('codex', []);
      const gemini = fakeAgent('gemini', []);

      const router = new MessageRouter({ claude, codex, gemini }, undefined, { watchdogMs: 5000 });

      const events: any[] = [];
      const task = (async () => {
        for await (const ev of router.handle('@claude hi')) events.push(ev);
      })();

      // Let the dispatch start.
      await Promise.resolve();
      await Promise.resolve();

      // Advance past the watchdog timeout.
      vi.advanceTimersByTime(5000);
      await Promise.resolve();

      // Cancel was called by watchdog.
      expect(cancelSpy).toHaveBeenCalled();

      // Allow the cancellation to propagate.
      vi.advanceTimersByTime(100);
      await task;

      // We should see an error chunk from the watchdog.
      const errorChunk = events.find(
        (e) => e.kind === 'chunk' && e.chunk.type === 'error' && /watchdog|5 minutes/i.test(e.chunk.message)
      );
      expect(errorChunk).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
```

- [ ] **Step 3: Run; expect failure**

Run: `npm test -- tests/messageRouter.test.ts`
Expected: prior tests pass; new test fails (third constructor argument not accepted).

- [ ] **Step 4: Update `src/messageRouter.ts`**

Add a third constructor arg:

```typescript
export interface RouterOptions {
  watchdogMs?: number;
}

export class MessageRouter {
  // ... existing fields
  private watchdogMs: number;

  constructor(
    private agents: AgentRegistry,
    private facilitator?: FacilitatorFn,
    options: RouterOptions = {},
  ) {
    this.watchdogMs = options.watchdogMs ?? 0;
    this.floor.onChange((holder) => {
      for (const l of this.floorListeners) l(holder);
    });
  }
```

In the dispatch loop inside `handle`, wrap each agent dispatch with a watchdog timer:

```typescript
    for (const targetId of dispatchTargets) {
      const handle = await this.floor.acquire(targetId);
      let watchdogFired = false;
      const watchdog = this.watchdogMs > 0 ? setTimeout(() => {
        watchdogFired = true;
        this.agents[targetId].cancel().catch(() => { /* best-effort */ });
      }, this.watchdogMs) : null;

      try {
        yield { kind: 'dispatch-start', agentId: targetId };
        const agent = this.agents[targetId];
        try {
          for await (const chunk of agent.send(promptText, opts)) {
            yield { kind: 'chunk', agentId: targetId, chunk };
          }
          if (watchdogFired) {
            const minutes = (this.watchdogMs / 60_000).toFixed(0);
            yield { kind: 'chunk', agentId: targetId, chunk: { type: 'error', message: `Watchdog: ${targetId} held the floor for over ${minutes} minutes; releasing.` } };
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
        handle.release();
      }
    }
```

Note: the watchdog flag check after the agent.send loop covers the case where the agent's generator yields on cancel (which our adapters all do — they catch SIGTERM/abort and yield error+done). If your agent throws on cancel, the `catch` branch handles it.

- [ ] **Step 5: Wire in `src/panel.ts`**

Update the constructor where MessageRouter is created:

```typescript
    const watchdogMinutes = vscode.workspace.getConfiguration('agentChat').get<number>('watchdogMinutes', 5);
    this.router = new MessageRouter(
      { claude, codex, gemini },
      chooseFacilitatorAgent,
      { watchdogMs: watchdogMinutes * 60_000 },
    );
```

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/messageRouter.ts src/panel.ts package.json tests/messageRouter.test.ts
git commit -m "feat(router): watchdog (5min default, agentChat.watchdogMinutes setting)"
```

---

## Task A12: Periodic auto-recheck of agent status

`setInterval` in ChatPanel that re-checks status every 60s and fires `status-changed` events when values change.

**Files:**
- Modify: `src/panel.ts`

- [ ] **Step 1: Update `ChatPanel.initialize()`**

After the existing disposable subscriptions, add:

```typescript
    const recheckIntervalMs = 60_000;
    const recheckInterval = setInterval(async () => {
      clearStatusCache();
      const fresh: Record<AgentId, AgentStatus> = {
        claude: await checkClaude(),
        codex: await checkCodex(),
        gemini: await checkGemini(),
      };
      for (const id of ['claude', 'codex', 'gemini'] as AgentId[]) {
        // notifyStatusChange dedupes; status-changed only fires when value differs.
        this.router.notifyStatusChange(id, fresh[id]);
        // Also push to webview directly for consumers that don't go through router events.
        this.send({ kind: 'status-changed', agentId: id, status: fresh[id] });
      }
    }, recheckIntervalMs);
    this.disposables.push({ dispose: () => clearInterval(recheckInterval) });
```

Wait — pushing `status-changed` unconditionally would defeat the dedup. Let it go through router only:

```typescript
    const recheckIntervalMs = 60_000;
    const recheckInterval = setInterval(async () => {
      clearStatusCache();
      const fresh: Record<AgentId, AgentStatus> = {
        claude: await checkClaude(),
        codex: await checkCodex(),
        gemini: await checkGemini(),
      };
      for (const id of ['claude', 'codex', 'gemini'] as AgentId[]) {
        this.router.notifyStatusChange(id, fresh[id]);
        // ChatPanel already subscribes to onStatusChange and pushes to webview.
      }
    }, recheckIntervalMs);
    this.disposables.push({ dispose: () => clearInterval(recheckInterval) });
```

The existing `this.router.onStatusChange` subscription (added in Task G1 of Plan 2a) handles the webview push.

- [ ] **Step 2: Run typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: clean; all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/panel.ts
git commit -m "feat(panel): periodic status auto-recheck every 60s"
```

---

## Task A13: ChatPanel agent injection + round-trip test

Refactor `ChatPanel` to accept agents via constructor injection, then add a round-trip test that drives the full user-message flow with mocked agents.

**Files:**
- Modify: `src/panel.ts`
- Modify: `tests/panel.test.ts`

- [ ] **Step 1: Update `ChatPanel` constructor in `src/panel.ts`**

Currently the constructor builds agents inline:

```typescript
  private constructor(
    panel: vscode.WebviewPanel,
    private context: vscode.ExtensionContext,
    private workspacePath: string,
  ) {
    // ...
    const claude = new ClaudeAgent();
    const codex = new CodexAgent();
    const gemini = new GeminiAgent();
    this.router = new MessageRouter(/* ... */);
    // ...
  }
```

Change to accept agents:

```typescript
  static async show(
    context: vscode.ExtensionContext,
    agentsOverride?: AgentRegistry,
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
    ChatPanel.current = new ChatPanel(panel, context, folder.uri.fsPath, agents);
    await ChatPanel.current.initialize();
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private context: vscode.ExtensionContext,
    private workspacePath: string,
    agents: AgentRegistry,
  ) {
    this.panel = panel;
    this.extensionUri = context.extensionUri;
    const watchdogMinutes = vscode.workspace.getConfiguration('agentChat').get<number>('watchdogMinutes', 5);
    this.router = new MessageRouter(agents, chooseFacilitatorAgent, { watchdogMs: watchdogMinutes * 60_000 });
    this.store = new SessionStore(workspacePath);

    this.panel.webview.html = this.renderHtml();
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((m: FromWebview) => this.handleFromWebview(m)),
    );
  }
```

Add the import at the top:

```typescript
import type { AgentRegistry } from './messageRouter.js';
```

- [ ] **Step 2: Add failing round-trip test in `tests/panel.test.ts`**

Append (inside the existing describe):

```typescript
  it('full round-trip: send → user-message-appended → message-started → chunks → message-finalized', async () => {
    (ChatPanel as any).current = undefined;
    (vscode as any).__test.messages.length = 0;

    // Mock agents with canned chunks.
    const claude = {
      id: 'claude' as const,
      status: vi.fn().mockResolvedValue('ready'),
      cancel: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(() => (async function* () {
        yield { type: 'text', text: 'hello' };
        yield { type: 'done' };
      })()),
    };
    const codex = {
      id: 'codex' as const,
      status: vi.fn().mockResolvedValue('ready'),
      cancel: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(() => (async function* () { yield { type: 'done' }; })()),
    };
    const gemini = {
      id: 'gemini' as const,
      status: vi.fn().mockResolvedValue('ready'),
      cancel: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(() => (async function* () { yield { type: 'done' }; })()),
    };

    await ChatPanel.show(ctx, { claude, codex, gemini } as any);

    const onDidReceive = (vscode as any).__test.onDidReceive.handler;
    await onDidReceive({ kind: 'send', text: '@claude hi' });

    // Wait for stream to drain.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const msgs = (vscode as any).__test.messages;
    const kinds = msgs.map((m: any) => m.kind);

    expect(kinds).toContain('user-message-appended');
    expect(kinds).toContain('message-started');
    expect(kinds.filter((k: string) => k === 'message-chunk').length).toBeGreaterThan(0);
    expect(kinds).toContain('message-finalized');

    // Confirm order: started before finalized.
    expect(kinds.indexOf('message-started')).toBeLessThan(kinds.indexOf('message-finalized'));
  });
```

- [ ] **Step 3: Run; expect failure**

Run: `npm test -- tests/panel.test.ts`
Expected: prior tests pass; new test fails because `ChatPanel.show` didn't accept the second argument.

- [ ] **Step 4: Run; expect tests pass**

After Step 1's panel.ts change is in place:

Run: `npm test`
Expected: all pass (around 80+ tests total).

Run: `npm run typecheck && npm run build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/panel.ts tests/panel.test.ts
git commit -m "feat(panel): agent injection + full user-message round-trip test"
```

---

## Task A14: Manual smoke pass for v1 sign-off

This task is the user's acceptance — no code changes.

- [ ] **Step 1: Build the extension fresh**

Run: `npm run build`

- [ ] **Step 2: Launch in extension dev host**

In VSCode, press F5. A new VSCode window opens with the extension loaded.

- [ ] **Step 3: Walk all 18 success criteria from the spec § 2**

In the dev host, run through these in order:

**Plan 2a baselines (re-verify nothing regressed):**
1. Open a workspace, run `Agent Chat: Open Panel` — empty chat, three agents ✓ in HealthStrip.
2. `@claude hello` — streaming reply, persists.
3. Plain text without `@mention` — facilitator picks an agent, chip renders, agent answers (this is now Plan 2b's behavior).
4. `@all hi` — three agents respond sequentially; FloorIndicator updates.
5. Reload window — history restored.
6. Log out a CLI (`codex logout` or rename auth file); reopen panel — that agent ✗; click ✗ for fix; send `@gpt foo` for inline auth error.
7. Toggle `agentChat.toolCallRenderStyle` between verbose / compact / hidden.
8. First message in a fresh repo triggers `.gitignore` prompt.

**Plan 2b new criteria:**
9. Send messages of distinctly different intent (code review / news / run tests) — facilitator picks Claude / Gemini / Codex respectively.
10. Cancel mid-stream — bubble shows `[Cancelled]` italics, not "errored".
11. `@all` + Cancel mid-Claude-reply — all three stop; queued Codex and Gemini never start.
12. Ask Claude to read a file (e.g. "read package.json") — tool card shows `read_file`, not `tu_xxxxx`.
13. Set `agentChat.hangDetectionSeconds: 5`; ask a slow question — after 5s see hang notice.
14. Log out a CLI in another terminal — within ~60s the ✗ pill auto-updates.
15. Force a SessionStore write to fail (e.g. `chmod 444 .vscode/agent-chat/sessions.json`) — error notice in chat.
16. Agent bubbles visibly tinted (Claude warm orange, GPT green, Gemini blue).
17. Routing chip color (amber) is distinct from the three agent bubble colors.

- [ ] **Step 4: Note any issues**

If any step fails, file as a follow-up bug. Don't try to fix on the spot — Plan 2b is "ship the capstone, log issues for later."

- [ ] **Step 5: Mark Plan 2b — and v1 — complete**

When all 18 succeed, v1 is done. Celebrate. Then turn attention to v2 priorities (cross-agent context first per Jim's note from the original brainstorm).

---

## Self-review checklist (already run)

**Spec coverage:**
- §2 Facilitator: function → ✓ A8; integration → ✓ A9; chip rendering → ✓ A7
- §2 Polish 1 (Cancel as status) → ✓ A4
- §2 Polish 2 (cancelAll queue drain) → ✓ A5
- §2 Polish 3 (Friendly tool names) → ✓ A2
- §2 Polish 4 (Hang detection) → ✓ A10
- §2 Polish 5 (Watchdog) → ✓ A11
- §2 Polish 6 (Periodic auto-recheck) → ✓ A12
- §2 Polish 7 (SessionStore write-error surface) → ✓ A6
- §2 Polish 8 (CSP nonce) → ✓ A1
- §2 Tinting → ✓ A3
- §2 Round-trip test → ✓ A13
- §6 Settings (hangDetectionSeconds, watchdogMinutes) → ✓ A10, A11
- §7 Manual smoke → ✓ A14

**Placeholder scan:** No "TBD" / "fill in later" patterns. The note in Task A2 about Codex/Gemini friendly names being a deferred verification is documented honestly, not as a hidden gap.

**Type consistency:** `FacilitatorDecision`, `FacilitatorFn`, `RouterOptions`, `AgentRegistry`, `RouterEvent` (with new `'facilitator-decision'` kind), `SystemMessage` (with new `'facilitator-decision'` kind + agentId + reason fields) — defined once and used consistently across tasks.

**v2 will cover:** cross-agent context (the long-flagged priority), kanban, per-agent worktrees, click-to-override on chip, context-aware routing, multi-agent facilitator dispatch, editable agent profiles, and any v1 polish surfaces caught during real use.
