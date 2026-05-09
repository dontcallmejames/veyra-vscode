import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSharedContext } from '../../src/sharedContext.js';
import { readWorkspaceRules } from '../../src/workspaceRules.js';
import { embedFiles, parseFileMentions } from '../../src/fileMentions.js';
import { composePrompt } from '../../src/composePrompt.js';
import type { Session } from '../../src/shared/protocol.js';

const fsState = new Map<string, string | Buffer>();

vi.mock('node:fs', () => ({
  existsSync: (p: string) => fsState.has(String(p).replace(/\\/g, '/')),
  readFileSync: (p: string, _enc?: string) => {
    const k = String(p).replace(/\\/g, '/');
    const v = fsState.get(k);
    if (v === undefined) throw new Error('ENOENT');
    return v;
  },
  statSync: (p: string) => {
    const k = String(p).replace(/\\/g, '/');
    const v = fsState.get(k);
    if (v === undefined) throw new Error('ENOENT');
    return { size: typeof v === 'string' ? Buffer.byteLength(v, 'utf8') : v.length };
  },
}));

beforeEach(() => {
  fsState.clear();
});

describe('integration: full prompt composition', () => {
  it('produces the expected prompt for rules + 3-turn history + @file mention', () => {
    fsState.set('/fake/ws/gambit.md', 'Always use pnpm.\n');
    fsState.set('/fake/ws/src/auth.ts', 'export const greet = () => "hi";\n');

    const session: Session = {
      version: 1,
      messages: [
        { id: 'u1', role: 'user', text: 'How do we handle auth?', timestamp: 100 },
        {
          id: 'a1', role: 'agent', agentId: 'claude', text: 'Use OAuth2 with PKCE.',
          toolEvents: [], timestamp: 200, status: 'complete',
        },
        { id: 'u2', role: 'user', text: '@codex implement the route handlers', timestamp: 300 },
      ],
    };

    const userInput = '@codex review @src/auth.ts please';
    const { filePaths, remainingText } = parseFileMentions(userInput);
    const embed = embedFiles(filePaths, '/fake/ws', { maxLines: 500 });
    const sharedCtx = buildSharedContext(session, { window: 25 });
    const rules = readWorkspaceRules('/fake/ws');

    const prompt = composePrompt({
      rules,
      sharedContext: sharedCtx,
      fileBlocks: embed.embedded,
      userText: remainingText,
    });

    // Snapshot match — vitest will create the snapshot on first run.
    // Verify it contains the expected blocks in order:
    expect(prompt).toContain('[Workspace rules from gambit.md]');
    expect(prompt).toContain('Always use pnpm.');
    expect(prompt).toContain('[/Workspace rules]');
    expect(prompt).toContain('[Conversation so far]');
    expect(prompt).toContain('user: How do we handle auth?');
    expect(prompt).toContain('claude: Use OAuth2 with PKCE.');
    expect(prompt).toContain('user: @codex implement the route handlers');
    expect(prompt).toContain('[/Conversation so far]');
    expect(prompt).toContain('[File: src/auth.ts]');
    expect(prompt).toContain('export const greet = () => "hi";');
    expect(prompt).toContain('[/File]');
    expect(prompt).toContain('@codex review please');

    // Order verification:
    const idxRules = prompt.indexOf('[Workspace rules');
    const idxConv = prompt.indexOf('[Conversation so far');
    const idxFile = prompt.indexOf('[File: src/auth.ts]');
    const idxUser = prompt.indexOf('@codex review please');
    expect(idxRules).toBeLessThan(idxConv);
    expect(idxConv).toBeLessThan(idxFile);
    expect(idxFile).toBeLessThan(idxUser);

    // Snapshot for regression catch (will be auto-written on first run):
    expect(prompt).toMatchSnapshot();
  });
});
