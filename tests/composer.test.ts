import { describe, expect, it, vi, beforeEach } from 'vitest';
import { h } from 'preact';

vi.stubGlobal('React', { createElement: h });

vi.mock('preact/hooks', () => ({
  useState: vi.fn((initial: unknown) => [initial, vi.fn()]),
  useRef: vi.fn(() => ({ current: null })),
  useEffect: vi.fn(),
  useMemo: vi.fn((factory: () => unknown) => factory()),
}));

import { Composer } from '../src/webview/components/Composer.js';
import { useState } from 'preact/hooks';

const mockedUseState = useState as unknown as ReturnType<typeof vi.fn>;

describe('Composer', () => {
  beforeEach(() => {
    mockedUseState.mockReset();
    mockedUseState.mockImplementation((initial: unknown) => [initial, vi.fn()]);
  });

  it('renders composer affordances without mojibake', () => {
    mockedUseState
      .mockReturnValueOnce(['Review @src/main.ts', vi.fn()])
      .mockImplementation((initial: unknown) => [initial, vi.fn()]);

    const vnode = Composer({
      send: vi.fn(),
      floorHolder: null,
      status: { claude: 'ready', codex: 'ready', gemini: 'ready' },
      gambitMdPresent: true,
    });

    const text = collectText(vnode);
    const textarea = findNode(vnode, 'textarea');

    expect(text).toContain('Attached: src/main.ts');
    expect(text).not.toContain('ðŸ');
    expect(text).not.toContain('â');
    expect(textarea?.props.placeholder).toBe('Type @ to mention an agent or @path/to/file to attach...');
  });

  it('does not show scoped npm package mentions as attached files', () => {
    mockedUseState
      .mockReturnValueOnce(['Upgrade @openai/codex and @google/gemini-cli', vi.fn()])
      .mockImplementation((initial: unknown) => [initial, vi.fn()]);

    const vnode = Composer({
      send: vi.fn(),
      floorHolder: null,
      status: { claude: 'ready', codex: 'ready', gemini: 'ready' },
      gambitMdPresent: true,
    });

    expect(collectText(vnode)).not.toContain('Attached:');
  });

  it('normalizes punctuation around file attachment chips', () => {
    mockedUseState
      .mockReturnValueOnce(['Review (@src/auth.ts), then @README.md.', vi.fn()])
      .mockImplementation((initial: unknown) => [initial, vi.fn()]);

    const vnode = Composer({
      send: vi.fn(),
      floorHolder: null,
      status: { claude: 'ready', codex: 'ready', gemini: 'ready' },
      gambitMdPresent: true,
    });

    const text = collectText(vnode);

    expect(text).toContain('Attached: src/auth.ts');
    expect(text).toContain('Attached: README.md');
    expect(text).not.toContain('Attached: src/auth.ts)');
    expect(text).not.toContain('Attached: README.md.');
  });

  it('does not show fenced code block tokens as attached files', () => {
    mockedUseState
      .mockReturnValueOnce([[
          'Review @src/auth.ts and this snippet:',
          '',
          '```ts',
          '@fixtures/not-attached.ts',
          '```',
        ].join('\n'), vi.fn()])
      .mockImplementation((initial: unknown) => [initial, vi.fn()]);

    const vnode = Composer({
      send: vi.fn(),
      floorHolder: null,
      status: { claude: 'ready', codex: 'ready', gemini: 'ready' },
      gambitMdPresent: true,
    });

    const text = collectText(vnode);

    expect(text).toContain('Attached: src/auth.ts');
    expect(text).not.toContain('not-attached.ts');
  });

  it('does not show email addresses as attached files', () => {
    mockedUseState
      .mockReturnValueOnce(['Contact support@example.com before editing @src/auth.ts', vi.fn()])
      .mockImplementation((initial: unknown) => [initial, vi.fn()]);

    const vnode = Composer({
      send: vi.fn(),
      floorHolder: null,
      status: { claude: 'ready', codex: 'ready', gemini: 'ready' },
      gambitMdPresent: true,
    });

    const text = collectText(vnode);

    expect(text).toContain('Attached: src/auth.ts');
    expect(text).not.toContain('example.com');
  });
});

function collectText(vnode: any): string {
  if (vnode === null || vnode === undefined || typeof vnode === 'boolean') return '';
  if (typeof vnode === 'string' || typeof vnode === 'number') return String(vnode);
  if (Array.isArray(vnode)) return vnode.map(collectText).join('');
  return collectText(vnode.props?.children);
}

function findNode(vnode: any, type: string): any | undefined {
  if (vnode === null || vnode === undefined || typeof vnode !== 'object') return undefined;
  if (vnode.type === type) return vnode;
  const children = vnode.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findNode(child, type);
      if (found) return found;
    }
    return undefined;
  }
  return findNode(children, type);
}
