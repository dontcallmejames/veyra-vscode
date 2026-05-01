# Agent Chat v1 — Plan 2b Design

**Date:** 2026-04-29
**Status:** Draft, awaiting user review
**Author:** Jim (with Claude)

Companion document to `2026-04-29-agent-chat-vscode-v1-design.md` (the v1 spec) and `2026-04-29-agent-chat-v1-plan-2a-design.md` (Plan 2a's design supplement). Plan 2b is the v1 capstone — it adds the facilitator agent (smart routing without `@mention`) and finishes the polish items deferred from Plan 2a's final code review.

## 1. Summary

Plan 2b finishes v1. It adds the **facilitator agent** — a small Claude SDK call that picks the single best agent for messages without `@mention` — plus a routing chip in the chat showing the decision. It also lands the eight polish items deferred from Plan 2a's final review (cancel as distinct status, `cancelAll()` queue drain, friendly tool-result names, hang detection, watchdog, periodic auto-recheck, SessionStore error surfacing, secure CSP nonce, full panel round-trip test) plus subtle agent-brand bubble tinting.

After 2b ships, the extension matches the v1 spec end-to-end: drive-style chat with smart routing, three wrapped CLIs running on subscription auth, full error surface, persistence, all the right safety nets.

## 2. Goals & non-goals

### In scope (Plan 2b)

**Facilitator (the headline):**
- `chooseFacilitatorAgent(userMessage, availability)` function that calls the Claude Agent SDK with a system prompt + the user message and returns either `{ agent, reason }` (single-agent routing) or `{ error }`.
- Agent profiles hardcoded in the prompt — Claude (code reasoning, refactors, code review, planning), Codex (execution, tests, scripts, terminal commands), Gemini (research, current events, large-context reading).
- Unavailable agents (status `not-installed` or `unauthenticated`) are excluded from the choice set in the prompt.
- Graceful failure — SDK call throws / malformed JSON / invalid agent name / all agents unavailable → router yields `routing-needed` with appropriate text. No auto-retry.
- The facilitator does **not** see chat history in v1 — only the latest user message. Context-aware routing is a v2 concern.

**Routing chip:**
- New `kind: 'facilitator-decision'` on `SystemMessage`, with optional `agentId` field.
- Centered amber pill in the chat: `→ <Agent>` (bold) + `·` separator + `<reason>` (smaller, subdued).
- Persisted in the session — shows up in scrollback after reload.
- Informational only; no click-to-override in v1.

**Eight polish items deferred from Plan 2a's final review:**

1. **Cancel as distinct status** — track per-agent cancellation; persisted `AgentMessage.status` becomes `'cancelled'` (not `'errored'`); AgentBubble already renders `[Cancelled]` italics for that status.
2. **`cancelAll()` queue drain** — `FloorManager.drainQueue()` rejects waiters with a sentinel; `MessageRouter.cancelAll()` drains queue before killing the active agent so queued ones never start. The router's loop catches drain rejections and yields `dispatch-end` for each.
3. **Friendly tool-result names** — adapters track `tool_use_id → name` from each `tool_use` event so the matching `tool_result` resolves to the friendly name. Currently affects `claude.ts`; Codex/Gemini behavior verified during implementation (may already use friendly names).
4. **Hang detection (60s default)** — per-active-dispatch timer in `ChatPanel.dispatchUserMessage`; reset on each chunk; on timeout, post a `SystemMessage` ("Gemini hasn't responded for 60s — keep waiting or cancel?"). Timer resets and can fire repeatedly.
5. **Watchdog (5min default)** — per-floor-acquisition timer in `MessageRouter`; tracks total elapsed wall time (NOT idle); on timeout, force-release the floor with a notice ("Releasing floor — {agent} held it for over 5 minutes").
6. **Periodic auto-recheck (60s default)** — `setInterval` in `ChatPanel.initialize()`, cleared in `dispose()`. Re-runs the three status checks; pushes `status-changed` events only when a value changes (existing dedup in `MessageRouter.notifyStatusChange`).
7. **SessionStore write-error surfacing** — `.catch()` on debounced write promise; on failure, log + invoke `onWriteError` listener; ChatPanel renders a system-notice in the chat.
8. **Secure CSP nonce** — new `cspNonce()` helper using `crypto.randomBytes(16).toString('base64')`; replaces the `Math.random`-based ULID nonce in `ChatPanel.renderHtml`. The existing `ulid()` keeps using `Math.random` for non-security-critical IDs.

**Plus one design add (item 10 from the in-progress brainstorm):**

9. **Agent bubble brand tinting** — three CSS rules adding subtle background + border tints to `.bubble.agent-claude` (orange), `.bubble.agent-codex` (green), `.bubble.agent-gemini` (blue). The class is already applied by `AgentBubble.tsx`; just adding the rules.

**Plus one test add:**

10. **Panel round-trip test** — refactor `ChatPanel` to accept `agents` via constructor injection so a panel test can drive the full user-message flow with mocked agents. New test asserts the postMessage sequence (`user-message-appended → message-started → message-chunk → message-finalized`) plus a hang-detection fake-timer test.

**Settings additions** (in `package.json`'s `contributes.configuration`):
- `agentChat.hangDetectionSeconds` — number, default 60, set to 0 to disable.
- `agentChat.watchdogMinutes` — number, default 5, set to 0 to disable.
- (Existing `agentChat.toolCallRenderStyle` from Plan 2a stays.)

### Out of scope (deferred to v2)

- **Cross-agent context** — agents seeing each other's replies. High-priority v2 item, flagged from the original brainstorm.
- Kanban board.
- Per-agent git worktrees.
- Editable agent profiles via settings (hardcoded for v1).
- Click-to-override on facilitator chip.
- Context-aware facilitator routing (using chat history).
- Multi-agent facilitator dispatch (`{ agents: [...] }`).
- Custom hang/watchdog thresholds beyond simple `seconds`/`minutes` (e.g., per-agent overrides).

### Success criteria

Plan 2b is done when **the v1 manual smoke pass passes end-to-end.** That is, all 8 Plan 2a criteria still pass, plus these new criteria:

9. Send a plain-text message (no `@mention`) → facilitator chip renders → agent answers naturally. The right agent gets picked for most messages.
10. Send messages of distinctly different intent (code review / news / run tests) → facilitator picks Claude / Gemini / Codex respectively.
11. Cancel mid-stream → bubble shows `[Cancelled]` italics; not "errored".
12. `@all` + Cancel mid-Claude-reply → all three stop; queued Codex and Gemini never start.
13. Agent uses a tool (e.g. ask Claude to read a file) → tool card shows friendly name (`read_file`), not opaque ID.
14. Set `agentChat.hangDetectionSeconds: 5` → slow message → after 5s see hang notice.
15. Log out a CLI in another terminal → within ~60s the ✗ pill updates automatically.
16. Force a SessionStore write to fail (e.g. chmod readonly) → error notice surfaces in chat.
17. Agent bubbles visibly tinted with brand colors.
18. Routing chip color is distinct from any agent bubble color.

## 3. Architecture

Plan 2b doesn't change the three-layer architecture from Plan 2a. The additions slot in cleanly:

- **Webview layer:** unchanged structure; adds the `facilitator-decision` system-notice variant + three CSS tint rules.
- **Extension host:** new `src/facilitator.ts` module; `ChatPanel` gains hang-detection timer + status auto-recheck `setInterval`; `MessageRouter` gains watchdog timer + facilitator integration.
- **Headless foundation:** `FloorManager` gains `drainQueue()`; agent adapters track `tool_use_id → name` map.

### Files added/modified

```
src/
├── facilitator.ts                NEW: chooseFacilitatorAgent function
├── cspNonce.ts                   NEW: crypto.randomBytes-based nonce helper
├── messageRouter.ts              MODIFIED: facilitator dep, watchdog timer
├── floor.ts                      MODIFIED: drainQueue() method
├── panel.ts                      MODIFIED: hang detection, auto-recheck setInterval, cancelled-status tracking, write-error handling
├── sessionStore.ts               MODIFIED: onWriteError callback
├── agents/claude.ts              MODIFIED: tool_use_id → name map
├── agents/codex.ts               MODIFIED: tool_use_id → name map (if needed)
├── agents/gemini.ts              MODIFIED: tool_use_id → name map (if needed)
├── shared/protocol.ts            MODIFIED: SystemMessage adds 'facilitator-decision' kind + agentId
├── webview/state.ts              MODIFIED: handle facilitator-decision messages (treated like other system messages)
├── webview/components/SystemNotice.tsx  MODIFIED: render facilitator-decision variant
└── webview/styles.css            MODIFIED: agent bubble tints + facilitator-decision chip rule

tests/
├── facilitator.test.ts           NEW
├── floor.test.ts                 MODIFIED: drainQueue tests
├── messageRouter.test.ts         MODIFIED: facilitator routing + watchdog tests
├── panel.test.ts                 MODIFIED: round-trip test, hang detection test
└── sessionStore.test.ts          MODIFIED: write-error callback test
```

## 4. Component contracts

### 4.1 Facilitator

```typescript
// src/facilitator.ts

export type FacilitatorDecision =
  | { agent: AgentId; reason: string }
  | { error: string };

export type FacilitatorFn = (
  userMessage: string,
  availability: Record<AgentId, AgentStatus>,
) => Promise<FacilitatorDecision>;

export const chooseFacilitatorAgent: FacilitatorFn;
```

Internal flow:
1. Build the list of available agents (status `'ready'` or `'busy'`). If empty, return `{ error: 'No agents currently authenticated; check the health pills' }`.
2. Build the system prompt with available-agent profiles + the constraint that response MUST be JSON `{ "agent": "...", "reason": "..." }`.
3. Call Claude Agent SDK with the prompt + user message. Drain the streaming response into a single string (the SDK's final assistant message).
4. Parse JSON. If parse fails or `agent` value isn't in the available set, return `{ error: 'Routing unavailable; please prefix with @claude / @gpt / @gemini / @all' }`.
5. Return `{ agent, reason }`.

The function is its own module — not a method on `ClaudeAgent` — because:
- It uses the SDK with non-streaming semantics
- It has different failure modes (no chunk forwarding to a webview)
- It has no per-call cancellation (a stale facilitator decision is OK to throw away when the next user message arrives; aborting mid-flight isn't worth the wiring)

### 4.2 MessageRouter facilitator integration

```typescript
constructor(
  private agents: AgentRegistry,
  private facilitator?: FacilitatorFn,
) {}
```

In `handle(input, opts)`, when `targets.length === 0`:

```typescript
if (this.facilitator) {
  const status = { /* current statuses, populated via notifyStatusChange */ };
  const decision = await this.facilitator(remainingText || input, status);
  if ('error' in decision) {
    yield { kind: 'routing-needed', text: decision.error };
    return;
  }
  yield { kind: 'facilitator-decision', agentId: decision.agent, reason: decision.reason };
  // Then dispatch as if user had typed @mention
  /* ... existing dispatch loop with [decision.agent] ... */
} else {
  yield { kind: 'routing-needed', text: remainingText || input };
  return;
}
```

The router emits a new `RouterEvent` kind `'facilitator-decision'`; ChatPanel translates it into a `system-message` with `kind: 'facilitator-decision'` and persists it.

### 4.3 Watchdog

`MessageRouter.handle` wraps each dispatch with a 5-minute (configurable) timer:

```typescript
const watchdogMs = this.watchdogMinutes * 60_000;
const watchdogTimer = watchdogMs > 0 ? setTimeout(() => {
  // Force release: trigger AbortController on the agent
  this.agents[targetId].cancel().catch(() => {});
  // The dispatch loop sees the abort and yields error+done
}, watchdogMs) : null;
try {
  // ... existing dispatch
} finally {
  if (watchdogTimer) clearTimeout(watchdogTimer);
}
```

`MessageRouter` constructor takes `watchdogMinutes` as a parameter. ChatPanel reads the setting and passes it. Setting at 0 disables.

### 4.4 Hang detection

In `ChatPanel.dispatchUserMessage`:

```typescript
const hangSec = this.hangDetectionSeconds;
let lastChunkAt = Date.now();
const hangCheck = hangSec > 0 ? setInterval(() => {
  if (Date.now() - lastChunkAt >= hangSec * 1000) {
    const sys: SystemMessage = {
      id: ulid(),
      role: 'system',
      kind: 'error',
      text: `${activeAgent} hasn't responded for ${hangSec}s — keep waiting or cancel?`,
      timestamp: Date.now(),
    };
    this.store.appendSystem(sys);
    this.send({ kind: 'system-message', message: sys });
    lastChunkAt = Date.now(); // reset so we fire once per interval, not per tick
  }
}, 1000) : null;
```

`activeAgent` is the agent whose dispatch is currently in flight. Reset `lastChunkAt = Date.now()` whenever a chunk arrives. Clear the interval on `dispatch-end`. ChatPanel reads the setting and re-reads on `onDidChangeConfiguration`.

### 4.5 Periodic auto-recheck

In `ChatPanel.initialize()`:

```typescript
const recheckInterval = setInterval(async () => {
  clearStatusCache();
  const fresh = {
    claude: await checkClaude(),
    codex: await checkCodex(),
    gemini: await checkGemini(),
  };
  for (const id of ['claude', 'codex', 'gemini'] as AgentId[]) {
    this.router.notifyStatusChange(id, fresh[id]);  // dedup + emit if changed
  }
}, 60_000);
this.disposables.push({ dispose: () => clearInterval(recheckInterval) });
```

`notifyStatusChange` dedup means only changes fire `status-changed`; the webview never sees redundant updates.

### 4.6 FloorManager.drainQueue

```typescript
drainQueue(): AgentId[] {
  const drained = this.waiters.map((w) => w.agent);
  for (const w of this.waiters) {
    w.resolve(/* sentinel */);
    // Or: w.reject(new FloorDrainedError())
    // Lean toward a sentinel handle whose release() is a no-op,
    // so the caller's existing `try { ... } finally { handle.release(); }`
    // still works without a special-case catch.
  }
  this.waiters.length = 0;
  return drained;
}
```

`MessageRouter.cancelAll()` calls `floor.drainQueue()` and yields `dispatch-end` events for the drained agents (so the webview knows they were never going to dispatch).

### 4.7 SessionStore write-error callback

```typescript
class SessionStore {
  // ... existing
  private writeErrorListeners = new Set<(err: unknown) => void>();
  onWriteError(listener: (err: unknown) => void): () => void { ... }

