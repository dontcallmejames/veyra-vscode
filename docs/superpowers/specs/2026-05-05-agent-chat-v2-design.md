# Agent Chat v2 — Cross-Agent Context + Polish Design

**Date:** 2026-05-05
**Status:** Draft, awaiting user review
**Author:** Jim (with Claude)

Companion to the v1 spec (`2026-04-29-agent-chat-vscode-v1-design.md`) and its plan supplements. v2's headline is **cross-agent context** — letting each agent see the full shared transcript instead of only the current user prompt — plus four supporting features lifted from a competitive audit of [Mysti](https://github.com/DeepMyst/Mysti) (`@file` mentions, `agentchat.md` workspace rules, file decoration badges, and commit signature tagging via git hook).

## 1. Summary

v1 ships a stateless multi-agent chat: each `agent.send(prompt)` receives only the user's current input. v2 makes the chat truly collaborative — when the user says "@gpt continue what claude said," Codex actually sees what Claude said. The mechanism is a pure-function shared-transcript serializer that runs on every send, applies a sliding window (default 25 messages), strips tool-call payloads, and prepends the result to the agent's prompt.

Around that headline, v2 adds four polish features that compound naturally with shared context:

- **`@file.ts` mentions** — auto-embed file contents in the user prompt so all three agents see the same file at once (a deliberate "share with everyone" gesture).
- **`agentchat.md` workspace rules** — a per-project Markdown file pinned to the top of every agent prompt.
- **File decoration badges** — when an agent edits a file, a colored dot appears in the VS Code explorer for 24h.
- **Commit signature tagging** — an opt-in git `prepare-commit-msg` hook adds a `Co-Authored-By: Agent Chat (<agentId>)` trailer to commits made during agent dispatches.

Compaction (summarizing older messages once the transcript exceeds a token threshold) was scoped out and parked for v2.1.

## 2. Goals & non-goals

### In scope (v2)

**Headline — cross-agent context:**
- Pure function `buildSharedContext(session, opts)` returns a labeled-line preamble of the last N messages (default 25). Includes `UserMessage.text` and `AgentMessage.text` for `complete` and `errored` statuses; excludes cancelled agents, system messages, in-progress messages, and all `toolEvents`.
- Empty session → empty string; the caller skips the preamble entirely.
- Sliding-window trim adds an `[Conversation so far — earlier messages omitted]` prefix when applied.
- Composition order in the final prompt: `agentchat.md` rules → shared transcript → embedded file blocks (from `@file`) → user's current natural-language text.
- Same shared transcript is passed to the facilitator (`chooseFacilitatorAgent` signature gains `sharedContext: string`) so smart routing handles follow-ups like "@gpt continue from there" correctly.
- For `@all` dispatches, the transcript is rebuilt between agents in the router loop, so the second and third agents in `@all` see the prior agents' just-finished replies.

**`@file.ts` mentions:**
- `parseMentions` (extended) recognizes `@<path>` tokens distinct from `@claude` / `@gpt` / `@gemini` / `@all`; returns `{ targets, fileMentions, remainingText }`.
- Paths resolve relative to the workspace root; absolute paths accepted; `..` paths that escape the workspace are rejected with an inline error system message.
- File contents are embedded as labeled blocks before the user's prose, in mention order:

  ```
  [File: src/auth.ts]
  ~~~ts
  <up to fileEmbedMaxLines lines>
  ~~~
  [/File]
  ```

  (the `~~~` markers are triple-backticks in the actual prompt — written as tildes here only to keep this Markdown spec from breaking out of its own code fence)
- Truncated files show `[File: src/auth.ts — first 500 of 2,341 lines]` and a `[/File — truncated; use the Read tool to fetch the rest]` marker. The responding agent can fetch the rest via its own Read tool; that fetched content stays private to that agent (shared context strips tool calls).
- Default cap: 500 lines, configurable via `agentChat.fileEmbedMaxLines` (1–10000). Hard byte ceiling: 10MB.
- Error cases (file missing, binary, too large, read failure) skip that embed and emit an inline system message; the rest of the send proceeds.
- `UserMessage` gains optional `attachedFiles?: { path: string; lines: number; truncated: boolean }[]` for UI rendering; `text` retains the user's original input with `@path` tokens preserved so the chat reads naturally to humans.
- UI: composer chip-highlights `@<path>` tokens during typing; user message bubble renders a small attachment list under the prose (`📎 src/auth.ts (213 lines)`).
- No file-path autocomplete in v2.0 (parked).

