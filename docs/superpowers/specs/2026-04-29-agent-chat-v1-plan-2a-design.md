# Agent Chat v1 — Plan 2a Design

**Date:** 2026-04-29
**Status:** Draft, awaiting user review
**Author:** Jim (with Claude)

Companion document to `2026-04-29-agent-chat-vscode-v1-design.md` (the v1 spec). Plan 2a is the second of two implementation plans for v1; Plan 1 (Foundation) is already shipped. This doc fills in implementation details the v1 spec deferred — webview tech stack, postMessage protocol, persistence schema, component breakdown — for the slice of v1 that 2a covers.

## 1. Summary

Plan 2a adds a usable VSCode UI on top of Plan 1's headless library: a Preact-based webview chat panel, per-workspace persistence, real `Agent.status()` checks, and a basic error/health surface. The facilitator agent and the full error matrix (hang detection, watchdog, periodic status refresh) are deferred to Plan 2b. After 2a lands, the user can drive real conversations with `@mention` routing — this is the "I can use this now" milestone.

## 2. Goals & non-goals

### In scope (Plan 2a)

- **VSCode webview chat panel** opened via the `agentChat.openPanel` command. Shown as a `WebviewPanel` (editor tab), singleton — closing disposes, opening rehydrates from SessionStore.
- **Preact app** for the panel UI. Components: App root, MessageList, UserBubble, AgentBubble (streaming-aware), ToolCallCard (compact-by-default), SystemNotice, Composer, MentionAutocomplete, FloorIndicator, HealthStrip.
- **`@mention` autocomplete** in the composer (`@` opens popup with `@claude` / `@gpt` / `@gemini` / `@all`).
- **Floor indicator** at the top of the panel (idle / "X has the floor"), driven by a new `MessageRouter.onFloorChange()` subscription.
- **Subscription health strip** in the composer footer — three pills (`Claude ✓` / `GPT ✓` / `Gemini ✓`), `✗` clickable for fix instructions.
- **Per-workspace persistence** at `<workspace>/.vscode/agent-chat/sessions.json`, debounced 200ms writes, atomic-rename on save.
- **`.gitignore` prompt** on first creation of `<workspace>/.vscode/agent-chat/` — `showInformationMessage` with `[Add to .gitignore]` `[Not now]` `[Don't ask again]`.
- **Real `Agent.status()`** for all three agents (file-existence checks for auth files; resolve-function calls for install checks). Cached 30s, busted on user-issued `reload-status`.
- **Inline error notices** for: CLI not installed, CLI not authenticated, CLI process crashed mid-stream, generic agent error, user sends without `@mention`.
- **Setting `agentChat.toolCallRenderStyle`** with values `verbose` / `compact` / `hidden`, default `compact`.
- **Deferred Plan 1 items:** `MessageRouter.onFloorChange()`, `parseMentions` empty-input guard.

### Out of scope (Plan 2b)

- **Facilitator agent** (routing without `@mention`). 2a requires `@mention`; messages without one show a routing-needed system notice.
- **Routing chips** (no facilitator → no chips).
- **Hang detection** (60s no-output warning).
- **Watchdog** (5min forced floor release).
- **Periodic auto-recheck** of agent status.
- **`Agent.cancel()` UI wiring beyond the basic Cancel button** — Cancel itself works in 2a; cancel-during-tool-call edge cases are 2b polish.
- **`mapSdkEvent` Option-A pass-through cleanup** in `claude.ts` — defer to a 2b cleanup task once the test suite is rewritten.
- **Manual smoke-test pass for full v1** — happens at end of 2b.

### Success criteria

Plan 2a is done when:

