# Veyra v1.0 Roadmap Design

**Date:** 2026-05-11
**Status:** Draft for review
**Author:** Codex

## 1. Summary

Veyra v1.0 should optimize for professional parity without losing the product's core identity. It should not try to beat Copilot at inline autocomplete or Cursor at being a full AI-native editor. The v1.0 target is narrower and sharper:

> Veyra understands enough of the workspace to route useful multi-agent work, shows every meaningful change, and lets the user inspect or roll back before trust is lost.

This roadmap uses a **Context + Trust Spine**:

1. Add enough workspace context for real repositories.
2. Add diff and checkpoint controls so multi-agent edits feel safe.
3. Deepen Veyra's unique multi-agent review, debate, and implementation workflows once context and trust are in place.

Autocomplete, browser testing, local models, and Git hosting workflows are deferred until after this spine is useful.

## 2. Product Positioning

Veyra's strongest position is not "another AI assistant inside VS Code." Its strongest position is:

> The safest way to coordinate multiple strong coding agents inside the editor you already use.

The differentiator is multi-agent collaboration:

- Claude, Codex, and Gemini share conversation context.
- Workflows route agents through review, debate, and implementation roles.
- Agent file edits are visible through chat, panel state, file badges, session summaries, and commit attribution.
- Cross-agent edit conflicts are surfaced instead of hidden.

The v1.0 roadmap should make that differentiator usable on real projects by adding workspace understanding and stronger user control around edits.

## 3. Roadmap Principles

### Trust before breadth

Veyra asks users to let several agents reason about and sometimes modify a workspace. That is inherently higher-trust than single-response chat. Diff preview, checkpoints, and rollback are therefore core v1.0 features, not polish.

### Context before autonomy

More autonomy is only valuable if agents receive the right repo context. Veyra should first make context retrieval predictable, inspectable, and cheap enough for daily use.

### Use simple retrieval first

Start with lexical and metadata-backed workspace retrieval before adding embeddings. Most near-term value can come from file inventory, symbol names, ripgrep-style search, package/test metadata, and prompt budgeting. Vector search should be introduced only when simpler retrieval stops being good enough.

### Preserve existing architecture

New roadmap work should reuse the current extension-host service path where possible:

- `VeyraSessionService` remains the shared dispatch pipeline.
- Native chat, the Language Model provider, and the panel should keep using one service path.
- Existing file-edited events, workspace change detection, file badges, edit-conflict notices, and commit attribution should become inputs to the trust features instead of being replaced.

### Do not chase every competitor feature for v1.0

Inline autocomplete, browser automation, local models, and PR workflows are real product opportunities. They are not required for the v1.0 promise unless the product strategy changes from "multi-agent trust and orchestration" to "full daily AI coding assistant replacement."

## 4. Milestone 0: Preview Hardening

### Goal

Make the current preview easy to understand, install, verify, and demo.

### Ship

- Marketplace-ready README copy focused on Veyra's multi-agent promise.
- Screenshot and demo script showing `/review`, `/debate`, and `/implement`.
- Clean setup flow for Claude, Codex, Gemini, Node, and CLI path readiness.
- First-run guidance that explains what Veyra is good for and what it is not trying to do yet.
- Continued verification for native chat, Language Model provider, file edit visibility, smoke tests, packaging, and live readiness.

### Non-goals

- No new AI capability.
- No new indexing, diff, checkpoint, or terminal feature in this milestone.

### Success criteria

- A new user can understand Veyra's purpose from the README and first-run experience.
- The extension can still pass the current local, smoke, package, and live-readiness gates.
- Demo materials show the current differentiator without implying unbuilt features.

## 5. Milestone 1: Workspace Context

### Goal

Make Veyra useful on repositories larger than toy projects.

### Ship

- Lightweight workspace inventory:
  - tracked and untracked source files
  - common ignored directories
  - language and framework hints
  - package manager and test command hints
  - important project metadata files
