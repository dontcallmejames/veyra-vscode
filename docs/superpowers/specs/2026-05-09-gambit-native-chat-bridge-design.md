# Gambit Native Chat Bridge Design

**Date:** 2026-05-09
**Status:** Draft, implementation-ready under the current goal decision policy
**Author:** Codex

## 1. Summary

Gambit should move from a custom-panel-only extension to a hybrid VS Code extension. The current Gambit panel remains the command center for session history, health, settings, file badges, commit attribution, and future autonomy controls. Native VS Code Chat gains first-class participants for daily use:

- `@gambit` as the orchestrator
- `@claude` as the Claude specialist
- `@codex` as the Codex/GPT execution specialist
- `@gemini` as the Gemini specialist

The implementation should not duplicate routing, prompt composition, session persistence, file mention embedding, workspace rules, badges, or commit attribution. Instead, extract the panel's dispatch pipeline into a reusable extension-host service, tentatively `GambitSessionService`, and have both the webview panel and native chat participants call that service.

This phase prioritizes the Chat Participant API. Language Model Chat Provider support is deferred behind a feature flag because it requires a provider manifest contribution, model metadata, token counting, and conversion between VS Code language model messages and Gambit's existing agent streams. It is valuable, but it should not block the first native chat bridge.

## 2. Problem

The current codebase already has a useful multi-agent core:

- Claude, Codex, and Gemini adapters
- a `MessageRouter` with facilitator support and sequential `@all`
- shared context via `buildSharedContext`
- `@file` embedding via `fileMentions`
- workspace rules via `gambit.md`
- visible file edit badges via `FileBadgesController`
- commit attribution through `.vscode/gambit/active-dispatch`
- a custom Preact webview panel

The limitation is that the user must work inside Gambit's custom panel. That prevents Gambit from feeling native in VS Code's chat workflow and makes it harder to use the standard Chat UI affordances that VS Code already provides.

The project mantra is:

> agents can work together without losing context, stomping each other's edits, or making invisible changes.

The native bridge should preserve that mantra. Native chat must not become a bypass around Gambit's shared session context, edit visibility, or dispatch attribution.

## 3. Goals

### In scope

1. Add native VS Code Chat participants for `@gambit`, `@claude`, `@codex`, and `@gemini`.
2. Keep the current Gambit panel as a command center rather than deleting or replacing it.
3. Extract a reusable service from panel dispatch logic so panel and native chat use the same behavior.
4. Persist native chat messages into the same workspace `SessionStore` used by the panel.
5. Preserve prompt composition order:
   - `gambit.md` workspace rules
   - shared conversation context
   - embedded `@file` blocks
   - current user prompt
6. Preserve file badge tracking for edits triggered from native chat participants.
7. Preserve commit sentinel attribution for dispatches triggered from native chat participants.
8. Stream agent text and progress into VS Code Chat using `ChatResponseStream`.
9. Surface tool calls and tool results in native chat in a compact, visible way so changes are not invisible.
10. Provide enough tests to prove the native bridge reuses the same service and does not fork behavior.

### Out of scope for this phase

1. Full Language Model Chat Provider support.
2. Registering Gambit as a provider for arbitrary VS Code `lm.selectChatModels` consumers.
3. Parallel autonomous worktrees.
4. Long-term memory or summarizing compaction.
5. Full planner/debate/review autonomy loops.
6. Publishing/package marketplace work.

These are next-phase features after the native Chat Participant bridge is stable.

## 4. Assumptions

The goal explicitly asks not to block on questions. The design therefore assumes:

1. Hybrid architecture is correct.
2. `@gambit` plus direct specialists is the preferred native chat surface.
3. Autonomy defaults to "plan, edit, test, then ask before commit" rather than asking before every edit or committing fully autonomously.
4. Native chat and panel messages should share one workspace session history by default.
5. `gambit.md` remains the workspace rules file name.
6. Language Model Chat Provider support is important but should be feature-flagged and implemented after the Chat Participant bridge.

## 5. Architecture

### Current shape

`ChatPanel` currently owns too much orchestration:

