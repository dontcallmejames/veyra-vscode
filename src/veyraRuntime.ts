import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ClaudeAgent, getEditedPath as getClaudeEditedPath } from './agents/claude.js';
import { CodexAgent, getEditedPath as getCodexEditedPath } from './agents/codex.js';
import { GeminiAgent, getEditedPath as getGeminiEditedPath } from './agents/gemini.js';
import { VeyraSessionService } from './veyraService.js';
import { createWorkspaceChangeTracker } from './workspaceChanges.js';
import { WorkspaceContextProvider, type WorkspaceContextOptions } from './workspaceContext.js';
import type { FacilitatorDecision, FacilitatorFn } from './facilitator.js';
import type { AgentRegistry } from './messageRouter.js';
import type { Agent, SendOptions } from './agents/types.js';
import type { FileBadgesController } from './fileBadges.js';
import type { VeyraSessionOptions } from './veyraService.js';
import type { AgentChunk, AgentId, AgentStatus } from './types.js';

export function createDefaultAgents(): AgentRegistry {
  return {
    claude: new ClaudeAgent(),
    codex: new CodexAgent(),
    gemini: new GeminiAgent(),
  };
}

export function shouldUseSmokeAgents(env: Record<string, string | undefined> = process.env): boolean {
  return env.VSCODE_VEYRA_SMOKE === '1';
}

export function createSmokeAgents(): AgentRegistry {
  return {
    claude: new SmokeAgent('claude'),
    codex: new SmokeAgent('codex'),
    gemini: new SmokeAgent('gemini'),
  };
}

export function getEditedPathForAgent(agentId: AgentId, toolName: string, input: unknown): string | null {
  if (agentId === 'claude') return getClaudeEditedPath(toolName, input);
  if (agentId === 'codex') return getCodexEditedPath(toolName, input);
  if (agentId === 'gemini') return getGeminiEditedPath(toolName, input);
  return null;
}

class SmokeAgent implements Agent {
  constructor(readonly id: AgentId) {}

  async status(): Promise<AgentStatus> {
    return 'ready';
  }

  async *send(prompt: string, opts?: SendOptions): AsyncIterable<AgentChunk> {
    const mode = opts?.readOnly ? 'read-only' : 'write-capable';
    yield {
      type: 'text',
      text: `[smoke:${this.id}] ${mode} request reached Veyra provider.`,
    };
    const relayMarker = smokeSharedContextRelayMarker(this.id, prompt);
    if (relayMarker) {
      yield {
        type: 'text',
        text: relayMarker,
      };
    }
    const toolContextMarker = smokeToolContextMarker(this.id, prompt);
    if (toolContextMarker) {
      yield {
        type: 'text',
        text: toolContextMarker,
      };
    }
    const modelOptionsContextMarker = smokeModelOptionsContextMarker(this.id, prompt);
    if (modelOptionsContextMarker) {
      yield {
        type: 'text',
        text: modelOptionsContextMarker,
      };
    }
    const codebaseContextMarker = smokeCodebaseContextMarker(this.id, prompt);
    if (codebaseContextMarker) {
      yield {
        type: 'text',
        text: codebaseContextMarker,
      };
    }
    if (!opts?.readOnly) {
      const editedPath = smokeEditFileForPrompt(this.id, prompt);
      if (opts?.cwd) {
        writeSmokeEditFile(opts.cwd, this.id, editedPath);
      }
      const activity = smokeWriteToolActivity(this.id, editedPath);
      yield { type: 'tool-call', name: activity.name, input: activity.input };
      yield { type: 'tool-result', name: activity.name, output: activity.output };
    }
    yield { type: 'done' };
  }

  async cancel(): Promise<void> {
    // Smoke agents do not hold external processes.
  }
}

const SMOKE_EDIT_FILES: Record<AgentId, string> = {
  claude: 'src/veyra-smoke-claude.ts',
  codex: 'src/veyra-smoke-codex.ts',
  gemini: 'src/veyra-smoke-gemini.ts',
};
const SMOKE_CONFLICT_MARKER = '[veyra-smoke-conflict]';
const SMOKE_CONFLICT_EDIT_FILE = 'src/veyra-smoke-conflict.ts';
const SMOKE_SHARED_CONTEXT_MARKER = '[veyra-smoke-shared-context]';
const SMOKE_TOOL_CONTEXT_MARKER = '[veyra-smoke-tool-context]';
const SMOKE_CODEBASE_MARKER = '[veyra-smoke-codebase]';
const SMOKE_CLAUDE_WRITE_MARKER = '[smoke:claude] write-capable request reached Veyra provider.';
const SMOKE_CODEX_WRITE_MARKER = '[smoke:codex] write-capable request reached Veyra provider.';

function smokeEditFileForPrompt(agentId: AgentId, prompt: string): string {
  return prompt.trimEnd().endsWith(SMOKE_CONFLICT_MARKER)
    ? SMOKE_CONFLICT_EDIT_FILE
    : SMOKE_EDIT_FILES[agentId];
}