**`agentchat.md` workspace rules:**
- Optional file at `<workspace>/agentchat.md`; free-form Markdown.
- Read by `readWorkspaceRules(workspacePath)` on every send (no caching, supports live edits).
- Pinned to the top of every agent prompt as:

  ```
  [Workspace rules from agentchat.md]
  <file contents verbatim>
  [/Workspace rules]
  ```

- Missing file → no block (no placeholder).
- Same 10MB byte ceiling as `@file`; no line truncation (user authored these deliberately).
- Health-strip indicator: small "📋 rules" chip shown when the file exists; click opens the file.
- Bootstrap: one-time info nudge on first launch in a workspace without `agentchat.md` ("Tip: create `agentchat.md` at the workspace root to pin per-project instructions"). Dismissible. State stored under `agentChat.agentchatMdTipShown`.
- Agent-specific scoping is a prose convention (`## Codex` sections); we don't parse it.

**File decoration badges:**
- Triggered by successful write-class tool calls. Per-adapter `getEditedPath(toolName, input)` helper returns absolute path or null. Recognized tool names per adapter (verified via spike task on plan):
  - Claude SDK: `Edit`, `Write`, `MultiEdit`, `NotebookEdit`
  - Codex CLI: TBD by spike (likely `apply_patch`, `update_file`, `write_file`)
  - Gemini CLI: TBD by spike (likely `replace`, `write_file`)
- Unknown tool shapes silently no-op rather than crash.
- VS Code `FileDecorationProvider` renders a single colored dot per file in the explorer; color matches agent brand (Claude orange, Codex green, Gemini blue).
- Hover text: `Edited by Codex 14m ago.` Multiple agents within the 24h window: `Last edited by Codex 14m ago (also: Claude, Gemini)`.
- Failed tool calls (`tool-result` with error) do **not** badge. Adapters already pair call/result events.
- Lifecycle: 24h after last edit; pruned on panel construction.
- Storage: `context.workspaceState['agentChat.fileEdits']` as `FileEditRecord[]`:

  ```ts
  type FileEditRecord = {
    path: string;       // absolute
    agentId: AgentId;   // most-recent editor
    editedAt: number;   // ms epoch
    alsoBy: AgentId[];  // others within the 24h window
  };
  ```

- Setting: `agentChat.fileBadges.enabled` (default `true`).
- Out of scope: read-class tool tracking (creates noise, no value).

**Commit signature tagging via git hook:**
- Sentinel file at `<workspace>/.vscode/agent-chat/active-dispatch` containing the active agent's id (single line, e.g. `claude\n`).
- Panel writes the sentinel on each `dispatch-start`; deletes it on `dispatch-end` when no other dispatches are active. Floor manager keeps `@all` sequential, so the file always holds whichever agent is running now.
- Hook script (POSIX sh, runs in Git Bash on Windows) installed at `.git/hooks/prepare-commit-msg`:

  ```sh
  #!/bin/sh
  # AGENT-CHAT-MANAGED
  SENTINEL=".vscode/agent-chat/active-dispatch"
  if [ -f "$SENTINEL" ]; then
    AGENT_ID=$(cat "$SENTINEL" | tr -d '[:space:]')
    if [ -n "$AGENT_ID" ]; then
      if ! grep -q "Co-Authored-By: Agent Chat" "$1"; then
        printf "\nCo-Authored-By: Agent Chat (%s) <agent-chat@local>\n" "$AGENT_ID" >> "$1"
      fi
    fi
  fi
  ```

