# Veyra Diff Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a post-edit diff ledger so users can inspect, accept, or safely reject whole agent dispatch change sets.

**Architecture:** Add a pure `changeLedger` module for baseline snapshots, change-set metadata, accept, reject, and diff inputs. Wire it into `VeyraSessionService` after existing workspace-change detection, then expose controls through system notices, VS Code commands, native chat, and the panel.

**Tech Stack:** TypeScript, Node `fs/promises`, Node `crypto`, VS Code extension API, existing `VeyraSessionService`, existing `WorkspaceChangeTracker`, Vitest.

---

## Scope Check

This plan implements Milestone 2 from `docs/superpowers/specs/2026-05-11-veyra-v1-roadmap-design.md` and the design in `docs/superpowers/specs/2026-05-11-veyra-diff-preview-design.md`.

It does not implement per-hunk apply, custom diff rendering, Git commit/stash workflows, long-term checkpoint history, embeddings, browser testing, or terminal awareness.

## File Structure

- Create `src/changeLedger.ts`
  - Owns baseline capture, pending change-set persistence, diff input materialization, accept, reject, and pruning.
- Create `tests/changeLedger.test.ts`
  - Unit tests for created, edited, deleted, accept, reject, stale rejection, and large-file non-restorable behavior.
- Modify `src/shared/protocol.ts`
  - Adds change-set status and optional change-set fields to `SystemMessage`.
  - Adds webview messages for opening, accepting, and rejecting change sets.
- Modify `src/veyraService.ts`
  - Captures ledger baseline per agent dispatch.
  - Creates a `change-set` system notice after changed files are recorded.
  - Exposes service methods for listing, opening, accepting, and rejecting pending change sets.
- Modify `src/veyraRuntime.ts`
  - Creates the default `ChangeLedger`.
  - Reads diff-preview settings.
- Create `src/diffPreviewCommands.ts`
  - Registers command palette commands and uses `vscode.diff`.
- Modify `src/extension.ts`
  - Registers diff-preview commands against the active Veyra service.
- Modify `src/panel.ts`
  - Handles panel requests to open, accept, and reject change sets.
- Modify `src/nativeChat.ts`
  - Renders change-set notices and command buttons when a dispatch changes files.
- Modify `src/languageModelProvider.ts`
  - Streams concise change-set notices.
- Modify webview files under `src/webview/`
  - Renders change-set system notices with actions in the panel.
- Modify `package.json`
  - Adds command contributions and settings.
- Modify `README.md`
  - Documents diff preview, accept, reject, and settings.

## Task 1: Add Pure Change Ledger

**Files:**
- Create: `src/changeLedger.ts`
- Create: `tests/changeLedger.test.ts`

- [ ] **Step 1: Write failing tests for change-set creation and diff inputs**

Create `tests/changeLedger.test.ts` with tests shaped like this:

```ts
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChangeLedger } from '../src/changeLedger.js';

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-change-ledger-'));
}

function writeFile(root: string, relativePath: string, content: string): void {
  const absolute = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
}

describe('ChangeLedger', () => {
  it('creates a pending change set with before snapshots and diff inputs', async () => {
    const root = tempWorkspace();
    writeFile(root, 'src/a.ts', 'export const value = 1;\n');
    const ledger = new ChangeLedger(root, { maxFileBytes: 1_000_000 });

    const baseline = await ledger.captureBaseline('msg1');
    writeFile(root, 'src/a.ts', 'export const value = 2;\n');
    writeFile(root, 'src/new.ts', 'export const created = true;\n');
    const changeSet = await ledger.createChangeSet(baseline, {
      agentId: 'codex',
      messageId: 'msg1',
      readOnly: false,
      files: [
        { path: 'src/a.ts', changeKind: 'edited' },
        { path: 'src/new.ts', changeKind: 'created' },
      ],
      timestamp: 123,
    });

    expect(changeSet).toMatchObject({
      agentId: 'codex',
      messageId: 'msg1',
      status: 'pending',
      fileCount: 2,
    });
    const diff = await ledger.diffInputs(changeSet!.id, 'src/a.ts');
    expect(fs.readFileSync(diff.beforePath, 'utf8')).toBe('export const value = 1;\n');
    expect(diff.afterPath.replace(/\\/g, '/')).toContain('src/a.ts');
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/changeLedger.test.ts
```

