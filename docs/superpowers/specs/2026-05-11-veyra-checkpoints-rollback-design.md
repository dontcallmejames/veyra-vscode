# Veyra Checkpoints And Rollback Design

**Date:** 2026-05-11
**Status:** Draft for implementation planning
**Author:** Codex

## 1. Summary

Milestone 3 adds checkpoint and rollback controls for Veyra write-capable workflows. Diff preview lets users inspect and reject a single dispatch change set; checkpoints add a broader escape hatch around a workflow or manual moment in time.

The first version should support:

- Automatic checkpoints before write-capable dispatches.
- A command to create a manual checkpoint.
- A command to roll back the latest checkpoint.
- A command to list checkpoints.
- Stale-file protection that refuses rollback when files changed after the checkpointed workflow state.

This design uses a Veyra-managed snapshot ledger under `.vscode/veyra` rather than Git commits or stashes. Git remains the durable project history tool; Veyra checkpoints cover local experimentation between commits and work in dirty or non-Git workspaces.

## 2. Product Goal

A user should be able to run `/implement`, inspect the result, and return the workspace to its pre-dispatch state without guessing which files changed. Rollback must be safe enough that users trust it not to overwrite their own edits made after the checkpoint.

The feature should feel like a natural extension of the pending change ledger: Veyra already knows which agent edited which files; checkpoints add a named recovery point around that activity.

## 3. Non-Goals

- No Git commit, branch, stash, or remote backup automation.
- No cross-branch history browser.
- No per-hunk rollback.
- No checkpoint sync across machines.
- No automatic rollback after failed tests.
- No destructive rollback when any affected file is stale.

## 4. Approaches Considered

### A. Veyra-managed snapshots

Capture restorable file contents and file hashes into `.vscode/veyra/checkpoints`. This works in Git and non-Git workspaces, aligns with the diff-preview ledger, and keeps rollback semantics fully under Veyra's control.

Trade-off: Veyra must manage snapshot storage and pruning carefully.

### B. Git stash or temporary commits

Use Git's object database and existing checkout mechanics to restore state.

Trade-off: this is fragile in dirty workspaces, unavailable outside Git repositories, and risks surprising users by mutating source-control state. It also conflicts with Veyra's current editor-first trust model.

### C. Reuse pending change sets only

Treat every dispatch change set as the checkpoint.

Trade-off: this does not cover manual checkpoints or multi-agent workflow boundaries, and accepted/rejected change sets are designed to be pruned rather than kept as recoverable history.

## 5. Chosen Design

Use approach A: a Veyra-managed checkpoint ledger.

The implementation should add a pure `checkpointLedger` module parallel to `changeLedger`. It should share the same basic path normalization, excluded directories, size limits, hash-based stale detection, and atomic metadata writes.

Automatic checkpoints are captured before a write-capable dispatch starts and finalized after the dispatch with the files changed by that dispatch plus their after-dispatch hashes. Manual checkpoints capture the current workspace on command and are rolled back explicitly by the user. Rollback restores the latest checkpoint only after verifying every file that would be touched is restorable under that checkpoint's safety model.

## 6. Storage

Store metadata at:

```text
.vscode/veyra/checkpoints.json
```

Store snapshots at:

```text
.vscode/veyra/checkpoints/<checkpointId>/before/<workspace-relative-path>
```

Store an empty file for created/deleted-file diff or restore helpers when needed:

```text
.vscode/veyra/checkpoints/<checkpointId>/empty.txt
```

Exclude the same paths as the diff preview ledger:

- `.git`
- `node_modules`
- `dist`
- `.vscode/veyra`

Use `veyra.checkpoints.maxFileBytes` with the same default as diff preview: `1000000`. Files above the limit may be tracked as non-restorable metadata but must not be overwritten by rollback.

## 7. Checkpoint Model

A checkpoint should include:

- `id`
- `timestamp`
- `source`: `automatic` or `manual`
- `label`
- optional `messageId`
- optional `workflow`
- optional `agentId`
- `promptSummary`
- `status`: `available`, `rolled-back`, `stale`, or `pruned`
- `fileCount`
- `files`
- for automatic checkpoints, `rollbackFiles`

Each file entry should include:

- workspace-relative `path`
- `exists`
- `size`
- `hash` when the file is at or below the snapshot size limit
- `snapshotPath` when content was captured
- `restorable`
- optional `nonRestorableReason`

Each automatic checkpoint rollback file should include:

- workspace-relative `path`
- `changeKind`: `created`, `edited`, or `deleted`
- `beforeExists`
- `afterExists`
- `beforeHash`
- `afterHash`
- `beforeSnapshotPath`
- `canRollback`
- optional `rollbackReason`

Automatic checkpoints should use deterministic labels:

```text
Before Claude dispatch
Before Codex dispatch
Before Gemini dispatch
```

Manual checkpoints should default to:

```text
Manual checkpoint
```

If a user enters a manual label, trim whitespace and store the entered label when non-empty.

## 8. Rollback Semantics

Rollback is a whole-checkpoint operation.

### Automatic Checkpoints

Automatic checkpoint rollback uses `rollbackFiles`, finalized after dispatch. This is what lets Veyra detect edits made after the agent finished.

Before writing anything, Veyra must compare the current workspace state to each rollback file's recorded after-dispatch state:

- `created`: delete the file only if it still exists and its current hash matches `afterHash`.
- `edited`: restore the before snapshot only if the current hash matches `afterHash`.
- `deleted`: restore the before snapshot only if the file is still absent.
- non-restorable files block rollback if they would need modification.

