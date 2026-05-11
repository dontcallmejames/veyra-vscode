# Veyra Diff Preview Design

**Date:** 2026-05-11
**Status:** Draft for review
**Author:** Codex

## 1. Summary

Milestone 2 adds a post-edit diff ledger for Veyra agent dispatches. Agents keep writing through the existing CLI paths, but Veyra captures a workspace baseline before each write-capable agent turn, records the files changed afterward, and exposes those changes as a pending change set.

The first version should support:

- Opening a VS Code diff for files changed by an agent dispatch.
- Accepting a whole dispatch change set.
- Rejecting a whole dispatch change set when it can be restored safely.
- Refusing rejection when a file changed after the agent edit.

This is Option A from the roadmap discussion: a post-edit ledger that fits the current architecture without rebuilding how Claude, Codex, and Gemini apply edits.

## 2. Product Goal

After an agent changes files, the user should not have to hunt through the workspace to understand what happened. Veyra should show a concrete change set tied to the responsible agent, workflow, timestamp, and files.

The user should be able to inspect the diff before deciding whether to keep or reject the whole dispatch. This makes write-capable multi-agent workflows feel reversible enough to trust.

## 3. Non-Goals

- No custom diff renderer. Use VS Code's built-in `vscode.diff` command.
- No per-hunk accept or reject.
- No staging area that prevents the underlying CLI from writing directly.
- No Git commit, stash, branch, or remote backup automation.
- No checkpoint history browser. Milestone 3 owns broader checkpoint and rollback UX.

## 4. Architecture

Add a focused change-ledger layer next to the existing workspace-change tracker.

The existing `WorkspaceChangeTracker` already snapshots the workspace before each agent dispatch and reports `FileChange[]` after dispatch. Milestone 2 should reuse that behavior, but add enough persisted baseline data to open diffs and restore files.

### Core Data Flow

1. A write-capable agent dispatch starts.
2. Veyra captures a ledger baseline for restorable workspace files.
3. The existing dispatch pipeline runs.
4. Veyra detects changed files through `recordWorkspaceChanges`.
5. If files changed, Veyra creates a pending change set.
6. Veyra appends a `change-set` system notice that names the pending change set.
7. The user can open diffs, accept the change set, or reject it.

### Storage

Store ledger metadata under `.vscode/veyra/change-ledger.json`.

Store baseline file contents under `.vscode/veyra/change-ledger/<changeSetId>/before/...`.

This keeps Veyra-local trust data out of Git and aligns with existing `.vscode/veyra` state handling.

### Change Set Shape

A change set should include:

- `id`
- `agentId`
- `messageId`
- `timestamp`
- `status`: `pending`, `accepted`, `rejected`, or `stale`
- `files`: changed file entries

Each file entry should include:

- workspace-relative `path`
- `changeKind`: `created`, `edited`, or `deleted`
- `beforeExists`
- `afterExists`
- `beforeHash` when a baseline file exists
- `afterHash` when the file exists after dispatch
- `beforeSnapshotPath` when Veyra can restore or diff the old content
- `canReject`
- optional `rejectReason`

## 5. Restore Semantics

Rejecting a change set is a whole-dispatch operation.

For each file:

- `created`: delete the file if its current hash still matches the recorded after hash.
- `edited`: restore the before snapshot if the current hash still matches the recorded after hash.
- `deleted`: restore the before snapshot if the file is still absent.

If any file no longer matches the recorded after state, the reject operation must refuse the entire change set and surface a warning. This avoids overwriting user edits made after the agent dispatch.

Accepting a change set marks it accepted and removes baseline snapshots for that change set. It does not modify workspace files.

## 6. Diff Semantics

Opening a file diff should compare:

- Left side: the saved before snapshot, or an empty virtual file for created files.
- Right side: the current workspace file, or an empty virtual file for deleted files.

Use VS Code's `vscode.diff` command so the UX feels native.

For whole-dispatch diff review, open the first changed file and show the full file list in Veyra surfaces. A later iteration can add a picker for all files; this first version can expose per-file diff actions in the panel and command palette.

## 7. User Surfaces

### Panel

The panel should show a visible system notice when a change set is created:

- Agent label and file count.
- Buttons or links to open diffs.
- Accept and reject actions for pending change sets.
- Status text after accept, reject, or stale rejection.

### Native Chat

Native chat should show a short message for a new change set and expose command buttons when possible:

- Open changes.
- Accept changes.
- Reject changes.

If buttons are unavailable in a given client surface, the text should still name the command path.

### Language Model Provider

The Language Model provider should stream a short change-set notice after file edits. It does not need full interactive controls in the first version.

### Command Palette

Add commands:

- `Veyra: Open Pending Changes`
- `Veyra: Accept Pending Changes`
- `Veyra: Reject Pending Changes`

When more than one pending change set exists, commands should show a quick pick.

## 8. Error Handling

Veyra should surface system messages for:

- Unable to capture baseline.
- Unable to create change set metadata.
- Unable to open diff because snapshot data is missing.
- Reject refused because files changed after the agent edit.
- Reject failed while restoring a specific file.

Errors should not hide the agent response. A failed ledger operation is a trust warning, not a dispatch failure.

## 9. Settings

Add settings:

- `veyra.diffPreview.enabled`: default `true`.
- `veyra.diffPreview.maxFileBytes`: default `1000000`.

Files larger than the byte limit can still be reported as changed, but they should be marked non-restorable unless a safe baseline was captured.

## 10. Tests

Coverage should include:

- Pure ledger creation for created, edited, and deleted files.
- Reject restores edited and deleted files and removes created files.
- Reject refuses when current file state differs from recorded after state.
- Accept marks status and removes snapshots.
- Service appends a `change-set` system notice after write-capable changes.
- Read-only workflow violations still create a rejectable change set, but the notice must clearly label the edit as a read-only violation rather than as an expected write.
- Panel forwards `change-set-created` events and can send open/accept/reject messages.
- Extension commands register and call the active service.
- Manifest and README document the new settings and commands.

## 11. Risks

### Baseline storage can be large

Mitigation: bound stored files by `veyra.diffPreview.maxFileBytes`, exclude existing generated/internal directories, and prune snapshots on accept/reject.

### Reject can overwrite user edits

Mitigation: compare current file state to recorded after state before writing anything. Refuse whole-dispatch rejection if any file is stale.

### Native chat buttons may be inconsistent across clients

Mitigation: make panel and command palette the canonical controls, and use native chat buttons as convenience.

### The first version is whole-dispatch only

Mitigation: keep the change-set model file-level enough that later per-file or per-hunk actions can build on it without replacing the ledger.

## 12. Success Criteria

- After an agent changes files, Veyra creates a pending change set.
- The user can open VS Code diffs for changed files.
- The user can accept the change set without modifying workspace files.
- The user can reject the change set when files are unchanged since the agent edit.
- Veyra refuses rejection rather than overwriting post-dispatch user edits.
- Existing file-edited events, badges, edit-conflict notices, native chat, Language Model provider, packaging, smoke, and local verification still pass.
