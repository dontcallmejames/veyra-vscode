import { describe, it, expect } from 'vitest';
import { DEFAULT_AUTONOMY_POLICY, composePrompt } from '../src/composePrompt.js';

describe('composePrompt', () => {
  it('returns just user text when all other inputs empty', () => {
    expect(composePrompt({ rules: '', sharedContext: '', fileBlocks: '', userText: 'hello' }))
      .toBe('hello');
  });

  it('orders blocks: rules -> autonomy -> context -> edit awareness -> workspace context -> files -> user text', () => {
    const out = composePrompt({
      rules: 'use pnpm',
      autonomyPolicy: '[Autonomy policy]\nproceed without confirmation\n[/Autonomy policy]',
      sharedContext: '[Conversation so far]\nuser: hi\n[/Conversation so far]',
      editAwareness: '[Edit coordination]\n- src/a.ts (claude)\n[/Edit coordination]',
      workspaceContext: '[Workspace context from @codebase]\nSelected files:\n- src/auth.ts\n[/Workspace context]',
      fileBlocks: '[File: a.ts]\nx\n[/File]',
      userText: 'review',
    });

    const idxRules = out.indexOf('use pnpm');
    const idxAutonomy = out.indexOf('[Autonomy policy]');
    const idxCtx = out.indexOf('[Conversation so far]');
    const idxEditAwareness = out.indexOf('[Edit coordination]');
    const idxWorkspaceContext = out.indexOf('[Workspace context from @codebase]');
    const idxFile = out.indexOf('[File: a.ts]');
    const idxUser = out.indexOf('review');

    expect(idxRules).toBeGreaterThan(-1);
    expect(idxAutonomy).toBeGreaterThan(idxRules);
    expect(idxCtx).toBeGreaterThan(idxAutonomy);
    expect(idxEditAwareness).toBeGreaterThan(idxCtx);
    expect(idxWorkspaceContext).toBeGreaterThan(idxEditAwareness);
    expect(idxFile).toBeGreaterThan(idxWorkspaceContext);
    expect(idxUser).toBeGreaterThan(idxFile);
  });

  it('wraps rules in [Workspace rules] markers', () => {
    const out = composePrompt({ rules: 'always pnpm', sharedContext: '', fileBlocks: '', userText: 'x' });
    expect(out).toContain('[Workspace rules from veyra.md]');
    expect(out).toContain('always pnpm');
    expect(out).toContain('[/Workspace rules]');
  });

  it('includes an autonomy policy block when provided', () => {
    const out = composePrompt({
      rules: '',
      autonomyPolicy: '[Autonomy policy]\nUse reasonable assumptions.\n[/Autonomy policy]',
      sharedContext: '',
      fileBlocks: '',
      userText: 'ship it',
    });

    expect(out).toContain('[Autonomy policy]');
    expect(out).toContain('Use reasonable assumptions.');
    expect(out).toContain('[/Autonomy policy]');
    expect(out.trimEnd().endsWith('ship it')).toBe(true);
  });

  it('prevents broad actionable requests from becoming approval checkpoints', () => {
    expect(DEFAULT_AUTONOMY_POLICY).toContain('Do not turn broad actionable requests into brainstorming or approval checkpoints.');
  });

  it('omits rules block when rules empty', () => {
    const out = composePrompt({ rules: '', sharedContext: '[Conversation so far]\nx\n[/Conversation so far]', fileBlocks: '', userText: 'hi' });
    expect(out).not.toContain('[Workspace rules');
  });

  it('omits context block when shared context empty', () => {
    const out = composePrompt({ rules: 'r', sharedContext: '', fileBlocks: '', userText: 'hi' });
    expect(out).not.toContain('[Conversation so far');
  });

  it('omits edit coordination block when edit awareness empty', () => {
    const out = composePrompt({ rules: 'r', sharedContext: '', editAwareness: '', fileBlocks: '', userText: 'hi' });
    expect(out).not.toContain('[Edit coordination]');
  });

  it('omits workspace context when empty', () => {
    const out = composePrompt({
      rules: '',
      sharedContext: '',
      editAwareness: '',
      workspaceContext: '',
      fileBlocks: '',
      userText: 'hi',
    });
    expect(out).not.toContain('[Workspace context from @codebase]');
  });

  it('omits file block when fileBlocks empty', () => {
    const out = composePrompt({ rules: '', sharedContext: '', fileBlocks: '', userText: 'hi' });
    expect(out).not.toContain('[File:');
  });

  it('includes file attachment errors before the user text', () => {
    const out = composePrompt({
      rules: '',
      sharedContext: '',
      fileBlocks: '',
      attachmentErrors: [{ path: 'missing.ts', reason: 'File not found' }],
      userText: 'review this',
    });

    expect(out).toContain('[File attachment problems]');
    expect(out).toContain('- missing.ts: File not found');
    expect(out).toContain('[/File attachment problems]');
    expect(out.indexOf('[File attachment problems]')).toBeLessThan(out.indexOf('review this'));
  });

  it('separates each present block with a blank line', () => {
    const out = composePrompt({
      rules: 'r',
      sharedContext: '[Conversation so far]\nx\n[/Conversation so far]',
      fileBlocks: '[File: a]\ny\n[/File]',
      userText: 'go',
    });
    expect(out.split('\n\n').length).toBeGreaterThanOrEqual(4);
  });
});
