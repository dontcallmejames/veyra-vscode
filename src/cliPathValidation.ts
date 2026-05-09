import { dirname, join } from 'node:path';

export type CliRuntimeName = 'codex' | 'gemini';

export function normalizeCliPathOverride(runtime: CliRuntimeName, filePath: string): string {
  const trimmed = filePath.trim();
  if (!isWindowsNpmShimPath(runtime, trimmed)) return trimmed;
  return join(dirname(trimmed), ...windowsNpmBundleSegments(runtime));
}

export function windowsNpmShimNames(runtime: CliRuntimeName): string[] {
  return [`${runtime}.cmd`, `${runtime}.bat`, `${runtime}.ps1`];
}

export function cliPathMisconfiguration(runtime: CliRuntimeName, filePath: string): string | null {
  const baseName = filePath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  const expected = expectedCliRuntimePathNames(runtime);
  if (expected.includes(baseName)) return null;
  const label = runtime === 'codex' ? 'Codex' : 'Gemini';
  return `${label} CLI path override must point to ${formatExpectedNames(expected)}. Received ${filePath}.`;
}

export function expectedCliRuntimePathNames(runtime: CliRuntimeName): string[] {
  return [`${runtime}.js`, `${runtime}.exe`, runtime];
}

export function isWindowsNpmShimPath(runtime: CliRuntimeName, filePath: string): boolean {
  const baseName = filePath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  return windowsNpmShimNames(runtime).includes(baseName);
}

function windowsNpmBundleSegments(runtime: CliRuntimeName): string[] {
  return runtime === 'codex'
    ? ['node_modules', '@openai', 'codex', 'bin', 'codex.js']
    : ['node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js'];
}

function formatExpectedNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')}, or ${names[names.length - 1]}`;
}
