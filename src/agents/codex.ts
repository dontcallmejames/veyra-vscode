import { spawn, execSync } from 'node:child_process';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Agent, SendOptions } from './types.js';
import type { AgentChunk, AgentStatus } from '../types.js';
import { checkCodex } from '../statusChecks.js';
import { findNode } from '../findNode.js';
import * as vscode from 'vscode';

// Spike A3: invoke `codex exec --json '<prompt>'` for non-interactive JSONL.
//
// Windows: `codex` is an npm shim (codex.cmd). Plain spawn('codex') fails
// with ENOENT, and spawn('codex.cmd') fails with EINVAL on Node 20+ due
// to DEP0190 (refusal to spawn .cmd files without shell:true, and
// shell:true introduces unsafe arg concatenation). Reliable fix: resolve
// the bundle's JS entrypoint via `npm root -g` and invoke node directly.
const CODEX_CMD = resolveCodexCommand();

function resolveCodexCommand(): { command: string; args: string[] } {
  if (process.platform !== 'win32') {
    return { command: 'codex', args: [] };
  }
  const npmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  const bundle = join(npmRoot, '@openai', 'codex', 'bin', 'codex.js');
  return { command: findNode(), args: [bundle] };
}

const CODEX_BASE_ARGS = ['exec', '--json', '--skip-git-repo-check'];
const CODEX_AUTO_EDIT_ARGS = ['--sandbox', 'workspace-write'];

function codexArgs(prompt: string): string[] {
  const writeApproval = vscode.workspace.getConfiguration('gambit').get<string>('writeApproval', 'auto-edit');
  const extra = writeApproval === 'auto-edit' ? CODEX_AUTO_EDIT_ARGS : [];
  return [...CODEX_BASE_ARGS, ...extra, prompt];
}

export class CodexAgent implements Agent {
  readonly id = 'codex' as const;
  private active: ChildProcess | null = null;

  async status(): Promise<AgentStatus> {
    return checkCodex();
  }

  async *send(prompt: string, opts: SendOptions = {}): AsyncIterable<AgentChunk> {
    const child = spawn(
      CODEX_CMD.command,
      [...CODEX_CMD.args, ...codexArgs(prompt)],
      { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    this.active = child;

    const onAbort = () => child.kill('SIGTERM');
    if (opts.signal) {
      if (opts.signal.aborted) child.kill('SIGTERM');
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const exitPromise = new Promise<{ code: number | null; stderr: string }>((resolve) => {
      let stderr = '';
      child.stderr?.on('data', (d) => (stderr += String(d)));
      child.on('close', (code) => resolve({ code, stderr }));
    });

    let buffer = '';
    let sawDone = false;
    try {
      for await (const data of child.stdout!) {
        buffer += String(data);
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const chunk = parseCodexEvent(line);
          if (!chunk) continue;
          if (chunk.type === 'done') sawDone = true;
          yield chunk;
        }
      }
      if (buffer.trim()) {
        const chunk = parseCodexEvent(buffer);
        if (chunk) {
          if (chunk.type === 'done') sawDone = true;
          yield chunk;
        }
      }
    } catch (err) {
      yield { type: 'error', message: errorMessage(err) };
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }

    const { code, stderr } = await exitPromise;
    if (code !== 0) {
      yield { type: 'error', message: `Codex exited with exit code ${code}${stderr ? `: ${stderr.trim()}` : ''}` };
    }
    if (!sawDone) yield { type: 'done' };
    this.active = null;
  }

  async cancel(): Promise<void> {
    this.active?.kill('SIGTERM');
  }
}

// Codex JSONL event shapes from spike A3:
//   { type: 'thread.started', thread_id }   -> ignore
//   { type: 'turn.started' }                -> ignore
//   { type: 'item.completed', item: { type: 'agent_message', text: '...' } } -> text chunk
//   { type: 'turn.completed', usage: {...} } -> done
function parseCodexEvent(line: string): AgentChunk | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let event: { type?: string; item?: { type?: string; text?: string } };
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null; // ignore non-JSON lines (stray banners, ANSI noise)
  }
  switch (event.type) {
    case 'item.completed':
      if (event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        return { type: 'text', text: event.item.text };
      }
      return null;
    case 'turn.completed':
      return { type: 'done' };
    default:
      return null;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const CODEX_WRITE_TOOLS = new Set(['apply_patch', 'write_file', 'update_file']);

export function getEditedPath(toolName: string, input: unknown): string | null {
  if (!CODEX_WRITE_TOOLS.has(toolName)) return null;
  if (typeof input !== 'object' || input === null) return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.path === 'string') return obj.path;
  if (typeof obj.file_path === 'string') return obj.file_path as string;
  return null;
}
