# Agent Chat VSCode Extension — v1 Design

**Date:** 2026-04-29
**Status:** Draft, awaiting user review
**Author:** Jim (with Claude)

## 1. Summary

A VSCode extension that puts Claude, ChatGPT, and Gemini into a shared chat panel inside the editor. A facilitator agent routes each message to whichever agent is best suited; the user can override with `@mention`. Each agent does real work (file edits, terminal commands) using its own native tooling. v1 is the chat surface end-to-end. Kanban, parallel work, and cross-agent context are deferred to later versions.

## 2. Goals & non-goals

### In scope (v1)
- VSCode extension that opens a chat panel webview
- Three agents wired in via wrapped CLIs/SDKs:
  - Claude — `@anthropic-ai/claude-code` SDK (in-process)
  - ChatGPT — Codex CLI (subprocess)
  - Gemini — Gemini CLI (subprocess)
- All agents authenticate via the user's existing consumer subscriptions (Claude Pro/Max, ChatGPT Plus/Pro, Google account). No API billing.
- Facilitator agent (a small Claude SDK call) that picks the right agent for each user message based on a hardcoded agent profile.
- `@mention` syntax (`@claude`, `@gpt`, `@gemini`, `@all`, or multiple specific mentions like `@claude @gemini`) that bypasses the facilitator.
- Sequential turn-taking — one agent holds the floor at a time, streams its response back into chat.
- Per-workspace chat history persistence.
- Clear inline error states when a CLI is not installed, not authenticated, or has stalled.

### Out of scope (deferred)
- Kanban board with assigned tasks (v2)
- Cross-agent message visibility — agents seeing each other's replies (v2; user has flagged this as an important v2 feature)
- Per-agent git worktrees / parallel agent work (v3)
- Editable agent profiles / personas (v2 polish)
- Tool-call approval UI beyond what each underlying CLI already prompts for
- Cross-platform polish — Windows is the primary target; macOS and Linux best-effort

### Success criteria for v1
v1 is "done" when:
1. Open the panel in VSCode, type a message, and the right agent responds (facilitator-routed or `@mention`-routed).
2. Each agent can read and edit files in the workspace via its native tool execution.
3. Chat history survives a VSCode reload.
4. A missing or unauthenticated CLI produces a useful error inline in the chat — never a silent failure.

## 3. Architecture

Three layers:

1. **UI layer** — a VSCode webview hosting the chat panel (HTML/CSS/JS). Renders messages, composer, `@mention` autocomplete, floor indicator.
2. **Extension host** — Node, where VSCode extensions run. Owns the Message Router, Facilitator, Session Store, and the Agent Adapter interface that all three agents implement.
3. **Wrapped agents** — asymmetric: Claude is an in-process SDK import; Codex and Gemini are external CLI binaries spawned as child processes. The adapter interface hides that asymmetry.

Each CLI handles its own tool execution and edits files in the workspace directly. The extension does not reimplement file operations or sandbox the CLIs — it orchestrates.

**Auth is not managed by the extension.** The user runs each CLI's first-time login (`claude /login`, `codex login`, `gemini`) once before using the extension. If a CLI is not authenticated, the adapter's `status()` reports it and the chat surfaces an actionable error.

## 4. Component contracts

### 4.1 Agent adapter interface

```typescript
interface Agent {
  id: 'claude' | 'codex' | 'gemini';
  status(): 'ready' | 'unauthenticated' | 'not-installed' | 'busy';
  send(prompt: string, opts: SendOptions): AsyncIterable<AgentChunk>;
  cancel(): Promise<void>;
}

type AgentChunk =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; name: string; input: unknown }
  | { type: 'tool-result'; name: string; output: unknown }
  | { type: 'error'; message: string }
  | { type: 'done' };
```

Every adapter normalizes its underlying CLI/SDK output into this `AgentChunk` stream. The Message Router and webview both consume `AgentChunk` exclusively, so they don't know or care which agent is upstream.

### 4.2 Facilitator

A pure function (no state of its own) that calls the Claude SDK with:

- A system prompt describing each agent's strengths (the **agent profile**)
- The user's message
- Optional context: which agents are currently `ready` vs `unauthenticated` (excluded agents are removed from the choice set)

It returns structured JSON:

```typescript
type RoutingDecision =
  | { agent: 'claude' | 'codex' | 'gemini'; reason: string }
  | { agents: Array<'claude' | 'codex' | 'gemini'>; reason: string };
```

**Initial agent profile (hardcoded for v1):**

| Agent | Strengths |
|---|---|
| Claude | code reasoning, refactors, code review, planning |
| ChatGPT (Codex) | execution, running tests, scripts, command-line work |
| Gemini | research, current events, large-context document reading |

If the facilitator returns malformed output or the call fails, the router surfaces an inline error and waits for the user to `@mention` manually. No auto-retry in v1.

### 4.3 Message Router

The orchestration core. Responsibilities:

- Receive messages posted from the webview
- Persist the user message to the Session Store
- Parse `@mention` targets; if present, skip facilitator
- Otherwise call facilitator, render the routing chip, dispatch to chosen agent(s)
- Hold the **floor lock** while an agent is streaming
- Relay each `AgentChunk` to the webview via `postMessage`
- On `done`, persist the final agent message and either dispatch the next queued agent (multi-target dispatch) or release the floor
- Handle cancel requests from the webview by calling `agent.cancel()` and releasing the floor

### 4.4 Session Store

Per-workspace JSON file at `<workspace>/.vscode/agent-chat/sessions.json`. Schema:

```typescript
type Session = {
  version: 1;
  messages: Array<UserMessage | AgentMessage | FacilitatorChip | ErrorNotice>;
};

type UserMessage = {
  id: string;
  role: 'user';
  text: string;
  timestamp: number;
  mentions?: Array<'claude' | 'codex' | 'gemini' | 'all'>;
};

type AgentMessage = {
  id: string;
  role: 'agent';
  agentId: 'claude' | 'codex' | 'gemini';
  text: string;
  toolEvents: Array<{ name: string; input?: unknown; output?: unknown }>;
  timestamp: number;
  status: 'complete' | 'cancelled' | 'errored';
};

type FacilitatorChip = {
  id: string;
  role: 'facilitator';
  decision: RoutingDecision;
  timestamp: number;
};

type ErrorNotice = {
  id: string;
  role: 'system';
  text: string;
  timestamp: number;
};
```

Mid-stream state is not persisted; if VSCode reloads while an agent is mid-reply, the partial message is dropped on next load.

The CLIs maintain their own conversation memory in `~/.claude/`, `~/.codex/`, `~/.gemini/`. The extension does not mirror this.

## 5. Per-CLI integration plan

### 5.1 Claude — Claude Agent SDK
- Import from `@anthropic-ai/claude-agent-sdk` (Anthropic renamed Claude Code SDK → Claude Agent SDK; the older `@anthropic-ai/claude-code` package is just a CLI binary wrapper, not what we want)
- Use `query({ prompt })` which returns an `AsyncIterable` of events
- Event types observed: `system/init`, `system/hook_*` (ignore), `assistant` (the model reply — text and tool calls live in `message.content[]`), `rate_limit_event` (ignore), `result/success` (terminal — maps to `done`), `result/error` (maps to `error`)
- Auth lives in `~/.claude/`; token from a Pro/Max account uses subscription billing automatically (`apiKeySource: "none"` confirms no API key in use)
- In-process — no subprocess, no PTY concerns
- Cancellation: pass `options.abortController` to `query()`; the returned `Query` object also exposes `interrupt()` for graceful stop

### 5.2 ChatGPT — Codex CLI
- Spawn `codex exec` (the non-interactive single-turn mode) as a child process
- Pipe prompt into stdin, parse streaming stdout (likely JSONL — verify during spike)
- Auth in `~/.codex/auth.json` from `codex login`

### 5.3 Gemini — Gemini CLI
- Spawn `gemini` as a child process; same pattern as Codex
- Auth in `~/.gemini/`

### 5.4 Implementation risk: PTY emulation

Codex and Gemini CLIs were primarily designed as interactive REPLs. Their non-interactive / single-turn modes may need specific flags or, worst case, PTY emulation via `node-pty` to capture output cleanly.

**Mitigation:** the first implementation step is a small spike — for each CLI, run a minimal non-interactive prompt and observe what the output stream looks like. If a clean mode does not exist, the adapter for that agent gets noticeably more complex (PTY-based). The result of the spike feeds back into the implementation plan.

## 6. Message flow

1. User types in the webview composer, hits Send.
2. Webview `postMessage`s payload (raw text + parsed mentions) to the extension host.
3. Router persists the user message; checks for `@mention`.
4. **If mention present:** skip facilitator; build the dispatch list directly from the mentioned targets — one agent for `@claude`, multiple for `@claude @gemini`, or all three for `@all`.
5. **If no mention:** call the facilitator. Render the returned routing chip into the chat. Build the dispatch list from `decision.agent` or `decision.agents`.
6. Router takes the floor lock and dispatches to the first agent in the list.
7. Adapter calls its CLI/SDK; chunks stream back through the router to the webview.
8. UI renders streaming bubbles, tool-call/result panels, etc.
9. On `done`, the router persists the final agent message. If more agents are queued, loop to step 6 for the next one. Otherwise release the floor.

While the floor is held, new user input is allowed and queued (with a visible "queued — waiting for *agent*" indicator); it is not raced against the active agent. The Cancel button is the only way to interrupt a streaming agent.

## 7. Chat UI

- VSCode webview, no React dependency required for v1 (vanilla HTML/CSS/JS keeps the bundle small; React can be added later if complexity warrants it).
- Floor indicator at the top of the panel: pulsing dot + "*Agent* has the floor" when active; calm "Idle" state otherwise.
- Message types rendered distinctly:
  - User bubbles — right-aligned, blue tint
  - Agent bubbles — left-aligned, color-coded per agent (Claude orange, GPT green, Gemini blue)
  - Facilitator chips — centered, amber pill with reason
  - Tool-call / tool-result panels — collapsible monospace blocks under the parent agent bubble
  - Error notices — centered, red, terse + actionable
