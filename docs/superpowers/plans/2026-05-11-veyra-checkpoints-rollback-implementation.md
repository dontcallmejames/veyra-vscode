# Veyra Checkpoints And Rollback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Veyra-managed checkpoints so users can create recovery points and roll back safe workspace changes after write-capable dispatches.

**Architecture:** Add a pure `checkpointLedger` module for checkpoint snapshots, rollback previews, rollback execution, and pruning. Wire it into `VeyraSessionService` before and after write-capable dispatches, then expose manual checkpoint, list, and rollback commands through the extension, panel, native chat, Language Model provider, manifest, and README.

**Tech Stack:** TypeScript, Node `fs/promises`, Node `crypto`, VS Code extension API, existing `VeyraSessionService`, existing `WorkspaceChangeTracker`, existing diff-preview command and notice patterns, Vitest.

---

## Scope Check

This plan implements Milestone 3 from `docs/superpowers/specs/2026-05-11-veyra-v1-roadmap-design.md` and the design in `docs/superpowers/specs/2026-05-11-veyra-checkpoints-rollback-design.md`.

It does not implement Git stashes, Git commits, cross-branch checkpoint history, per-hunk rollback, remote backup, automatic rollback after failed tests, browser testing, terminal awareness, workflow intelligence, or embedding retrieval.

## File Structure

- Create `src/checkpointLedger.ts`
  - Owns checkpoint capture, automatic checkpoint finalization, rollback previews, rollback execution, metadata persistence, snapshot pruning, and path safety.
- Create `tests/checkpointLedger.test.ts`
  - Unit tests for manual checkpoints, automatic finalization, rollback, stale rollback refusal, non-restorable large files, and pruning.
- Modify `src/shared/protocol.ts`
  - Adds checkpoint summary/result types, `checkpoint` system notices, and webview messages for manual checkpoint and rollback actions.
- Modify `src/veyraService.ts`
  - Captures automatic checkpoints before write-capable dispatches, finalizes them after workspace-change detection, appends checkpoint system notices, and exposes manual/list/preview/rollback methods.
- Modify `src/veyraRuntime.ts`
  - Creates the default `CheckpointLedger` and reads checkpoint settings.
- Create `src/checkpointCommands.ts`
  - Registers command palette commands and handles manual label prompt plus rollback confirmation.
- Modify `src/extension.ts`
  - Registers checkpoint commands against the active Veyra service.
- Modify `src/panel.ts`
  - Handles panel requests for manual checkpoint creation and latest rollback.
- Modify `src/nativeChat.ts`
  - Renders concise checkpoint system notices.
- Modify `src/languageModelProvider.ts`
  - Streams concise checkpoint notices.
- Modify `src/webview/components/SystemNotice.tsx`
  - Renders checkpoint notices and action buttons when applicable.
- Modify `src/webview/styles.css`
  - Adds minimal checkpoint notice styling.
- Modify `package.json`
  - Adds commands and checkpoint settings.
- Modify `README.md`
  - Documents checkpoint commands, rollback semantics, and settings.

## Task 1: Add Pure Checkpoint Ledger

**Files:**
- Create: `src/checkpointLedger.ts`
- Create: `tests/checkpointLedger.test.ts`

- [ ] **Step 1: Write failing checkpoint ledger tests**

