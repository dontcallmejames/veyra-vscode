import { describe, it, expect } from 'vitest';
import { composePrompt } from '../src/composePrompt.js';

describe('composePrompt', () => {
  it('returns just user text when all other inputs empty', () => {
    expect(composePrompt({ rules: '', sharedContext: '', fileBlocks: '', userText: 'hello' }))
      .toBe('hello');
  });

  it('orders blocks: rules → context → files → user text', () => {
    const out = composePrompt({
      rules: 'use pnpm',
      sharedContext: '[Conversation so far]\nuser: hi\n[/Conversation so far]',
      fileBlocks: '[File: a.ts]\nx\n[/File]',
      userText: 'review',
    });

    const idxRules = out.indexOf('use pnpm');
    const idxCtx = out.indexOf('[Conversation so far]');
    const idxFile = out.indexOf('[File: a.ts]');
    const idxUser = out.indexOf('review');

    expect(idxRules).toBeGreaterThan(-1);
    expect(idxCtx).toBeGreaterThan(idxRules);
    expect(idxFile).toBeGreaterThan(idxCtx);
    expect(idxUser).toBeGreaterThan(idxFile);
  });

  it('wraps rules in [Workspace rules] markers', () => {
    const out = composePrompt({ rules: 'always pnpm', sharedContext: '', fileBlocks: '', userText: 'x' });
    expect(out).toContain('[Workspace rules from agentchat.md]');
    expect(out).toContain('always pnpm');
    expect(out).toContain('[/Workspace rules]');
  });

  it('omits rules block when rules empty', () => {
    const out = composePrompt({ rules: '', sharedContext: '[Conversation so far]\nx\n[/Conversation so far]', fileBlocks: '', userText: 'hi' });
    expect(out).not.toContain('[Workspace rules');
  });

  it('omits context block when shared context empty', () => {
    const out = composePrompt({ rules: 'r', sharedContext: '', fileBlocks: '', userText: 'hi' });
    expect(out).not.toContain('[Conversation so far');
  });

  it('omits file block when fileBlocks empty', () => {
    const out = composePrompt({ rules: '', sharedContext: '', fileBlocks: '', userText: 'hi' });
    expect(out).not.toContain('[File:');
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
