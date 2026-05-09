import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const claudeSdkMocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_key: string, dflt: unknown) => dflt),
    })),
  },
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: claudeSdkMocks.query,
}));

import { createGambitSessionService, createSmokeAgents, shouldUseSmokeAgents } from '../src/gambitRuntime.js';

function makeSmokeWorkspace(prefix: string): string {
  const smokeRoot = join(process.cwd(), '.vscode-test');
  mkdirSync(smokeRoot, { recursive: true });
  return mkdtempSync(join(smokeRoot, prefix));
}

describe('Gambit runtime smoke agents', () => {
  it('enables smoke agents only for the Extension Host smoke sentinel', () => {
    expect(shouldUseSmokeAgents({ VSCODE_GAMBIT_SMOKE: '1' })).toBe(true);
    expect(shouldUseSmokeAgents({ VSCODE_GAMBIT_SMOKE: 'true' })).toBe(false);
    expect(shouldUseSmokeAgents({})).toBe(false);
  });

  it('creates deterministic ready agents for no-paid Extension Host request smoke tests', async () => {
    const agents = createSmokeAgents();
    const chunks = [];

    for await (const chunk of agents.codex.send('Smoke prompt', { readOnly: true })) {
      chunks.push(chunk);
    }

    expect(await agents.claude.status()).toBe('ready');
    expect(await agents.codex.status()).toBe('ready');
    expect(await agents.gemini.status()).toBe('ready');
    expect(chunks).toEqual([
      {
        type: 'text',
        text: '[smoke:codex] read-only request reached Gambit provider.',
      },
      { type: 'done' },
    ]);
  });

  it('uses a shared smoke edit path for deterministic conflict validation requests', async () => {
    const workspace = makeSmokeWorkspace('gambit-smoke-conflict-');
    const agents = createSmokeAgents();

    try {
      for await (const _chunk of agents.claude.send(
        'Gambit conflict validation request. [gambit-smoke-conflict]',
        { cwd: workspace },
      )) {
        // Drain the smoke agent stream so its deterministic write runs.
      }

      expect(existsSync(join(workspace, 'src', 'gambit-smoke-conflict.ts'))).toBe(true);
      expect(existsSync(join(workspace, 'src', 'gambit-smoke-claude.ts'))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('surfaces shared-context relay markers when later smoke agents see prior replies', async () => {
    const workspace = makeSmokeWorkspace('gambit-smoke-shared-context-');
    const service = createGambitSessionService(workspace, undefined, createSmokeAgents());
    const chunks: string[] = [];

    try {
      await service.dispatch(
        {
          text: '@all Gambit shared context smoke request. [gambit-smoke-shared-context]',
          source: 'language-model',
          cwd: workspace,
          forcedTarget: 'gambit',
        },
        (event) => {
          if (event.kind === 'chunk' && event.chunk.type === 'text') {
            chunks.push(event.chunk.text);
          }
        },
      );
    } finally {
      await service.flush();
      rmSync(workspace, { recursive: true, force: true });
    }

    expect(chunks).toContain('[smoke:codex] saw prior Claude reply in shared context.');
    expect(chunks).toContain('[smoke:gemini] saw prior Claude and Codex replies in shared context.');
  });

  it('does not treat stale shared-context smoke markers as the current validation request', async () => {
    const agents = createSmokeAgents();
    const chunks = [];

    for await (const chunk of agents.codex.send([
      '[Conversation so far]',
      'user: Gambit shared context smoke request. [gambit-smoke-shared-context]',
      'claude: [smoke:claude] write-capable request reached Gambit provider.',
      '[/Conversation so far]',
      'Current direct smoke request without the marker.',
    ].join('\n'))) {
      chunks.push(chunk);
    }

    expect(chunks).not.toContainEqual({
      type: 'text',
      text: '[smoke:codex] saw prior Claude reply in shared context.',
    });
  });

  it('surfaces VS Code request tool and model option context markers in smoke provider prompts', async () => {
    const agents = createSmokeAgents();
    const chunks = [];

    for await (const chunk of agents.codex.send([
      '[VS Code model options]',
      '{"temperature":0.2}',
      '[/VS Code model options]',
      '',
      '[VS Code request tools]',
      'Tool mode: auto',
      '- workspaceSearch: Search indexed workspace symbols.',
      '[/VS Code request tools]',
      '',
      'Gambit tool context smoke request. [gambit-smoke-tool-context]',
    ].join('\n'))) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual({
      type: 'text',
      text: '[smoke:codex] saw VS Code request tool workspaceSearch in provider context.',
    });
    expect(chunks).toContainEqual({
      type: 'text',
      text: '[smoke:codex] saw VS Code model option temperature in provider context.',
    });
  });

  it('routes smoke-mode orchestrator requests without calling the paid facilitator backend', async () => {
    const originalSmoke = process.env.VSCODE_GAMBIT_SMOKE;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.VSCODE_GAMBIT_SMOKE = '1';
    claudeSdkMocks.query.mockClear();
    const tempRoot = join(process.cwd(), '.vscode-test');
    mkdirSync(tempRoot, { recursive: true });
    const workspace = mkdtempSync(join(tempRoot, 'gambit-runtime-smoke-'));
    const service = createGambitSessionService(workspace, undefined, createSmokeAgents());
    const chunks: string[] = [];
    const visibleEdits: string[] = [];
    let smokeEditFileExists = false;

    try {
      await service.dispatch(
        {
          text: 'Gambit Extension Host smoke request for gambit-orchestrator.',
          source: 'language-model',
          cwd: workspace,
          forcedTarget: 'gambit',
        },
        (event) => {
          if (event.kind === 'chunk' && event.chunk.type === 'text') {
            chunks.push(event.chunk.text);
          }
          if (event.kind === 'file-edited') {
            visibleEdits.push(`${event.agentId}:${event.changeKind}:${event.path}`);
          }
        },
      );
      smokeEditFileExists = existsSync(join(workspace, 'src', 'gambit-smoke-codex.ts'));
    } finally {
      await service.flush();
      if (originalSmoke === undefined) {
        delete process.env.VSCODE_GAMBIT_SMOKE;
      } else {
        process.env.VSCODE_GAMBIT_SMOKE = originalSmoke;
      }
      rmSync(workspace, { recursive: true, force: true });
    }

    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(claudeSdkMocks.query).not.toHaveBeenCalled();
    expect(chunks).toContain('[smoke:codex] write-capable request reached Gambit provider.');
    expect(visibleEdits).toContain('codex:created:src/gambit-smoke-codex.ts');
    expect(smokeEditFileExists).toBe(true);
    expect(consoleError).not.toHaveBeenCalledWith('SessionStore write failed:', expect.anything());
    consoleError.mockRestore();
  });
});