1. Open a fresh workspace, run `Agent Chat: Open Panel` → empty chat, three agents marked ready in HealthStrip.
2. Send `@claude hello` → streaming reply appears in the panel, persists across reload.
3. Send `@all hi` → Claude, then Codex, then Gemini respond sequentially; FloorIndicator updates each turn.
4. Reload VSCode (or close + reopen the panel) → history is restored from `sessions.json`.
5. Log out of one CLI (e.g., `codex logout` or rename `~/.codex/auth.json`), reopen panel → that agent shows ✗ in HealthStrip; sending to it yields an inline auth error in chat; clicking ✗ surfaces fix instructions.
6. Send plain text without `@mention` → inline routing-needed system notice.
7. Toggle `agentChat.toolCallRenderStyle` between verbose / compact / hidden → tool-call rendering switches without reload.
8. First message in a fresh repo triggers the `.gitignore` prompt; clicking `[Add to .gitignore]` actually appends the entry.

## 3. Architecture

Three layers:

1. **Webview (Preact app, all new in 2a).** Lives in its own bundle (`dist/webview.js`). Receives messages from the extension host via `window.addEventListener('message')`; sends back via `acquireVsCodeApi().postMessage()`. Holds local UI state (input text, autocomplete open, scroll position, in-progress streaming buffer). The persisted session history is owned by the extension and pushed to the webview.

2. **Extension host bridge (new for 2a).** `ChatPanel` wraps the webview lifecycle and owns the postMessage protocol both directions. `SessionStore` does load/save against the per-workspace JSON file. `extension.ts` (existing) is updated to register the panel command and instantiate `ChatPanel` on demand.

3. **Headless foundation (existing, three small additions).**
   - `MessageRouter` — add `onFloorChange(listener)` and `onStatusChange(listener)` so the FloorIndicator and HealthStrip can subscribe.
   - `Agent.status()` — replace the hardcoded `'ready'` with real install + auth checks per agent.
   - `parseMentions` — empty-input guard.

### File structure produced by Plan 2a

```
src/
├── extension.ts                        # updated: register panel command
├── panel.ts                            # NEW: ChatPanel class
├── sessionStore.ts                     # NEW: per-workspace JSON load/save
├── statusChecks.ts                     # NEW: real Agent.status() impls
├── shared/
│   └── protocol.ts                     # NEW: FromExtension / FromWebview types
├── messageRouter.ts                    # updated: onFloorChange / onStatusChange
├── mentions.ts                         # updated: empty-input guard
├── agents/                             # updated: status() impls
│   ├── claude.ts
│   ├── codex.ts
│   └── gemini.ts
└── webview/
    ├── index.html                      # NEW: shell, loads webview.js
    ├── main.tsx                        # NEW: Preact mount
    ├── App.tsx                         # NEW: root component
    ├── state.ts                        # NEW: state types + reducer (testable as pure fn)
    ├── styles.css                      # NEW: uses VSCode theme tokens
    └── components/                     # NEW
        ├── MessageList.tsx
        ├── UserBubble.tsx
        ├── AgentBubble.tsx
        ├── ToolCallCard.tsx
        ├── SystemNotice.tsx
        ├── Composer.tsx
        ├── MentionAutocomplete.tsx
        ├── FloorIndicator.tsx
        └── HealthStrip.tsx
```

### Build setup

esbuild gets a second entry point for the webview bundle. Either fold both into `esbuild.config.mjs` (build extension + webview in one pass) or add `esbuild.webview.config.mjs`. Recommend folding into one config — simpler, shared toolchain.

