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

  it('accepts a pending change set without changing workspace files', async () => {
    const root = tempWorkspace();
    writeFile(root, 'src/edit.ts', 'before\n');
    const ledger = new ChangeLedger(root, { maxFileBytes: 1_000_000 });
    const baseline = await ledger.captureBaseline('msg4');
    writeFile(root, 'src/edit.ts', 'after\n');
    const changeSet = await ledger.createChangeSet(baseline, {
      agentId: 'codex',
      messageId: 'msg4',
      readOnly: false,
      files: [{ path: 'src/edit.ts', changeKind: 'edited' }],
      timestamp: 1000,
    });

    const accepted = await ledger.acceptChangeSet(changeSet!.id);

    expect(accepted.status).toBe('accepted');
    expect(await ledger.listPendingChangeSets()).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'src/edit.ts'), 'utf8')).toBe('after\n');
    expect(fs.existsSync(path.join(root, '.vscode', 'veyra', 'change-ledger', changeSet!.id))).toBe(false);
  });
});