Create `tests/checkpointLedger.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CheckpointLedger } from '../src/checkpointLedger.js';

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-checkpoint-ledger-'));
}

function writeFile(root: string, relativePath: string, content: string): void {
  const absolute = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
}

function readFile(root: string, relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('CheckpointLedger', () => {
  it('previews and rolls back a manual checkpoint', async () => {
    const root = tempWorkspace();
    writeFile(root, 'src/edit.ts', 'before\n');
    const ledger = new CheckpointLedger(root, { maxFileBytes: 1_000_000, maxCount: 20 });

    const checkpoint = await ledger.createCheckpoint({
      source: 'manual',
      label: 'before experiment',
      promptSummary: 'manual checkpoint',
      timestamp: 100,
    });
    writeFile(root, 'src/edit.ts', 'after\n');
    writeFile(root, 'src/new.ts', 'created\n');

    const preview = await ledger.previewRollback(checkpoint.id);

    expect(preview).toMatchObject({
      checkpointId: checkpoint.id,
      status: 'ready',
      files: [
        { path: 'src/edit.ts', changeKind: 'edited' },
        { path: 'src/new.ts', changeKind: 'created' },
      ],
    });

    const result = await ledger.rollbackCheckpoint(checkpoint.id);

    expect(result).toEqual({
      status: 'rolled-back',
      checkpointId: checkpoint.id,
      staleFiles: [],
      restoredFiles: ['src/edit.ts', 'src/new.ts'],
    });
    expect(readFile(root, 'src/edit.ts')).toBe('before\n');
    expect(fs.existsSync(path.join(root, 'src/new.ts'))).toBe(false);
  });

  it('finalizes an automatic checkpoint and refuses stale rollback', async () => {
    const root = tempWorkspace();
    writeFile(root, 'src/edit.ts', 'before\n');
    const ledger = new CheckpointLedger(root, { maxFileBytes: 1_000_000, maxCount: 20 });

    const checkpoint = await ledger.createCheckpoint({
      source: 'automatic',
      label: 'Before Codex dispatch',
      promptSummary: '@codex edit the file',
      agentId: 'codex',
      messageId: 'msg1',
      timestamp: 100,
    });
    writeFile(root, 'src/edit.ts', 'agent edit\n');
    await ledger.finalizeAutomaticCheckpoint(checkpoint.id, [
      { path: 'src/edit.ts', changeKind: 'edited' },
    ]);
    writeFile(root, 'src/edit.ts', 'user edit after agent\n');

    const result = await ledger.rollbackCheckpoint(checkpoint.id);

    expect(result).toEqual({
      status: 'stale',
      checkpointId: checkpoint.id,
      staleFiles: ['src/edit.ts'],
      restoredFiles: [],
    });
    expect(readFile(root, 'src/edit.ts')).toBe('user edit after agent\n');
  });

  it('rolls back finalized automatic created edited and deleted files', async () => {
    const root = tempWorkspace();
    writeFile(root, 'src/edit.ts', 'before\n');
    writeFile(root, 'src/delete.ts', 'keep\n');
    const ledger = new CheckpointLedger(root, { maxFileBytes: 1_000_000, maxCount: 20 });
    const checkpoint = await ledger.createCheckpoint({
      source: 'automatic',
      label: 'Before Claude dispatch',
      promptSummary: '@claude implement',
      agentId: 'claude',
      messageId: 'msg2',
      timestamp: 200,
    });

    writeFile(root, 'src/edit.ts', 'after\n');
    writeFile(root, 'src/create.ts', 'created\n');
    fs.unlinkSync(path.join(root, 'src/delete.ts'));
    await ledger.finalizeAutomaticCheckpoint(checkpoint.id, [
      { path: 'src/edit.ts', changeKind: 'edited' },
      { path: 'src/create.ts', changeKind: 'created' },
      { path: 'src/delete.ts', changeKind: 'deleted' },
    ]);

    const result = await ledger.rollbackCheckpoint(checkpoint.id);

    expect(result.status).toBe('rolled-back');
    expect(result.restoredFiles).toEqual(['src/create.ts', 'src/delete.ts', 'src/edit.ts']);
    expect(readFile(root, 'src/edit.ts')).toBe('before\n');
    expect(readFile(root, 'src/delete.ts')).toBe('keep\n');
    expect(fs.existsSync(path.join(root, 'src/create.ts'))).toBe(false);
  });

  it('blocks rollback when a changed large file is non-restorable', async () => {
    const root = tempWorkspace();
    writeFile(root, 'src/large.txt', '0123456789\n');
    const ledger = new CheckpointLedger(root, { maxFileBytes: 4, maxCount: 20 });
    const checkpoint = await ledger.createCheckpoint({
      source: 'manual',
      label: 'manual checkpoint',
      promptSummary: 'manual checkpoint',
      timestamp: 300,
    });

    writeFile(root, 'src/large.txt', 'changed\n');
    const result = await ledger.rollbackCheckpoint(checkpoint.id);

    expect(result.status).toBe('stale');
    expect(result.staleFiles).toEqual(['src/large.txt']);
    expect(readFile(root, 'src/large.txt')).toBe('changed\n');
  });

  it('prunes oldest checkpoint snapshots beyond maxCount', async () => {
    const root = tempWorkspace();
    writeFile(root, 'src/a.ts', 'a\n');
    const ledger = new CheckpointLedger(root, { maxFileBytes: 1_000_000, maxCount: 2 });

    const first = await ledger.createCheckpoint({ source: 'manual', label: 'one', promptSummary: 'one', timestamp: 1 });
    const second = await ledger.createCheckpoint({ source: 'manual', label: 'two', promptSummary: 'two', timestamp: 2 });
    const third = await ledger.createCheckpoint({ source: 'manual', label: 'three', promptSummary: 'three', timestamp: 3 });

    const checkpoints = await ledger.listCheckpoints();

    expect(checkpoints.map((checkpoint) => checkpoint.id)).toEqual([third.id, second.id]);
    expect(fs.existsSync(path.join(root, '.vscode', 'veyra', 'checkpoints', first.id))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/checkpointLedger.test.ts
```

Expected: fail because `src/checkpointLedger.ts` does not exist.

- [ ] **Step 3: Implement checkpoint ledger types and constructor**

Create `src/checkpointLedger.ts` with these exported types:

```ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ulid } from './ulid.js';
import type { FileChange, FileChangeKind } from './shared/protocol.js';
import type { AgentId } from './types.js';

export type CheckpointSource = 'automatic' | 'manual';
export type CheckpointStatus = 'available' | 'rolled-back' | 'stale' | 'pruned';

export interface CheckpointLedgerOptions {
  maxFileBytes: number;
  maxCount: number;
}

export interface Checkpoint {
  id: string;
  timestamp: number;
  source: CheckpointSource;
  label: string;
  promptSummary: string;
  status: CheckpointStatus;
  fileCount: number;
  files: CheckpointFile[];
  rollbackFiles?: CheckpointRollbackFile[];
  messageId?: string;
  agentId?: AgentId;
  workflow?: string;
}

export interface CheckpointFile {
  path: string;
  exists: boolean;
  size: number;
  hash: string | null;
  snapshotPath: string | null;
  restorable: boolean;
  nonRestorableReason?: string;
}

export interface CheckpointRollbackFile {
  path: string;
  changeKind: FileChangeKind;
  beforeExists: boolean;
  afterExists: boolean;
  beforeHash: string | null;
  afterHash: string | null;
  beforeSnapshotPath: string | null;
  canRollback: boolean;
  rollbackReason?: string;
}

export interface CreateCheckpointInput {
  source: CheckpointSource;
  label: string;
  promptSummary: string;
  timestamp: number;
  messageId?: string;
  agentId?: AgentId;
  workflow?: string;
}

export interface RollbackPreviewFile {
  path: string;
  changeKind: FileChangeKind;
}

export interface RollbackCheckpointPreview {
  checkpointId: string;
  status: 'ready' | 'stale';
  files: RollbackPreviewFile[];
  staleFiles: string[];
}

export interface RollbackCheckpointResult {
  checkpointId: string;
  status: 'rolled-back' | 'stale';
  staleFiles: string[];
  restoredFiles: string[];
}
```

The class signature should be:

```ts
export class CheckpointLedger {
  constructor(workspacePath: string, options: CheckpointLedgerOptions);
  createCheckpoint(input: CreateCheckpointInput): Promise<Checkpoint>;
  finalizeAutomaticCheckpoint(id: string, files: FileChange[]): Promise<Checkpoint>;
  listCheckpoints(): Promise<Checkpoint[]>;
  getCheckpoint(id: string): Promise<Checkpoint | null>;
  latestCheckpoint(): Promise<Checkpoint | null>;
  previewRollback(id: string): Promise<RollbackCheckpointPreview>;
  previewLatestRollback(): Promise<RollbackCheckpointPreview | null>;
  rollbackCheckpoint(id: string): Promise<RollbackCheckpointResult>;
  rollbackLatestCheckpoint(): Promise<RollbackCheckpointResult>;
}
```

- [ ] **Step 4: Implement capture, persistence, and pruning**

Implementation requirements:

- Store metadata at `.vscode/veyra/checkpoints.json`.
- Store snapshots at `.vscode/veyra/checkpoints/<checkpointId>/before/<path>`.
- Exclude `.git`, `node_modules`, `dist`, and `.vscode/veyra`.
- Snapshot files at or below `maxFileBytes`.
- Mark large files as `restorable: false` with `nonRestorableReason: 'File exceeds checkpoint snapshot size limit.'`.
- Use SHA-256 hashes.
- Write metadata atomically through `checkpoints.json.tmp`.
- Sort `listCheckpoints()` newest first by `timestamp`, then `id`.
- Prune oldest checkpoints beyond `maxCount` from persisted metadata and remove their snapshot directories.

Use these helper names to keep the implementation readable:

```ts
const DEFAULT_EXCLUDED_DIR_NAMES = new Set(['.git', 'node_modules', 'dist']);
const DEFAULT_EXCLUDED_DIR_PATHS = new Set(['.vscode/veyra']);
const SIZE_LIMIT_REASON = 'File exceeds checkpoint snapshot size limit.';

async function listWorkspaceFiles(workspacePath: string): Promise<string[]>;
async function currentFileState(absolutePath: string, maxFileBytes: number): Promise<{ exists: boolean; size: number; hash: string | null }>;
async function hashFile(filePath: string): Promise<string>;
function normalizeWorkspaceRelativePath(workspacePath: string, filePath: string): string;
function isExcludedPath(relativePath: string): boolean;
```

- [ ] **Step 5: Implement automatic finalization and rollback**

Rules:

- `finalizeAutomaticCheckpoint(id, files)` dedupes and sorts `FileChange[]`.
- For each changed file, read the before checkpoint file entry and current after state.
- Created files have `beforeExists: false`.
- Edited/deleted files require a restorable before snapshot.
- `previewRollback()` uses `rollbackFiles` for automatic checkpoints and derives changed files from current workspace state for manual checkpoints.
- `rollbackCheckpoint()` calls `previewRollback()` immediately before writing.
- If preview is stale, mark checkpoint `stale`, write metadata, and return without modifying files.
- On success:
  - created files are removed,
  - edited files are restored from before snapshot,
  - deleted files are restored from before snapshot,
  - checkpoint is marked `rolled-back`,
  - result files are sorted.

- [ ] **Step 6: Run focused tests**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/checkpointLedger.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit this slice**

