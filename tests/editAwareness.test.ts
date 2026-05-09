import { describe, expect, it } from 'vitest';
import { buildEditAwareness, findPriorEditorsForFile } from '../src/editAwareness.js';
import type { AgentMessage, Session, UserMessage } from '../src/shared/protocol.js';

const session = (...messages: Session['messages']): Session => ({ version: 1, messages });

const user = (text: string): UserMessage => ({
  id: 'u1',
  role: 'user',
  text,
  timestamp: 1,
});

const agent = (
  agentId: AgentMessage['agentId'],
  editedFiles: string[],
  status: AgentMessage['status'] = 'complete',
): AgentMessage => ({
  id: `${agentId}-${status}`,
  role: 'agent',
  agentId,
  text: `${agentId} reply`,
  toolEvents: [],
  editedFiles,
  timestamp: 2,
  status,
});

const agentWithFileChanges = (
  agentId: AgentMessage['agentId'],
  fileChanges: NonNullable<AgentMessage['fileChanges']>,
  status: AgentMessage['status'] = 'complete',
): AgentMessage => ({
  id: `${agentId}-${status}-changes`,
  role: 'agent',
  agentId,
  text: `${agentId} reply`,
  toolEvents: [],
  editedFiles: fileChanges.map((change) => change.path),
  fileChanges,
  timestamp: 2,
  status,
});

describe('buildEditAwareness', () => {
  it('returns empty when no other agent has edited files', () => {
    expect(buildEditAwareness(session(user('hi'), agent('claude', ['src/a.ts'])), 'claude')).toBe('');
  });

  it('lists files edited by other agents and warns before changing them', () => {
    const out = buildEditAwareness(
      session(
        user('ship it'),
        agent('claude', ['src/a.ts']),
        agent('gemini', ['src/b.ts']),
      ),
      'codex',
    );

    expect(out).toContain('[Edit coordination]');
    expect(out).toContain('src/a.ts (claude)');
    expect(out).toContain('src/b.ts (gemini)');
    expect(out).toContain('inspect current contents');
  });

  it('coalesces multiple agents that touched the same file', () => {
    const out = buildEditAwareness(
      session(
        agent('claude', ['src/a.ts']),
        agent('gemini', ['src/a.ts']),
      ),
      'codex',
    );

    expect(out).toContain('src/a.ts (claude, gemini)');
  });

  it('coalesces equivalent relative paths with leading dot segments', () => {
    const out = buildEditAwareness(
      session(
        agent('claude', ['./src/a.ts']),
        agent('gemini', ['src/a.ts']),
      ),
      'codex',
    );

    expect(out).toContain('src/a.ts (claude, gemini)');
    expect(out).not.toContain('./src/a.ts');
  });

  it('includes cancelled turns when they already recorded edits', () => {
    const out = buildEditAwareness(
      session(agent('claude', ['src/a.ts'], 'cancelled')),
      'codex',
    );

    expect(out).toContain('src/a.ts (claude)');
  });

  it('distinguishes deleted files from edited files in coordination prompts', () => {
    const out = buildEditAwareness(
      session(
        agentWithFileChanges('claude', [
          { path: 'src/old.ts', changeKind: 'deleted' },
        ]),
        agentWithFileChanges('gemini', [
          { path: 'src/live.ts', changeKind: 'edited' },
          { path: 'src/new.ts', changeKind: 'created' },
        ]),
      ),
      'codex',
    );

    expect(out).toContain('Files changed by other agents in this session:');
    expect(out).toContain('- src/live.ts edited by gemini');
    expect(out).toContain('- src/new.ts created by gemini');
    expect(out).toContain('- src/old.ts deleted by claude');
    expect(out).toContain('inspect current contents or confirm the file still exists');
    expect(out).not.toContain('src/old.ts (claude)');
  });
});

describe('findPriorEditorsForFile', () => {
  it('matches prior editors across equivalent relative path spellings', () => {
    const editors = findPriorEditorsForFile(
      session(
        agent('claude', ['./src/shared.ts']),
        agent('gemini', ['src/feature/../shared.ts']),
        agent('codex', ['src/shared.ts']),
      ),
      'codex',
      'src/shared.ts',
    );

    expect(editors).toEqual(['claude', 'gemini']);
  });
});
