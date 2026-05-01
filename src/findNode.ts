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
  const cmd = process.platform === 'win32' ? 'where node' : 'which node';
  try {
    const out = execSync(cmd, { encoding: 'utf8' });
    const first = out.split(/\r?\n/).find((line) => line.trim().length > 0);
    if (!first) throw new Error('node not found on PATH');
    cached = first.trim();
    return cached;
  } catch (err) {
    throw new Error(
      'Could not locate Node.js on PATH (needed to invoke wrapped CLIs): ' +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}