Run:

```powershell
git add src/checkpointLedger.ts tests/checkpointLedger.test.ts
git diff --cached --check
git commit -m "feat: add checkpoint ledger"
```

## Task 2: Wire Checkpoints Into Service And Runtime

**Files:**
- Modify: `src/shared/protocol.ts`
- Modify: `src/veyraService.ts`
- Modify: `src/veyraRuntime.ts`
- Modify: `tests/veyraService.test.ts`
- Modify: `tests/veyraRuntime.test.ts`

- [ ] **Step 1: Add protocol types for checkpoint notices**

In `src/shared/protocol.ts`, add:

```ts
export type CheckpointStatus = 'available' | 'rolled-back' | 'stale' | 'pruned';
export type CheckpointSource = 'automatic' | 'manual';

export type CheckpointSummary = {
  id: string;
  timestamp: number;
  source: CheckpointSource;
  label: string;
  promptSummary: string;
  status: CheckpointStatus;
  fileCount: number;
  agentId?: AgentId;
  messageId?: string;
  workflow?: string;
};

export type RollbackCheckpointPreview = {
  checkpointId: string;
  status: 'ready' | 'stale';
  files: FileChange[];
  staleFiles: string[];
};

export type RollbackCheckpointResult = {
  checkpointId: string;
  status: 'rolled-back' | 'stale';
  staleFiles: string[];
  restoredFiles: string[];
};
```

Extend `SystemMessage.kind`:

```ts
kind: 'routing-needed' | 'error' | 'facilitator-decision' | 'edit-conflict' | 'file-edited' | 'change-set' | 'checkpoint';
```

Add optional field:

```ts
checkpoint?: CheckpointSummary;
```

- [ ] **Step 2: Write failing service tests**

Add tests to `tests/veyraService.test.ts` with a fake checkpoint ledger:

```ts
function fakeCheckpointLedger() {
  return {
    createCheckpoint: vi.fn().mockResolvedValue({
      id: 'checkpoint-1',
      timestamp: 100,
      source: 'automatic',
      label: 'Before Codex dispatch',
      promptSummary: '@codex edit',
      status: 'available',
      fileCount: 0,
      files: [],
      agentId: 'codex',
      messageId: 'msg1',
    }),
    finalizeAutomaticCheckpoint: vi.fn().mockResolvedValue({
      id: 'checkpoint-1',
      timestamp: 100,
      source: 'automatic',
      label: 'Before Codex dispatch',
      promptSummary: '@codex edit',
      status: 'available',
      fileCount: 1,
      files: [],
      rollbackFiles: [{ path: 'src/a.ts', changeKind: 'edited' }],
      agentId: 'codex',
      messageId: 'msg1',
    }),
    listCheckpoints: vi.fn().mockResolvedValue([]),
    latestCheckpoint: vi.fn().mockResolvedValue(null),
    previewLatestRollback: vi.fn().mockResolvedValue(null),
    rollbackLatestCheckpoint: vi.fn(),
  };
}
```

Add one test proving a write-capable dispatch creates and finalizes an automatic checkpoint:

```ts
expect(checkpointLedger.createCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
  source: 'automatic',
  label: 'Before Claude dispatch',
  agentId: 'claude',
  promptSummary: expect.stringContaining('@claude'),
}));
expect(checkpointLedger.finalizeAutomaticCheckpoint).toHaveBeenCalledWith(
  'checkpoint-1',
  [{ path: 'src/a.ts', changeKind: 'edited' }],
);
```

Add one test proving read-only dispatches do not create automatic checkpoints:

```ts
expect(checkpointLedger.createCheckpoint).not.toHaveBeenCalled();
```

Add one test proving manual/list/preview/rollback service methods call the ledger and return summaries.

