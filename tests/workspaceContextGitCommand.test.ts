import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-context-git-'));
}

function writeFile(root: string, relativePath: string, content: string): void {
  const absolute = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
}

describe('workspace context git commands', () => {
  afterEach(() => {
    vi.doUnmock('node:child_process');
    vi.resetModules();
  });

  it('sets an explicit maxBuffer for git inventory output', async () => {
    vi.resetModules();
    const root = tempWorkspace();
    writeFile(root, 'src/app.ts', 'export const app = true;\n');
    const calls: Array<{ args: string[]; options: Record<string, unknown> }> = [];
    const execFile = vi.fn();
    (execFile as any)[promisify.custom] = vi.fn(async (
      _command: string,
      args: string[],
      options: Record<string, unknown>,
    ) => {
      calls.push({ args, options });
      return { stdout: 'src/app.ts\0', stderr: '' };
    });
    vi.doMock('node:child_process', () => ({ execFile }));

    const { buildWorkspaceInventory } = await import('../src/workspaceContext.js');
    const inventory = await buildWorkspaceInventory(root);

    expect(inventory.files.map((file) => file.path)).toEqual(['src/app.ts']);
    const lsFilesCall = calls.find((call) => call.args[0] === 'ls-files');
    expect(lsFilesCall?.options).toEqual(expect.objectContaining({
      maxBuffer: expect.any(Number),
    }));
    expect(lsFilesCall?.options.maxBuffer).toBeGreaterThan(1024 * 1024);
  });
});
