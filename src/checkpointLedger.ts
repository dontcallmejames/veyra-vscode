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

interface CheckpointLedgerStore {
  version: 1;
  checkpoints: Checkpoint[];
}

const DEFAULT_EXCLUDED_DIR_NAMES = new Set(['.git', 'node_modules', 'dist']);
const DEFAULT_EXCLUDED_DIR_PATHS = new Set(['.vscode/veyra']);
const SIZE_LIMIT_REASON = 'File exceeds checkpoint snapshot size limit.';

export class CheckpointLedger {
  private readonly maxFileBytes: number;
  private readonly maxCount: number;
  private readonly metadataPath: string;
  private readonly snapshotRoot: string;

  constructor(
    private readonly workspacePath: string,
    options: CheckpointLedgerOptions,
  ) {
    this.maxFileBytes = Math.max(0, Math.floor(options.maxFileBytes));
    this.maxCount = Math.max(1, Math.floor(options.maxCount));
    this.metadataPath = path.join(workspacePath, '.vscode', 'veyra', 'checkpoints.json');
    this.snapshotRoot = path.join(workspacePath, '.vscode', 'veyra', 'checkpoints');
  }

  async createCheckpoint(input: CreateCheckpointInput): Promise<Checkpoint> {
    const id = ulid();
    const checkpointRoot = path.join(this.snapshotRoot, id, 'before');
    const files: CheckpointFile[] = [];

    for (const relativePath of await listWorkspaceFiles(this.workspacePath)) {
      const absolutePath = this.workspaceFilePath(relativePath);
      try {
        const stat = await fs.stat(absolutePath);
        if (!stat.isFile()) continue;

        let hash: string | null = null;
        let snapshotPath: string | null = null;
        let restorable = false;
        if (stat.size <= this.maxFileBytes) {
          hash = await hashFile(absolutePath);
          snapshotPath = path.join(checkpointRoot, relativePath);
          await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
          await fs.copyFile(absolutePath, snapshotPath);
          restorable = true;
        }

        files.push({
          path: relativePath,
          exists: true,
          size: stat.size,
          hash,
          snapshotPath,
          restorable,
          ...(!restorable ? { nonRestorableReason: SIZE_LIMIT_REASON } : {}),
        });
      } catch {
        // File disappeared while the checkpoint was being captured.
      }
    }

    const checkpoint: Checkpoint = {
      id,
      timestamp: input.timestamp,
      source: input.source,
      label: input.label,
      promptSummary: input.promptSummary,
      status: 'available',
      fileCount: input.source === 'automatic' ? 0 : files.length,
      files,
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.workflow ? { workflow: input.workflow } : {}),
    };

