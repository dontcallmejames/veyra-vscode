import * as fs from 'node:fs';
import * as path from 'node:path';

// Tokens that look like agent mentions, NOT files. Mirror src/mentions.ts.
const AGENT_TOKENS = new Set(['claude', 'gpt', 'codex', 'chatgpt', 'gemini', 'all']);
const PACKAGE_SCOPES = new Set(['anthropic-ai', 'google', 'openai', 'types', 'vscode']);

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const BINARY_DETECT_BYTES = 8 * 1024;

export interface ParsedFileMentions {
  filePaths: string[];
  remainingText: string;
}

export interface AttachedFile {
  path: string;
  lines: number;
  truncated: boolean;
}

export interface EmbedError {
  path: string;
  reason: string;
}

export interface EmbedResult {
  embedded: string;
  attached: AttachedFile[];
  errors: EmbedError[];
}

export interface EmbedOptions {
  maxLines: number;
}

function looksLikeFile(token: string): boolean {
  if (AGENT_TOKENS.has(token.toLowerCase())) return false;
  return token.includes('/') || token.includes('.');
}

export function parseFileMentions(input: string): ParsedFileMentions {
  const filePaths: string[] = [];
  const parts = input.split(/(\r?\n)/);
  let activeFence: FenceMarker | null = null;
  let remainingText = '';

  for (const part of parts) {
    if (part === '\n' || part === '\r\n') {
      remainingText += part;
      continue;
    }

    const fenceMarker = detectFenceMarker(part);
    if (fenceMarker && (activeFence === null || activeFence === fenceMarker)) {
      activeFence = activeFence === null ? fenceMarker : null;
      remainingText += part;
      continue;
    }

    remainingText += activeFence ? part : removeFileMentionsFromLine(part, filePaths);
  }

  return { filePaths, remainingText: remainingText.trim() };
}

function removeFileMentionsFromLine(line: string, filePaths: string[]): string {
  return line.replace(/(^|\s[\([{<`]|\s|[\([{<`])(@\S+)/g, (match, _boundary: string, token: string) => {
    const mention = normalizeFileMentionToken(token.slice(1));
    if (!mention || !looksLikeFile(mention) || looksLikeScopedPackage(mention)) {
      return match;
    }

    filePaths.push(mention);
    return '';
  });
}

function normalizeFileMentionToken(token: string): string {
  return token.replace(/[)\]}>,:;.`]+$/, '');
}

type FenceMarker = '```' | '~~~';

function detectFenceMarker(line: string): FenceMarker | null {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('```')) return '```';
  if (trimmed.startsWith('~~~')) return '~~~';
  return null;
}

function looksLikeScopedPackage(token: string): boolean {
  const parts = token.split('/');
  return parts.length >= 2 && PACKAGE_SCOPES.has(parts[0].toLowerCase());
}

export function embedFiles(
  paths: string[],
  workspacePath: string,
  opts: EmbedOptions,
): EmbedResult {
  if (paths.length === 0) {
    return { embedded: '', attached: [], errors: [] };
  }

  const blocks: string[] = [];
  const attached: AttachedFile[] = [];
  const errors: EmbedError[] = [];

  for (const p of paths) {
    const result = embedOne(p, workspacePath, opts.maxLines);
    if ('error' in result) {
      errors.push({ path: p, reason: result.error });
    } else {
      blocks.push(result.block);
      attached.push(result.attached);
    }
  }

  return { embedded: blocks.join('\n\n'), attached, errors };
}

/**
 * Resolve a path string by collapsing `.` and `..` segments (POSIX-style,
 * forward-slash only). This avoids using `path.resolve` which is
 * drive-aware on Windows and breaks POSIX-style test paths like `/fake/ws`.
 */
function normalizePosix(p: string): string {
  const parts = p.split('/');
  const stack: string[] = [];
  for (const seg of parts) {
    if (seg === '..') {
      stack.pop();
    } else if (seg !== '.') {
      stack.push(seg);
    }
  }
  return stack.join('/') || '/';
}

function embedOne(
  rawPath: string,
  workspacePath: string,
  maxLines: number,
): { block: string; attached: AttachedFile } | { error: string } {
  // Normalize everything to forward slashes (project convention).
  const wsNorm = workspacePath.replace(/\\/g, '/');
  const absolute = path.isAbsolute(rawPath)
    ? rawPath.replace(/\\/g, '/')
    : normalizePosix(wsNorm + '/' + rawPath.replace(/\\/g, '/'));
  const resolvedWorkspace = normalizePosix(wsNorm);
  const resolvedFile = normalizePosix(absolute);

  if (!resolvedFile.startsWith(resolvedWorkspace + '/') && resolvedFile !== resolvedWorkspace) {
    return { error: 'Path escapes workspace' };
  }

  if (!fs.existsSync(resolvedFile)) {
    return { error: 'File not found' };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedFile);
  } catch {
    return { error: 'Could not stat file' };
  }

  if (stat.size > MAX_FILE_BYTES) {
    return { error: 'File too large' };
  }

  let raw: Buffer | string;
  try {
    raw = fs.readFileSync(resolvedFile);
  } catch (err) {
    return { error: `Read failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const buf = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw;
  const head = buf.subarray(0, BINARY_DETECT_BYTES);
  if (head.includes(0)) {
    return { error: 'Binary file' };
  }

  const text = buf.toString('utf8');
  const rawLines = text.split(/\r?\n/);
  // Drop trailing empty element produced by a final newline (standard text-file convention).
  const allLines =
    rawLines.length > 0 && rawLines[rawLines.length - 1] === ''
      ? rawLines.slice(0, -1)
      : rawLines;
  const truncated = allLines.length > maxLines;
  const usedLines = truncated ? allLines.slice(0, maxLines) : allLines;

  const header = truncated
    ? `[File: ${rawPath} - first ${maxLines} of ${allLines.length} lines]`
    : `[File: ${rawPath}]`;
  const footer = truncated
    ? '[/File - truncated; use the Read tool to fetch the rest]'
    : '[/File]';
  const lang = inferLang(rawPath);
  const fence = '```';
  const block = [header, `${fence}${lang}`, usedLines.join('\n'), fence, footer].join('\n');

  return {
    block,
    attached: { path: rawPath, lines: usedLines.length, truncated },
  };
}

function inferLang(p: string): string {
  const ext = path.extname(p).toLowerCase();
  switch (ext) {
    case '.ts': case '.tsx': return 'ts';
    case '.js': case '.jsx': return 'js';
    case '.json': return 'json';
    case '.md': return 'md';
    case '.py': return 'python';
    case '.sh': return 'sh';
    case '.html': return 'html';
    case '.css': return 'css';
    case '.yml': case '.yaml': return 'yaml';
    default: return '';
  }
}
