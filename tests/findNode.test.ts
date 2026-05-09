import { afterEach, describe, expect, it, vi } from 'vitest';

const originalPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  vi.doUnmock('node:child_process');
  vi.resetModules();
});

describe('findNode', () => {
  it('uses PowerShell command lookup on Windows when where misses node', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const execSync = vi.fn((command: string) => {
      if (command === 'where node') throw new Error('where missed node');
      if (command.includes('Get-Command node')) {
        return 'C:\\Program Files\\nodejs\\node.exe\n';
      }
      throw new Error(`unexpected command: ${command}`);
    });
    vi.doMock('node:child_process', () => ({ execSync }));

    const { findNode } = await import('../src/findNode.js');

    expect(findNode()).toBe('C:\\Program Files\\nodejs\\node.exe');
  });
});
