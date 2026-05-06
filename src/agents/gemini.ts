import { spawn, execSync } from 'node:child_process';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Agent, SendOptions } from './types.js';
import type { AgentChunk, AgentStatus } from '../types.js';
import { checkGemini } from '../statusChecks.js';
import { findNode } from '../findNode.js';

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

const GEMINI_ARGS = (prompt: string): string[] => ['-p', prompt, '-o', 'stream-json'];

export class GeminiAgent implements Agent {
  readonly id = 'gemini' as const;
  private active: ChildProcess | null = null;

  async status(): Promise<AgentStatus> {
    return checkGemini();
  }

  async *send(prompt: string, opts: SendOptions = {}): AsyncIterable<AgentChunk> {
    const child = spawn(
      GEMINI_CMD.command,
      [...GEMINI_CMD.args, ...GEMINI_ARGS(prompt)],
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
          const chunk = parseGeminiEvent(line);
          if (!chunk) continue;
          if (chunk.type === 'done') sawDone = true;
          yield chunk;
        }
      }
      if (buffer.trim()) {
        const chunk = parseGeminiEvent(buffer);
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
      yield { type: 'error', message: `Gemini exited with exit code ${code}${stderr ? `: ${stderr.trim()}` : ''}` };
    }
    if (!sawDone) yield { type: 'done' };
    this.active = null;
  }

  async cancel(): Promise<void> {
    this.active?.kill('SIGTERM');
  }
}

// Gemini stream-json event shapes from spike A4:
//   { type: 'init', ... }                                                     -> ignore
//   { type: 'message', role: 'user', content: '...' }                         -> ignore (user echo)
//   { type: 'message', role: 'assistant', content: '...', delta: true }       -> text chunk
//   { type: 'result', status: 'success' }                                     -> done
//   { type: 'result', status: 'error', error: '...' }                         -> error then done
function parseGeminiEvent(line: string): AgentChunk | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let event: { type?: string; role?: string; content?: string; delta?: boolean; status?: string; error?: string };
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null; // ignore non-JSON lines (stderr warnings get filtered upstream)
  }
  switch (event.type) {
    case 'message':
      if (event.role === 'assistant' && typeof event.content === 'string') {
        return { type: 'text', text: event.content };
      }
      return null;
    case 'result':
      if (event.status === 'success') {
        return { type: 'done' };
      }
      return null;
    default:
      return null;
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