The webview entry compiles JSX (Preact). Add `--jsx-factory=h --jsx-fragment=Fragment` to esbuild options for the webview entry, plus `import { h, Fragment } from 'preact'` in source files (or use the Preact `htm/preact` shim, but we'll stick with explicit JSX for clarity).

## 4. postMessage protocol

JSON-serializable. Shared types in `src/shared/protocol.ts`, imported by both extension host and webview.

### Extension → Webview

```typescript
type FromExtension =
  | { kind: 'init'; session: Session; status: Record<AgentId, AgentStatus>; settings: Settings }
  | { kind: 'message-started'; id: string; agentId: AgentId; timestamp: number }
  | { kind: 'message-chunk'; id: string; chunk: AgentChunk }
  | { kind: 'message-finalized'; message: AgentMessage }     // canonical persisted form, has `status`
  | { kind: 'system-message'; message: SystemMessage }       // routing-needed or error notice
  | { kind: 'floor-changed'; holder: AgentId | null }
  | { kind: 'status-changed'; agentId: AgentId; status: AgentStatus }
  | { kind: 'settings-changed'; settings: Settings };
```

### Webview → Extension

```typescript
type FromWebview =
  | { kind: 'send'; text: string }
  | { kind: 'cancel' }
  | { kind: 'reload-status' }                                 // user clicked ✗ in HealthStrip
  | { kind: 'open-external'; url: string };                   // for clickable doc links in fix instructions
```

### Streaming flow (webview side)

- `message-started` → webview stores `{ id, agentId, timestamp, text: '', toolEvents: [] }` in an in-progress `Map<id, InProgressMessage>` (no `status` field — it's still streaming).
- `message-chunk` → webview applies the chunk to the in-progress entry (append `text`; push `tool-call` / `tool-result` chunks to `toolEvents`; record `error` text on the entry; ignore `done`) and re-renders.
- `message-finalized` → webview removes from in-progress, appends the finalized `AgentMessage` (with `status`) to the persisted-history list (extension already wrote it to disk).

The `InProgressMessage` and `AgentMessage` types share most fields; the difference is `status` (and `error`) being absent on in-progress entries. AgentBubble accepts either via a discriminator prop (`streaming: boolean`).

Two-stage (started + chunk + finalized) instead of one-shot streaming because:
- Started gives the webview the bubble to render immediately (with a streaming cursor).
- Chunk applies deltas without re-sending the whole message.
- Finalized is the canonical persisted form, distinct from in-progress so the UI can clear the streaming cursor and styles.

### Settings shape

```typescript
type Settings = {
  toolCallRenderStyle: 'verbose' | 'compact' | 'hidden';   // default 'compact'
};
```

Extension reads from `vscode.workspace.getConfiguration('agentChat')`, subscribes to `onDidChangeConfiguration`, pushes `settings-changed`.

## 5. Component contracts

### 5.1 ChatPanel (extension host)

Singleton manager of the webview panel. Public surface:

```typescript
class ChatPanel {
  static show(context: vscode.ExtensionContext): void;          // command handler entry point
  dispose(): void;                                               // on user close
  // Internal: handles all postMessage routing both directions
}
```

On `show()`:
1. If a panel already exists, reveal it.
2. Otherwise create a `WebviewPanel` (column 1 by default), load `index.html`, wire `webview.onDidReceiveMessage` to handle `FromWebview` events.
3. Send `init` with the loaded session, current statuses, current settings.

Subscribes to:
- `MessageRouter.onFloorChange` → forward as `floor-changed`
- `MessageRouter.onStatusChange` → forward as `status-changed` (added in 2a)
- `vscode.workspace.onDidChangeConfiguration` (filter `agentChat.*`) → forward as `settings-changed`

### 5.2 SessionStore (extension host)

```typescript
class SessionStore {
  constructor(workspaceFolder: vscode.WorkspaceFolder);
  load(): Promise<Session>;                  // empty session if file missing/corrupted
  appendUser(msg: UserMessage): void;        // schedules debounced write
  appendAgent(msg: AgentMessage): void;
  appendSystem(msg: SystemMessage): void;
  flush(): Promise<void>;                    // for dispose
}
```

- File path: `<workspace>/.vscode/agent-chat/sessions.json`.
- 200ms debounce, coalescing.
- Atomic rename: write to `sessions.json.tmp`, `fs.rename` to `sessions.json`.
- On corrupted parse: append a SystemMessage warning to a fresh in-memory session, persist it, continue. Don't lose the user's flow over a bad file.

### 5.3 Webview state reducer (testable pure function)

```typescript
type InProgressMessage = {
  id: string;
  role: 'agent';
  agentId: AgentId;
  text: string;
  toolEvents: ToolEvent[];
  timestamp: number;
  // No `status` — message is still streaming.
};

type WebviewState = {
  session: Session;
  inProgress: Map<string, InProgressMessage>;
  status: Record<AgentId, AgentStatus>;
  settings: Settings;
  floorHolder: AgentId | null;
};

function reduce(state: WebviewState, message: FromExtension): WebviewState;
```

Pure function — no side effects, no async. The App component holds this state and dispatches `FromExtension` events into the reducer. This is the unit testable as plain Vitest cases without any DOM or component framework.

### 5.4 Other components

- **`App`** — owns `WebviewState`, handles `FromExtension` events through `reduce`, passes pieces to children. Sends `FromWebview` messages on user actions.
- **`MessageList`** — renders persisted history + in-progress entries (interleaved by timestamp).
- **`AgentBubble`** — accepts either an `AgentMessage` (finalized, has `status`) or an `InProgressMessage`, plus a `streaming: boolean` prop. Renders `text` + `toolEvents` in chunk order. When `streaming` is true, shows a trailing `█` cursor; when false and `status === 'cancelled'`, appends an italic "[Cancelled]"; when `status === 'errored'`, renders the `error` text in the error-notice style.
- **`ToolCallCard`** — reads `settings.toolCallRenderStyle` from props/context. Each style is a different render mode at the component level — no per-card user toggle in 2a.
- **`MentionAutocomplete`** — listens for `@` keypress in the composer, shows popup. Arrow keys navigate, Enter selects, Esc closes. Inserts the mention token + space into the textarea.
- **`HealthStrip`** — renders three pills based on `status`. ✗ pills clickable; click sends `reload-status`.
- **`FloorIndicator`** — top-of-panel banner. `null` holder → "Idle"; named holder → "*X* has the floor" with a pulse animation.

## 6. Persistence schema

```typescript
type Session = {
  version: 1;
  messages: Array<UserMessage | AgentMessage | SystemMessage>;
};

type UserMessage = {
  id: string;            // ULID
  role: 'user';
  text: string;          // raw input including @mentions
  timestamp: number;
  mentions?: AgentId[];  // parsed targets (omitted if none)
};

type AgentMessage = {
  id: string;
  role: 'agent';
  agentId: AgentId;
  text: string;          // accumulated text from `text` chunks
  toolEvents: ToolEvent[];
  timestamp: number;     // dispatch start
  status: 'complete' | 'cancelled' | 'errored';
  error?: string;        // present only when status === 'errored'
};

type ToolEvent =
  | { kind: 'call'; name: string; input: unknown; timestamp: number }
  | { kind: 'result'; name: string; output: unknown; timestamp: number };
// Stored flat; UI groups by name + order. Adapters don't pair calls with results
// at the chunk level, so neither does the persistence layer.

type SystemMessage = {
  id: string;
  role: 'system';
  kind: 'routing-needed' | 'error';
  text: string;
  timestamp: number;
};
```

ULIDs (one tiny inline helper, no dep) for sortable IDs.

## 7. Status checks & error handling

### 7.1 Agent.status() implementations

| Agent | Install check | Auth check |
|---|---|---|
| Claude | If `import { query } from '@anthropic-ai/claude-agent-sdk'` resolves, installed. | `~/.claude/.credentials.json` exists. |
| Codex | `resolveCodexCommand()` succeeds (POSIX: `which codex` succeeds; Windows: `npm root -g` resolves to a directory containing `@openai/codex/bin/codex.js`). | `~/.codex/auth.json` exists. |
| Gemini | Same pattern as Codex with `@google/gemini-cli/bundle/gemini.js`. | `~/.gemini/oauth_creds.json` exists. |

Cached 30s. `reload-status` busts the cache.

### 7.2 Error UX matrix

| Failure | Surface |
|---|---|
| CLI not installed | HealthStrip ✗; click → "Codex CLI not installed. Install: `npm i -g @openai/codex` …" with link button. Inline error in chat if user dispatches anyway. |
| CLI not authenticated | HealthStrip ✗; click → "Run `codex login` in a terminal". Inline error if user dispatches. |
| CLI crashes mid-stream | Inline error within the agent's bubble (status: 'errored'); existing Plan 1 adapter logic captures stderr tail. |
| User cancel | "[Cancelled]" italic note in the agent's bubble (status: 'cancelled'). |
| Generic agent throw | Plan 1's router error-wrap (commit `884728f`) yields error+done; same surface as crash. |
| Send without `@mention` | SystemMessage `kind: 'routing-needed'`, rendered as a centered system notice. |

No periodic auto-refresh in 2a; status is checked on panel open + on each dispatch attempt + on `reload-status`.

## 8. Testing approach

### Unit tests (default `npm test`)

- `sessionStore.test.ts` — round-trip; corrupted JSON; atomic rename simulation.
- `statusChecks.test.ts` — mocked filesystem; ready/unauthenticated/not-installed per agent; 30s cache.
- `panel.test.ts` — mocked vscode API; postMessage routing both directions.
- `mentions.test.ts` (existing, +2 tests) — empty-string and whitespace-only inputs.
- `messageRouter.test.ts` (existing, +2 tests) — `onFloorChange` fires correctly during single + multi-agent dispatch.
- `webviewState.test.ts` — the pure reducer tested with init/started/chunk/finalized/system-message/status-changed scenarios.

### Not unit-tested

- Preact components themselves. Visual review only.
- VSCode webview rendering pipeline.
- `vscode.window.showInformationMessage` (gitignore prompt) — covered manually.

### Manual smoke checklist for 2a sign-off

The eight items in §2 success criteria, run by the user before declaring 2a done.

### Live integration tests stay opt-in

Plan 1's three live tests still pass; no new ones in 2a.

## 9. Implementation order (for the planning step)

Suggested phasing (the writing-plans step will refine):

1. Plan 1 deferred items: `parseMentions` empty-input guard; `MessageRouter.onFloorChange` + `onStatusChange`.
2. `Agent.status()` real impls + `statusChecks.ts`.
3. Persistence: types in `shared/protocol.ts`, `sessionStore.ts` with tests.
4. Build setup: esbuild webview entry + Preact JSX config.
5. Webview shell: `index.html`, `main.tsx`, `App.tsx`, `state.ts` (pure reducer + tests).
6. Component scaffolding: empty MessageList, Composer, FloorIndicator, HealthStrip wired to state.
7. ChatPanel: extension host wiring, postMessage routing, init flow, command registration in `extension.ts`.
8. End-to-end vertical slice: send `@claude hello`, see the bubble stream in. (This is the first "it works" milestone.)
9. Remaining components: tool-call rendering with all three styles, mention autocomplete, system notices, error inline rendering.
10. `.gitignore` prompt.
11. Settings wiring.
12. Manual smoke pass against §2 success criteria.

## 10. Open risks

- **Webview ↔ extension postMessage delivery order** is generally reliable but not strictly ordered relative to the extension's own state writes. Mitigation: extension processes a tick of work then sends; doesn't interleave. If the test plan reveals races, we can add sequence numbers in 2b.
- **VSCode CSS theme tokens** vary between light/dark/high-contrast. Use `--vscode-foreground`, `--vscode-editor-background`, etc., plus `[data-vscode-theme-kind="vscode-dark"]` selectors for tweaks. Manual visual check across all three themes is part of the smoke pass.
- **Preact's bundle size on top of the extension's existing bundle** — should still be ~30-50KB total for `dist/webview.js`. Watch the build output.