Expected: fail because `src/changeLedger.ts` does not exist.

- [ ] **Step 3: Implement the public ledger API**

Create `src/changeLedger.ts` with these exported types and methods:

```ts
export type ChangeSetStatus = 'pending' | 'accepted' | 'rejected' | 'stale';

export interface ChangeLedgerOptions {
  maxFileBytes: number;
}

export interface ChangeLedgerBaseline {
  id: string;
  messageId: string;
  snapshotRoot: string;
  files: Map<string, BaselineFile>;
}

export interface BaselineFile {
  path: string;
  exists: boolean;
  size: number;
  hash: string | null;
  snapshotPath: string | null;
}

export interface DispatchChangeSet {
  id: string;
  agentId: AgentId;
  messageId: string;
  timestamp: number;
  readOnly: boolean;
  status: ChangeSetStatus;
  fileCount: number;
  files: DispatchChangeSetFile[];
}

export interface DispatchChangeSetFile {
  path: string;
  changeKind: FileChangeKind;
  beforeExists: boolean;
  afterExists: boolean;
  beforeHash: string | null;
  afterHash: string | null;
  beforeSnapshotPath: string | null;
  canReject: boolean;
  rejectReason?: string;
}

export interface ChangeSetDiffInputs {
  beforePath: string;
  afterPath: string;
  title: string;
}

export interface RejectChangeSetResult {
  status: 'rejected' | 'stale';
  staleFiles: string[];
  restoredFiles: string[];
}
```

The class must expose:

```ts
export class ChangeLedger {
  constructor(workspacePath: string, options: ChangeLedgerOptions);
  captureBaseline(messageId: string): Promise<ChangeLedgerBaseline>;
  createChangeSet(
    baseline: ChangeLedgerBaseline,
    input: {
      agentId: AgentId;
      messageId: string;
      readOnly: boolean;
      files: FileChange[];
      timestamp: number;
    },
  ): Promise<DispatchChangeSet | null>;
  listPendingChangeSets(): Promise<DispatchChangeSet[]>;
  getChangeSet(id: string): Promise<DispatchChangeSet | null>;
  diffInputs(id: string, filePath: string): Promise<ChangeSetDiffInputs>;
  acceptChangeSet(id: string): Promise<DispatchChangeSet>;
  rejectChangeSet(id: string): Promise<RejectChangeSetResult>;
}
```

Use these implementation rules:

- Store metadata at `.vscode/veyra/change-ledger.json`.
- Store snapshots at `.vscode/veyra/change-ledger/<baselineId>/before/<path>`.
- Exclude `.git`, `node_modules`, `dist`, and `.vscode/veyra`.
- Capture before content only when the file exists and is at or below `maxFileBytes`.
- For files above `maxFileBytes`, set `canReject: false` with `rejectReason: 'File exceeds diff preview snapshot size limit.'`.
- Use SHA-256 for content hashes.
- Use atomic metadata writes by writing `change-ledger.json.tmp` and renaming it.

- [ ] **Step 4: Add reject and accept tests**

Extend `tests/changeLedger.test.ts` with:

```ts
it('rejects a pending change set by restoring edited and deleted files and removing created files', async () => {
  const root = tempWorkspace();
  writeFile(root, 'src/edit.ts', 'before\n');
  writeFile(root, 'src/delete.ts', 'keep me\n');
  const ledger = new ChangeLedger(root, { maxFileBytes: 1_000_000 });
  const baseline = await ledger.captureBaseline('msg2');

  writeFile(root, 'src/edit.ts', 'after\n');
  fs.unlinkSync(path.join(root, 'src/delete.ts'));
  writeFile(root, 'src/create.ts', 'created\n');

  const changeSet = await ledger.createChangeSet(baseline, {
    agentId: 'claude',
    messageId: 'msg2',
    readOnly: false,
    files: [
      { path: 'src/edit.ts', changeKind: 'edited' },
      { path: 'src/delete.ts', changeKind: 'deleted' },
      { path: 'src/create.ts', changeKind: 'created' },
    ],
    timestamp: 456,
  });

  const result = await ledger.rejectChangeSet(changeSet!.id);

  expect(result).toEqual({
    status: 'rejected',
    staleFiles: [],
    restoredFiles: ['src/create.ts', 'src/delete.ts', 'src/edit.ts'],
  });
  expect(fs.readFileSync(path.join(root, 'src/edit.ts'), 'utf8')).toBe('before\n');
  expect(fs.readFileSync(path.join(root, 'src/delete.ts'), 'utf8')).toBe('keep me\n');
  expect(fs.existsSync(path.join(root, 'src/create.ts'))).toBe(false);
});

it('refuses rejection when a file changed after the agent edit', async () => {
  const root = tempWorkspace();
  writeFile(root, 'src/edit.ts', 'before\n');
  const ledger = new ChangeLedger(root, { maxFileBytes: 1_000_000 });
  const baseline = await ledger.captureBaseline('msg3');
  writeFile(root, 'src/edit.ts', 'agent edit\n');
  const changeSet = await ledger.createChangeSet(baseline, {
    agentId: 'gemini',
    messageId: 'msg3',
    readOnly: false,
    files: [{ path: 'src/edit.ts', changeKind: 'edited' }],
    timestamp: 789,
  });

  writeFile(root, 'src/edit.ts', 'user edit after agent\n');
  const result = await ledger.rejectChangeSet(changeSet!.id);

  expect(result.status).toBe('stale');
  expect(result.staleFiles).toEqual(['src/edit.ts']);
  expect(fs.readFileSync(path.join(root, 'src/edit.ts'), 'utf8')).toBe('user edit after agent\n');
});
```

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/changeLedger.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit this slice**

Run:

```powershell
git add src/changeLedger.ts tests/changeLedger.test.ts
git commit -m "feat: add dispatch change ledger"
```

## Task 2: Wire Change Sets Into Veyra Service

**Files:**
- Modify: `src/shared/protocol.ts`
- Modify: `src/veyraService.ts`
- Modify: `src/veyraRuntime.ts`
- Modify: `tests/veyraService.test.ts`
- Modify: `tests/veyraRuntime.test.ts`

- [ ] **Step 1: Add protocol fields for change-set system notices**

In `src/shared/protocol.ts`, add:

```ts
export type ChangeSetStatus = 'pending' | 'accepted' | 'rejected' | 'stale';

export type DispatchChangeSetSummary = {
  id: string;
  agentId: AgentId;
  messageId: string;
  timestamp: number;
  readOnly: boolean;
  status: ChangeSetStatus;
  fileCount: number;
  files: FileChange[];
};
```

Extend `SystemMessage.kind` to include `change-set`, and add optional fields:

```ts
  changeSet?: DispatchChangeSetSummary;
```

- [ ] **Step 2: Write failing service tests**

Add tests to `tests/veyraService.test.ts` proving:

- a write-capable dispatch with file changes appends a `change-set` system message,
- the message includes `readOnly: false`, `agentId`, `messageId`, and changed files,
- a read-only violation still creates a `change-set` system message with `readOnly: true`.

Use a fake ledger object with methods `captureBaseline`, `createChangeSet`, `acceptChangeSet`, `rejectChangeSet`, `listPendingChangeSets`, `getChangeSet`, and `diffInputs`.

