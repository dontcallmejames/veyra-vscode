# Veyra Consensus Workflow Design

**Date:** 2026-05-11
**Status:** Approved
**Author:** Codex

## 1. Summary

Add a first-class `/consensus` workflow that asks Claude, Codex, and Gemini to converge on one practical recommendation before any implementation work begins.

This is the second slice of Workflow Intelligence. It should reuse the existing serial `@all` path rather than adding a new facilitator call, scheduler, panel surface, or custom workflow engine.

## 2. Product Goal

Users often know they want Veyra to decide, not just review or debate. `/consensus` should turn several model perspectives into a single, usable answer with enough rationale to act on it.

The workflow should feel different from `/debate`:

- `/debate` compares approaches and preserves disagreement.
- `/consensus` resolves options into a decision and next action.

## 3. Workflow Contract

The consensus workflow is read-only.

It keeps the existing agent order:

1. Claude identifies architecture, product, and correctness constraints.
2. Codex identifies implementation cost, tests, migration risk, and operational failure modes.
3. Gemini compares the prior positions, challenges assumptions, and produces the final recommendation.

Each agent should use stable headings:

- Position
- Evidence
- Risks
- Next action

Gemini runs last and must add a `Consensus Recommendation` section with:

- Decision
- Rationale
- Tradeoffs
- Risks
- Next action

## 4. Surfaces

Expose the workflow through:

- Native chat slash command: `@veyra /consensus ...`
- Language Model Chat model: `veyra-consensus`
- Smoke diagnostics and smoke response validation
- README and smoke-test documentation

## 5. Non-Goals

- No file edits during consensus dispatches.
- No separate facilitator backend request.
- No custom roles or configurable workflow templates.
- No change to agent ordering.
- No terminal awareness, shell transcript capture, browser automation, or embedding retrieval in this slice.

## 6. Success Criteria

- `/consensus` routes through the existing all-agent workflow path.
- `/consensus` is treated as read-only anywhere review/debate are read-only.
- `veyra-consensus` is registered and dispatches the same prompt shape through the Language Model Chat API.
- Smoke diagnostics include the new command and model.
- README documents when to use consensus and what output shape to expect.
- Focused tests, full verification, and VS Code smoke pass.
