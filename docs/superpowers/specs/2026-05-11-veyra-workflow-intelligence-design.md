# Veyra Workflow Intelligence Design

**Date:** 2026-05-11
**Status:** Approved for first implementation slice
**Author:** Codex

## 1. Summary

Milestone 4 should make the existing multi-agent workflows produce clearer outcomes without adding another backend call or a new orchestration subsystem yet. The first slice improves the instructions that already drive `/review`, `/debate`, and `/implement`.

The implementation should keep the existing serial `@all` flow:

1. Claude speaks first from architecture and correctness.
2. Codex speaks second from implementation and tests.
3. Gemini speaks last from edge cases and adversarial review.

Because Gemini already runs after the other agents and receives shared context, Gemini can produce the first facilitator-style synthesis inside the existing workflow.

## 2. Product Goal

After a workflow finishes, the user should not need to manually reconcile three independent answers. `/review` should classify issues by actionability. `/debate` should end with a recommended path. `/implement` should leave a compact handoff summary that makes follow-up work easier.

## 3. Non-Goals

- No new `/consensus` command in this slice.
- No extra paid facilitator synthesis call after all agents respond.
- No workspace-configurable roles yet.
- No template picker or custom workflow editor yet.
- No changes to dispatch ordering, checkpointing, diff preview, or rollback.

## 4. Workflow Changes

### Review

Review agents should use stable categories:

- Blocking issues
- Advisory risks
- Missing tests
- Follow-up suggestions

Gemini, as the final reviewer, should append a `Veyra Synthesis` section with:

- Recommendation
- Blocking issues
- Missing tests
- Next action

### Debate

Debate agents should each state:

- Recommendation
- Tradeoffs
- Concerns with prior replies
- Next action

Gemini should append a `Veyra Synthesis` section with:

- Recommended approach
- Why
- Risks
- Next action

### Implement

Implementation remains write-capable. Claude frames approach and risk, Codex implements, and Gemini reviews the result. Gemini should end with a `Handoff Summary` section covering:

- What changed
- Verification status
- Remaining risks
- Recommended next action

## 5. Architecture

Update `src/workflowPrompts.ts` only for production behavior. Native chat, the Language Model provider, the panel, smoke agents, checkpoints, and diff preview already route through those workflow prompts.

Tests should focus on prompt contract stability so future edits do not blur the categories, synthesis instruction, or read-only guardrails.

## 6. Success Criteria

- `/review` prompts require categorized findings and final synthesis.
- `/debate` prompts require a concrete final recommendation.
- `/implement` prompts require a final handoff summary.
- README documents the workflow outcome shape.
- Existing focused workflow tests, native chat tests, language model tests, full local verification, and VS Code smoke still pass.
