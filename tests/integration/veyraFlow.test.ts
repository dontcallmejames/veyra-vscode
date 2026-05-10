import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { VeyraSessionService } from '../../src/veyraService.js';
import { createWorkspaceChangeTracker } from '../../src/workspaceChanges.js';
import type { Agent } from '../../src/agents/types.js';
import type { AgentChunk, AgentId } from '../../src/types.js';

describe('Veyra integrated dispatch flow', () => {
  it('surfaces invisible file changes and flags a later cross-agent edit conflict', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'veyra-flow-'));
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: fileWritingAgent('claude', "export const owner = 'claude';\n"),
        codex: fileWritingAgent('codex', "export const owner = 'codex with longer content';\n"),
        gemini: noopAgent('gemini'),
      },
      {
        workspaceChangeTracker: createWorkspaceChangeTracker(workspacePath),
      },
    );

    const events: any[] = [];
    await service.dispatch(
      { text: '@all update src/shared.ts', source: 'panel', cwd: workspacePath },
      (event) => {
        events.push(event);
      },
    );

    const editedEvents = events.filter((event) =>
      event.kind === 'file-edited' &&
      event.path === 'src/shared.ts',
    );
    expect(editedEvents.map((event) => event.agentId)).toEqual(['claude', 'codex']);

    const conflict = events.find((event) =>
      event.kind === 'system-message' &&
      event.message.kind === 'edit-conflict',
    );
    expect(conflict?.message.text).toContain('src/shared.ts');
    expect(conflict?.message.text).toContain('Claude');
    expect(conflict?.message.text).toContain('Codex');

    await expect(fs.readFile(path.join(workspacePath, 'src', 'shared.ts'), 'utf8'))
      .resolves.toContain('codex with longer content');
  });
});

function fileWritingAgent(id: AgentId, contents: string): Agent {
  return {
    id,
    status: async () => 'ready',
    cancel: async () => {},
    async *send(_prompt: string, opts = {}) {
      const cwd = opts.cwd ?? process.cwd();
      const filePath = path.join(cwd, 'src', 'shared.ts');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, contents, 'utf8');
      yield { type: 'text', text: `${id} wrote src/shared.ts` } as AgentChunk;
      yield { type: 'done' } as AgentChunk;
    },
  };
}

function noopAgent(id: AgentId): Agent {
  return {
    id,
    status: async () => 'ready',
    cancel: async () => {},
    async *send() {
      yield { type: 'done' } as AgentChunk;
    },
  };
}