- Idempotent (no double-add), silent when no dispatch is active, no node/python dependency, recognizes our own hook via the `# AGENT-CHAT-MANAGED` marker line.
- Install flow: opt-in dialog after the existing gitignore prompt — `Install` / `Not now` / `Don't ask again`. Dismissed state persists in `context.workspaceState['agentChat.commitHookPromptDismissed']`.
- Hook-manager refusal: detects `.husky/`, `lefthook.yml`, `.pre-commit-config.yaml`, `simple-git-hooks` in `package.json`. If any present, refuses install with: `"Detected a hook manager. Please add the Agent Chat trailer logic manually — see Agent Chat: Show commit hook snippet."`
- Refuses overwriting an existing `.git/hooks/prepare-commit-msg` that lacks our marker.
- Commands: `agentChat.installCommitHook`, `agentChat.uninstallCommitHook`, `agentChat.showCommitHookSnippet`.
- Setting: `agentChat.commitSignature.enabled` (default `true`); when `false` the panel doesn't write the sentinel, hook becomes a no-op even if installed.
- Submodules and worktrees: only the active workspace's `.git/hooks/` is touched.

**Settings additions (`package.json` `contributes.configuration`):**

| Key | Type | Default | Purpose |
|---|---|---|---|
| `agentChat.fileEmbedMaxLines` | number | 500 | Line cap for `@file` embedding |
| `agentChat.sharedContextWindow` | number | 25 | Sliding-window size (messages) |
| `agentChat.fileBadges.enabled` | boolean | true | Toggle file decoration badges |
| `agentChat.commitSignature.enabled` | boolean | true | Toggle sentinel writing |

**Protocol additions (`src/shared/protocol.ts`):**

```ts
type UserMessage = {
  ...existing fields,
  attachedFiles?: { path: string; lines: number; truncated: boolean }[];
};

type FromExtension =
  | ...existing variants
  | { kind: 'file-edited'; path: string; agentId: AgentId; timestamp: number };
```

Session JSON stays at `version: 1`; `attachedFiles` is optional, so old sessions load without migration.

### Out of scope (deferred)

- **Compaction** — threshold-based summarization of older transcript entries when token budget exceeds ~75%. Recognized as the natural successor when sliding-window cuts start losing useful history. Targeted for v2.1.
- **Kanban board** — original v1 framing, deferred to v3.
- **Per-agent git worktrees / parallel @all** — v3.
- **Editable agent profiles / personas** — v2 polish parked.
- **File-path autocomplete on `@<path>` typing** — UX polish.
- **`@@file.ts` "embed in full" override syntax** — bumping the cap setting suffices in v2.0.
- **In-composer "this file is large — embed in full?" toggle** — better UX, more plumbing.
- **Read-class tool tracking for badges** — adds noise.
- **Per-agent shared-context budgets** — uniform window suffices until compaction lands.

### Success criteria

v2 is done when the v1 manual smoke checklist still passes end-to-end **and** the new criteria below pass:

1. Empty session → `@claude hi` → no preamble in prompt (verified by intercepting `agent.send`).
2. Reply, then `@gpt did you see what claude said?` → Codex's prompt contains Claude's prior reply text.
3. `@all draft something` → second and third agents in the dispatch see the earlier ones in their prompts.
4. `agentchat.md` says "always use pnpm" → all three agents respect it; live-edit the file, send another message, and the new rules take effect without panel reload.
5. `@src/auth.ts review` (small file) → file embedded in prompt; user bubble shows attachment chip.
6. `@src/big_file.ts review` (cap exceeded) → truncated marker present; agent's reply references using its Read tool for more.
7. Agent edits a file via tool call → file decoration appears in the explorer with the agent's brand color; hover shows agent name.
8. Install commit hook on a workspace with husky → install dialog refuses with helpful message pointing at the snippet command.
9. Install commit hook on a clean repo → succeeds; agent commit during a dispatch gets the trailer; uninstall removes cleanly without touching user-authored hooks.
10. Disable `commitSignature.enabled` → sentinel file never appears even with hook installed; commits during dispatch get no trailer.

## 3. Architecture overview

v1 is stateless per send. v2 introduces shared state — but only as a derivation from the persisted `Session`, not as new persistent state of its own. The session JSON is unchanged in shape (version 1, optional `attachedFiles` field). All v2 features are pure-function transforms on `Session` + filesystem reads at send time.

**Send pipeline (extension host):**

```
text + cwd
  → parseMentions (extended for @<path>)
  → embedFiles (read + truncate + format)
  → buildSharedContext(session, last-N)
  → readWorkspaceRules(cwd)
  → composePrompt(rules, sharedContext, fileBlocks, userText)
  → agent.send(composedPrompt, opts)
```