- [ ] **Step 3: Run focused service tests and verify they fail**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/veyraService.test.ts tests/veyraRuntime.test.ts
```

Expected: fail because checkpoint ledger options and service methods do not exist.

- [ ] **Step 4: Update service options and in-progress state**

In `src/veyraService.ts`:

- Import checkpoint ledger types.
- Add `checkpointLedger?: CheckpointLedger` to `VeyraSessionOptions`.
- Store `private checkpointLedger?: CheckpointLedger`.
- Add `checkpointId?: string` to `InProgressDispatch`.
- Include `checkpointLedger` in `updateOptions`.

At dispatch start:

```ts
if (!request.readOnly && this.checkpointLedger) {
  try {
    const checkpoint = await this.checkpointLedger.createCheckpoint({
      source: 'automatic',
      label: `Before ${agentLabel(event.agentId)} dispatch`,
      promptSummary: summarizePrompt(request.text),
      agentId: event.agentId,
      messageId,
      timestamp,
    });
    inProgress.checkpointId = checkpoint.id;
  } catch (err) {
    await this.emitWorkspaceChangeError(
      event.agentId,
      `Unable to create checkpoint before ${agentLabel(event.agentId)} dispatch: ${errorMessage(err)}`,
      emit,
    );
  }
}
```

Implement `summarizePrompt(text: string): string` near the existing helpers:

```ts
function summarizePrompt(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}
```

At dispatch end after `recordWorkspaceChanges`:

```ts
if (inProgress.checkpointId && this.checkpointLedger) {
  const checkpoint = await this.checkpointLedger.finalizeAutomaticCheckpoint(
    inProgress.checkpointId,
    inProgress.fileChanges,
  );
  await this.appendCheckpointNotice(checkpoint, emit);
}
```

The system notice text should be:

```ts
`Checkpoint saved: ${checkpoint.label}.`
```

- [ ] **Step 5: Add service methods**

Add methods:

```ts
async createManualCheckpoint(label?: string): Promise<CheckpointSummary>;
async listCheckpoints(): Promise<CheckpointSummary[]>;
async previewLatestCheckpointRollback(): Promise<RollbackCheckpointPreview | null>;
async rollbackLatestCheckpoint(): Promise<RollbackCheckpointResult>;
```

Use `Date.now()` for manual checkpoint timestamps and default label `Manual checkpoint` when the trimmed label is empty.

Add converters:

```ts
function checkpointSummary(checkpoint: Checkpoint): CheckpointSummary;
function checkpointFileChange(file: RollbackPreviewFile): FileChange;
```

- [ ] **Step 6: Update runtime construction**

In `src/veyraRuntime.ts`:

```ts
import { CheckpointLedger, type CheckpointLedgerOptions } from './checkpointLedger.js';
```

Add:

```ts
export function readCheckpointOptions(): CheckpointLedgerOptions {
  const config = vscode.workspace.getConfiguration('veyra');
  return {
    maxFileBytes: config.get<number>('checkpoints.maxFileBytes', 1_000_000),
    maxCount: config.get<number>('checkpoints.maxCount', 20),
  };
}

function checkpointsEnabled(): boolean {
  return vscode.workspace.getConfiguration('veyra').get<boolean>('checkpoints.enabled', true);
}
```

Pass:

```ts
checkpointLedger: checkpointsEnabled()
  ? new CheckpointLedger(workspacePath, readCheckpointOptions())
  : undefined,
```

in both `createVeyraSessionService` and `refreshVeyraSessionOptions`.

- [ ] **Step 7: Run focused tests**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/veyraService.test.ts tests/veyraRuntime.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit this slice**

Run:

```powershell
git add src/shared/protocol.ts src/veyraService.ts src/veyraRuntime.ts tests/veyraService.test.ts tests/veyraRuntime.test.ts
git diff --cached --check
git commit -m "feat: create dispatch checkpoints"
```

## Task 3: Add Checkpoint Commands And Manifest Contributions

**Files:**
- Create: `src/checkpointCommands.ts`
- Modify: `src/extension.ts`
- Modify: `package.json`
- Modify: `tests/extension.test.ts`
- Modify: `tests/manifest.test.ts`

- [ ] **Step 1: Write failing extension and manifest tests**

In `tests/extension.test.ts`, extend the mock service:

```ts
createManualCheckpoint: vi.fn(),
listCheckpoints: vi.fn(),
previewLatestCheckpointRollback: vi.fn(),
rollbackLatestCheckpoint: vi.fn(),
```

Extend the command list expectation with:

```ts
'veyra.createCheckpoint',
'veyra.listCheckpoints',
'veyra.rollbackLatestCheckpoint',
```

Add a command callback test:

```ts
const createCheckpoint = mocks.commandCallbacks.get('veyra.createCheckpoint')!;
const listCheckpoints = mocks.commandCallbacks.get('veyra.listCheckpoints')!;
const rollbackLatestCheckpoint = mocks.commandCallbacks.get('veyra.rollbackLatestCheckpoint')!;

await createCheckpoint();
await listCheckpoints();
await rollbackLatestCheckpoint();

expect(mocks.service.createManualCheckpoint).toHaveBeenCalled();
expect(mocks.service.listCheckpoints).toHaveBeenCalled();
expect(mocks.service.previewLatestCheckpointRollback).toHaveBeenCalled();
expect(mocks.service.rollbackLatestCheckpoint).toHaveBeenCalled();
```

In `tests/manifest.test.ts`, assert command contributions and settings:

```ts
expect(commands.get('veyra.createCheckpoint')).toBe('Veyra: Create Checkpoint');
expect(commands.get('veyra.listCheckpoints')).toBe('Veyra: List Checkpoints');
expect(commands.get('veyra.rollbackLatestCheckpoint')).toBe('Veyra: Roll Back Latest Checkpoint');
expect(properties['veyra.checkpoints.enabled']).toMatchObject({ type: 'boolean', default: true });
expect(properties['veyra.checkpoints.maxFileBytes']).toMatchObject({ type: 'number', default: 1000000, minimum: 1024 });
expect(properties['veyra.checkpoints.maxCount']).toMatchObject({ type: 'number', default: 20, minimum: 1, maximum: 100 });
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/extension.test.ts tests/manifest.test.ts
```

Expected: fail because commands and manifest entries do not exist.

- [ ] **Step 3: Implement `checkpointCommands.ts`**

Create `src/checkpointCommands.ts`:

```ts
import * as vscode from 'vscode';
import type { CheckpointSummary, RollbackCheckpointPreview, RollbackCheckpointResult } from './shared/protocol.js';