function smokeSharedContextRelayMarker(agentId: AgentId, prompt: string): string | null {
  if (!prompt.trimEnd().endsWith(SMOKE_SHARED_CONTEXT_MARKER)) return null;
  if (agentId === 'codex' && prompt.includes(SMOKE_CLAUDE_WRITE_MARKER)) {
    return '[smoke:codex] saw prior Claude reply in shared context.';
  }
  if (
    agentId === 'gemini' &&
    prompt.includes(SMOKE_CLAUDE_WRITE_MARKER) &&
    prompt.includes(SMOKE_CODEX_WRITE_MARKER)
  ) {
    return '[smoke:gemini] saw prior Claude and Codex replies in shared context.';
  }
  return null;
}

function smokeToolContextMarker(agentId: AgentId, prompt: string): string | null {
  if (!prompt.trimEnd().endsWith(SMOKE_TOOL_CONTEXT_MARKER)) return null;
  if (
    agentId === 'codex' &&
    prompt.includes('[VS Code request tools]') &&
    prompt.includes('workspaceSearch')
  ) {
    return '[smoke:codex] saw VS Code request tool workspaceSearch in provider context.';
  }
  return null;
}

function smokeModelOptionsContextMarker(agentId: AgentId, prompt: string): string | null {
  if (!prompt.trimEnd().endsWith(SMOKE_TOOL_CONTEXT_MARKER)) return null;
  if (
    agentId === 'codex' &&
    prompt.includes('[VS Code model options]') &&
    prompt.includes('"temperature":0.2')
  ) {
    return '[smoke:codex] saw VS Code model option temperature in provider context.';
  }
  return null;
}

function smokeCodebaseContextMarker(agentId: AgentId, prompt: string): string | null {
  if (!prompt.trimEnd().endsWith(SMOKE_CODEBASE_MARKER)) return null;
  if (agentId === 'codex' && prompt.includes('[Workspace context from @codebase]')) {
    return '[smoke:codex] saw @codebase workspace context.';
  }
  return null;
}

function writeSmokeEditFile(workspacePath: string, agentId: AgentId, relativePath: string): void {
  const absolutePath = path.join(workspacePath, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(
    absolutePath,
    [
      `export const veyraSmokeAgent = '${agentId}';`,
      `export const veyraSmokeTouchedAt = ${Date.now()};`,
      '',
    ].join('\n'),
    'utf8',
  );
}

function smokeWriteToolActivity(
  agentId: AgentId,
  filePath: string,
): { name: string; input: Record<string, string>; output: Record<string, string> } {
  if (agentId === 'claude') {
    return {
      name: 'Write',
      input: { file_path: filePath },
      output: { kind: 'created', file_path: filePath },
    };
  }
  if (agentId === 'codex') {
    return {
      name: 'apply_patch',
      input: { path: filePath },
      output: { kind: 'created', path: filePath },
    };
  }
  return {
    name: 'write_file',
    input: { file_path: filePath },
    output: { kind: 'created', file_path: filePath },
  };
}

const smokeFacilitator: FacilitatorFn = async (
  _userMessage,
  availability,
): Promise<FacilitatorDecision> => {
  if (availability.codex === 'ready') {
    return { agent: 'codex', reason: 'smoke: deterministic route' };
  }
  for (const agentId of ['claude', 'gemini'] as AgentId[]) {
    if (availability[agentId] === 'ready') {
      return { agent: agentId, reason: 'smoke: available route' };
    }
  }
  return { error: 'Smoke routing unavailable; no ready agents.' };
};

export function readVeyraSessionOptions(
  badgeController?: FileBadgesController,
): VeyraSessionOptions {
  const config = vscode.workspace.getConfiguration('veyra');
  return {
    watchdogMs: config.get<number>('watchdogMinutes', 5) * 60_000,
    hangSeconds: config.get<number>('hangDetectionSeconds', 60),
    fileEmbedMaxLines: config.get<number>('fileEmbedMaxLines', 500),
    sharedContextWindow: config.get<number>('sharedContextWindow', 25),
    commitSignatureEnabled: config.get<boolean>('commitSignature.enabled', true),
    badgeController,
    getEditedPathForAgent,
  };
}

export function readWorkspaceContextOptions(): WorkspaceContextOptions {
  const config = vscode.workspace.getConfiguration('veyra');
  return {
    maxFiles: config.get<number>('workspaceContext.maxFiles', 8),
    maxSnippetLines: config.get<number>('workspaceContext.maxSnippetLines', 80),
    maxFileBytes: config.get<number>('workspaceContext.maxFileBytes', 1_000_000),
  };
}

export function createVeyraSessionService(
  workspacePath: string,
  badgeController?: FileBadgesController,
  agents: AgentRegistry = createDefaultAgents(),
): VeyraSessionService {
  return new VeyraSessionService(
    workspacePath,
    agents,
    {
      ...readVeyraSessionOptions(badgeController),
      facilitator: shouldUseSmokeAgents() ? smokeFacilitator : undefined,
      workspaceChangeTracker: createWorkspaceChangeTracker(workspacePath),
      workspaceContextProvider: new WorkspaceContextProvider(workspacePath, readWorkspaceContextOptions()),
    },
  );
}

export function refreshVeyraSessionOptions(
  service: VeyraSessionService,
  badgeController?: FileBadgesController,
): void {
  service.updateOptions(readVeyraSessionOptions(badgeController));
}
