import { spawn, execSync } from 'node:child_process';
import { accessSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Agent, SendOptions } from './types.js';
import type { AgentChunk, AgentStatus } from '../types.js';
import { checkCodex } from '../statusChecks.js';
import { findNode } from '../findNode.js';
import { getCodexCliPathOverride } from '../cliPathOverrides.js';
import { cliPathMisconfiguration, normalizeCliPathOverride, windowsNpmShimNames } from '../cliPathValidation.js';
import * as vscode from 'vscode';

// Spike A3: invoke `codex exec --json '<prompt>'` for non-interactive JSONL.
//
// Windows: `codex` is an npm shim (codex.cmd). Plain spawn('codex') fails
// with ENOENT, and spawn('codex.cmd') fails with EINVAL on Node 20+ due
// to DEP0190 (refusal to spawn .cmd files without shell:true, and
// shell:true introduces unsafe arg concatenation). Reliable fix: resolve
// the bundle's JS entrypoint via `npm root -g` and invoke node directly.
function resolveCodexCommand(): { command: string; args: string[] } {
  const override = getCodexCliPathOverride();
  if (override) {
    assertCliPathAccessible(
      override,
      `Codex CLI path override not found at ${override}. Update VEYRA_CODEX_CLI_PATH or veyra.codexCliPath, or install it with \`npm install -g @openai/codex\`, then run \`codex login\`.`,
    );
    return cliPathCommand(override);
  }

  if (process.platform !== 'win32') {
    return { command: 'codex', args: [] };
  }
  const nativeCommand = resolveWindowsNativeExecutable('codex');
  if (nativeCommand) return nativeCommand;
  const shimCommand = resolveWindowsNpmShim('codex');
  if (shimCommand) return shimCommand;

  const npmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  const bundle = join(npmRoot, '@openai', 'codex', 'bin', 'codex.js');
  assertCliPathAccessible(
    bundle,
    `Codex CLI bundle not found at ${bundle}. Install it with \`npm install -g @openai/codex\`, then run \`codex login\`.`,
  );
  return { command: findNode(), args: [bundle] };
}

