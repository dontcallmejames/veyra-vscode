import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorkspaceChangeTracker, diffWorkspaceSnapshotFileChanges, diffWorkspaceSnapshots } from '../src/workspaceChanges.js';

describe('diffWorkspaceSnapshots', () => {
  it('returns files added after the snapshot', () => {
    expect(diffWorkspaceSnapshots(
      { files: new Map() },
      { files: new Map([['src/new.ts', { size: 10, mtimeMs: 100 }]]) },
    )).toEqual(['src/new.ts']);
  });

  it('returns created file details for files added after the snapshot', () => {
    expect(diffWorkspaceSnapshotFileChanges(
      { files: new Map() },
      { files: new Map([['src/new.ts', { size: 10, mtimeMs: 100 }]]) },
    )).toEqual([{ path: 'src/new.ts', changeKind: 'created' }]);
  });

  it('returns files whose fingerprint changed', () => {
    expect(diffWorkspaceSnapshots(
      { files: new Map([['src/a.ts', { size: 10, mtimeMs: 100 }]]) },
      { files: new Map([['src/a.ts', { size: 12, mtimeMs: 101 }]]) },
    )).toEqual(['src/a.ts']);
  });

  it('returns files deleted after the snapshot', () => {
    expect(diffWorkspaceSnapshots(
      { files: new Map([['src/removed.ts', { size: 10, mtimeMs: 100 }]]) },
      { files: new Map() },
    )).toEqual(['src/removed.ts']);
  });

  it('does not return unchanged files', () => {
    expect(diffWorkspaceSnapshots(
      { files: new Map([['src/a.ts', { size: 10, mtimeMs: 100 }]]) },
      { files: new Map([['src/a.ts', { size: 10, mtimeMs: 100 }]]) },
    )).toEqual([]);
  });

  it('returns files whose content hash changed even when size and mtime match', () => {
    expect(diffWorkspaceSnapshots(
      { files: new Map([['src/a.ts', { size: 10, mtimeMs: 100, contentHash: 'old' }]]) },
      { files: new Map([['src/a.ts', { size: 10, mtimeMs: 100, contentHash: 'new' }]]) },
    )).toEqual(['src/a.ts']);
  });

  it('detects changes to ignored workspace files outside excluded directories', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-workspace-changes-'));
    try {
      execFileSync('git', ['init'], { cwd: workspacePath, stdio: 'ignore' });
      fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
      fs.writeFileSync(path.join(workspacePath, '.gitignore'), '.env\n');
      fs.writeFileSync(path.join(workspacePath, 'src', 'tracked.ts'), 'export const value = 1;\n');
      fs.writeFileSync(path.join(workspacePath, '.env'), 'TOKEN=one\n');
      execFileSync('git', ['add', '.gitignore', 'src/tracked.ts'], { cwd: workspacePath, stdio: 'ignore' });

      const tracker = createWorkspaceChangeTracker(workspacePath);
      const before = await tracker.snapshot();

      fs.writeFileSync(path.join(workspacePath, '.env'), 'TOKEN=two-and-longer\n');

      await expect(tracker.changedFilesSince(before)).resolves.toContain('.env');
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it('ignores Veyra internal state from git-backed snapshots', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-workspace-changes-'));
    try {
      execFileSync('git', ['init'], { cwd: workspacePath, stdio: 'ignore' });
      fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, '.vscode', 'veyra'), { recursive: true });
      fs.writeFileSync(path.join(workspacePath, 'src', 'real.ts'), 'export const value = 1;\n');
      fs.writeFileSync(path.join(workspacePath, '.vscode', 'veyra', 'sessions.json'), '{}\n');

      const tracker = createWorkspaceChangeTracker(workspacePath);
      const before = await tracker.snapshot();

      fs.writeFileSync(path.join(workspacePath, 'src', 'real.ts'), 'export const value = 2;\n');
      fs.writeFileSync(path.join(workspacePath, '.vscode', 'veyra', 'sessions.json'), '{"internal":true}\n');
      fs.writeFileSync(path.join(workspacePath, '.vscode', 'veyra', 'sessions.json.tmp'), '{"tmp":true}\n');

      await expect(tracker.changedFilesSince(before)).resolves.toEqual(['src/real.ts']);
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it('detects same-size file content changes even when mtime is unchanged', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-workspace-changes-'));
    try {
      fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
      const filePath = path.join(workspacePath, 'src', 'stable.ts');
      fs.writeFileSync(filePath, 'aaaa\n');

      const tracker = createWorkspaceChangeTracker(workspacePath);
      const before = await tracker.snapshot();
      const originalStat = fs.statSync(filePath);

      fs.writeFileSync(filePath, 'bbbb\n');
      fs.utimesSync(filePath, originalStat.atime, originalStat.mtime);

      await expect(tracker.changedFilesSince(before)).resolves.toContain('src/stable.ts');
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it('ignores excluded directories at any workspace depth', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-workspace-changes-'));
    try {
      fs.mkdirSync(path.join(workspacePath, 'packages', 'app', 'node_modules', 'pkg'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, 'packages', 'app', 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(workspacePath, 'packages', 'app', 'node_modules', 'pkg', 'index.js'),
        'module.exports = 1;\n',
      );
      fs.writeFileSync(
        path.join(workspacePath, 'packages', 'app', 'src', 'real.ts'),
        'export const value = 1;\n',
      );

      const tracker = createWorkspaceChangeTracker(workspacePath);
      const before = await tracker.snapshot();

      fs.writeFileSync(
        path.join(workspacePath, 'packages', 'app', 'node_modules', 'pkg', 'index.js'),
        'module.exports = 2;\n',
      );
      fs.writeFileSync(
        path.join(workspacePath, 'packages', 'app', 'src', 'real.ts'),
        'export const value = 2;\n',
      );

      await expect(tracker.changedFilesSince(before)).resolves.toEqual(['packages/app/src/real.ts']);
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
