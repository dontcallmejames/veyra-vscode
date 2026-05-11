# Veyra Workflow Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve Veyra's existing workflows so review/debate/implement produce categorized findings, final recommendations, and handoff summaries.

**Architecture:** Keep the current serial `@all` dispatch path. Change only the workflow prompt contract and README documentation, then verify the shared surfaces that consume those prompts.

**Tech Stack:** TypeScript, existing `src/workflowPrompts.ts`, README documentation, Vitest.

---

## Scope Check

This plan implements the first slice of Milestone 4 from `docs/superpowers/specs/2026-05-11-veyra-v1-roadmap-design.md` and the design in `docs/superpowers/specs/2026-05-11-veyra-workflow-intelligence-design.md`.

It does not add `/consensus`, role customization, workflow templates, another facilitator backend call, or terminal awareness.

## File Structure

- Modify `src/workflowPrompts.ts`
  - Adds structured categories and final synthesis instructions to review and debate prompts.
  - Adds a final handoff summary instruction to implement prompts.
- Modify `tests/workflowPrompts.test.ts`
  - Locks the prompt contract for categories, synthesis, final recommendation, and handoff summary.
- Modify `README.md`
  - Documents the clearer output shape for review, debate, and implement workflows.
- Modify `tests/manifest.test.ts`
  - Ensures README keeps documenting synthesis and handoff expectations.

## Task 1: Lock Workflow Prompt Contracts

**Files:**
- Modify: `tests/workflowPrompts.test.ts`

- [ ] **Step 1: Add failing review prompt assertions**

Add assertions to the review test:

```ts
expect(prompt).toContain('Blocking issues');
expect(prompt).toContain('Advisory risks');
expect(prompt).toContain('Missing tests');
expect(prompt).toContain('Follow-up suggestions');
expect(prompt).toContain('Gemini runs last');
expect(prompt).toContain('Veyra Synthesis');
expect(prompt).toContain('Next action');
```

- [ ] **Step 2: Add failing debate prompt assertions**

Add assertions to the debate test:

```ts
expect(prompt).toContain('Recommendation');
expect(prompt).toContain('Tradeoffs');
expect(prompt).toContain('Concerns with prior replies');
expect(prompt).toContain('Veyra Synthesis');
expect(prompt).toContain('Recommended approach');
expect(prompt).toContain('Next action');
```

- [ ] **Step 3: Add failing implement prompt assertions**

Add assertions to the implement test:

```ts
expect(prompt).toContain('Handoff Summary');
expect(prompt).toContain('What changed');
expect(prompt).toContain('Verification status');
expect(prompt).toContain('Remaining risks');
expect(prompt).toContain('Recommended next action');
```

- [ ] **Step 4: Run focused tests and verify failure**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/workflowPrompts.test.ts
```

Expected: fail because the prompt does not yet contain the new structured sections.

## Task 2: Implement Prompt Enhancements

**Files:**
- Modify: `src/workflowPrompts.ts`

- [ ] **Step 1: Update the review prompt**

Add instructions that require each reviewer to use the four review categories and require Gemini to append `Veyra Synthesis` with recommendation, blocking issues, missing tests, and next action.

- [ ] **Step 2: Update the debate prompt**

Add instructions that require each agent to state recommendation, tradeoffs, concerns with prior replies, and next action. Require Gemini to append `Veyra Synthesis` with recommended approach, rationale, risks, and next action.

- [ ] **Step 3: Update the implement prompt**

Add instructions that require Gemini to end with `Handoff Summary` covering what changed, verification status, remaining risks, and recommended next action.

- [ ] **Step 4: Run focused prompt tests**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/workflowPrompts.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit prompt slice**

Run:

```powershell
git add src/workflowPrompts.ts tests/workflowPrompts.test.ts docs/superpowers/specs/2026-05-11-veyra-workflow-intelligence-design.md docs/superpowers/plans/2026-05-11-veyra-workflow-intelligence-implementation.md
git commit -m "feat: sharpen workflow synthesis prompts"
```

## Task 3: Document Workflow Outcomes

**Files:**
- Modify: `README.md`
- Modify: `tests/manifest.test.ts`

- [ ] **Step 1: Add failing README contract assertions**

In `tests/manifest.test.ts`, add README assertions for:

```ts
expect(readme).toContain('Veyra Synthesis');
expect(readme).toContain('Blocking issues');
expect(readme).toContain('Recommended approach');
expect(readme).toContain('Handoff Summary');
```

- [ ] **Step 2: Run docs test and verify failure**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/manifest.test.ts
```

Expected: fail because README does not document the new output shape.

- [ ] **Step 3: Update README workflow section**

Document that `/review` categorizes output, `/debate` ends with `Veyra Synthesis`, and `/implement` ends with `Handoff Summary`.

- [ ] **Step 4: Run docs test**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/manifest.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit docs slice**

Run:

```powershell
git add README.md tests/manifest.test.ts
git commit -m "docs: document workflow synthesis"
```

## Task 4: Final Verification

**Files:**
- Modify only if verification exposes a defect.

- [ ] **Step 1: Run focused workflow surface tests**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/workflowPrompts.test.ts tests/nativeChat.test.ts tests/languageModelProvider.test.ts tests/manifest.test.ts
```

Expected: pass.

- [ ] **Step 2: Run full local verification**

Run:

```powershell
npm run verify
```

Expected: pass.

- [ ] **Step 3: Run VS Code smoke verification**

Run:

```powershell
npm run test:vscode-smoke
```

Expected: pass.

- [ ] **Step 4: Check branch status and whitespace**

Run:

```powershell
git status --short --branch
git diff --check
```

Expected: only intended committed changes and no whitespace errors.
