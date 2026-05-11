# Veyra Preview Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add preview quickstart and demo documentation, surface it in setup guidance, and package it with the extension.

**Architecture:** Keep the change documentation-first. Add one packaged demo document, link it from README and the in-editor setup guide, and extend package verification tests so package contents stay intentional.

**Tech Stack:** Markdown, VS Code extension setup-guide string, package allowlist, Vitest.

---

## File Structure

- Create `docs/preview-demo-script.md`
  - Repeatable preview demo checklist.
- Modify `README.md`
  - Add a Preview Quickstart and demo link.
- Modify `src/extension.ts`
  - Add quickstart/demo guidance to `SETUP_GUIDE_MARKDOWN`.
- Modify `package.json`
  - Include `docs/preview-demo-script.md` in packaged files.
- Modify `scripts/verify-package.mjs`
  - Include `docs/preview-demo-script.md` in the allowlist.
- Modify tests:
  - `tests/manifest.test.ts`
  - `tests/extension.test.ts`
  - `tests/verifyPackage.test.ts`

## Task 1: Add Failing Tests

- [x] **Step 1: Extend manifest/package docs assertions**

Update `tests/manifest.test.ts` to expect `docs/preview-demo-script.md` in `package.json#files`, the package verifier allowlist, and the README.

- [x] **Step 2: Extend setup-guide assertions**

Update `tests/extension.test.ts` so `Veyra: Show setup guide` must include `Preview Quickstart`, `docs/preview-demo-script.md`, `@veyra /review`, `@veyra /debate`, `@veyra /consensus`, and `@veyra /implement`.

- [x] **Step 3: Extend package count assertion**

Update `tests/verifyPackage.test.ts` so the dry-run output expects 13 files after adding the demo script.

- [x] **Step 4: Run focused tests and verify failure**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/manifest.test.ts tests/extension.test.ts tests/verifyPackage.test.ts
```

Expected: fail because docs/package/setup-guide content is not implemented yet.

## Task 2: Implement Preview Hardening Docs

- [x] **Step 1: Create `docs/preview-demo-script.md`**

Write a concise demo script with setup, safe read-only workflow prompts, implementation smoke, diff/checkpoint controls, and verification commands.

- [x] **Step 2: Update `README.md`**

Add a `Preview Quickstart` section near the top and link to `docs/preview-demo-script.md`.

- [x] **Step 3: Update setup guide**

Add `Preview Quickstart` and demo-script references to `SETUP_GUIDE_MARKDOWN` in `src/extension.ts`.

- [x] **Step 4: Update package allowlists**

Add `docs/preview-demo-script.md` to `package.json#files` and `scripts/verify-package.mjs`.

- [x] **Step 5: Run focused tests**

Run the focused test command. Expected: pass.

## Task 3: Final Verification

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: pass.

- [x] **Step 2: Run VS Code smoke verification**

Run:

```powershell
npm run test:vscode-smoke
```

Expected: pass.

- [x] **Step 3: Check status and whitespace**

Run:

```powershell
git status --short --branch
git diff --check
```

Expected: only intended changes and no whitespace errors.
