# Veyra Consensus Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only `/consensus` workflow and matching `veyra-consensus` Language Model Chat model.

**Architecture:** Reuse the existing serial `@all` workflow prompt path. Add consensus to the workflow command union, native chat slash command handling, language model registry, smoke diagnostics, smoke fixtures, package manifest, README, and smoke docs.

**Tech Stack:** TypeScript, existing Veyra session service, existing native chat participant, existing Language Model Chat provider, VS Code manifest, Vitest.

---

## Scope Check

This plan implements the `/consensus` slice from Milestone 4 in `docs/superpowers/specs/2026-05-11-veyra-v1-roadmap-design.md` and the design in `docs/superpowers/specs/2026-05-11-veyra-consensus-workflow-design.md`.

It does not implement terminal awareness, browser automation, role customization, workflow templates, embeddings, or any new facilitator backend call.

## File Structure

- Modify `src/workflowPrompts.ts`
  - Add the `consensus` workflow command and prompt contract.
- Modify `src/nativeChat.ts`
  - Add native slash command dispatch, diagnostics, and smoke responses for `/consensus`.
- Modify `src/languageModelProvider.ts`
  - Add `veyra-consensus` and preserve read-only dispatch behavior.
- Modify `package.json`
  - Add the `/consensus` chat participant command.
- Modify tests:
  - `tests/workflowPrompts.test.ts`
  - `tests/nativeChat.test.ts`
  - `tests/languageModelProvider.test.ts`
  - `tests/manifest.test.ts`
  - `tests/vscodeSmokeScript.test.ts`
- Modify smoke/docs:
  - `tests/extension-host/smoke.js`
  - `scripts/run-vscode-smoke.mjs`
  - `README.md`
  - `docs/vscode-smoke-test.md`

## Task 1: Add Failing Tests

- [x] **Step 1: Lock the consensus prompt contract**

Add a test proving `veyraWorkflowPrompt('consensus', ...)` includes `Workflow: consensus`, read-only guardrails, all three role instructions, stable headings, `Consensus Recommendation`, `Decision`, `Rationale`, `Tradeoffs`, `Risks`, `Next action`, and the user prompt.

- [x] **Step 2: Lock native chat behavior**

Add tests proving `/consensus` routes to `@all`, uses the consensus workflow prompt, and sets `readOnly: true`.

- [x] **Step 3: Lock Language Model Chat behavior**

Add tests proving `veyra-consensus` is listed and dispatches with `workflowCommand: 'consensus'` and `readOnly: true`.

- [x] **Step 4: Lock manifest and smoke expectations**

Add assertions for the `/consensus` command, README coverage, smoke docs coverage, smoke participant commands, smoke workflow diagnostics, native chat smoke responses, and language model smoke responses.

- [x] **Step 5: Run focused tests and verify failure**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/workflowPrompts.test.ts tests/nativeChat.test.ts tests/languageModelProvider.test.ts tests/manifest.test.ts tests/vscodeSmokeScript.test.ts
```

Expected: fail because consensus is not implemented yet.

## Task 2: Implement Consensus Workflow

- [x] **Step 1: Add the prompt**

Add `consensus` to `VeyraWorkflowCommand` and implement the read-only consensus prompt in `src/workflowPrompts.ts`.

- [x] **Step 2: Add native chat support**

Route `request.command === 'consensus'` through `veyraWorkflowPrompt('consensus', prompt)` with `target: 'veyra'` and `readOnly: true`. Add consensus to workflow diagnostics and native smoke requests.

- [x] **Step 3: Add Language Model Chat support**

Register `veyra-consensus` in `VEYRA_LANGUAGE_MODELS` and treat it as read-only during dispatch.

- [x] **Step 4: Add manifest and smoke coverage**

Add the package command, extension-host smoke command/model expectations, smoke-script required response validation, and fixture expectations.

- [x] **Step 5: Run focused tests**

Run the same focused Vitest command. Expected: pass.

## Task 3: Document Consensus

- [x] **Step 1: Update README**

Document `/consensus`, `veyra-consensus`, read-only behavior, examples, and final `Consensus Recommendation` output shape.

- [x] **Step 2: Update smoke docs**

Document the new model and command in `docs/vscode-smoke-test.md`.

- [x] **Step 3: Run manifest and smoke-script tests**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/manifest.test.ts tests/vscodeSmokeScript.test.ts
```

Expected: pass.

## Task 4: Final Verification

- [x] **Step 1: Run focused workflow surface tests**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/workflowPrompts.test.ts tests/nativeChat.test.ts tests/languageModelProvider.test.ts tests/manifest.test.ts tests/vscodeSmokeScript.test.ts
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
