import { describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { SystemNotice } from '../src/webview/components/SystemNotice.js';
import type { SystemMessage } from '../src/shared/protocol.js';

vi.stubGlobal('React', { createElement: h });

describe('SystemNotice', () => {
  it('opens edited workspace files from file-edited notices', () => {
    const send = vi.fn();
    const message: SystemMessage = {
      id: 's1',
      role: 'system',
      kind: 'file-edited',
      text: 'Codex edited src/parser.ts',
      timestamp: 100,
      agentId: 'codex',
      filePath: 'src/parser.ts',
    };

    const vnode = SystemNotice({ message, send });
    const children = Array.isArray(vnode.props.children)
      ? vnode.props.children
      : [vnode.props.children];
    const button = children.find((child: any) => child?.type === 'button') as any;

    expect(button).toBeDefined();
    expect(button.props.children).toBe('src/parser.ts');

    button.props.onClick();

    expect(send).toHaveBeenCalledWith({
      kind: 'open-workspace-file',
      relativePath: 'src/parser.ts',
    });
  });

  it('labels deleted workspace files from file-edited notices', () => {
    const message: SystemMessage = {
      id: 's5',
      role: 'system',
      kind: 'file-edited',
      text: 'Claude deleted src/removed.ts',
      timestamp: 100,
      agentId: 'claude',
      filePath: 'src/removed.ts',
      changeKind: 'deleted',
    };

    const text = flattenText(SystemNotice({ message }));

    expect(text).toContain('Claude deleted');
    expect(text).toContain('src/removed.ts');
    expect(text).not.toContain('Claude edited');
  });

  it('opens conflicted workspace files from edit-conflict notices', () => {
    const send = vi.fn();
    const message: SystemMessage = {
      id: 's2',
      role: 'system',
      kind: 'edit-conflict',
      text: 'Codex edited src/shared.ts, which was already edited by Claude in this session.',
      timestamp: 100,
      agentId: 'codex',
      filePath: 'src/shared.ts',
    };

    const vnode = SystemNotice({ message, send });
    const button = findButtons(vnode)[0];

    expect(button).toBeDefined();
    expect(button.props.children).toBe('src/shared.ts');

    button.props.onClick();

    expect(send).toHaveBeenCalledWith({
      kind: 'open-workspace-file',
      relativePath: 'src/shared.ts',
    });
  });

  it('opens workspace files from file-scoped error notices', () => {
    const send = vi.fn();
    const message: SystemMessage = {
      id: 's4',
      role: 'system',
      kind: 'error',
      text: 'Read-only workflow violation: Claude edited src/review.ts during a read-only dispatch.',
      timestamp: 100,
      agentId: 'claude',
      filePath: 'src/review.ts',
    };

    const vnode = SystemNotice({ message, send });
    const button = findButtons(vnode)[0];

    expect(button).toBeDefined();
    expect(button.props.children).toBe('src/review.ts');

    button.props.onClick();

    expect(send).toHaveBeenCalledWith({
      kind: 'open-workspace-file',
      relativePath: 'src/review.ts',
    });
  });

  it('opens the live validation guide from routing-needed notices that mention it', () => {
    const send = vi.fn();
    const message: SystemMessage = {
      id: 's6',
      role: 'system',
      kind: 'routing-needed',
      text: 'Codex files are inaccessible. You can also run Veyra: Show setup guide or Veyra: Show live validation guide.',
      timestamp: 100,
    };

    const vnode = SystemNotice({ message, send });
    const button = findButtons(vnode).find((candidate) => flattenText(candidate).trim() === 'Open live validation guide');

    expect(flattenText(vnode)).toContain('Veyra: Show live validation guide');
    expect(button).toBeDefined();

    button!.props.onClick();

    expect(send).toHaveBeenCalledWith({ kind: 'show-live-validation-guide' });
  });

  it('opens the setup guide from routing-needed notices that mention it', () => {
    const send = vi.fn();
    const message: SystemMessage = {
      id: 's8',
      role: 'system',
      kind: 'routing-needed',
      text: 'Codex is not installed. Run Veyra: Show setup guide, then retry.',
      timestamp: 100,
    };

    const vnode = SystemNotice({ message, send });
    const button = findButtons(vnode).find((candidate) => flattenText(candidate).trim() === 'Open setup guide');

    expect(flattenText(vnode)).toContain('Veyra: Show setup guide');
    expect(button).toBeDefined();

    button!.props.onClick();

    expect(send).toHaveBeenCalledWith({ kind: 'show-setup-guide' });
  });

  it('opens CLI path configuration from routing-needed notices that mention it', () => {
    const send = vi.fn();
    const message: SystemMessage = {
      id: 's7',
      role: 'system',
      kind: 'routing-needed',
      text: 'Codex files are inaccessible. Run Veyra: Configure Codex/Gemini CLI paths, then retry.',
      timestamp: 100,
    };

    const vnode = SystemNotice({ message, send });
    const button = findButtons(vnode).find((candidate) => flattenText(candidate).trim() === 'Configure CLI paths');

    expect(flattenText(vnode)).toContain('Veyra: Configure Codex/Gemini CLI paths');
    expect(button).toBeDefined();

    button!.props.onClick();

    expect(send).toHaveBeenCalledWith({ kind: 'configure-cli-paths' });
  });

  it('labels Codex facilitator routing decisions consistently', () => {
    const message: SystemMessage = {
      id: 's3',
      role: 'system',
      kind: 'facilitator-decision',
      text: '',
      timestamp: 100,
      agentId: 'codex',
      reason: 'implementation request',
    };

    const text = flattenText(SystemNotice({ message }));

    expect(text).toContain('Codex');
    expect(text).not.toContain('ChatGPT');
  });
});

function findButtons(vnode: any): any[] {
  if (!vnode) return [];
  if (Array.isArray(vnode)) return vnode.flatMap(findButtons);
  const own = vnode.type === 'button' ? [vnode] : [];
  return own.concat(findButtons(vnode.props?.children));
}

function flattenText(vnode: any): string {
  if (vnode === null || vnode === undefined || typeof vnode === 'boolean') return '';
  if (typeof vnode === 'string' || typeof vnode === 'number') return String(vnode);
  if (Array.isArray(vnode)) return vnode.map(flattenText).join('');
  return flattenText(vnode.props?.children);
}