- `@codebase` mention for retrieval over workspace files.
- Lexical search-backed retrieval using file names, symbols, and content matches.
- Context budgeter that chooses snippets, summaries, recent session context, and attached files predictably.
- Per-workspace cache invalidated by file changes.
- Context section in prompts that clearly names why files were selected.

### Non-goals

- No embeddings in the first version.
- No background cloud indexing.
- No attempt to read entire repositories into prompts.

### Success criteria

- Users can ask broad questions such as "review the auth flow" or "where should this parser change go?" and Veyra can retrieve relevant files without explicit `@file` mentions.
- Later agents in `/review`, `/debate`, and `/implement` see the same retrieved context and prior replies.
- Retrieval is fast enough for normal VS Code use on medium repositories.

### Design notes

The first implementation should prefer explicit, explainable retrieval over opaque ranking. A response should make it possible to tell which files informed the agent. This matters because Veyra's product promise depends on trust, not just answer quality.

## 6. Milestone 2: Diff Preview

### Goal

Make agent changes inspectable before they feel risky.

### Ship

- Pending change ledger for each write-capable dispatch.
- Command to open a diff view from:
  - native chat file-edited references
  - the panel
  - file badge or session surfaces where practical
- Accept or reject a whole dispatch in the first version.
- Later extension to accept or reject individual files or hunks.
- Setting for diff behavior, likely one of:
  - automatic edit with visible diff
  - preview before final accept
  - delegate approval to the underlying CLI where supported

### Non-goals

- No custom diff renderer if VS Code's built-in diff editor is sufficient.
- No per-hunk apply in the first version unless it falls out cheaply from the chosen implementation.

### Success criteria

- After an agent changes files, the user can inspect the exact workspace diff from Veyra surfaces.
- The user can accept or reject the full dispatch change set.
- Diff state is associated with the agent, workflow, timestamp, and changed files.

### Design notes

This milestone should reuse existing workspace change detection and `file-edited` events. The product surface should feel like a natural expansion of current invisible-change prevention rather than a separate subsystem.

## 7. Milestone 3: Checkpoints And Rollback

### Goal

Give users an escape hatch for multi-agent workflows.

### Ship

- Auto-checkpoint before every write-capable dispatch.
- Manual checkpoint command.
- Rollback latest checkpoint.
- Checkpoint list with:
  - timestamp
  - workflow or participant source
  - participating agents
  - changed files
  - short user prompt summary
- Warning when rollback would overwrite user edits made after the checkpoint.

### Non-goals

- No cross-branch history browser.
- No automatic commit creation.
- No remote backup system.

### Success criteria

- A user can run `/implement`, inspect the result, and roll back to the pre-dispatch state.
- Rollback avoids silently overwriting unrelated user changes.
- Checkpoint metadata makes it clear what is being restored.

### Design notes

Checkpointing should be implemented as a trust feature, not as source-control replacement. Git remains the durable history tool. Veyra checkpoints cover local experimentation between user commits.

## 8. Milestone 4: Workflow Intelligence

### Goal

Make Veyra's unique multi-agent workflows more useful after workspace context and trust controls exist.

### Ship

- Enhanced `/debate` or new `/consensus` workflow that produces a facilitator synthesis after agents respond.
- Role customization for Claude, Codex, and Gemini at the workspace level.
- Workflow templates for common use cases:
  - architecture review
  - security review
  - test improvement
  - refactor plan
  - implementation with review
- Review output categories:
  - blocking issue
  - advisory risk
  - missing test
  - follow-up suggestion
- Better cross-agent handoff summaries.

### Non-goals

- No fully autonomous project manager.
- No parallel worktree execution in v1.0.
- No cross-agent long-term learning system.

### Success criteria

- `/review` produces clearer, more actionable findings.
- `/debate` or `/consensus` ends with a concrete recommended next action.
- `/implement` makes better use of prior agents' reasoning and retrieved context.

### Design notes

This milestone is where Veyra's moat becomes louder. It should not land before context and trust features, because more intelligent workflows without inspectable context and rollback would increase perceived risk.

