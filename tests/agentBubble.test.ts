import { describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import * as AgentBubbleModule from '../src/webview/components/AgentBubble.js';

vi.stubGlobal('React', { createElement: h });

describe('AgentBubble edited files', () => {
  it('renders edited files as clickable workspace-file chips', () => {
    const send = vi.fn();

    expect(typeof AgentBubbleModule.EditedFilesRow).toBe('function');
    const vnode = AgentBubbleModule.EditedFilesRow({
      editedFiles: ['src/parser.ts', 'README.md'],
      send,
    });

    const buttons = findButtons(vnode);

    expect(buttons.map((button) => button.props.children)).toEqual(['src/parser.ts', 'README.md']);

    buttons[0].props.onClick();

    expect(send).toHaveBeenCalledWith({
      kind: 'open-workspace-file',
      relativePath: 'src/parser.ts',
    });
  });
});

function findButtons(vnode: any): any[] {
  if (!vnode) return [];
  if (Array.isArray(vnode)) return vnode.flatMap(findButtons);
  const own = vnode.type === 'button' ? [vnode] : [];
  return own.concat(findButtons(vnode.props?.children));
}
