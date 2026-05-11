# Veyra Terminal Awareness Design

**Date:** 2026-05-11
**Status:** Approved for first implementation slice
**Author:** Codex

## 1. Summary

Terminal Awareness should help Veyra understand build, test, lint, and compiler loops without turning into hidden shell automation.

The first slice adds safe context:

- Explicit terminal selections from VS Code Chat are preserved as terminal context.
- Project command hints are detected from workspace metadata and included in prompts.
- Agents are told these commands are suggestions only and must not run them unless the user explicitly asks or approves.

## 2. Product Goal

Users should be able to ask Veyra about failing terminal output or implementation verification without manually explaining the repository's command shape every time.

For v1.0, the important trust boundary is clear: Veyra may recommend commands from project metadata, but it does not run hidden terminal commands.

## 3. First Slice

### Terminal Selection Context

Native chat already receives VS Code references. Terminal-like string references should remain visible in the prompt as named context so agents know the text came from terminal output, not from user prose.

### Project Command Hints

Veyra should inspect local workspace metadata and surface a compact prompt block:

- Detected package manager.
- Verification-oriented scripts such as `verify`, `test`, `typecheck`, `lint`, `build`, `check`, and `format`.
- Concrete command suggestions, for example `npm test` or `npm run verify`.
- A guardrail that the commands are suggestions only.

This block is context, not execution evidence.

## 4. Non-Goals

- No hidden terminal command execution.
- No shell history scraping.
- No destructive command automation.
- No background terminal polling.
- No task runner UI.
- No terminal transcript persistence beyond explicit prompt context.

## 5. Architecture

Add a small project command provider that reads package metadata and formats command hints. Wire it into `VeyraSessionService` so panel, native chat, and Language Model provider requests share the same prompt block.

Keep the provider deterministic and local:

- Read `package.json`.
- Infer package manager from lockfiles.
- Cache results until the session service is refreshed.
- Ignore malformed or missing metadata without blocking dispatch.

## 6. Success Criteria

- Prompts include project command hints when package scripts are available.
- Command hints explicitly say not to run commands without user request or approval.
- Native chat terminal selections remain labelled and included in dispatched prompts.
- Missing or malformed package metadata does not block dispatch.
- Focused tests, full verification, and VS Code smoke pass.
