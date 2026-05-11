import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ulid } from './ulid.js';
import type { FileChange, FileChangeKind } from './shared/protocol.js';
import type { AgentId } from './types.js';

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

interface ChangeLedgerStore {
  version: 1;
  changeSets: DispatchChangeSet[];
}

const DEFAULT_EXCLUDED_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
]);

const DEFAULT_EXCLUDED_DIR_PATHS = new Set([
  '.vscode/veyra',
]);

const SIZE_LIMIT_REJECT_REASON = 'File exceeds diff preview snapshot size limit.';

export class ChangeLedger {
  private readonly maxFileBytes: number;
  private readonly metadataPath: string;
  private readonly snapshotRoot: string;

  constructor(
    private readonly workspacePath: string,
    options: ChangeLedgerOptions,
  ) {
    this.maxFileBytes = Math.max(0, Math.floor(options.maxFileBytes));
    this.metadataPath = path.join(workspacePath, '.vscode', 'veyra', 'change-ledger.json');
    this.snapshotRoot = path.join(workspacePath, '.vscode', 'veyra', 'change-ledger');
  }

  async captureBaseline(messageId: string): Promise<ChangeLedgerBaseline> {
    const id = ulid();
    const baselineRoot = path.join(this.snapshotRoot, id, 'before');
    const files = new Map<string, BaselineFile>();

    for (const relativePath of await listWorkspaceFiles(this.workspacePath)) {
      const absolutePath = this.workspaceFilePath(relativePath);
      try {
        const stat = await fs.stat(absolutePath);
        if (!stat.isFile()) continue;

        let hash: string | null = null;
        let snapshotPath: string | null = null;
        if (stat.size <= this.maxFileBytes) {
          hash = await hashFile(absolutePath);
          snapshotPath = path.join(baselineRoot, relativePath);
          await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
          await fs.copyFile(absolutePath, snapshotPath);
        }

        files.set(relativePath, {
          path: relativePath,
          exists: true,
          size: stat.size,
          hash,
          snapshotPath,
        });
      } catch {
        // File disappeared while the baseline was being captured.
      }
    }

    return {
      id,
      messageId,
      snapshotRoot: path.join(this.snapshotRoot, id),
      files,
    };
  }

  async createChangeSet(
    baseline: ChangeLedgerBaseline,
    input: {
      agentId: AgentId;
      messageId: string;
      readOnly: boolean;
      files: FileChange[];
      timestamp: number;
    },
  ): Promise<DispatchChangeSet | null> {
    const files = await Promise.all(dedupeFileChanges(input.files).map(async (change) => {
      const relativePath = normalizeWorkspaceRelativePath(this.workspacePath, change.path);
      const before = baseline.files.get(relativePath) ?? missingBaselineFile(relativePath);
      const after = await currentFileState(this.workspaceFilePath(relativePath), this.maxFileBytes);
      const rejectState = rejectCapability(change.changeKind, before, after);
      return {
        path: relativePath,
        changeKind: change.changeKind,
        beforeExists: before.exists,
        afterExists: after.exists,
        beforeHash: before.hash,
        afterHash: after.hash,
        beforeSnapshotPath: before.snapshotPath,
        canReject: rejectState.canReject,
        ...(rejectState.rejectReason ? { rejectReason: rejectState.rejectReason } : {}),
      };
    }));

    if (files.length === 0) return null;

    const changeSet: DispatchChangeSet = {
      id: baseline.id,
      agentId: input.agentId,
      messageId: input.messageId,
      timestamp: input.timestamp,
      readOnly: input.readOnly,
      status: 'pending',
      fileCount: files.length,
      files,
    };

    const store = await this.readStore();
    store.changeSets = [
      ...store.changeSets.filter((entry) => entry.id !== changeSet.id),
      changeSet,
    ];
    await this.writeStore(store);
    return changeSet;
  }

  async listPendingChangeSets(): Promise<DispatchChangeSet[]> {
    const store = await this.readStore();
    return store.changeSets
      .filter((changeSet) => changeSet.status === 'pending')
      .sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
  }

  async getChangeSet(id: string): Promise<DispatchChangeSet | null> {
    const store = await this.readStore();
    return store.changeSets.find((changeSet) => changeSet.id === id) ?? null;
  }