The `Agent.send()` interface doesn't change — agents still receive a single string. The composition is a panel/router-side concern. Webview is unaware of context plumbing.

**Bolt-on subsystems (independent of the prompt pipeline):**
- File decoration badges — a `FileDecorationProvider` driven by tool-event observation in the panel.
- Commit signature tagging — sentinel-file writes around dispatch lifecycle + an opt-in git hook install command.

**Module structure — new files:**

```
src/sharedContext.ts       — buildSharedContext() pure function
src/workspaceRules.ts      — readWorkspaceRules() fs read
src/fileMentions.ts        — parseFileMentions(), embedFiles(), truncation
src/composePrompt.ts       — single composer: rules + transcript + attachments + user text
src/fileBadges.ts          — FileDecorationProvider + workspaceState bookkeeping
src/commitHook.ts          — install/uninstall/snippet logic + sentinel writer + hook-manager detection
```

**Existing files modified:**
- `src/messageRouter.ts` — accepts composed prompts; rebuilds shared context between targets in `@all` loop; passes shared transcript to facilitator.
- `src/facilitator.ts` — signature gains `sharedContext: string`.
- `src/panel.ts` — orchestrates the new pipeline; writes/clears the dispatch sentinel; emits `file-edited` events on write tool calls.
- `src/mentions.ts` — extended to recognize `@<path>` tokens distinct from agent names (or wrapped by a new `parseAllMentions`).
- `src/shared/protocol.ts` — `UserMessage.attachedFiles?`, new `file-edited` event variant.
- `package.json` — four new settings, three new commands, one `contributes.configuration` block update.

**Unchanged modules:**
- `src/floor.ts` — sequential dispatch semantics still correct.
- `src/sessionStore.ts` — session JSON shape compatible.
- `src/statusChecks.ts` — unrelated.
- `src/agents/{claude,codex,gemini}.ts` — adapters gain a single `getEditedPath(toolName, input)` helper each, but `send()` unchanged.

## 4. Cross-agent context details

**Serializer format (`buildSharedContext`):**

```
[Conversation so far]
user: How should we structure auth?
claude: I'd suggest OAuth2 with PKCE...
user: @gpt now write the route handlers
codex: Here's auth.ts: ...
[/Conversation so far]
```

When the sliding window trims earlier messages:

```
[Conversation so far — earlier messages omitted]
user: ...
...
[/Conversation so far]
```

**Inclusion rules:**

| Field | Included? |
|---|---|
| `UserMessage.text` | Yes, full text including `@mentions` |
| `AgentMessage.text` (status: complete) | Yes |
| `AgentMessage.text` (status: errored) | Yes — went to user |
| `AgentMessage.text` (status: cancelled) | No — never delivered |
| `AgentMessage.toolEvents` | No — stripped per design |
| `SystemMessage` (any kind) | No — internal noise to LLM |
| In-progress agent message (current dispatch) | No — transcript built before dispatch |

**Sliding window:** keep the last `agentChat.sharedContextWindow` messages (default 25). Counts user + agent messages combined. System and in-progress excluded.

**Composition order in the final prompt:**

```
[Workspace rules from agentchat.md]
<rules content>
[/Workspace rules]

[Conversation so far]
<windowed history>
[/Conversation so far]

[File: src/auth.ts]
<embedded file>
[/File]

review please
```

Each block is omitted independently when empty. First send in a clean workspace with no rules → just the user's text.

**Facilitator integration:** `chooseFacilitatorAgent(userMessage, availability, sharedContext)`. The Claude SDK call adds the shared context to its system prompt or pre-message context (decision deferred to plan). This lets the facilitator route follow-ups based on history rather than only the latest message.

## 5. Settings, persistence, protocol summary

**New settings:**

| Key | Type | Default | Range/notes |
|---|---|---|---|
| `agentChat.fileEmbedMaxLines` | number | 500 | 1–10000 |
| `agentChat.sharedContextWindow` | number | 25 | 1–200 |
| `agentChat.fileBadges.enabled` | boolean | true | hard off-switch |
| `agentChat.commitSignature.enabled` | boolean | true | governs sentinel writes |

**New commands:**
- `agentChat.installCommitHook`
- `agentChat.uninstallCommitHook`
- `agentChat.showCommitHookSnippet`

