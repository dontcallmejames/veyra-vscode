import type { Agent, SendOptions } from './types.js';
import type { AgentChunk, AgentStatus } from '../types.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { checkClaude } from '../statusChecks.js';
import { findNode } from '../findNode.js';
import * as vscode from 'vscode';

export class ClaudeAgent implements Agent {
  readonly id = 'claude' as const;
  private activeAbortController: AbortController | null = null;

  async status(): Promise<AgentStatus> {
    return checkClaude();
  }

  async *send(prompt: string, opts: SendOptions = {}): AsyncIterable<AgentChunk> {
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    const onAbort = () => abortController.abort();
    if (opts.signal) {
      if (opts.signal.aborted) abortController.abort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    // The SDK spawns its native bridge using process.execPath. Inside the
    // VSCode extension host that's Code.exe (Electron), not real node - the
    // bridge then crashes with "path argument undefined". Override execPath
    // to the real node binary for the duration of the SDK call.
    const origExecPath = process.execPath;
    const overrideExecPath = process.versions.electron !== undefined;
    if (overrideExecPath) {
      process.execPath = findNode();
    }

    let stream: AsyncIterable<unknown>;
    try {
      const writeApproval = vscode.workspace.getConfiguration('veyra').get<string>('writeApproval', 'auto-edit');
      const permissionMode = !opts.readOnly && writeApproval === 'auto-edit' ? 'acceptEdits' : 'default';
      stream = query({ prompt, options: { abortController, cwd: opts.cwd, permissionMode } });
    } catch (err) {
      yield { type: 'error', message: errorMessage(err) };
      yield { type: 'done' };
      if (overrideExecPath) process.execPath = origExecPath;
      opts.signal?.removeEventListener('abort', onAbort);
      this.activeAbortController = null;
      return;
    }

    const idToName = new Map<string, string>();
    let sawTerminal = false;
    try {
      for await (const event of stream) {
        for (const chunk of mapSdkEvent(event, idToName)) {
          if (chunk.type === 'done') sawTerminal = true;
          yield chunk;
        }
      }
      if (!sawTerminal) yield { type: 'done' };
    } catch (err) {
      yield { type: 'error', message: errorMessage(err) };
      yield { type: 'done' };
    } finally {
      if (overrideExecPath) process.execPath = origExecPath;
      opts.signal?.removeEventListener('abort', onAbort);
      this.activeAbortController = null;
    }
  }

  async cancel(): Promise<void> {
    this.activeAbortController?.abort();
  }
}

// Real Claude Agent SDK event shape (from spike A2 findings):
//   - { type: 'system', subtype: 'init' | 'hook_started' | 'hook_response' }   → ignore
//   - { type: 'rate_limit_event', ... }                                          → ignore
//   - { type: 'assistant', message: { content: [...] } }
//       content[i].type === 'text'      → { type: 'text', text: content[i].text }
//       content[i].type === 'tool_use'  → { type: 'tool-call', name, input }
//   - { type: 'user', message: { content: [...] } }
//       content[i].type === 'tool_result' → { type: 'tool-result', name, output }
//   - { type: 'result', subtype: 'success' }                                     → { type: 'done' }
//   - { type: 'result', subtype: 'error', error: '...' }                         → { type: 'error', ... } then 'done'
//
// Option A: also pass through events whose `type` is already a valid AgentChunk
// discriminator (text / tool-call / tool-result / error / done). This keeps the
// four canned tests passing while the fifth test exercises the real switch.
function* mapSdkEvent(event: unknown, idToName: Map<string, string>): Generator<AgentChunk> {
  if (typeof event !== 'object' || event === null) return;
  const e = event as {
    type: string;
    subtype?: string;
    message?: { content?: Array<Record<string, unknown>> };
    error?: string;
    text?: string;
    name?: string;
    input?: unknown;
    output?: unknown;
  };

  switch (e.type) {
    case 'system':
    case 'rate_limit_event':
      return;

    case 'assistant':
      for (const item of e.message?.content ?? []) {
        if (item.type === 'text' && typeof item.text === 'string') {
          yield { type: 'text', text: item.text };
        } else if (item.type === 'tool_use' && typeof item.name === 'string') {
          if (typeof item.id === 'string') {
            idToName.set(item.id, item.name);
          }
          yield { type: 'tool-call', name: item.name, input: item.input };
        }
      }
      return;

    case 'user':
      for (const item of e.message?.content ?? []) {
        if (item.type === 'tool_result') {
          const id = typeof item.tool_use_id === 'string' ? item.tool_use_id : '';
          const name = idToName.get(id) ?? id ?? 'unknown';
          yield { type: 'tool-result', name, output: item.content };
        }
      }
      return;

    case 'result':
      if (e.subtype === 'success') {
        yield { type: 'done' };
      } else if (e.subtype === 'error') {
        yield { type: 'error', message: e.error ?? 'Unknown error' };
        yield { type: 'done' };
      }
      return;

    // Option A: pass-through for events already shaped as AgentChunk.
    // The four canned tests send { type: 'text', text: '...' } / { type: 'tool-call', ... }
    // / { type: 'done' } directly; these fall here and are emitted as-is.
    case 'text':
      if (typeof e.text === 'string') yield { type: 'text', text: e.text };
      return;

    case 'tool-call':
      if (typeof e.name === 'string') yield { type: 'tool-call', name: e.name, input: e.input };
      return;

    case 'tool-result':
      if (typeof e.name === 'string') yield { type: 'tool-result', name: e.name, output: e.output };
      return;

    case 'error': {
      const msg = (event as { message?: unknown }).message;
      if (typeof msg === 'string') {
        yield { type: 'error', message: msg };
      }
      return;
    }

    case 'done':
      yield { type: 'done' };
      return;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const CLAUDE_WRITE_TOOLS: Record<string, string[]> = {
  Edit: ['file_path'],
  Write: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'],
};

export function getEditedPath(toolName: string, input: unknown): string | null {
  const fields = CLAUDE_WRITE_TOOLS[toolName];
  if (!fields) return null;
  if (typeof input !== 'object' || input === null) return null;
  const obj = input as Record<string, unknown>;
  for (const f of fields) {
    if (typeof obj[f] === 'string') return obj[f] as string;
  }
  return null;
}