export interface CheckpointCommandService {
  createManualCheckpoint(label?: string): Promise<CheckpointSummary>;
  listCheckpoints(): Promise<CheckpointSummary[]>;
  previewLatestCheckpointRollback(): Promise<RollbackCheckpointPreview | null>;
  rollbackLatestCheckpoint(): Promise<RollbackCheckpointResult>;
}

export function registerCheckpointCommands(
  context: vscode.ExtensionContext,
  getService: () => CheckpointCommandService | undefined,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('veyra.createCheckpoint', async (labelArg?: string) => {
      const service = activeService(getService);
      if (!service) return;
      const label = labelArg !== undefined ? labelArg : await vscode.window.showInputBox({
        title: 'Veyra checkpoint label',
        prompt: 'Optional label for this checkpoint.',
        placeHolder: 'Manual checkpoint',
        ignoreFocusOut: true,
      });
      const checkpoint = await service.createManualCheckpoint(label);
      vscode.window.showInformationMessage(`Checkpoint saved: ${checkpoint.label}.`);
    }),
    vscode.commands.registerCommand('veyra.listCheckpoints', async () => {
      const service = activeService(getService);
      if (!service) return;
      const checkpoints = await service.listCheckpoints();
      if (checkpoints.length === 0) {
        vscode.window.showInformationMessage('No Veyra checkpoints found.');
        return;
      }
      await vscode.window.showQuickPick(
        checkpoints.map((checkpoint) => ({
          label: checkpoint.label,
          description: `${checkpoint.source} - ${checkpoint.status}`,
          detail: `${checkpoint.fileCount} ${checkpoint.fileCount === 1 ? 'file' : 'files'} - ${checkpoint.promptSummary}`,
        })),
        { placeHolder: 'Veyra checkpoints' },
      );
    }),
    vscode.commands.registerCommand('veyra.rollbackLatestCheckpoint', async () => {
      const service = activeService(getService);
      if (!service) return;
      const preview = await service.previewLatestCheckpointRollback();
      if (!preview) {
        vscode.window.showInformationMessage('No Veyra checkpoints to roll back.');
        return;
      }
      if (preview.status === 'stale') {
        vscode.window.showWarningMessage(`Rollback refused because files changed after the checkpoint: ${preview.staleFiles.join(', ')}.`);
        return;
      }
      const selected = await vscode.window.showWarningMessage(
        `Roll back latest Veyra checkpoint? This will restore or delete ${preview.files.length} ${preview.files.length === 1 ? 'file' : 'files'}.`,
        'Roll back',
      );
      if (selected !== 'Roll back') return;
      const result = await service.rollbackLatestCheckpoint();
      if (result.status === 'stale') {
        vscode.window.showWarningMessage(`Rollback refused because files changed after the checkpoint: ${result.staleFiles.join(', ')}.`);
        return;
      }
      vscode.window.showInformationMessage(`Rolled back Veyra checkpoint for ${result.restoredFiles.length} ${result.restoredFiles.length === 1 ? 'file' : 'files'}.`);
    }),
  );
}

