# Veyra Preview Hardening Design

**Date:** 2026-05-11
**Status:** Approved for implementation
**Author:** Codex

## 1. Summary

This slice makes the current Veyra preview easier to understand, install, verify, and demo without adding new agent capability.

The preview now has the core v1 trust spine: workspace context, diff preview, checkpoints, consensus, terminal context, and Claude CLI fallback. The next useful step is packaging those capabilities into a clear first-run path and a repeatable demo script.

## 2. Scope

Ship a documentation and setup-guide hardening pass:

- Add a packaged demo script that walks through status verification, `/review`, `/debate`, `/consensus`, `/implement`, diff preview, checkpoints, and smoke verification.
- Add a README preview quickstart that explains what Veyra is for, how to verify local agents, and which commands to run first.
- Update the in-editor setup guide so a user can move from backend setup to a safe demo without hunting through the repository.
- Keep package verification aware of the new packaged demo document.

## 3. Non-Goals

- No screenshots or generated media in this slice.
- No new command registrations.
- No new first-run modal prompts.
- No paid live prompt execution.
- No marketplace publishing automation.

## 4. Architecture

This is intentionally low-risk:

- `docs/preview-demo-script.md` becomes the canonical demo checklist.
- `README.md` links to that checklist and adds a preview quickstart.
- `src/extension.ts` embeds the same setup-to-demo path in `Veyra: Show setup guide`.
- `package.json` and `scripts/verify-package.mjs` include the demo document in the package allowlist.
- Existing tests cover README/package/setup-guide drift.

## 5. Success Criteria

- A new user can follow the README from install/setup to a safe demo.
- The setup guide names the read-only workflows and points at the demo script.
- The demo script is included in package dry-run verification.
- Focused docs/setup/package tests, full verification, and VS Code smoke pass.