- reads configuration
- reads and writes the session store
- parses file mentions
- embeds files
- builds shared context
- reads workspace rules
- composes prompts
- calls `MessageRouter`
- translates router events into webview messages
- writes commit sentinels
- registers file badge edits
- handles hang detection

That makes the webview the only practical entry point.

### Target shape

Introduce a reusable extension-host service:

```ts
export interface GambitDispatchRequest {
  text: string;
  source: 'panel' | 'chat';
  forcedTarget?: AgentId | 'gambit';
  cwd: string;
}

export type GambitDispatchEvent =
  | { kind: 'user-message'; message: UserMessage }
  | { kind: 'system-message'; message: SystemMessage }
  | { kind: 'dispatch-start'; agentId: AgentId; messageId: string; timestamp: number }
  | { kind: 'text'; agentId: AgentId; messageId: string; text: string }
  | { kind: 'tool-call'; agentId: AgentId; messageId: string; name: string; input: unknown }
  | { kind: 'tool-result'; agentId: AgentId; messageId: string; name: string; output: unknown }
  | { kind: 'error'; agentId: AgentId; messageId: string; message: string }
  | { kind: 'dispatch-end'; agentId: AgentId; message: AgentMessage };
```

`GambitSessionService.dispatch(request)` returns `AsyncIterable<GambitDispatchEvent>`.

Both surfaces consume this event stream:

- `ChatPanel` converts events to `FromExtension` webview protocol messages.
- native chat participants convert events to `ChatResponseStream.markdown`, `progress`, anchors, and final `ChatResult` metadata.

The service owns shared mutable behavior:

- `SessionStore`
- `MessageRouter`
- agent registry
- `SentinelWriter`
- file badge registration
- prompt composition
- config reads
- cancellation plumbing

The panel should become thinner. It should still own webview rendering, webview state translation, and UI-only prompts, but not the core dispatch pipeline.

## 6. Native Participants

### `@gambit`

`@gambit` is the orchestrator. It should accept prompts like:

- `@gambit review this change with all agents`
- `@gambit have Claude design it, Codex implement it, and Gemini review edge cases`
- `@gambit continue from the prior Codex result`

Initial implementation can route through the existing facilitator and explicit mention parser. It does not need a full planning loop on day one. The main requirement is that it runs through the same shared context and persisted session as the panel.

The simplest first behavior:

1. If the prompt includes `@claude`, `@codex`, `@gpt`, `@gemini`, or `@all`, preserve existing routing semantics.
2. If no explicit target appears, use the existing facilitator to choose one agent.
3. Add later slash-like commands or `request.command` support for debate/review workflows.

### `@claude`, `@codex`, and `@gemini`

Direct specialist participants force the target agent without requiring the user to type the agent mention inside the prompt.

For example:

- VS Code request to `@codex` with prompt `add tests for the router`
- service receives `forcedTarget: 'codex'`
- service internally dispatches as if the prompt was `@codex add tests for the router`

The displayed prompt in VS Code Chat should stay clean. The synthetic routing prefix is an internal service detail.

## 7. Package Manifest

The first implementation will add activation for native chat usage and register participants in `activate`.

Expected package changes:

```json
{
  "activationEvents": [
    "onCommand:gambit.openPanel",
    "onCommand:gambit.installCommitHook",
    "onCommand:gambit.uninstallCommitHook",
    "onCommand:gambit.showCommitHookSnippet",
    "onChatParticipant:gambit",
    "onChatParticipant:gambit.claude",
    "onChatParticipant:gambit.codex",
    "onChatParticipant:gambit.gemini"
  ],
  "contributes": {
    "chatParticipants": [
      {
        "id": "gambit",
        "name": "gambit",
        "fullName": "Gambit",
        "description": "Coordinate Claude, Codex, and Gemini with shared context and visible edits.",
        "isSticky": true
      },
      {
        "id": "gambit.claude",
        "name": "claude",
        "fullName": "Gambit: Claude",
        "description": "Ask Claude through Gambit's shared context and edit tracking.",
        "isSticky": true
      },
      {
        "id": "gambit.codex",
        "name": "codex",
        "fullName": "Gambit: Codex",
        "description": "Ask Codex through Gambit's shared context and edit tracking.",
        "isSticky": true
      },
      {
        "id": "gambit.gemini",
        "name": "gemini",
        "fullName": "Gambit: Gemini",
        "description": "Ask Gemini through Gambit's shared context and edit tracking.",
        "isSticky": true
      }
    ]
  }
}
```