function activeService(getService: () => CheckpointCommandService | undefined): CheckpointCommandService | undefined {
  const service = getService();
  if (!service) {
    vscode.window.showWarningMessage('Open a workspace folder before using Veyra checkpoints.');
  }
  return service;
}
```

- [ ] **Step 4: Wire commands in extension activation**

In `src/extension.ts`:

```ts
import { registerCheckpointCommands } from './checkpointCommands.js';
```

After `registerDiffPreviewCommands(...)`:

```ts
registerCheckpointCommands(context, () => ensureNativeRegistration()?.service);
```

- [ ] **Step 5: Add package contributions**

In `package.json`, add activation events:

```json
"onCommand:veyra.createCheckpoint",
"onCommand:veyra.listCheckpoints",
"onCommand:veyra.rollbackLatestCheckpoint"
```

Add command entries:

```json
{
  "command": "veyra.createCheckpoint",
  "title": "Veyra: Create Checkpoint"
},
{
  "command": "veyra.listCheckpoints",
  "title": "Veyra: List Checkpoints"
},
{
  "command": "veyra.rollbackLatestCheckpoint",
  "title": "Veyra: Roll Back Latest Checkpoint"
}
```

Add settings:

```json
"veyra.checkpoints.enabled": {
  "type": "boolean",
  "default": true,
  "description": "Capture Veyra-managed checkpoints before write-capable dispatches and allow manual checkpoints."
},
"veyra.checkpoints.maxFileBytes": {
  "type": "number",
  "default": 1000000,
  "minimum": 1024,
  "maximum": 10485760,
  "description": "Maximum file size Veyra snapshots for checkpoint rollback."
},
"veyra.checkpoints.maxCount": {
  "type": "number",
  "default": 20,
  "minimum": 1,
  "maximum": 100,
  "description": "Maximum number of Veyra checkpoints to keep before pruning older snapshots."
}
```

- [ ] **Step 6: Run focused tests**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/extension.test.ts tests/manifest.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit this slice**

Run:

```powershell
git add src/checkpointCommands.ts src/extension.ts package.json tests/extension.test.ts tests/manifest.test.ts
git diff --cached --check
git commit -m "feat: add checkpoint commands"
```

## Task 4: Render Checkpoint Notices In Panel, Native Chat, And Language Model Provider

**Files:**
- Modify: `src/panel.ts`
- Modify: `src/nativeChat.ts`
- Modify: `src/languageModelProvider.ts`
- Modify: `src/shared/protocol.ts`
- Modify: `src/webview/components/SystemNotice.tsx`
- Modify: `src/webview/styles.css`
- Modify: `tests/panel.test.ts`
- Modify: `tests/nativeChat.test.ts`
- Modify: `tests/languageModelProvider.test.ts`
- Modify: `tests/systemNotice.test.ts`
- Modify: `tests/webviewState.test.ts`

- [ ] **Step 1: Add failing rendering and webview action tests**

In `src/shared/protocol.ts`, extend `FromWebview` in the test expectation later with:

```ts
| { kind: 'create-checkpoint'; label?: string }
| { kind: 'rollback-latest-checkpoint' }
```

In `tests/panel.test.ts`, add:

```ts
await onDidReceive({ kind: 'create-checkpoint', label: 'before experiment' });
await onDidReceive({ kind: 'rollback-latest-checkpoint' });

expect((vscode as any).commands.executeCommand).toHaveBeenCalledWith('veyra.createCheckpoint', 'before experiment');
expect((vscode as any).commands.executeCommand).toHaveBeenCalledWith('veyra.rollbackLatestCheckpoint');
```

In `tests/systemNotice.test.ts`, add a checkpoint notice test:

```ts
const message: SystemMessage = {
  id: 'checkpoint-system-1',
  role: 'system',
  kind: 'checkpoint',
  text: 'Checkpoint saved: Before Codex dispatch.',
  timestamp: 1,
  checkpoint: {
    id: 'checkpoint-1',
    timestamp: 1,
    source: 'automatic',
    label: 'Before Codex dispatch',
    promptSummary: '@codex edit',
    status: 'available',
    fileCount: 1,
  },
};
expect(flattenText(SystemNotice({ message }))).toContain('Checkpoint saved');
```

In `tests/nativeChat.test.ts`, add a test expecting:

```ts
expect(response.markdown).toHaveBeenCalledWith(expect.stringContaining('Checkpoint saved: Before Codex dispatch.'));
```

In `tests/languageModelProvider.test.ts`, add a test expecting:

```ts
expect(progress.report).toHaveBeenCalledWith(expect.objectContaining({
  value: 'Veyra checkpoint: Checkpoint saved: Before Codex dispatch.',
}));
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/panel.test.ts tests/nativeChat.test.ts tests/languageModelProvider.test.ts tests/systemNotice.test.ts tests/webviewState.test.ts
```

Expected: fail because checkpoint notices and webview messages are not handled.

- [ ] **Step 3: Add webview messages and panel forwarding**

In `src/shared/protocol.ts`, extend `FromWebview`:

```ts
| { kind: 'create-checkpoint'; label?: string }
| { kind: 'rollback-latest-checkpoint' }
```

In `src/panel.ts`, handle:

```ts
case 'create-checkpoint':
  await vscode.commands.executeCommand('veyra.createCheckpoint', msg.label);
  break;
case 'rollback-latest-checkpoint':
  await vscode.commands.executeCommand('veyra.rollbackLatestCheckpoint');
  break;
