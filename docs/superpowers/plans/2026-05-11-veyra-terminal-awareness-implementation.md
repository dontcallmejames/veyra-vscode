# Veyra Terminal Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first Terminal Awareness slice: explicit terminal-selection context and safe project command hints.

**Architecture:** Add a pure project command provider, pass its formatted block through `VeyraSessionService` into `composePrompt`, keep native chat terminal references labelled, and document the no-hidden-execution guardrail.

**Tech Stack:** TypeScript, Node `fs/promises`, existing `VeyraSessionService`, existing native chat reference parsing, Vitest.

---

## Scope Check

This plan implements the first slice of Milestone 5 from `docs/superpowers/specs/2026-05-11-veyra-v1-roadmap-design.md` and the design in `docs/superpowers/specs/2026-05-11-veyra-terminal-awareness-design.md`.

It does not run terminal commands, scrape shell history, create a task runner UI, or add background terminal polling.

## File Structure

- Create `src/projectCommands.ts`
  - Detects package manager and verification-oriented package scripts.
  - Formats a prompt block with explicit approval guardrails.
- Modify `src/composePrompt.ts`
  - Adds `projectCommands` between workspace context and file attachments.
- Modify `src/veyraService.ts`
  - Accepts an optional `projectCommandProvider`.
  - Retrieves and injects project command hints without blocking dispatch on provider errors.
- Modify `src/veyraRuntime.ts`
  - Wires `ProjectCommandProvider` into the default service and refresh path.
- Modify `src/nativeChat.ts`
  - Keeps terminal string references labelled as terminal context.
- Modify tests:
  - `tests/projectCommands.test.ts`
  - `tests/composePrompt.test.ts`
  - `tests/veyraService.test.ts`
  - `tests/nativeChat.test.ts`
  - `tests/manifest.test.ts`
- Modify docs:
  - `README.md`
  - `docs/vscode-smoke-test.md`

## Task 1: Add Failing Tests

- [x] **Step 1: Test project command detection**

Create tests proving package scripts are converted to safe command hints, lockfiles influence package-manager selection, missing metadata returns no hints, and malformed package JSON does not throw.

- [x] **Step 2: Test prompt composition**

Add assertions that project command hints are ordered after workspace context and before file attachments, and are omitted when empty.

- [x] **Step 3: Test service injection**

Add tests proving command hints appear in direct-agent prompts and provider failures do not block dispatch.

- [x] **Step 4: Test terminal reference labelling**

Add or update native chat tests proving terminal selections are preserved as labelled terminal context.

- [x] **Step 5: Run focused tests and verify failure**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/projectCommands.test.ts tests/composePrompt.test.ts tests/veyraService.test.ts tests/nativeChat.test.ts tests/manifest.test.ts
```

Expected: fail because the provider and prompt plumbing are not implemented yet.

## Task 2: Implement Terminal Awareness Context

- [x] **Step 1: Implement `src/projectCommands.ts`**

Detect `package.json` scripts and infer package manager from lockfiles. Format a `[Project command hints]` prompt block with a no-hidden-execution guardrail.

- [x] **Step 2: Wire prompt composition**

Add `projectCommands?: string` to `ComposePromptInput` and render it after workspace context.

- [x] **Step 3: Wire session service and runtime**

Add `projectCommandProvider` to service options, retrieve hints once per dispatch, ignore provider failures, and instantiate the provider in runtime creation and refresh paths.

- [x] **Step 4: Label terminal context**

Format string references whose label looks terminal-related as `[Terminal context]` blocks.

- [x] **Step 5: Run focused tests**

Run the focused test command. Expected: pass.

## Task 3: Document Behavior

- [x] **Step 1: Update README**

Document terminal selections, project command hints, and the no-hidden-execution guardrail.

- [x] **Step 2: Update smoke docs**

Mention that smoke coverage validates command-hint packaging through unit tests and keeps actual command execution out of the no-paid smoke path.

- [x] **Step 3: Run docs tests**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/manifest.test.ts
```

Expected: pass.

## Task 4: Final Verification

- [x] **Step 1: Run focused workflow surface tests**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/projectCommands.test.ts tests/composePrompt.test.ts tests/veyraService.test.ts tests/nativeChat.test.ts tests/manifest.test.ts
```

Expected: pass.

- [x] **Step 2: Run full local verification**

Run:

```powershell
npm run verify
```

Expected: pass.

- [x] **Step 3: Run VS Code smoke verification**

Run:

```powershell
npm run test:vscode-smoke
```

Expected: pass.

- [x] **Step 4: Check status and whitespace**

Run:

```powershell
git status --short --branch
git diff --check
```

Expected: only intended changes and no whitespace errors.