- [ ] **Step 3: Run the focused test and verify it fails**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/veyraService.test.ts
```

Expected: fail because the service does not accept a change ledger yet.

- [ ] **Step 4: Update service options and dispatch lifecycle**

In `src/veyraService.ts`:

- Import `ChangeLedger`, `ChangeLedgerBaseline`, and `DispatchChangeSet`.
- Add `changeLedger?: ChangeLedger` to `VeyraSessionOptions`.
- Store `private changeLedger?: ChangeLedger`.
- Add `changeBaseline?: ChangeLedgerBaseline` to `InProgressDispatch`.
- At `dispatch-start`, after the existing workspace-change snapshot, call `this.changeLedger?.captureBaseline(messageId)`.
- At `dispatch-end`, after `recordWorkspaceChanges`, call `createChangeSet` when `inProgress.fileChanges.length > 0`.
- Append and emit a `SystemMessage` with `kind: 'change-set'`.

The system message text should be deterministic:

```ts
`${agentLabel(agentId)} changed ${count} file${count === 1 ? '' : 's'}. Review pending changes before continuing.`
```

For read-only violations, use:

```ts
`${agentLabel(agentId)} changed ${count} file${count === 1 ? '' : 's'} during a read-only workflow. Review or reject these changes before continuing.`
```

- [ ] **Step 5: Add service command methods**

Add methods to `VeyraSessionService`:

```ts
listPendingChangeSets(): Promise<DispatchChangeSetSummary[]>;
getChangeSet(id: string): Promise<DispatchChangeSetSummary | null>;
acceptChangeSet(id: string): Promise<DispatchChangeSetSummary>;
rejectChangeSet(id: string): Promise<RejectChangeSetResult>;
changeSetDiffInputs(id: string, filePath: string): Promise<ChangeSetDiffInputs>;
```

These methods should call the underlying ledger and convert full change-set records into protocol summaries.

- [ ] **Step 6: Update runtime construction**

In `src/veyraRuntime.ts`:

- Import `ChangeLedger`.
- Add:

```ts
export function readDiffPreviewOptions(): ChangeLedgerOptions {
  const config = vscode.workspace.getConfiguration('veyra');
  return {
    maxFileBytes: config.get<number>('diffPreview.maxFileBytes', 1_000_000),
  };
}
```

- Pass `changeLedger: new ChangeLedger(workspacePath, readDiffPreviewOptions())` into `createVeyraSessionService` when `veyra.diffPreview.enabled` is true.
- Refresh the ledger in `refreshVeyraSessionOptions` when settings change.

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
git commit -m "feat: surface dispatch change sets"
```

## Task 3: Add VS Code Diff Preview Commands

**Files:**
- Create: `src/diffPreviewCommands.ts`
- Modify: `src/extension.ts`
- Modify: `package.json`
- Modify: `tests/extension.test.ts`
- Modify: `tests/manifest.test.ts`

- [ ] **Step 1: Write failing command registration tests**

In `tests/extension.test.ts`, extend the command list expectation to include:

```ts
'veyra.openPendingChanges',
'veyra.acceptPendingChanges',
'veyra.rejectPendingChanges',
```

Add tests that call the registered callbacks and verify they use the active service.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/extension.test.ts tests/manifest.test.ts
```

Expected: fail because commands and manifest contributions do not exist.

- [ ] **Step 3: Implement command helpers**

Create `src/diffPreviewCommands.ts` exporting:

```ts
export interface DiffPreviewCommandService {
  listPendingChangeSets(): Promise<DispatchChangeSetSummary[]>;
  acceptChangeSet(id: string): Promise<DispatchChangeSetSummary>;
  rejectChangeSet(id: string): Promise<RejectChangeSetResult>;
  changeSetDiffInputs(id: string, filePath: string): Promise<ChangeSetDiffInputs>;
}