- `@mention` autocomplete: typing `@` opens a small popup with the four targets and one-line descriptions; arrow keys + Enter selects.
- Subscription health strip in the composer footer shows live status of all three agents (`✓` / `✗`); a `✗` is clickable and explains the fix.
- Cancel button appears next to Send only while the floor is held.
- Streaming cursor (`█`) at the end of in-progress agent messages, removed on `done`.

## 8. Persistence

- **Location:** `<workspace>/.vscode/agent-chat/sessions.json` (workspace-scoped).
- **Add to `.gitignore`** — the extension prompts the user on first run to add `.vscode/agent-chat/` to the workspace's `.gitignore` if not already present.
- **Mid-stream state is lost on reload.** This is a deliberate v1 simplification.
- **Migration:** the file has a `version` field for future schema evolution.

## 9. Error handling

| Failure | UI surface | System action |
|---|---|---|
| CLI binary not on PATH | Inline: "Codex CLI not installed — install instructions: …" | Mark agent `not-installed`; exclude from facilitator routing |
| CLI not authenticated | Inline: "Run `codex login` in a terminal" | Mark `unauthenticated`; same exclusion |
| CLI hangs (no output 60s) | Inline: "Gemini hasn't responded for 60s — keep waiting / cancel?" | Surface buttons; on cancel, SIGTERM and release floor |
| CLI process crashes mid-stream | Inline error with stderr tail | Release floor; mark agent `ready` for retry |
| Facilitator call fails | Inline: "Couldn't pick an agent — pick manually with @mention" | No auto-retry |
| User-issued cancel | Italic note: "Cancelled" | SIGTERM active subprocess (or `cancel()` on SDK); release floor |
| Floor deadlock (defensive) | Watchdog: forced release after 5 min with no chunks (and not in known long tool call) | Release floor with notice |

**Two design intents:**
1. Errors live in the chat, not as toasts. A failed agent call is part of the conversation history.
2. Routing degrades gracefully. Facilitator excludes unavailable agents; if it fails entirely, the user can `@mention` manually.

## 10. Testing approach

### Unit tests (run on every change)
- **Adapter normalization** — feed canned CLI/SDK output (recorded fixtures) into each adapter; assert correct `AgentChunk` sequence.
- **Facilitator routing** — mock the Claude SDK with scripted responses (well-formed JSON, malformed JSON, error). Assert correct router behavior in each case.
- **Floor manager** — simulate concurrent dispatch attempts; assert floor lock and queue.
- **`@mention` parser** — text → `{ targets, remainingText }`.
- **Persistence round-trip** — write, reload, assert equivalence.

### Integration tests (live CLIs, opt-in via `npm run test:integration`)
- One per agent: minimal "say hello" prompt; assert non-empty stream of chunks ending in `done`. Plus one known auth/install error path.
- Skipped by default to avoid burning subscription quota and slowing the feedback loop.

### Manual smoke checklist for v1 sign-off
1. Open a workspace, open the chat panel — three agents show ready in the strip.
2. Send a message with no `@mention` — facilitator picks an agent, chip renders, response streams.
3. Send `@gemini …` — bypasses facilitator, dispatches to Gemini.
4. Send `@all …` — three agents respond sequentially, floor passes between them.
5. Cancel mid-stream — process killed, floor released.
6. Reload VSCode — chat history restored.
7. Log out of one CLI, send a message — error renders inline, other agents still work.

### Not tested in v1
- Webview rendering edge cases (manual review only)
- Tool-call/result rendering edge cases (defer)
- macOS / Linux compatibility (best-effort, primary target is Windows)

## 11. Open risks & spikes

- **PTY emulation for Codex / Gemini.** First implementation step is a small spike to validate non-interactive mode for each CLI. Result feeds back into the plan.
- **Streaming format normalization.** Each CLI emits differently shaped events; the adapter contracts will likely need refinement after the spike.
- **Subscription rate limits.** Each provider may rate-limit subscription tier traffic differently from API tier. Surfaced as inline errors when hit; not a v1 design problem unless it's pervasive.

## 12. Implementation order (suggested for the planning step)

1. CLI spike — confirm non-interactive mode for each of Claude SDK, Codex CLI, Gemini CLI
2. Agent adapter interface + Claude adapter (the simplest — in-process SDK)
3. Codex adapter + Gemini adapter, using whatever the spike revealed
4. Message router + floor manager (no facilitator yet, `@mention`-only)
5. Webview chat panel rendering + composer + `@mention` autocomplete
6. Session store / persistence
7. Facilitator + routing chips
8. Error handling matrix + subscription health strip
9. Manual smoke pass; ship v1

This ordering is a suggestion for the implementation plan that follows; the writing-plans step will refine it.
