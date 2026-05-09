import { h } from 'preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('React', { createElement: h });

vi.mock('preact/hooks', () => ({
  useState: vi.fn((initial: unknown) => [initial, vi.fn()]),
}));

import { HealthStrip } from '../src/webview/components/HealthStrip.js';
import { useState } from 'preact/hooks';

const mockedUseState = useState as unknown as ReturnType<typeof vi.fn>;

describe('HealthStrip', () => {
  beforeEach(() => {
    mockedUseState.mockReset();
    mockedUseState.mockImplementation((initial: unknown) => [initial, vi.fn()]);
  });

  it('labels the Codex backend as Codex', () => {
    const vnode = HealthStrip({
      status: {
        claude: 'ready',
        codex: 'ready',
        gemini: 'ready',
      },
      send: vi.fn(),
      gambitMdPresent: true,
    });

    const text = collectText(vnode);
    expect(text).toContain('Codex');
    expect(text).not.toContain('GPT');
    expect(findTitle(vnode, 'gambit.md present')).toBe('gambit.md present - rules pinned to all agent prompts');
  });

  it('uses current Claude setup guidance in the not-installed popover', () => {
    mockedUseState.mockReturnValueOnce(['claude', vi.fn()]);
    const send = vi.fn();

    const vnode = HealthStrip({
      status: {
        claude: 'not-installed',
        codex: 'ready',
        gemini: 'ready',
      },
      send,
      gambitMdPresent: false,
    });

    const text = collectText(vnode);
    expect(text).toContain('Install Claude Code, then run `claude /login`.');
    expect(text).not.toContain('@anthropic-ai/claude-code');
    expect(text).toContain('Open setup guide');

    const action = findClickableNodeByText(vnode, 'Open setup guide');
    expect(action).toBeTruthy();

    (action.props.onClick ?? action.props.onclick)();

    expect(send).toHaveBeenCalledWith({ kind: 'show-setup-guide' });
  });

  it('offers setup guidance for unauthenticated Codex status', () => {
    mockedUseState.mockReturnValueOnce(['codex', vi.fn()]);
    const send = vi.fn();

    const vnode = HealthStrip({
      status: {
        claude: 'ready',
        codex: 'unauthenticated',
        gemini: 'ready',
      },
      send,
      gambitMdPresent: false,
    });

    const action = findClickableNodeByText(vnode, 'Open setup guide');
    expect(action).toBeTruthy();

    (action.props.onClick ?? action.props.onclick)();

    expect(send).toHaveBeenCalledWith({ kind: 'show-setup-guide' });
  });

  it('shows filesystem guidance for inaccessible agent status', () => {
    mockedUseState.mockReturnValueOnce(['codex', vi.fn()]);

    const send = vi.fn();
    const vnode = HealthStrip({
      status: {
        claude: 'ready',
        codex: 'inaccessible',
        gemini: 'ready',
      },
      send,
      gambitMdPresent: false,
    });

    expect(collectText(vnode)).toContain('Check filesystem permissions, rerun outside the current sandbox, or set `GAMBIT_CODEX_CLI_PATH` / `gambit.codexCliPath` to a JS bundle, native executable, or npm shim.');
    expect(collectText(vnode)).toContain('Run Gambit: Show live validation guide before paid prompts.');
    expect(collectText(vnode)).toContain('Configure CLI paths');
    expect(collectText(vnode)).toContain('Open live validation guide');

    const configureAction = findClickableNodeByText(vnode, 'Configure CLI paths');
    expect(configureAction).toBeTruthy();
    (configureAction.props.onClick ?? configureAction.props.onclick)();
    expect(send).toHaveBeenCalledWith({ kind: 'configure-cli-paths' });

    const action = findClickableNodeByText(vnode, 'Open live validation guide');
    expect(action).toBeTruthy();
    (action.props.onClick ?? action.props.onclick)();
    expect(send).toHaveBeenCalledWith({ kind: 'show-live-validation-guide' });
  });

  it('shows Gemini override guidance for inaccessible agent status', () => {
    mockedUseState.mockReturnValueOnce(['gemini', vi.fn()]);

    const vnode = HealthStrip({
      status: {
        claude: 'ready',
        codex: 'ready',
        gemini: 'inaccessible',
      },
      send: vi.fn(),
      gambitMdPresent: false,
    });

    expect(collectText(vnode)).toContain('Check filesystem permissions, rerun outside the current sandbox, or set `GAMBIT_GEMINI_CLI_PATH` / `gambit.geminiCliPath` to a JS bundle, native executable, or npm shim.');
    expect(collectText(vnode)).toContain('Run Gambit: Show live validation guide before paid prompts.');
  });

  it('offers CLI path configuration for misconfigured Codex status', () => {
    mockedUseState.mockReturnValueOnce(['codex', vi.fn()]);
    const send = vi.fn();

    const vnode = HealthStrip({
      status: {
        claude: 'ready',
        codex: 'misconfigured',
        gemini: 'ready',
      },
      send,
      gambitMdPresent: false,
    });

    const action = findClickableNodeByText(vnode, 'Configure CLI paths');
    expect(action).toBeTruthy();

    (action.props.onClick ?? action.props.onclick)();

    expect(send).toHaveBeenCalledWith({ kind: 'configure-cli-paths' });

    const setupAction = findClickableNodeByText(vnode, 'Open setup guide');
    expect(setupAction).toBeTruthy();

    (setupAction.props.onClick ?? setupAction.props.onclick)();

    expect(send).toHaveBeenCalledWith({ kind: 'show-setup-guide' });
  });

  it('shows Node setup guidance when a JS-bundle backend cannot launch without Node', () => {
    mockedUseState.mockReturnValueOnce(['codex', vi.fn()]);

    const vnode = HealthStrip({
      status: {
        claude: 'ready',
        codex: 'node-missing',
        gemini: 'ready',
      },
      send: vi.fn(),
      gambitMdPresent: false,
    });

    expect(collectText(vnode)).toContain('Install Node.js on PATH, or set `GAMBIT_CODEX_CLI_PATH` / `gambit.codexCliPath` to a native codex executable.');
    expect(collectText(vnode)).toContain('Configure CLI paths');
  });
});

function collectText(vnode: any): string {
  if (vnode === null || vnode === undefined || typeof vnode === 'boolean') return '';
  if (typeof vnode === 'string' || typeof vnode === 'number') return String(vnode);
  if (Array.isArray(vnode)) return vnode.map(collectText).join('');
  return collectText(vnode.props?.children);
}

function findTitle(vnode: any, prefix: string): string | undefined {
  if (vnode === null || vnode === undefined || typeof vnode !== 'object') return undefined;
  if (typeof vnode.props?.title === 'string' && vnode.props.title.startsWith(prefix)) {
    return vnode.props.title;
  }
  const children = vnode.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const title = findTitle(child, prefix);
      if (title) return title;
    }
  }
  return findTitle(children, prefix);
}

function findClickableNodeByText(vnode: any, text: string): any | undefined {
  if (vnode === null || vnode === undefined || typeof vnode !== 'object') return undefined;
  if (Array.isArray(vnode)) {
    for (const child of vnode) {
      const found = findClickableNodeByText(child, text);
      if (found) return found;
    }
    return undefined;
  }
  const click = vnode.props?.onClick ?? vnode.props?.onclick;
  if (typeof click === 'function' && collectText(vnode).trim() === text) return vnode;
  const children = vnode.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findClickableNodeByText(child, text);
      if (found) return found;
    }
  }
  return findClickableNodeByText(children, text);
}
