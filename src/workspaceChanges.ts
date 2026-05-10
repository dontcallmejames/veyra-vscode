import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorkspaceChangeTracker } from './veyraService.js';
import type { FileChange } from './shared/protocol.js';

const execFileAsync = promisify(execFile);

export interface FileFingerprint {
  size: number;
  mtimeMs: number;
  contentHash?: string;
}

export interface WorkspaceFileSnapshot {
  files: Map<string, FileFingerprint>;
}

const DEFAULT_EXCLUDED_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
]);
const DEFAULT_EXCLUDED_DIR_PATHS = new Set(['.vscode/veyra']);

export function createWorkspaceChangeTracker(workspacePath: string): WorkspaceChangeTracker {
  return new GitAwareWorkspaceChangeTracker(workspacePath);
}

export class GitAwareWorkspaceChangeTracker implements WorkspaceChangeTracker {
  constructor(private readonly workspacePath: string) {}

  async snapshot(): Promise<WorkspaceFileSnapshot> {
    const files = await listWorkspaceFiles(this.workspacePath);
    const entries = new Map<string, FileFingerprint>();
    await Promise.all(files.map(async (file) => {
      const absolute = path.join(this.workspacePath, file);
      try {
        const stat = await fs.stat(absolute);
        if (stat.isFile()) {
          entries.set(normalizePath(file), {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            contentHash: await hashFile(absolute),
          });
        }
      } catch {
        // File disappeared while scanning. The next snapshot will capture the deletion.
      }
    }));
    return { files: entries };
  }

  async changedFilesSince(snapshot: unknown): Promise<string[]> {
    if (!isWorkspaceFileSnapshot(snapshot)) return [];
    return (await this.changedFileChangesSince(snapshot)).map((change) => change.path);
  }

  async changedFileChangesSince(snapshot: unknown): Promise<FileChange[]> {
    if (!isWorkspaceFileSnapshot(snapshot)) return [];
    const after = await this.snapshot();
    return diffWorkspaceSnapshotFileChanges(snapshot, after);
  }
}

export function diffWorkspaceSnapshots(
  before: WorkspaceFileSnapshot,
  after: WorkspaceFileSnapshot,
): string[] {
  return diffWorkspaceSnapshotFileChanges(before, after).map((change) => change.path);
}

export function diffWorkspaceSnapshotFileChanges(
  before: WorkspaceFileSnapshot,
  after: WorkspaceFileSnapshot,
): FileChange[] {
  const changes: FileChange[] = [];

  for (const [file, beforeFingerprint] of before.files) {
    const afterFingerprint = after.files.get(file);
    if (!afterFingerprint || !sameFingerprint(beforeFingerprint, afterFingerprint)) {
      changes.push({
        path: file,
        changeKind: afterFingerprint ? 'edited' : 'deleted',
      });
    }
  }

  for (const file of after.files.keys()) {
    if (!before.files.has(file)) {
      changes.push({ path: file, changeKind: 'created' });
    }
  }

  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

async function listWorkspaceFiles(workspacePath: string): Promise<string[]> {
  const gitFiles = await listGitFiles(workspacePath);
  const files = new Set<string>(gitFiles ?? []);
  for (const file of await listFilesRecursively(workspacePath, workspacePath)) {
    files.add(file);
  }
  return [...files].sort((a, b) => a.localeCompare(b));
}

async function listGitFiles(workspacePath: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: workspacePath, windowsHide: true, timeout: 10_000 },
    );
    return stdout
      .split('\0')
      .map((file) => normalizePath(file.trim()))
      .filter((file) => file.length > 0 && !isExcludedPath(file));
  } catch {
    return null;
  }
}

async function listFilesRecursively(root: string, current: string): Promise<string[]> {
  let entries: Array<import('node:fs').Dirent>;
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = normalizePath(path.relative(root, absolute));
    if (entry.isDirectory()) {
      if (isExcludedPath(relative)) continue;
      files.push(...await listFilesRecursively(root, absolute));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

function isWorkspaceFileSnapshot(value: unknown): value is WorkspaceFileSnapshot {
  return typeof value === 'object' &&
    value !== null &&
    'files' in value &&
    value.files instanceof Map;
}

function sameFingerprint(a: FileFingerprint, b: FileFingerprint): boolean {
  return a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.contentHash === b.contentHash;
}

async function hashFile(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
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