    const store = await this.readStore();
    store.checkpoints = [
      ...store.checkpoints.filter((entry) => entry.id !== checkpoint.id),
      checkpoint,
    ];
    const prunedIds = this.pruneStore(store);
    await this.writeStore(store);
    await this.removeCheckpointSnapshots(prunedIds);
    return checkpoint;
  }

  async finalizeAutomaticCheckpoint(id: string, files: FileChange[]): Promise<Checkpoint> {
    const store = await this.readStore();
    const checkpoint = findCheckpoint(store, id);
    const beforeFiles = new Map(checkpoint.files.map((file) => [file.path, file]));
    const rollbackFiles = await Promise.all(dedupeFileChanges(files).map(async (change) => {
      const relativePath = normalizeWorkspaceRelativePath(this.workspacePath, change.path);
      const before = beforeFiles.get(relativePath) ?? missingCheckpointFile(relativePath);
      const after = await currentFileState(this.workspaceFilePath(relativePath), this.maxFileBytes);
      const rollback = rollbackCapability(change.changeKind, before, after);
      return {
        path: relativePath,
        changeKind: change.changeKind,
        beforeExists: before.exists,
        afterExists: after.exists,
        beforeHash: before.hash,
        afterHash: after.hash,
        beforeSnapshotPath: before.snapshotPath,
        canRollback: rollback.canRollback,
        ...(rollback.rollbackReason ? { rollbackReason: rollback.rollbackReason } : {}),
      };
    }));

    checkpoint.rollbackFiles = rollbackFiles;
    checkpoint.fileCount = rollbackFiles.length;
    await this.writeStore(store);
    return checkpoint;
  }

  async listCheckpoints(): Promise<Checkpoint[]> {
    const store = await this.readStore();
    return [...store.checkpoints].sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id));
  }

  async getCheckpoint(id: string): Promise<Checkpoint | null> {
    const store = await this.readStore();
    return store.checkpoints.find((checkpoint) => checkpoint.id === id) ?? null;
  }

  async latestCheckpoint(): Promise<Checkpoint | null> {
    return (await this.listCheckpoints()).find((checkpoint) => checkpoint.status === 'available') ?? null;
  }

  async previewRollback(id: string): Promise<RollbackCheckpointPreview> {
    const checkpoint = await this.requireCheckpoint(id);
    if (checkpoint.source === 'automatic') {
      return this.previewAutomaticRollback(checkpoint);
    }
    return this.previewManualRollback(checkpoint);
  }

  async previewLatestRollback(): Promise<RollbackCheckpointPreview | null> {
    const checkpoint = await this.latestCheckpoint();
    return checkpoint ? this.previewRollback(checkpoint.id) : null;
  }

  async rollbackCheckpoint(id: string): Promise<RollbackCheckpointResult> {
    const store = await this.readStore();
    const checkpoint = findCheckpoint(store, id);
    const preview = await this.previewRollback(id);
    if (preview.status === 'stale') {
      checkpoint.status = 'stale';
      await this.writeStore(store);
      return {
        checkpointId: id,
        status: 'stale',
        staleFiles: preview.staleFiles,
        restoredFiles: [],
      };
    }

    const rollbackFiles = checkpoint.source === 'automatic'
      ? checkpoint.rollbackFiles ?? []
      : await this.manualRollbackFiles(checkpoint);
    const restoredFiles: string[] = [];
    for (const file of [...rollbackFiles].sort((a, b) => a.path.localeCompare(b.path))) {
      await this.restoreFile(file);
      restoredFiles.push(file.path);
    }

    checkpoint.status = 'rolled-back';
    await this.writeStore(store);
    return {
      checkpointId: id,
      status: 'rolled-back',
      staleFiles: [],
      restoredFiles,
    };
  }

  async rollbackLatestCheckpoint(): Promise<RollbackCheckpointResult> {
    const checkpoint = await this.latestCheckpoint();
    if (!checkpoint) {
      throw new Error('No Veyra checkpoints found.');
    }
    return this.rollbackCheckpoint(checkpoint.id);
  }

  private async previewAutomaticRollback(checkpoint: Checkpoint): Promise<RollbackCheckpointPreview> {
    const files = (checkpoint.rollbackFiles ?? []).map((file) => ({
      path: file.path,
      changeKind: file.changeKind,
    }));
    const staleFiles = await this.staleAutomaticFiles(checkpoint);
    return {
      checkpointId: checkpoint.id,
      status: staleFiles.length > 0 ? 'stale' : 'ready',
      files,
      staleFiles,
    };
  }

  private async previewManualRollback(checkpoint: Checkpoint): Promise<RollbackCheckpointPreview> {
    const rollbackFiles = await this.manualRollbackFiles(checkpoint);
    const staleFiles = rollbackFiles
      .filter((file) => !file.canRollback)
      .map((file) => file.path)
      .sort((a, b) => a.localeCompare(b));
    return {
      checkpointId: checkpoint.id,
      status: staleFiles.length > 0 ? 'stale' : 'ready',
      files: rollbackFiles.map((file) => ({ path: file.path, changeKind: file.changeKind })),
      staleFiles,
    };
  }

  private async manualRollbackFiles(checkpoint: Checkpoint): Promise<CheckpointRollbackFile[]> {
    const beforeFiles = new Map(checkpoint.files.map((file) => [file.path, file]));
    const currentFiles = new Set(await listWorkspaceFiles(this.workspacePath));
    const paths = new Set([...beforeFiles.keys(), ...currentFiles]);
    const rollbackFiles: CheckpointRollbackFile[] = [];

    for (const relativePath of [...paths].sort((a, b) => a.localeCompare(b))) {
      const before = beforeFiles.get(relativePath) ?? missingCheckpointFile(relativePath);
      const after = await currentFileState(this.workspaceFilePath(relativePath), this.maxFileBytes);
      const changeKind = manualChangeKind(before, after);
      if (!changeKind) continue;
      const rollback = rollbackCapability(changeKind, before, after);
      rollbackFiles.push({
        path: relativePath,
        changeKind,
        beforeExists: before.exists,
        afterExists: after.exists,
        beforeHash: before.hash,
        afterHash: after.hash,
        beforeSnapshotPath: before.snapshotPath,
        canRollback: rollback.canRollback,
        ...(rollback.rollbackReason ? { rollbackReason: rollback.rollbackReason } : {}),
      });
    }

    return rollbackFiles;
  }

  private async staleAutomaticFiles(checkpoint: Checkpoint): Promise<string[]> {
    if (checkpoint.status !== 'available') {
      return (checkpoint.rollbackFiles ?? []).map((file) => file.path).sort((a, b) => a.localeCompare(b));
    }

    const staleFiles: string[] = [];
    for (const file of checkpoint.rollbackFiles ?? []) {
      if (!file.canRollback) {
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

  private async restoreFile(file: CheckpointRollbackFile): Promise<void> {
    const absolutePath = this.workspaceFilePath(file.path);
    if (file.changeKind === 'created') {
      await fs.rm(absolutePath, { force: true });
      return;
    }

    if (!file.beforeSnapshotPath) {
      throw new Error(`Missing checkpoint snapshot for ${file.path}.`);
    }
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.copyFile(file.beforeSnapshotPath, absolutePath);
  }

  private async requireCheckpoint(id: string): Promise<Checkpoint> {
    const checkpoint = await this.getCheckpoint(id);
    if (!checkpoint) {
      throw new Error(`Checkpoint ${id} was not found.`);
    }
    return checkpoint;
  }

  private workspaceFilePath(relativePath: string): string {
    return path.join(this.workspacePath, normalizeWorkspaceRelativePath(this.workspacePath, relativePath));
  }

  private pruneStore(store: CheckpointLedgerStore): string[] {
    const sorted = [...store.checkpoints].sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id));
    const kept = new Set(sorted.slice(0, this.maxCount).map((checkpoint) => checkpoint.id));
    const prunedIds = store.checkpoints
      .filter((checkpoint) => !kept.has(checkpoint.id))
      .map((checkpoint) => checkpoint.id);
    store.checkpoints = store.checkpoints.filter((checkpoint) => kept.has(checkpoint.id));
    return prunedIds;
  }

  private async removeCheckpointSnapshots(ids: string[]): Promise<void> {
    await Promise.all(ids.map(async (id) => {
      await fs.rm(path.join(this.snapshotRoot, id), { recursive: true, force: true });
    }));
  }

  private async readStore(): Promise<CheckpointLedgerStore> {
    try {
      const raw = await fs.readFile(this.metadataPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<CheckpointLedgerStore>;
      return {
        version: 1,
        checkpoints: Array.isArray(parsed.checkpoints) ? parsed.checkpoints : [],
      };
    } catch (err) {
      if (isFileNotFoundError(err)) {
        return { version: 1, checkpoints: [] };
      }
      throw err;
    }
  }

  private async writeStore(store: CheckpointLedgerStore): Promise<void> {
    await fs.mkdir(path.dirname(this.metadataPath), { recursive: true });
    const tmpPath = `${this.metadataPath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    await fs.rename(tmpPath, this.metadataPath);
  }
}

function findCheckpoint(store: CheckpointLedgerStore, id: string): Checkpoint {
  const checkpoint = store.checkpoints.find((entry) => entry.id === id);
  if (!checkpoint) {
    throw new Error(`Checkpoint ${id} was not found.`);
  }
  return checkpoint;
}

function missingCheckpointFile(relativePath: string): CheckpointFile {
  return {
    path: relativePath,
    exists: false,
    size: 0,
    hash: null,
    snapshotPath: null,
    restorable: true,
  };
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

async function hashFile(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

function manualChangeKind(
  before: CheckpointFile,
  after: { exists: boolean; size: number; hash: string | null },
): FileChangeKind | null {
  if (!before.exists && after.exists) return 'created';
  if (before.exists && !after.exists) return 'deleted';
  if (!before.exists || !after.exists) return null;
  if (before.hash !== null && after.hash !== null) {
    return before.hash === after.hash ? null : 'edited';
  }
  return before.size === after.size ? null : 'edited';
}

function rollbackCapability(
  changeKind: FileChangeKind,
  before: CheckpointFile,
  after: { exists: boolean; hash: string | null },
): { canRollback: boolean; rollbackReason?: string } {
  if (before.exists && !before.restorable) {
    return { canRollback: false, rollbackReason: before.nonRestorableReason ?? SIZE_LIMIT_REASON };
  }
  if (after.exists && after.hash === null) {
    return { canRollback: false, rollbackReason: SIZE_LIMIT_REASON };
  }
  if (changeKind === 'created') {
    return after.exists
      ? { canRollback: true }
      : { canRollback: false, rollbackReason: 'Created file is missing.' };
  }
  if (!before.exists || !before.snapshotPath) {
    return { canRollback: false, rollbackReason: 'Missing checkpoint snapshot.' };
  }
  if (changeKind === 'deleted') {
    return after.exists
      ? { canRollback: false, rollbackReason: 'Deleted file exists again.' }
      : { canRollback: true };
  }
  return after.exists
    ? { canRollback: true }
    : { canRollback: false, rollbackReason: 'Edited file is missing.' };
}

function dedupeFileChanges(files: FileChange[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const file of files) {
    const normalizedPath = normalizePath(file.path);
    byPath.set(normalizedPath, {
      path: normalizedPath,
      changeKind: file.changeKind,
    });
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
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