If any affected file is stale or non-restorable, rollback refuses the whole operation, marks the checkpoint `stale`, and returns a sorted list of blocked files. It must not partially restore files.

### Manual Checkpoints

Manual checkpoint rollback has no after-dispatch boundary. It should compare current workspace state to the checkpoint baseline and roll back all files that changed since the manual checkpoint, after showing the changed file list in a warning confirmation.

For manual checkpoints:

- existing files at checkpoint time can be restored from snapshot when current content differs,
- files absent at checkpoint time and present now can be deleted,
- files above the size limit or missing snapshots block rollback if they would need modification.

Manual rollback should still refuse the whole operation when any affected file is non-restorable. It cannot distinguish agent edits from user edits after the checkpoint, so the explicit warning confirmation is the safety boundary.

## 9. Automatic Checkpoint Timing

For write-capable dispatches, capture an automatic checkpoint immediately before the agent dispatch starts.

Read-only `/review` and `/debate` dispatches should not create automatic checkpoints unless they unexpectedly edit files. If a read-only violation is detected, the pending change set remains the primary immediate recovery path; a later implementation can add post-violation checkpoint metadata if needed.

Manual checkpoints are always available when a workspace folder is open.

## 10. User Surfaces

### Command Palette

Add commands:

- `Veyra: Create Checkpoint`
- `Veyra: List Checkpoints`
- `Veyra: Roll Back Latest Checkpoint`

`List Checkpoints` should show a quick pick with newest checkpoints first. The first version can select a checkpoint and show its metadata in an information message. Rollback should target the latest available checkpoint. Manual checkpoint rollback should show a warning confirmation listing the files that would be restored or deleted before writing.

### Panel

When a checkpoint is created automatically, the panel should show a compact system notice:

```text
Checkpoint saved: Before Codex dispatch.
```

When rollback succeeds:

```text
Rolled back checkpoint: Before Codex dispatch.
```

When rollback is stale:

```text
Rollback refused because files changed after the checkpoint: src/a.ts, src/b.ts.
```

### Native Chat And Language Model Provider

Native chat and Language Model provider should surface concise checkpoint notices. Command buttons are not required in the first version; command palette and panel are the canonical controls.

## 11. Service API

Add service methods to `VeyraSessionService`:

```ts
createManualCheckpoint(label?: string): Promise<CheckpointSummary>;
listCheckpoints(): Promise<CheckpointSummary[]>;
previewLatestCheckpointRollback(): Promise<RollbackCheckpointPreview | null>;
rollbackLatestCheckpoint(): Promise<RollbackCheckpointResult>;
```

Add optional `checkpointLedger` to `VeyraSessionOptions`. Runtime construction should create it when `veyra.checkpoints.enabled` is true.

## 12. Settings

Add settings:

- `veyra.checkpoints.enabled`: default `true`.
- `veyra.checkpoints.maxFileBytes`: default `1000000`.
- `veyra.checkpoints.maxCount`: default `20`, minimum `1`, maximum `100`.

Prune oldest checkpoint snapshots after creating a new checkpoint when the count exceeds `maxCount`. Do not prune checkpoints marked `stale` until they are older than available checkpoints and over the limit; stale metadata is useful for explaining refused rollback.

## 13. Error Handling

Veyra should surface system warnings for:

- Unable to create automatic checkpoint.
- Unable to create manual checkpoint.
- Unable to list checkpoints.
- Rollback refused because files are stale.
- Rollback failed while restoring files.

Checkpoint errors should not hide agent output or prevent dispatch. They are trust warnings, not agent failures.

## 14. Tests

Coverage should include:

- Pure checkpoint ledger captures existing files, deleted-file baselines, and created-file absence.
- Automatic checkpoint finalization records changed files and after-dispatch hashes.
- Rollback restores edited and deleted files and removes files created after the checkpoint.
- Automatic rollback refuses when a file changed after dispatch and before rollback.
- Manual rollback requires confirmation and reverts all changed files since the manual checkpoint.
- Large files are marked non-restorable and block rollback if they would need modification.
- Pruning keeps only the configured number of checkpoints and removes pruned snapshots.
- Service creates automatic checkpoints before write-capable dispatches.
- Service exposes manual create, list, and latest rollback methods.
- Extension registers checkpoint commands and forwards them to the active service.
- Panel handles checkpoint webview actions and renders checkpoint system notices.
- README and manifest document the new commands and settings.

## 15. Risks

### Rollback can overwrite user edits

Mitigation: compare current state before writing and refuse the entire rollback when any affected file is stale or non-restorable.

### Snapshot storage can grow

Mitigation: use a file size limit, exclude generated/internal directories, and prune by `veyra.checkpoints.maxCount`.

### Automatic checkpoints can feel noisy

Mitigation: show compact notices and keep the first version command-driven. Do not build a large checkpoint browser yet.

### Checkpoints overlap with pending change sets

Mitigation: treat pending change sets as immediate dispatch review and checkpoints as broader recovery points. Both use similar safety rules, but they remain separate surfaces and stores.

## 16. Success Criteria

- A write-capable dispatch creates an automatic checkpoint before the agent can edit files.
- The user can create a manual checkpoint from the command palette.
- The user can list checkpoints from the command palette.
- The user can roll back the latest checkpoint when files are safe to restore.
- Rollback refuses rather than overwriting post-checkpoint user edits.
- Checkpoint state is associated with timestamp, source, agent/workflow context when available, changed files, and a prompt summary.
- Existing diff preview, file-edited events, file badges, edit-conflict notices, native chat, Language Model provider, packaging, smoke, and local verification remain covered.