These manifest fields match the current official VS Code Chat Participant guide: `id`, `name`, `fullName`, `description`, and optional `isSticky`. The TypeScript side is confirmed by `@types/vscode` for the current dependency: `vscode.chat.createChatParticipant(id, handler)` creates a participant, and `ChatRequestHandler` receives `(request, context, response, token)`.

## 8. Streaming Behavior

The service emits model-neutral dispatch events. Native chat rendering maps them as follows:

| Service event | Native chat rendering |
|---|---|
| `user-message` | no direct output; persisted for context |
| `system-message` | `response.markdown()` with a small system prefix |
| `dispatch-start` | `response.progress("Codex is working...")` |
| `text` | buffered then streamed via `response.markdown()` |
| `tool-call` | compact visible line, for example `Running tool: Edit src/foo.ts` |
| `tool-result` | compact visible result or hidden if setting is `hidden` |
| `error` | markdown error line and `ChatResult.errorDetails` when fatal |
| `dispatch-end` | final metadata containing agent id, message id, and status |

The current `gambit.toolCallRenderStyle` setting should apply to native chat too:

- `verbose`: show tool name, input, and output summary
- `compact`: show tool name and affected path when available
- `hidden`: suppress tool cards but still record tool events, badges, and commit attribution

Even when hidden, file badges and commit attribution remain active. Hidden means "less chat noise", not "invisible changes".

## 9. Context And References

VS Code Chat requests include `request.prompt` plus `request.references`. The first implementation should keep existing `@file` parsing because it already works in both panel and service contexts.

Native references can be added incrementally:

1. Phase 1: parse existing `@path` mentions and embed files with current `embedFiles`.
2. Phase 2: inspect `request.references` and convert file references into the same `AttachedFile` / file block representation.
3. Phase 3: add anchors in native chat output for files that were embedded or edited.

The important invariant is that a file shared in native chat becomes part of the persisted user message metadata when possible. This keeps panel and native chat views coherent.

## 10. Edit Safety

This phase should preserve current edit visibility and create hooks for stronger autonomy.

Current protections retained:

- sequential dispatch floor
- file edit badges
- tool-call visibility
- commit sentinel attribution
- shared conversation context
- `gambit.md` rules

New service-level invariants:

1. All write-class tool results pass through one edit detector path.
2. Native chat dispatches call `SentinelWriter.dispatchStart` and `dispatchEnd`.
3. Native chat dispatches call `FileBadgesController.registerEdit` for successful edits.
4. Native chat dispatches append agent messages to `SessionStore`.
5. Cancellation from VS Code's `CancellationToken` calls router cancellation.

Deferred edit safety:

- file reservations before agents edit
- conflict detection against dirty files changed by another agent
- change ledger panel
- diff summary before commit
- per-agent worktrees for parallel execution

## 11. Language Model Chat Provider Phase

Language Model Chat Provider support should be a separate phase.

Reasons:

1. It requires the `languageModelChatProviders` contribution point.
2. It needs model identity and metadata for Claude, Codex, and Gemini.
3. It needs token counting implementation.
4. It needs conversion between `LanguageModelChatRequestMessage[]` and Gambit's simpler prompt string.
5. Provider consumers may expect behavior unlike Gambit's autonomous tool-running agents.

Recommended later shape:

- setting: `gambit.languageModelProvider.enabled`
- vendor id: `gambit`
- models:
  - `gambit-claude`
  - `gambit-codex`
  - `gambit-gemini`
  - `gambit-orchestrator`
- provider implementation should reuse the same lower-level agent adapters, but not expose full autonomous edit behavior unless the calling context explicitly permits tools.

## 12. Test Strategy

### Unit tests

New tests should cover:

1. `GambitSessionService` composes prompts using rules, shared context, file blocks, and user text in the documented order.
2. `forcedTarget: 'codex'` dispatches to Codex without requiring a visible `@codex` prompt.
3. `forcedTarget: 'gambit'` uses facilitator routing when no explicit target is present.
4. native chat dispatch events persist user and agent messages to `SessionStore`.
5. native chat dispatches register file badges on successful write-class tool results.
6. native chat dispatches start and end commit sentinels.
7. cancellation token cancellation calls router cancellation.

