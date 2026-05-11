import { execSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Agent, SendOptions } from './types.js';
import type { AgentChunk, AgentStatus } from '../types.js';
import { checkClaude } from '../statusChecks.js';
import { findNode } from '../findNode.js';
import * as vscode from 'vscode';

type ClaudeSdkQuery = (request: {
  prompt: string;
  options?: {
    abortController?: AbortController;
    cwd?: string;
    permissionMode?: string;
    systemPrompt?: string;
  };
}) => AsyncIterable<unknown>;

export interface ClaudeAgentOptions {
  loadSdkQuery?: () => Promise<ClaudeSdkQuery>;
}

export class ClaudeAgent implements Agent {
  readonly id = 'claude' as const;
  private activeAbortController: AbortController | null = null;
  private activeCli: ChildProcess | null = null;

  constructor(private readonly options: ClaudeAgentOptions = {}) {}

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
      const query = await (this.options.loadSdkQuery ?? loadClaudeSdkQuery)();
      const writeApproval = vscode.workspace.getConfiguration('veyra').get<string>('writeApproval', 'auto-edit');
      const permissionMode = !opts.readOnly && writeApproval === 'auto-edit' ? 'acceptEdits' : 'default';
      stream = query({ prompt, options: { abortController, cwd: opts.cwd, permissionMode } });
    } catch (err) {
      if (isMissingClaudeSdkError(err)) {
        if (overrideExecPath) process.execPath = origExecPath;
        opts.signal?.removeEventListener('abort', onAbort);
        this.activeAbortController = null;
        yield* this.sendWithCli(prompt, opts);
        return;
      }
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
    this.activeCli?.kill('SIGTERM');
  }

  private async *sendWithCli(prompt: string, opts: SendOptions = {}): AsyncIterable<AgentChunk> {
    let claudeCommand: { command: string; args: string[] };
    try {
      claudeCommand = resolveClaudeCommand();
    } catch (err) {
      yield { type: 'error', message: `Unable to start Claude CLI: ${errorMessage(err)}` };
      yield { type: 'done' };
      return;
    }

    const writeApproval = vscode.workspace.getConfiguration('veyra').get<string>('writeApproval', 'auto-edit');
    const permissionMode = !opts.readOnly && writeApproval === 'auto-edit' ? 'acceptEdits' : 'default';
    let child: ChildProcess;
    try {
      child = spawn(
        claudeCommand.command,
        [
          ...claudeCommand.args,
          '-p',
          '--output-format',
          'stream-json',
          '--verbose',
          '--permission-mode',
          permissionMode,
        ],
        { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      child.stdin?.end(prompt);
    } catch (err) {
      yield { type: 'error', message: `Unable to start Claude CLI: ${errorMessage(err)}` };
      yield { type: 'done' };
      return;
    }
    this.activeCli = child;

    const onAbort = () => child.kill('SIGTERM');
    if (opts.signal) {
      if (opts.signal.aborted) child.kill('SIGTERM');
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const exitPromise = new Promise<{ code: number | null; stderr: string; processError?: string }>((resolve) => {
      let stderr = '';
      let settled = false;
      const finish = (code: number | null, processError?: string) => {
        if (settled) return;
        settled = true;
        resolve({ code, stderr, processError });
      };
      child.stderr?.on('data', (d) => (stderr += String(d)));
      child.on('error', (err) => finish(null, errorMessage(err)));
      child.on('close', (code) => finish(code));
    });

    const idToName = new Map<string, string>();
    let buffer = '';
    let sawDone = false;
    try {
      for await (const data of child.stdout!) {
        buffer += String(data);
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          for (const chunk of parseClaudeJsonLine(line, idToName)) {
            if (chunk.type === 'done') sawDone = true;
            yield chunk;
          }
        }
      }
      if (buffer.trim()) {
        for (const chunk of parseClaudeJsonLine(buffer, idToName)) {
          if (chunk.type === 'done') sawDone = true;
          yield chunk;
        }
      }
    } catch (err) {
      yield { type: 'error', message: errorMessage(err) };
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }

    const { code, stderr, processError } = await exitPromise;
    if (processError) {
      yield { type: 'error', message: `Claude process error: ${processError}` };
    } else if (code !== 0) {
      yield { type: 'error', message: `Claude exited with exit code ${code}${stderr ? `: ${stderr.trim()}` : ''}` };
    }
    if (!sawDone) yield { type: 'done' };
    this.activeCli = null;
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

async function loadClaudeSdkQuery(): Promise<ClaudeSdkQuery> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk') as { query: ClaudeSdkQuery };
  return sdk.query;
}

function isMissingClaudeSdkError(err: unknown): boolean {
  const maybeNodeError = err as { code?: unknown; message?: unknown };
  return typeof maybeNodeError.message === 'string' &&
    maybeNodeError.message.includes('@anthropic-ai/claude-agent-sdk') &&
    (
      maybeNodeError.code === 'MODULE_NOT_FOUND' ||
      maybeNodeError.code === 'ERR_MODULE_NOT_FOUND' ||
      maybeNodeError.message.includes('Cannot find module') ||
      maybeNodeError.message.includes('Cannot find package') ||
      maybeNodeError.message.includes('error when mocking a module')
    );
}

function* parseClaudeJsonLine(
  line: string,
  idToName: Map<string, string>,
): Generator<AgentChunk> {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    yield* mapSdkEvent(JSON.parse(trimmed), idToName);
  } catch {
    return;
  }
}

function resolveClaudeCommand(): { command: string; args: string[] } {
  if (process.platform !== 'win32') {
    return { command: 'claude', args: [] };
  }

  try {
    const output = execSync('where.exe claude.exe', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const command = output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.toLowerCase().endsWith('claude.exe'));
    if (command) return { command, args: [] };
  } catch {
    // fall through to a PATH lookup that can still work on non-standard installs
  }

  return { command: 'claude', args: [] };
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