**Protocol changes (`src/shared/protocol.ts`):**

```ts
type UserMessage = {
  ...existing fields,
  attachedFiles?: { path: string; lines: number; truncated: boolean }[];
};

type FromExtension =
  | ...existing variants
  | { kind: 'file-edited'; path: string; agentId: AgentId; timestamp: number };
```

**Workspace state additions (`context.workspaceState`):**

| Key | Shape | Purpose |
|---|---|---|
| `agentChat.fileEdits` | `FileEditRecord[]` | File badges; pruned >24h on panel construction |
| `agentChat.commitHookPromptDismissed` | boolean | One-shot install dialog suppression |
| `agentChat.agentchatMdTipShown` | boolean | One-shot info nudge for the rules file |

**Filesystem additions (per workspace):**
- `<workspace>/agentchat.md` — user-authored, optional, gitignore decision left to user
- `<workspace>/.vscode/agent-chat/active-dispatch` — sentinel, gitignored by existing prompt
- `<workspace>/.git/hooks/prepare-commit-msg` — opt-in install only

## 6. Testing strategy

**Unit tests (vitest, same pattern as v1's 83 tests):**

| Module | Key cases |
|---|---|
| `sharedContext.ts` | Empty session → `''`; includes user + complete + errored; excludes cancelled, system, in-progress, tool events; sliding window cap; "earlier omitted" prefix; agent labeling correct |
| `workspaceRules.ts` | Missing file → `''`; present file verbatim; re-read on every call (no cache) |
| `fileMentions.ts` | Distinguishes `@claude` vs `@src/foo.ts`; path traversal rejected; binary file rejected; file-not-found yields error; multiple files preserve order; truncation marker contains correct line counts; cap respects setting |
| `composePrompt.ts` | Order is rules → transcript → attachments → user text; each block omitted independently when empty |
| `fileBadges.ts` | 24h prune on load; `alsoBy` accumulates; most-recent wins color; missing file silent no-op; failed tool result doesn't badge |
| `commitHook.ts` | Detects husky / lefthook / pre-commit / simple-git-hooks; refuses on existing non-marker hook; marker line preserved; idempotent install; uninstall refuses on user-authored hook |

**Router-level tests (extend `tests/messageRouter.test.ts`):**
- Facilitator receives the shared transcript (mock asserts argument).
- `@all` rebuilds context between targets — Codex's prompt contains Claude's just-finished message.
- Prompt composition called once per target with fresh context.
- Cancelled messages don't pollute subsequent dispatches.

**Panel-level tests (extend `tests/panel.test.ts`):**
- Sentinel file lifecycle: written on `dispatch-start`, deleted on `dispatch-end` when no other dispatches active, persists between sequential `@all` agents until the last one finishes.
- `file-edited` event emitted exactly once per successful write tool-call.
- Sentinel writer is a no-op when `agentChat.commitSignature.enabled` is `false`.

**Integration / snapshot test:**
- One end-to-end test: feed a session with 3 prior turns + an `agentchat.md` + a `@file.ts` mention, intercept the prompt before `agent.send()`, snapshot-match the assembled string. Catches regressions in the composition order.

**Manual smoke checklist** (see Section 2 success criteria — runs before merge).

## 7. Open questions / parking lot

- **Compaction trigger and summarizer choice** — when v2.1 lands compaction, should Claude (in-process SDK, cheapest call) always be the summarizer, or should each agent get its own compaction? Decision deferred until v2.1.
- **Per-agent shared context budgets** — Codex/Gemini may have smaller context windows than Claude in practice. v2.0 uses one uniform window; if real users hit limits asymmetrically, revisit in v2.1.
- **Tool-call shape verification for badges** — Codex and Gemini adapter tool-call formats need a spike at start of plan. v1 telemetry has the data; spike is reading it.
- **Commit hook UX on Windows without Git Bash** — POSIX sh assumed. If a user has `git` from a non-bundled distribution, the hook may fail silently. Detect at install time?

## 8. Scope check

This spec covers a single coherent capability — making the chat truly multi-agent — with four supporting features that compound on it without standing alone (badges, rules, commit tagging, file mentions all reinforce the "agents working together on this codebase" framing). Single implementation plan; no decomposition needed.