  private async write(): Promise<void> {
    // ... existing
    try {
      await fsp.writeFile(tmp, JSON.stringify(this.session, null, 2), 'utf8');
      await fsp.rename(tmp, this.filePath);
    } catch (err) {
      console.error('SessionStore write failed:', err);
      for (const l of this.writeErrorListeners) l(err);
    }
  }
}
```

ChatPanel registers a listener that posts a system-message ("Couldn't save chat history: …"). To avoid feedback loops, the listener does NOT call `appendSystem` (which would schedule another write); instead it posts directly to the webview.

### 4.8 cspNonce helper

```typescript
// src/cspNonce.ts
import { randomBytes } from 'node:crypto';
export function cspNonce(): string {
  return randomBytes(16).toString('base64');
}
```

`ChatPanel.renderHtml` swaps `ulid()` for `cspNonce()`. Existing `ulid()` stays for message IDs.

### 4.9 Tool-use ID → friendly name map

In `claude.ts` (and codex/gemini if needed), `mapSdkEvent` keeps a `Map<tool_use_id, name>` per dispatch:

```typescript
function* mapSdkEvent(event: unknown, idToName: Map<string, string>): Generator<AgentChunk> {
  // assistant case:
  if (item.type === 'tool_use' && typeof item.name === 'string' && typeof item.id === 'string') {
    idToName.set(item.id, item.name);
    yield { type: 'tool-call', name: item.name, input: item.input };
  }
  // user case:
  if (item.type === 'tool_result' && typeof item.tool_use_id === 'string') {
    const name = idToName.get(item.tool_use_id) ?? 'unknown';
    yield { type: 'tool-result', name, output: item.content };
  }
}
```

The map's lifetime is one `send()` call — reset each invocation.

## 5. UX details

### 5.1 Routing chip

- Class `system-notice facilitator` with rule:
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
  ```
