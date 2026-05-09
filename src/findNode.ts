import { execSync } from 'node:child_process';

let cached: string | null = null;

/**
 * Find the user's real Node.js binary on PATH.
 *
 * In a normal Node process, `process.execPath` is what you want -- but inside
 * a VSCode extension host, `process.execPath` points to Code.exe (the Electron
 * binary), and spawning child processes via that path runs them under Electron's
 * argv semantics, which can mis-parse args (e.g. yargs sees both positional and
 * --prompt). Resolve the real node binary on PATH instead.
 */
export function findNode(): string {
  if (cached) return cached;
  try {
    cached = process.platform === 'win32'
      ? findWindowsCommand('node')
      : findUnixCommand('node');
    return cached;
  } catch (err) {
    throw new Error(
      'Could not locate Node.js on PATH (needed to invoke wrapped CLIs): ' +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

function findUnixCommand(command: string): string {
  return firstCommandPath(execSync(`which ${command}`, { encoding: 'utf8' }));
}

function findWindowsCommand(command: string): string {
  try {
    return firstCommandPath(execSync(`where ${command}`, { encoding: 'utf8' }));
  } catch (whereError) {
    if (!/^[A-Za-z0-9_.-]+$/.test(command)) {
      throw whereError;
    }
    return firstCommandPath(execSync(
      `powershell.exe -NoProfile -Command "Get-Command ${command} -ErrorAction Stop | Select-Object -ExpandProperty Source"`,
      { encoding: 'utf8' },
    ));
  }
}

function firstCommandPath(output: string): string {
  const first = output.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (!first) throw new Error('node not found on PATH');
  return first.trim();
}