export function registerDiffPreviewCommands(
  context: vscode.ExtensionContext,
  getService: () => DiffPreviewCommandService | undefined,
): void;
```

`registerDiffPreviewCommands` should register:

- `veyra.openPendingChanges`
- `veyra.acceptPendingChanges`
- `veyra.rejectPendingChanges`

Use `vscode.window.showQuickPick` when an id or file path is not passed. Use `vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, title)` to open diffs.

- [ ] **Step 4: Wire commands in extension activation**

In `src/extension.ts`, import `registerDiffPreviewCommands` and call it after `ensureNativeRegistration` is defined:

```ts
registerDiffPreviewCommands(context, () => ensureNativeRegistration()?.service);
```

- [ ] **Step 5: Add package command contributions**

In `package.json`, add commands:

```json
{
  "command": "veyra.openPendingChanges",
  "title": "Veyra: Open Pending Changes"
},
{
  "command": "veyra.acceptPendingChanges",
  "title": "Veyra: Accept Pending Changes"
},
{
  "command": "veyra.rejectPendingChanges",
  "title": "Veyra: Reject Pending Changes"
}
```

Add settings:

```json
"veyra.diffPreview.enabled": {
  "type": "boolean",
  "default": true,
  "description": "Capture pending agent change sets so Veyra can open diffs and safely reject whole dispatches."
},
"veyra.diffPreview.maxFileBytes": {
  "type": "number",
  "default": 1000000,
  "minimum": 1024,
  "maximum": 10485760,
  "description": "Maximum file size Veyra snapshots for diff preview and safe rejection."
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
git add src/diffPreviewCommands.ts src/extension.ts package.json tests/extension.test.ts tests/manifest.test.ts
git commit -m "feat: add diff preview commands"
```

## Task 4: Render Change Sets In Panel, Native Chat, And Language Model Provider

**Files:**
- Modify: `src/panel.ts`
- Modify: `src/nativeChat.ts`
- Modify: `src/languageModelProvider.ts`
- Modify: `src/webview/state.ts`
- Modify: `src/webview/components/SystemNotice.tsx`
- Modify: `src/webview/styles.css`
- Modify: `tests/panel.test.ts`
- Modify: `tests/nativeChat.test.ts`
- Modify: `tests/languageModelProvider.test.ts`
- Modify: `tests/systemNotice.test.ts`
- Modify: `tests/webviewState.test.ts`

- [ ] **Step 1: Add failing rendering tests**

Add tests proving:

- `panel.ts` sends `change-set` system messages to the webview.
- Webview state appends visible change-set notices.
- `SystemNotice` renders file count, agent label, and open/accept/reject actions for pending change sets.
- Native chat renders a concise change-set notice and command buttons.
- Language Model provider streams a concise change-set notice.

- [ ] **Step 2: Run focused tests and verify they fail**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/panel.test.ts tests/nativeChat.test.ts tests/languageModelProvider.test.ts tests/systemNotice.test.ts tests/webviewState.test.ts
```

Expected: fail because the UI surfaces do not special-case `change-set`.

- [ ] **Step 3: Add webview messages**

In `src/shared/protocol.ts`, extend `FromWebview`:

```ts
| { kind: 'open-change-set-diff'; changeSetId: string; filePath?: string }
| { kind: 'accept-change-set'; changeSetId: string }
| { kind: 'reject-change-set'; changeSetId: string }
```

In `src/panel.ts`, handle those messages by calling:

```ts
vscode.commands.executeCommand('veyra.openPendingChanges', msg.changeSetId, msg.filePath);
vscode.commands.executeCommand('veyra.acceptPendingChanges', msg.changeSetId);
vscode.commands.executeCommand('veyra.rejectPendingChanges', msg.changeSetId);
```

- [ ] **Step 4: Render panel notices**

In `src/webview/components/SystemNotice.tsx`, render `message.kind === 'change-set'` with:

- change-set text,
- a primary file list,
- an `Open diff` action for each file,
- `Accept` and `Reject` actions when `message.changeSet.status === 'pending'`.

Use existing button/link styling patterns and add minimal CSS classes in `src/webview/styles.css`.

- [ ] **Step 5: Render native chat and Language Model notices**

In `src/nativeChat.ts`, handle `system-message` with `kind === 'change-set'`:

- call `response.markdown` with the system message text,
- call `response.button` for open, accept, reject when supported by the mocked API shape.

In `src/languageModelProvider.ts`, stream:

```text
Veyra pending changes: <agent> changed <n> file(s). Use Veyra: Open Pending Changes to inspect.
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
git add src/panel.ts src/nativeChat.ts src/languageModelProvider.ts src/shared/protocol.ts src/webview/state.ts src/webview/components/SystemNotice.tsx src/webview/styles.css tests/panel.test.ts tests/nativeChat.test.ts tests/languageModelProvider.test.ts tests/systemNotice.test.ts tests/webviewState.test.ts
git commit -m "feat: render pending change sets"
```

## Task 5: Document Diff Preview

**Files:**
- Modify: `README.md`
- Modify: `tests/manifest.test.ts`

- [ ] **Step 1: Add documentation assertions**

In `tests/manifest.test.ts`, add assertions that README contains:

- `Veyra: Open Pending Changes`
- `Veyra: Accept Pending Changes`
- `Veyra: Reject Pending Changes`
- `veyra.diffPreview.enabled`
- `veyra.diffPreview.maxFileBytes`

- [ ] **Step 2: Run the manifest test and verify it fails**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/manifest.test.ts
```

Expected: fail because README does not mention diff preview yet.

- [ ] **Step 3: Update README**

Add a short section:

```md
### Diff Preview And Pending Changes

When an agent edits files, Veyra records a pending change set. Use `Veyra: Open Pending Changes` to inspect the files in VS Code's diff editor, `Veyra: Accept Pending Changes` to mark the change set as kept, or `Veyra: Reject Pending Changes` to safely restore the pre-dispatch file state.

Reject refuses to overwrite files that changed after the agent edit. In that case, inspect the file manually before continuing.
```

Add settings bullets:

```md
- `veyra.diffPreview.enabled`: capture pending agent change sets for diff preview and safe rejection.
- `veyra.diffPreview.maxFileBytes`: max file size snapshotted for diff preview and rejection.
```

- [ ] **Step 4: Run focused docs tests**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/manifest.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit this slice**

Run:

```powershell
git add README.md tests/manifest.test.ts
git commit -m "docs: document diff preview controls"
```

## Task 6: Final Verification

**Files:**
- Modify only if verification reveals a concrete defect from this plan.

- [ ] **Step 1: Run focused feature verification**

Run:

```powershell
npx vitest run --environment node --exclude ".vscode-test/**" tests/changeLedger.test.ts tests/veyraService.test.ts tests/veyraRuntime.test.ts tests/extension.test.ts tests/manifest.test.ts tests/panel.test.ts tests/nativeChat.test.ts tests/languageModelProvider.test.ts tests/systemNotice.test.ts tests/webviewState.test.ts
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
git commit -m "fix: stabilize diff preview"
```

When verification does not require fixes, leave the working tree clean.

## Self-Review Checklist

- [ ] Diff preview uses VS Code's native diff editor.
- [ ] Agent edit behavior still uses the existing CLI paths.
- [ ] Whole-dispatch reject refuses stale files before writing anything.
- [ ] Created, edited, and deleted files are all handled.
- [ ] Read-only violations produce a rejectable change set with explicit warning text.
- [ ] Change ledger files stay under `.vscode/veyra`.
- [ ] Panel, native chat, and Language Model provider all surface pending changes.
- [ ] Settings and README document the new behavior.
- [ ] Existing `file-edited`, file badges, edit-conflict notices, smoke tests, package verification, and workspace context behavior remain covered.