  async diffInputs(id: string, filePath: string): Promise<ChangeSetDiffInputs> {
    const changeSet = await this.requireChangeSet(id);
    const relativePath = normalizeWorkspaceRelativePath(this.workspacePath, filePath);
    const file = changeSet.files.find((entry) => entry.path === relativePath);
    if (!file) {
      throw new Error(`Change set ${id} does not include ${relativePath}.`);
    }

    const emptyPath = await this.emptyDiffFile(id);
    const beforePath = file.beforeSnapshotPath ?? emptyPath;
    const afterPath = file.afterExists ? this.workspaceFilePath(relativePath) : emptyPath;
    return {
      beforePath,
      afterPath,
      title: `Veyra diff: ${relativePath}`,
    };
  }

  async acceptChangeSet(id: string): Promise<DispatchChangeSet> {
    const store = await this.readStore();
    const changeSet = findChangeSet(store, id);
    changeSet.status = 'accepted';
    await this.writeStore(store);
    await this.removeChangeSetSnapshots(id);
    return changeSet;
  }

  async rejectChangeSet(id: string): Promise<RejectChangeSetResult> {
    const store = await this.readStore();
    const changeSet = findChangeSet(store, id);
    const staleFiles = await this.staleFilesForReject(changeSet);
    if (staleFiles.length > 0) {
      changeSet.status = 'stale';
      await this.writeStore(store);
      return {
        status: 'stale',
        staleFiles,
        restoredFiles: [],
      };
    }

    const restoredFiles: string[] = [];
    for (const file of [...changeSet.files].sort((a, b) => a.path.localeCompare(b.path))) {
      await this.restoreFile(file);
      restoredFiles.push(file.path);
    }

    changeSet.status = 'rejected';
    await this.writeStore(store);
    await this.removeChangeSetSnapshots(id);
    return {
      status: 'rejected',
      staleFiles: [],
      restoredFiles,
    };
  }

  private async requireChangeSet(id: string): Promise<DispatchChangeSet> {
    const changeSet = await this.getChangeSet(id);
    if (!changeSet) {
      throw new Error(`Change set ${id} was not found.`);
    }
    return changeSet;
  }

  private async staleFilesForReject(changeSet: DispatchChangeSet): Promise<string[]> {
    const staleFiles: string[] = [];
    for (const file of changeSet.files) {
      if (!file.canReject) {
        staleFiles.push(file.path);
        continue;
      }

      const current = await currentFileState(this.workspaceFilePath(file.path), this.maxFileBytes);
      if (file.afterExists) {
        if (!current.exists || current.hash !== file.afterHash) {
          staleFiles.push(file.path);
        }
      } else if (current.exists) {
        staleFiles.push(file.path);
      }
    }
    return staleFiles.sort((a, b) => a.localeCompare(b));
  }

  private async restoreFile(file: DispatchChangeSetFile): Promise<void> {
    const absolutePath = this.workspaceFilePath(file.path);
    if (file.changeKind === 'created') {
      await fs.rm(absolutePath, { force: true });
      return;
    }

    if (!file.beforeSnapshotPath) {
      throw new Error(`Missing baseline snapshot for ${file.path}.`);
    }
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.copyFile(file.beforeSnapshotPath, absolutePath);
  }

  private async emptyDiffFile(changeSetId: string): Promise<string> {
    const filePath = path.join(this.snapshotRoot, changeSetId, 'empty.txt');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    try {
      await fs.writeFile(filePath, '', { flag: 'wx' });
    } catch (err) {
      if (!isFileAlreadyExistsError(err)) throw err;
    }
    return filePath;
  }

  private async removeChangeSetSnapshots(id: string): Promise<void> {
    await fs.rm(path.join(this.snapshotRoot, id), { recursive: true, force: true });
  }

  private workspaceFilePath(relativePath: string): string {
    return path.join(this.workspacePath, normalizeWorkspaceRelativePath(this.workspacePath, relativePath));
  }