## 9. Milestone 5: Terminal Awareness

### Goal

Support realistic build, test, and debug loops from inside VS Code.

### Ship

- Capture selected terminal output and recent terminal errors.
- Agent-visible project command metadata from workspace inventory.
- Suggested commands with explicit approval.
- Optional verification step after implementation workflows.
- Clear handling for failed tests, lint errors, and compiler output.

### Non-goals

- No default destructive command automation.
- No hidden terminal command execution.
- No shell history scraping beyond explicit selected or recent bounded output.

### Success criteria

- A user can ask Veyra to diagnose selected terminal output.
- `/implement` can recommend or run a verification command with clear approval semantics.
- Test and lint failures can be brought into follow-up prompts without manual copy/paste.

### Design notes

The current agent CLIs can already run commands in some flows. This milestone is specifically about native VS Code terminal ergonomics and safer user control.

## 10. Milestone 6: Later Parity Candidates

These features are valuable but should be deferred until after the v1.0 spine is useful.

### Inline autocomplete

Useful for daily coding parity, but it is expensive to make good and does not directly strengthen Veyra's multi-agent trust promise.

### Browser testing

Useful for frontend workflows, especially visual debugging, but not core to v1.0 unless Veyra narrows its target market to web app development.

### Local model support

Useful for privacy-sensitive teams and cost control. It should come after the adapter and workflow surfaces stabilize.

### GitHub and GitLab workflows

Useful for teams, but Veyra already has a local editor-first story. PR generation, CI inspection, and issue integration can follow once local change safety is mature.

### Embedding or vector retrieval

Useful if lexical retrieval cannot find the right context often enough. It should be measured against real failures before becoming required infrastructure.

## 11. Sequencing

Recommended order:

1. Preview hardening.
2. Workspace context.
3. Diff preview.
4. Checkpoints and rollback.
5. Workflow intelligence.
6. Terminal awareness.
7. Later parity candidates.

The first three implementation plans should be separate:

1. Workspace context and `@codebase`.
2. Diff preview and pending change ledger.
3. Checkpoints and rollback.

Splitting them keeps each plan reviewable and reduces the risk of changing too many extension surfaces at once.

## 12. Risks

### Retrieval quality may disappoint without embeddings

Mitigation: make retrieval explainable, support manual `@file` override, and log missed-context feedback before adding vector search.

### Diff preview may conflict with underlying CLI approval models

Mitigation: define Veyra's diff model around workspace snapshots and VS Code diff views, then map CLI approval behavior into settings where possible.

### Checkpoints can overwrite user work if implemented carelessly

Mitigation: compare current workspace state against checkpoint metadata before rollback and warn when files changed after the checkpoint.

### Multi-agent workflows can become noisy

Mitigation: add facilitator synthesis and structured review categories instead of simply increasing agent output.

### Roadmap may drift into full competitor parity

Mitigation: use the v1.0 thesis as a scope guard. Features that do not improve workspace context, edit trust, or multi-agent workflow quality move out of v1.0.

## 13. Open Product Decisions

These decisions should be made during implementation planning, not blocked here:

- Exact `@codebase` retrieval ranking formula.
- Whether diff preview stores patch files, workspace snapshots, or both.
- Whether the first rollback implementation uses Git where available or a Veyra-managed snapshot format everywhere.
- Final names for diff and checkpoint commands.
- Whether workflow templates live in VS Code settings, a `veyra.md` section, or a separate workspace config file.

## 14. Definition Of v1.0

Veyra is ready to call v1.0 when:

- It can retrieve relevant workspace context without explicit file mentions.
- It can show a user what changed during an agent dispatch.
- It can roll back a write-capable dispatch safely.
- Its multi-agent workflows produce clearer final recommendations than a single-agent chat loop.
- Current native chat, Language Model provider, panel, file badge, edit-conflict, commit attribution, packaging, smoke, and live readiness gates remain covered.

