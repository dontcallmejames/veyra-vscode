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
