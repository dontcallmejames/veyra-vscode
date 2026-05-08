import { spawn, execSync } from 'node:child_process';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Agent, SendOptions } from './types.js';
import type { AgentChunk, AgentStatus } from '../types.js';
import { checkGemini } from '../statusChecks.js';
import { findNode } from '../findNode.js';
import * as vscode from 'vscode';

// Spike A4: invoke `gemini -p '<prompt>' -o stream-json` for non-interactive JSONL.
//
// Windows quirk (worse than Codex): the npm shim `gemini.cmd` cannot be
// spawned cleanly on Node 20+ -- Node's DEP0190 mitigation rejects raw
// .cmd spawning, and shell:true introduces unsafe arg concatenation.
// The reliable approach is to invoke the bundle's JS entrypoint directly
// via the running Node executable. Resolve the bundle path once at module
// load using `npm root -g`.
const GEMINI_CMD = resolveGeminiCommand();

function resolveGeminiCommand(): { command: string; args: string[] } {
  if (process.platform !== 'win32') {
    return { command: 'gemini', args: [] };
  }
  const npmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  const bundle = join(npmRoot, '@google', 'gemini-cli', 'bundle', 'gemini.js');
  return { command: findNode(), args: [bundle] };
}

const GEMINI_BASE_ARGS = ['-o', 'stream-json'];
const GEMINI_AUTO_EDIT_ARGS = ['--approval-mode', 'auto_edit'];

function geminiArgs(prompt: string): string[] {
  const writeApproval = vscode.workspace.getConfiguration('gambit').get<string>('writeApproval', 'auto-edit');
  const extra = writeApproval === 'auto-edit' ? GEMINI_AUTO_EDIT_ARGS : [];
  return ['-p', prompt, ...extra, ...GEMINI_BASE_ARGS];
}

export class GeminiAgent implements Agent {
  readonly id = 'gemini' as const;
  private active: ChildProcess | null = null;

  async status(): Promise<AgentStatus> {
    return checkGemini();
  }

  async *send(prompt: string, opts: SendOptions = {}): AsyncIterable<AgentChunk> {
    const child = spawn(
      GEMINI_CMD.command,
      [...GEMINI_CMD.args, ...geminiArgs(prompt)],
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
    // Track tool_id → tool_name within this send() call so tool_result events
    // can resolve the friendly tool name (the tool_result event carries only tool_id).
    const toolNameById = new Map<string, string>();
    try {
      for await (const data of child.stdout!) {
        buffer += String(data);
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          for (const chunk of parseGeminiEvent(line, toolNameById)) {
            if (chunk.type === 'done') sawDone = true;
            yield chunk;
          }
        }
      }
      if (buffer.trim()) {
        for (const chunk of parseGeminiEvent(buffer, toolNameById)) {
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
      yield { type: 'error', message: `Gemini exited with exit code ${code}${stderr ? `: ${stderr.trim()}` : ''}` };
    }
    if (!sawDone) yield { type: 'done' };
    this.active = null;
  }

  async cancel(): Promise<void> {
    this.active?.kill('SIGTERM');
  }
}

// Gemini stream-json event shapes from spike A4 + gemini-KXTGCWBT.js source analysis:
//   { type: 'init', timestamp, session_id, model }                            -> ignore
//   { type: 'message', role: 'user', content: '...' }                         -> ignore (user echo)
//   { type: 'message', role: 'assistant', content: '...', delta: true }       -> text chunk
//   { type: 'tool_use', timestamp, tool_name, tool_id, parameters }           -> tool-call chunk
//   { type: 'tool_result', timestamp, tool_id, status, output, error? }       -> tool-result chunk
//   { type: 'result', status: 'success', stats: {...} }                       -> done
//   { type: 'result', status: 'error', error: {...} }                         -> error (handled outside)
//   { type: 'error', severity, message }                                      -> non-fatal warning (ignore)
//
// Actual tool_use event shape captured from gemini-KXTGCWBT.js source:
//   {"type":"tool_use","timestamp":"...","tool_name":"write_file",
//    "tool_id":"call_abc123","parameters":{"file_path":"/abs/path/file.txt","content":"hello"}}
//
// Actual tool_result event shape:
//   {"type":"tool_result","timestamp":"...","tool_id":"call_abc123",
//    "status":"success","output":"Wrote 5 bytes"}
//
// Note: tool_result carries only tool_id (not tool_name). The toolNameById map
// is populated on tool_use and looked up here so the AgentChunk carries a
// friendly name consistent with what getEditedPath expects.
function* parseGeminiEvent(
  line: string,
  toolNameById: Map<string, string>,
): Generator<AgentChunk> {
  const trimmed = line.trim();
  if (!trimmed) return;
  let event: {
    type?: string;
    role?: string;
    content?: string;
    delta?: boolean;
    status?: string;
    error?: unknown;
    // tool_use
    tool_name?: string;
    tool_id?: string;
    parameters?: unknown;
    // tool_result
    output?: unknown;
  };
  try {
    event = JSON.parse(trimmed);
  } catch {
    return; // ignore non-JSON lines (stderr warnings get filtered upstream)
  }
  switch (event.type) {
    case 'message':
      if (event.role === 'assistant' && typeof event.content === 'string') {
        yield { type: 'text', text: event.content };
      }
      return;
    case 'tool_use': {
      const name = typeof event.tool_name === 'string' ? event.tool_name : 'unknown_tool';
      const id = typeof event.tool_id === 'string' ? event.tool_id : '';
      if (id) toolNameById.set(id, name);
      yield { type: 'tool-call', name, input: event.parameters ?? {} };
      return;
    }
    case 'tool_result': {
      const id = typeof event.tool_id === 'string' ? event.tool_id : '';
      const name = toolNameById.get(id) ?? 'unknown_tool';
      yield { type: 'tool-result', name, output: event.output ?? null };
      return;
    }
    case 'result':
      if (event.status === 'success') {
        yield { type: 'done' };
      }
      return;
    default:
      return;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const GEMINI_WRITE_TOOLS = new Set(['write_file', 'replace']);

export function getEditedPath(toolName: string, input: unknown): string | null {
  if (!GEMINI_WRITE_TOOLS.has(toolName)) return null;
  if (typeof input !== 'object' || input === null) return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.file_path === 'string') return obj.file_path as string;
  if (typeof obj.path === 'string') return obj.path as string;
  return null;
}