  private async readStore(): Promise<ChangeLedgerStore> {
    try {
      const raw = await fs.readFile(this.metadataPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<ChangeLedgerStore>;
      return {
        version: 1,
        changeSets: Array.isArray(parsed.changeSets) ? parsed.changeSets : [],
      };
    } catch (err) {
      if (isFileNotFoundError(err)) {
        return { version: 1, changeSets: [] };
      }
      throw err;
    }
  }

  private async writeStore(store: ChangeLedgerStore): Promise<void> {
    await fs.mkdir(path.dirname(this.metadataPath), { recursive: true });
    const tmpPath = `${this.metadataPath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    await fs.rename(tmpPath, this.metadataPath);
  }
}

function findChangeSet(store: ChangeLedgerStore, id: string): DispatchChangeSet {
  const changeSet = store.changeSets.find((entry) => entry.id === id);
  if (!changeSet) {
    throw new Error(`Change set ${id} was not found.`);
  }
  return changeSet;
}

function missingBaselineFile(relativePath: string): BaselineFile {
  return {
    path: relativePath,
    exists: false,
    size: 0,
    hash: null,
    snapshotPath: null,
  };
}

async function currentFileState(
  absolutePath: string,
  maxFileBytes: number,
): Promise<{ exists: boolean; size: number; hash: string | null }> {
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
      return { exists: false, size: 0, hash: null };
    }
    return {
      exists: true,
      size: stat.size,
      hash: stat.size <= maxFileBytes ? await hashFile(absolutePath) : null,
    };
  } catch (err) {
    if (isFileNotFoundError(err)) {
      return { exists: false, size: 0, hash: null };
    }
    throw err;
  }
}

function rejectCapability(
  changeKind: FileChangeKind,
  before: BaselineFile,
  after: { exists: boolean; hash: string | null },
): { canReject: boolean; rejectReason?: string } {
  if (before.exists && before.hash === null) {
    return { canReject: false, rejectReason: SIZE_LIMIT_REJECT_REASON };
  }
  if (after.exists && after.hash === null) {
    return { canReject: false, rejectReason: SIZE_LIMIT_REJECT_REASON };
  }
  if (changeKind === 'created') {
    return after.exists
      ? { canReject: true }
      : { canReject: false, rejectReason: 'Created file is missing.' };
  }
  if (!before.exists || !before.snapshotPath) {
    return { canReject: false, rejectReason: 'Missing baseline snapshot.' };
  }
  if (changeKind === 'deleted') {
    return after.exists
      ? { canReject: false, rejectReason: 'Deleted file exists again.' }
      : { canReject: true };
  }
  return after.exists
    ? { canReject: true }
    : { canReject: false, rejectReason: 'Edited file is missing.' };
}

function dedupeFileChanges(files: FileChange[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const file of files) {
    byPath.set(normalizePath(file.path), {
      path: normalizePath(file.path),
      changeKind: file.changeKind,
    });
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function listWorkspaceFiles(workspacePath: string): Promise<string[]> {
  const files: string[] = [];
  await collectFiles(workspacePath, workspacePath, files);
  return files.sort((a, b) => a.localeCompare(b));
}

async function collectFiles(root: string, current: string, files: string[]): Promise<void> {
  let entries: Array<import('node:fs').Dirent>;
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    const relativePath = normalizePath(path.relative(root, absolutePath));
    if (isExcludedPath(relativePath)) continue;

    if (entry.isDirectory()) {
      await collectFiles(root, absolutePath, files);
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
}

async function hashFile(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

function normalizeWorkspaceRelativePath(workspacePath: string, filePath: string): string {
  const normalized = normalizePath(filePath);
  const relative = path.isAbsolute(normalized)
    ? normalizePath(path.relative(workspacePath, normalized))
    : normalized;
  if (
    !relative ||
    relative.startsWith('../') ||
    relative === '..' ||
    path.isAbsolute(relative) ||
    isExcludedPath(relative)
  ) {
    throw new Error(`Path escapes workspace or is excluded: ${filePath}`);
  }
  return relative;
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function isExcludedPath(relativePath: string): boolean {
  const normalized = normalizePath(relativePath);
  for (const excludedPath of DEFAULT_EXCLUDED_DIR_PATHS) {
    if (normalized === excludedPath || normalized.startsWith(`${excludedPath}/`)) {
      return true;
    }
  }
  return normalized
    .split('/')
    .some((part) => DEFAULT_EXCLUDED_DIR_NAMES.has(part));
}

function isFileNotFoundError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}

function isFileAlreadyExistsError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'EEXIST';
}