function resolveWindowsNpmShim(baseName: 'codex'): { command: string; args: string[] } | null {
  for (const shimName of windowsNpmShimNames(baseName)) {
    let output: string;
    try {
      output = execSync(`where.exe ${shimName}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      continue;
    }

    const shimPath = output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.toLowerCase().endsWith(shimName));
    if (!shimPath) continue;

    const bundle = normalizeCliPathOverride(baseName, shimPath);
    const bundleStatus = inspectCliPath(bundle);
    if (bundleStatus === 'missing') continue;
    if (bundleStatus === 'inaccessible') {
      throw new Error(`Cannot inspect ${bundle}. Check filesystem permissions or rerun outside the current sandbox.`);
    }
    return { command: findNode(), args: [bundle] };
  }

  return null;
}

function resolveWindowsNativeExecutable(baseName: string): { command: string; args: string[] } | null {
  let output: string;
  try {
    output = execSync(`where.exe ${baseName}.exe`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }

  const expectedName = `${baseName}.exe`.toLowerCase();
  const command = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.toLowerCase().endsWith(expectedName));
  if (!command) return null;
  assertCliPathAccessible(command, `${baseName}.exe not found at ${command}.`);
  return { command, args: [] };
}

function cliPathCommand(cliPath: string): { command: string; args: string[] } {
  if (/\.js$/i.test(cliPath)) {
    return { command: findNode(), args: [cliPath] };
  }
  return { command: cliPath, args: [] };
}

function assertCliPathAccessible(filePath: string, missingMessage: string): void {
  if (isUnsupportedWindowsCommandShim(filePath)) {
    throw new Error('Windows npm command shim overrides are not supported; set VEYRA_CODEX_CLI_PATH or veyra.codexCliPath to the Codex JS bundle or native executable instead.');
  }
  const misconfiguration = cliPathMisconfiguration('codex', filePath);
  if (misconfiguration) {
    throw new Error(misconfiguration);
  }
  try {
    accessSync(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(`Cannot inspect ${filePath}. Check filesystem permissions or rerun outside the current sandbox.`);
    }
    throw new Error(missingMessage);
  }
}

function inspectCliPath(filePath: string): 'exists' | 'missing' | 'inaccessible' {
  try {
    accessSync(filePath);
    return 'exists';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') return 'inaccessible';
    return 'missing';
  }
}

function isUnsupportedWindowsCommandShim(filePath: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(filePath);
}

const CODEX_BASE_ARGS = ['exec', '--json', '--skip-git-repo-check'];
const CODEX_AUTO_EDIT_ARGS = ['--sandbox', 'workspace-write'];

function codexArgs(readOnly = false): string[] {
  const writeApproval = vscode.workspace.getConfiguration('veyra').get<string>('writeApproval', 'auto-edit');
  const extra = !readOnly && writeApproval === 'auto-edit' ? CODEX_AUTO_EDIT_ARGS : [];
  return [...CODEX_BASE_ARGS, ...extra, '-'];
}

export class CodexAgent implements Agent {
  readonly id = 'codex' as const;
  private active: ChildProcess | null = null;

  async status(): Promise<AgentStatus> {
    return checkCodex();
  }

  async *send(prompt: string, opts: SendOptions = {}): AsyncIterable<AgentChunk> {
    let codexCommand: { command: string; args: string[] };
    try {
      codexCommand = resolveCodexCommand();
    } catch (err) {
      yield { type: 'error', message: `Unable to start Codex CLI: ${errorMessage(err)}` };
      yield { type: 'done' };
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(
        codexCommand.command,
        [...codexCommand.args, ...codexArgs(opts.readOnly)],
        { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      child.stdin?.end(prompt);
    } catch (err) {
      yield { type: 'error', message: `Unable to start Codex CLI: ${errorMessage(err)}` };
      yield { type: 'done' };
      return;
    }
    this.active = child;

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

    let buffer = '';
    let sawDone = false;
    try {
      for await (const data of child.stdout!) {
        buffer += String(data);
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          for (const chunk of parseCodexEvent(line)) {
            if (chunk.type === 'done') sawDone = true;
            yield chunk;
          }
        }
      }
      if (buffer.trim()) {
        for (const chunk of parseCodexEvent(buffer)) {
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
      yield { type: 'error', message: `Codex process error: ${processError}` };
    } else if (code !== 0) {
      yield { type: 'error', message: `Codex exited with exit code ${code}${stderr ? `: ${stderr.trim()}` : ''}` };
    }
    if (!sawDone) yield { type: 'done' };
    this.active = null;
  }

  async cancel(): Promise<void> {
    this.active?.kill('SIGTERM');
  }
}

// Codex JSONL event shapes from spike A3 + codex-rs source analysis:
//   { type: 'thread.started', thread_id }   -> ignore
//   { type: 'turn.started' }                -> ignore
//   { type: 'item.completed', item: { type: 'agent_message', text: '...' } } -> text chunk
//   { type: 'item.completed', item: { type: 'file_change', changes: [{ path, kind }], status } }
//     -> tool-call chunk per change (name: 'apply_patch', input: { path })
//   { type: 'item.completed', item: { type: 'command_execution', command, exit_code, status } }
//     -> tool-call chunk (name: 'shell', input: { command }) - badge skipped (not a write tool)
//   { type: 'item.completed', item: { type: 'mcp_tool_call', server, tool, arguments, result } }
//     -> tool-call chunk (name: tool, input: arguments)
//   { type: 'turn.completed', usage: {...} } -> done
//
// Actual file_change event shape captured from codex-rs/exec source:
//   {"type":"item.completed","item":{"id":"item_1","type":"file_change",
//    "changes":[{"path":"/abs/path/file.txt","kind":"Add"}],"status":"Completed"}}
//
// Actual command_execution event shape:
//   {"type":"item.completed","item":{"id":"item_0","type":"command_execution",
//    "command":"echo hello","aggregated_output":"hello\n","exit_code":0,"status":"Completed"}}
//
// Actual mcp_tool_call event shape:
//   {"type":"item.completed","item":{"id":"item_2","type":"mcp_tool_call",
//    "server":"filesystem","tool":"write_file","status":"Completed",
//    "arguments":{"path":"/abs/path/file.txt","content":"hello"},
//    "result":{"content":"wrote 5 bytes","structured_content":null},"error":null}}
function* parseCodexEvent(line: string): Generator<AgentChunk> {
  const trimmed = line.trim();
  if (!trimmed) return;
  let event: {
    type?: string;
    item?: {
      type?: string;
      text?: string;
      // file_change
      changes?: Array<{ path?: string; kind?: string }>;
      status?: string;
      // command_execution
      command?: string;
      exit_code?: number | null;
      aggregated_output?: string;
      // mcp_tool_call
      server?: string;
      tool?: string;
      arguments?: unknown;
      result?: unknown;
    };
  };
  try {
    event = JSON.parse(trimmed);
  } catch {
    return; // ignore non-JSON lines (stray banners, ANSI noise)
  }
  switch (event.type) {
    case 'item.completed': {
      const item = event.item;
      if (!item) return;
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        yield { type: 'text', text: item.text };
      } else if (item.type === 'file_change' && Array.isArray(item.changes)) {
        // Emit call AND result per changed path. The badge controller only
        // fires registerEdit on tool-result (it looks back for the call to
        // recover the path), so a tool-call alone leaves the badge stale.
        for (const change of item.changes) {
          if (typeof change.path === 'string') {
            yield { type: 'tool-call', name: 'apply_patch', input: { path: change.path } };
            yield { type: 'tool-result', name: 'apply_patch', output: { kind: change.kind ?? 'edit', path: change.path } };
          }
        }
      } else if (item.type === 'command_execution' && typeof item.command === 'string') {
        // Shell commands: surfaced for chat display; badge intentionally skips them
        // because 'shell' is not in CODEX_WRITE_TOOLS.
        yield { type: 'tool-call', name: 'shell', input: { command: item.command } };
        if (typeof item.aggregated_output === 'string') {
          yield { type: 'tool-result', name: 'shell', output: item.aggregated_output };
        }
      } else if (item.type === 'mcp_tool_call' && typeof item.tool === 'string') {
        yield { type: 'tool-call', name: item.tool, input: item.arguments ?? {} };
        if (item.result !== undefined) {
          yield { type: 'tool-result', name: item.tool, output: item.result };
        }
      }
      return;
    }
    case 'turn.completed':
      yield { type: 'done' };
      return;
    default:
      return;
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
