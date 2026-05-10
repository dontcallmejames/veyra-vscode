import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { guardLiveModelPrompts } from './liveReadinessGuard.js';
import { ClaudeAgent } from '../../src/agents/claude.js';
import { CodexAgent } from '../../src/agents/codex.js';
import { GeminiAgent } from '../../src/agents/gemini.js';
import { VeyraSessionService } from '../../src/veyraService.js';
import { createWorkspaceChangeTracker } from '../../src/workspaceChanges.js';
import type { VeyraDispatchEvent } from '../../src/veyraService.js';

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({ get: (_k: string, dflt: unknown) => dflt })),
  },
}));

const describeLive = process.env.VEYRA_RUN_LIVE === '1' ? describe : describe.skip;
const CLAUDE_CONTEXT_MARKER = 'CLAUDE_CONTEXT_MARKER';
const CODEX_CONTEXT_MARKER = 'CODEX_CONTEXT_MARKER';
const GEMINI_CONTEXT_MARKER = 'GEMINI_CONTEXT_MARKER';
const VEYRA_LIVE_IMPLEMENT_MARKER = 'VEYRA_LIVE_IMPLEMENT_MARKER';

describeLive('Veyra all-agent handoff - LIVE', () => {
  guardLiveModelPrompts();

  it('dispatches one prompt through Claude, Codex, and Gemini with shared context relay', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'veyra-live-handoff-'));
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: new ClaudeAgent(),
        codex: new CodexAgent(),
        gemini: new GeminiAgent(),
      },
      {
        commitSignatureEnabled: false,
        hangSeconds: 0,
        workspaceChangeTracker: createWorkspaceChangeTracker(workspacePath),
      },
    );

    const events: VeyraDispatchEvent[] = [];
    await service.dispatch(
      {
        text: [
          '@all Context-relay validation. Do not inspect, create, or edit files. Follow only the instruction addressed to your Veyra agent role.',
          `Claude: reply with one line starting ${CLAUDE_CONTEXT_MARKER}: followed by two simple words you choose.`,
          `Codex: if the conversation so far contains a line starting ${CLAUDE_CONTEXT_MARKER}:, copy that full line exactly, then add one line starting ${CODEX_CONTEXT_MARKER}: followed by two simple words you choose.`,
          `Gemini: if the conversation so far contains lines starting ${CLAUDE_CONTEXT_MARKER}: and ${CODEX_CONTEXT_MARKER}:, copy both full lines exactly, then add one line starting ${GEMINI_CONTEXT_MARKER}: ok.`,
        ].join('\n'),
        source: 'panel',
        cwd: workspacePath,
        readOnly: true,
      },
      (event) => {
        events.push(event);
      },
    );
    await service.flush();

    expect(events.filter((event) => event.kind === 'dispatch-start').map((event) => event.agentId))
      .toEqual(['claude', 'codex', 'gemini']);

    const completed = events.filter((event) => event.kind === 'dispatch-end');
    expect(completed.map((event) => event.agentId)).toEqual(['claude', 'codex', 'gemini']);
    expect(completed.map((event) => event.message.status)).toEqual(['complete', 'complete', 'complete']);

    for (const event of completed) {
      expect(event.message.text.trim().length).toBeGreaterThan(0);
    }

    const claudeText = textForAgent(completed, 'claude');
    const codexText = textForAgent(completed, 'codex');
    const geminiText = textForAgent(completed, 'gemini');
    const claudeMarkerLine = extractMarkerLine(claudeText, CLAUDE_CONTEXT_MARKER);
    const codexMarkerLine = extractMarkerLine(codexText, CODEX_CONTEXT_MARKER);
    extractMarkerLine(geminiText, GEMINI_CONTEXT_MARKER);
    expect(codexText).toContain(claudeMarkerLine);
    expect(geminiText).toContain(claudeMarkerLine);
    expect(geminiText).toContain(codexMarkerLine);

    const errors = events.flatMap((event) => {
      if (event.kind === 'chunk' && event.chunk.type === 'error') {
        return [`${event.agentId}: ${event.chunk.message}`];
      }
      if (event.kind === 'dispatch-end' && event.message.status === 'errored') {
        return [`${event.agentId}: ${event.message.error ?? 'errored'}`];
      }
      return [];
    });
    expect(errors).toEqual([]);
    expect(events.filter((event) => event.kind === 'file-edited')).toEqual([]);
  }, 180_000);

  it('runs a write-capable implementation workflow in a disposable workspace', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'veyra-live-implement-'));
    const targetFile = 'veyra-live-implementation.txt';
    const service = new VeyraSessionService(
      workspacePath,
      {
        claude: new ClaudeAgent(),
        codex: new CodexAgent(),
        gemini: new GeminiAgent(),
      },
      {
        commitSignatureEnabled: false,
        hangSeconds: 0,
        workspaceChangeTracker: createWorkspaceChangeTracker(workspacePath),
      },
    );

    const events: VeyraDispatchEvent[] = [];
    await service.dispatch(
      {
        text: [
          '@all Write-capable implementation validation in this disposable workspace.',
          `Create or update ${targetFile} so it contains a line with exactly this marker: ${VEYRA_LIVE_IMPLEMENT_MARKER}: ok`,
          `Only edit ${targetFile}. Do not inspect or change unrelated files.`,
          'Later agents should preserve the marker if an earlier agent already wrote it.',
        ].join('\n'),
        source: 'panel',
        cwd: workspacePath,
        readOnly: false,
      },
      (event) => {
        events.push(event);
      },
    );
    await service.flush();

    const completed = events.filter((event) => event.kind === 'dispatch-end');
    expect(completed.map((event) => event.agentId)).toEqual(['claude', 'codex', 'gemini']);
    expect(completed.map((event) => event.message.status)).toEqual(['complete', 'complete', 'complete']);

    const fileEditedEvents = events.filter((event) =>
      event.kind === 'file-edited' &&
      event.path === targetFile,
    );
    expect(fileEditedEvents.length).toBeGreaterThan(0);

    const finalContents = await fs.readFile(path.join(workspacePath, targetFile), 'utf8');
    expect(finalContents).toContain(VEYRA_LIVE_IMPLEMENT_MARKER);

    const unexpectedFileEvents = events.filter((event) =>
      event.kind === 'file-edited' &&
      event.path !== targetFile,
    );
    expect(unexpectedFileEvents).toEqual([]);
  }, 240_000);
});

function textForAgent(
  completed: Array<Extract<VeyraDispatchEvent, { kind: 'dispatch-end' }>>,
  agentId: 'claude' | 'codex' | 'gemini',
): string {
  const event = completed.find((item) => item.agentId === agentId);
  expect(event, `Expected ${agentId} to complete`).toBeDefined();
  return event?.message.text ?? '';
}

function extractMarkerLine(text: string, marker: string): string {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`${escaped}:\\s*[^\\r\\n]+`));
  expect(match?.[0], `Expected ${marker} marker in ${text}`).toBeDefined();
  return match?.[0] ?? '';
}