### Adapter tests

`registerChatParticipants` should be tested with a mocked `vscode.chat.createChatParticipant`:

1. registers four participants
2. maps participant ids to the correct forced target
3. forwards prompt text to `GambitSessionService`
4. renders text chunks to `ChatResponseStream.markdown`
5. renders progress/tool events according to `toolCallRenderStyle`

### Regression tests

Existing tests for these modules must remain green:

- `messageRouter`
- `composePrompt`
- `sharedContext`
- `fileMentions`
- `workspaceRules`
- `fileBadges`
- `commitHook`
- `panel`

The bridge is only acceptable if it reduces duplication. If the tests need large duplicated panel and native chat expectations, the service boundary is wrong.

## 13. Implementation Plan Outline

Detailed implementation planning should be written separately, but the expected slices are:

1. Extract `GambitSessionService` from `ChatPanel.dispatchUserMessage` without changing behavior.
2. Update `ChatPanel` to consume the service event stream and keep existing webview protocol behavior.
3. Add `src/nativeChat.ts` with participant registration and event rendering.
4. Update `extension.ts` to create shared agents, shared badge controller, shared service, panel command, and chat participants.
5. Update `package.json` activation and `chatParticipants` contribution metadata.
6. Add service and native chat tests.
7. Run `npm run build`, `npm run typecheck`, and `npm test`.

## 14. Success Criteria

This phase is complete when:

1. `@gambit` appears in native VS Code Chat and can route a prompt through the existing facilitator.
2. `@claude`, `@codex`, and `@gemini` appear in native VS Code Chat and dispatch directly to the matching agent.
3. Native chat responses stream text as the agent produces it.
4. Native chat dispatches append to the same persisted `.vscode/gambit/sessions.json` history used by the panel.
5. A native chat follow-up can see prior panel messages through shared context.
6. A panel follow-up can see prior native chat messages through shared context.
7. `@file` mentions in native chat are embedded with the existing file mention logic.
8. `gambit.md` rules apply to native chat prompts.
9. Agent edits made from native chat trigger file badges.
10. Agent dispatches from native chat write and clear the commit sentinel.
11. Cancellation from the native chat UI cancels the active dispatch.
12. Existing panel behavior still passes tests.
13. `npm run build`, `npm run typecheck`, and `npm test` pass.

## 15. Completion Audit Mapping

| Objective requirement | Design coverage |
|---|---|
| fully featured VS Code extension | Hybrid architecture plus native chat participants while preserving panel controls |
| agents work together without losing context | shared `SessionStore`, `buildSharedContext`, panel/native cross-context success criteria |
| avoid stomping edits | sequential floor retained; stronger reservations deferred but named |
| avoid invisible changes | file badges, tool-call rendering, commit sentinel retained for native chat |
| use three paid models | direct `@claude`, `@codex`, `@gemini` participants plus `@gambit` orchestrator |
| collaborate, debate, review | `@gambit` orchestrator is first bridge; full debate/review loops are next phase |
| pretty autonomous | default assumes plan/edit/test/ask-before-commit; deeper autonomy follows bridge |
| VS Code Chat Participant API | primary implementation phase |
| Language Model Chat Provider API | deferred behind feature flag with explicit rationale |
| little human interaction | decision policy captured as assumptions; no blocking questions |

## 16. Risks

1. The local VS Code engine may reject a manifest field if the extension target changes. Keep the implementation pinned to the official Chat Participant guide and the local package schema.
2. Sharing one session between panel and native chat may surprise users who expect separate histories. The default should be shared because context preservation is central to Gambit.
3. Native chat rendering may be noisier than the webview for tool calls. Reuse `toolCallRenderStyle` to control this.
4. Extracting `ChatPanel.dispatchUserMessage` into a service can regress panel behavior if done as a big rewrite. Implement it in small slices with tests.
5. Language Model Provider semantics may not fit autonomous tool-running agents. Keep it separate and feature-flagged.