```

- [ ] **Step 4: Render checkpoint system notices in the panel**

In `src/webview/components/SystemNotice.tsx`, add:

```tsx
if (message.kind === 'checkpoint') classes.push('checkpoint');
if (message.kind === 'checkpoint' && message.checkpoint) {
  return (
    <div class={classes.join(' ')}>
      <div>{message.text}</div>
      <div class="checkpoint-meta">
        <span>{message.checkpoint.source}</span>
        <span>{message.checkpoint.status}</span>
        <span>{message.checkpoint.fileCount} {message.checkpoint.fileCount === 1 ? 'file' : 'files'}</span>
      </div>
    </div>
  );
}
```

In `src/webview/styles.css`, add:

```css
.system-notice.checkpoint {
  font-style: normal;
}
.checkpoint-meta {
  display: flex;
  gap: 8px;
  margin-top: 4px;
  opacity: 0.7;
}
```

- [ ] **Step 5: Render native chat and Language Model checkpoint notices**

In `src/nativeChat.ts`, inside `renderNativeChatEvent`:

```ts
if (event.message.kind === 'checkpoint') {
  response.markdown(`\n\n${event.message.text}`);
  return { sawText: true, sawError: false };
}
```

In `src/languageModelProvider.ts`, inside `reportLanguageModelEvent`:

```ts
} else if (event.message.kind === 'checkpoint') {
  progress.report(new vscode.LanguageModelTextPart(`Veyra checkpoint: ${event.message.text}`));
  return true;
}
```

- [ ] **Step 6: Run focused tests**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/panel.test.ts tests/nativeChat.test.ts tests/languageModelProvider.test.ts tests/systemNotice.test.ts tests/webviewState.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit this slice**

Run:

```powershell
git add src/panel.ts src/nativeChat.ts src/languageModelProvider.ts src/shared/protocol.ts src/webview/components/SystemNotice.tsx src/webview/styles.css tests/panel.test.ts tests/nativeChat.test.ts tests/languageModelProvider.test.ts tests/systemNotice.test.ts tests/webviewState.test.ts
git diff --cached --check
git commit -m "feat: render checkpoint notices"
```

## Task 5: Document Checkpoints

**Files:**
- Modify: `README.md`
- Modify: `tests/manifest.test.ts`

- [ ] **Step 1: Add documentation assertions**

In `tests/manifest.test.ts`, extend checkpoint assertions:

```ts
const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
expect(readme).toContain('Veyra: Create Checkpoint');
expect(readme).toContain('Veyra: List Checkpoints');
expect(readme).toContain('Veyra: Roll Back Latest Checkpoint');
expect(readme).toContain('veyra.checkpoints.enabled');
expect(readme).toContain('veyra.checkpoints.maxFileBytes');
expect(readme).toContain('veyra.checkpoints.maxCount');
```

- [ ] **Step 2: Run manifest test and verify it fails**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/manifest.test.ts
```

Expected: fail because README does not mention checkpoints yet.

- [ ] **Step 3: Update README**

Add under the Diff Preview section:

```md
### Checkpoints And Rollback

Veyra can save checkpoints before write-capable dispatches and on demand. Use `Veyra: Create Checkpoint` before an experiment, `Veyra: List Checkpoints` to inspect recent recovery points, and `Veyra: Roll Back Latest Checkpoint` to restore the latest safe checkpoint.

Rollback refuses when automatic checkpoint files changed after the agent dispatch or when files are too large to restore safely. Manual checkpoint rollback is explicit: Veyra shows the changed file count before restoring files to the manual checkpoint state.
```

Add settings bullets:

```md
- `veyra.checkpoints.enabled`: capture automatic and manual Veyra checkpoints.
- `veyra.checkpoints.maxFileBytes`: max file size snapshotted for checkpoint rollback.
- `veyra.checkpoints.maxCount`: max checkpoint count before pruning older snapshots.
```

- [ ] **Step 4: Run manifest test**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/manifest.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit this slice**

Run:

```powershell
git add README.md tests/manifest.test.ts
git diff --cached --check
git commit -m "docs: document checkpoint controls"
```

## Task 6: Final Verification

**Files:**
- Modify only if verification reveals a concrete defect from this plan.

- [ ] **Step 1: Run focused feature verification**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/checkpointLedger.test.ts tests/veyraService.test.ts tests/veyraRuntime.test.ts tests/extension.test.ts tests/manifest.test.ts tests/panel.test.ts tests/nativeChat.test.ts tests/languageModelProvider.test.ts tests/systemNotice.test.ts tests/webviewState.test.ts
```

Expected: all selected tests pass.

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

- [ ] **Step 4: Check git status and whitespace**

Run:

```powershell
git status --short --branch
git diff --check
```

Expected: branch contains only intended committed changes and no whitespace errors.

- [ ] **Step 5: Commit verification fixes if needed**

If final verification required fixes, commit only those fixes:

```powershell
git add <fixed-files>
git diff --cached --check
git commit -m "fix: stabilize checkpoints"
```

When verification does not require fixes, leave the working tree clean.

## Self-Review Checklist

- [ ] Automatic checkpoints are captured before write-capable dispatches.
- [ ] Automatic checkpoints are finalized with after-dispatch hashes.
- [ ] Manual checkpoints are command-driven and explicit.
- [ ] Rollback refuses stale automatic checkpoints before writing anything.
- [ ] Rollback refuses non-restorable large-file changes.
- [ ] Rollback handles created, edited, and deleted files.
- [ ] Checkpoint snapshots stay under `.vscode/veyra`.
- [ ] Pruning removes older snapshot directories.
- [ ] Command palette, panel, native chat, and Language Model provider surface checkpoint state.
- [ ] Settings and README document the new behavior.
- [ ] Existing diff preview, file-edited events, file badges, edit-conflict notices, package verification, smoke tests, and workspace context behavior remain covered.