- Markup: `<span>→</span> <span class="agent-name">{Agent}</span> <span>·</span> <span class="reason">{reason}</span>`

### 5.2 Agent bubble tints

```css
.bubble.agent-claude { background: rgba(217, 119, 87, 0.10); border-color: rgba(217, 119, 87, 0.40); }
.bubble.agent-codex  { background: rgba(16, 163, 127, 0.10); border-color: rgba(16, 163, 127, 0.40); }
.bubble.agent-gemini { background: rgba(74, 141, 240, 0.10); border-color: rgba(74, 141, 240, 0.40); }
```

The class `agent-${message.agentId}` is already applied by `AgentBubble.tsx` from Plan 2a's F1.

### 5.3 Cancel UX

When user clicks Cancel:
- Active agent receives SIGTERM (subprocess) / AbortController abort (Claude SDK)
- `inProgressByAgent` map gains `cancelled: true` for all agents currently in flight or queued
- Floor queue drains; queued agents emit `dispatch-end` without ever starting
- For each cancelled agent, `AgentMessage.status: 'cancelled'`; AgentBubble renders `[Cancelled]` italics

### 5.4 Hang notice

Surfaced via `system-message` with `kind: 'error'`. Same rendering as existing error notices (red tint). Text: `"{Agent} hasn't responded for {N}s — keep waiting or cancel?"`. The Cancel button in the composer is already visible during dispatch (from Plan 2a's Composer); no new button needed.

### 5.5 Watchdog notice

Surfaced via `system-message` with `kind: 'error'`. Text: `"Releasing floor — {Agent} held it for over {N} minutes without finishing."`. The agent bubble's `status` becomes `'errored'` with that error text appended.

## 6. Settings

```json
"agentChat.toolCallRenderStyle": {
  "type": "string",
  "enum": ["verbose", "compact", "hidden"],
  "default": "compact",
  "description": "How tool calls (file reads, edits, terminal commands) are displayed in the chat."
},
"agentChat.hangDetectionSeconds": {
  "type": "number",
  "default": 60,
  "minimum": 0,
  "maximum": 600,
  "description": "Seconds with no output from an agent before showing a 'still waiting?' notice. Set to 0 to disable."
},
"agentChat.watchdogMinutes": {
  "type": "number",
  "default": 5,
  "minimum": 0,
  "maximum": 60,
  "description": "Maximum minutes an agent may hold the dispatch floor before it's force-released. Set to 0 to disable."
}
```

ChatPanel reads on init + `onDidChangeConfiguration` and passes through to `MessageRouter` (watchdog) and its own dispatch logic (hang detection).

## 7. Testing

### Unit tests

- **`tests/facilitator.test.ts`** (new): well-formed/malformed JSON, invalid agent name, all-unavailable, exclusion of unavailable agents from prompt.
- **`tests/floor.test.ts`** (extends): `drainQueue()` rejects waiters; `acquire()` after drain works.
- **`tests/messageRouter.test.ts`** (extends): facilitator routing happy path, error path, watchdog timer fires after configured ms (vitest fake timers).
- **`tests/panel.test.ts`** (extends): full round-trip test (`@claude hi` → `user-message-appended` → `message-started` → `message-chunk` → `message-finalized`); hang-detection fake-timer test.
- **`tests/sessionStore.test.ts`** (extends): write-error callback fires.

### Existing tests

Updated where contracts shifted:
- Adapter tool-result tests use friendly name lookup
- Reducer tests pick up `kind: 'facilitator-decision'`

### Integration tests

No new live tests. Plan 1's three live adapter tests still cover dispatch end-to-end.

### Manual smoke for v1 sign-off

The 8 Plan 2a criteria + 10 new ones (numbered 9–18 in §2 success criteria). User runs them in F5 dev host before declaring v1 done.

## 8. Implementation order (for the planning step)

Recommended phasing — starts with the small standalone polish wins, then the foundation refactors needed for the facilitator, then the facilitator itself, then the timers, then the integration test:

1. `cspNonce` helper + ChatPanel swap — single-file change, immediate quality gate.
2. Friendly tool names (Claude adapter; verify Codex/Gemini).
3. Agent bubble tints (CSS only).
4. Cancel-as-distinct-status (panel + state reducer).
5. `FloorManager.drainQueue()` + `MessageRouter.cancelAll()` queue drain.
6. `SessionStore.onWriteError` callback + ChatPanel listener.
7. New `'facilitator-decision'` `SystemMessage` kind + reducer + SystemNotice variant + chip CSS.
8. `src/facilitator.ts` module + tests.
9. `MessageRouter` facilitator integration + tests.
10. Hang detection in ChatPanel + tests + setting.
11. Watchdog in MessageRouter + tests + setting.
12. Periodic status auto-recheck + setting.
13. ChatPanel agent injection + round-trip panel test.
14. Manual smoke pass against the 17 v1 success criteria.

## 9. Open risks

- **Facilitator latency.** Cold-start Claude SDK call is ~1-3s; subsequent calls ~500ms-1s. The user feels this every plain-text message. We could mitigate with a tiny LRU cache keyed on prompt text but it's not worth v1 complexity. If it feels bad in real use, easy to add later.
- **Watchdog vs valid long-running tasks.** A genuine 6-minute test run would force-release the floor. Mitigation: the user can set `agentChat.watchdogMinutes` to 0 (disable) or higher (15, 30) per their workflow. Not a bug, a tradeoff.
- **Friendly tool names for Codex/Gemini are uncertain.** Spike fixtures didn't capture tool calls for those CLIs (the spike prompts didn't trigger any). If those CLIs DON'T use `tool_use_id`-style references and we don't need the lookup, the change is a no-op. Worth verifying during implementation.
