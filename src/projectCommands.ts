import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type ProjectPackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'unknown';

export interface ProjectCommandHint {
  label: string;
  command: string;
  source: string;
}

export interface ProjectCommandHintsResult {
  packageManager: ProjectPackageManager;
  hints: ProjectCommandHint[];
}

const SCRIPT_PRIORITY = [
  'test',
  'verify',
  'typecheck',
  'lint',
  'build',
  'check',
  'format',
];

export class ProjectCommandProvider {
  private cached: ProjectCommandHintsResult | null = null;

  constructor(private readonly workspacePath: string) {}

  async retrieve(): Promise<ProjectCommandHintsResult> {
    this.cached ??= await detectProjectCommandHints(this.workspacePath);
    return this.cached;
  }

  invalidate(): void {
    this.cached = null;
  }
}

export async function detectProjectCommandHints(workspacePath: string): Promise<ProjectCommandHintsResult> {
  const packageJson = await readPackageJson(workspacePath);
  if (!packageJson || !isRecord(packageJson.scripts)) {
    return { packageManager: 'unknown', hints: [] };
  }

  const packageManager = await inferPackageManager(workspacePath);
  const scripts = packageJson.scripts;
  const hints = SCRIPT_PRIORITY
    .filter((scriptName) => typeof scripts[scriptName] === 'string')
    .map((scriptName): ProjectCommandHint => ({
      label: scriptName,
      command: packageScriptCommand(packageManager, scriptName),
      source: `package.json#scripts.${scriptName}`,
    }));

  return { packageManager, hints };
}

export function formatProjectCommandHintsBlock(result: ProjectCommandHintsResult): string {
  if (result.hints.length === 0) return '';
  return [
    '[Project command hints]',
    `Detected package manager: ${result.packageManager}`,
    'Suggested commands only. Do not run these commands unless the user explicitly asks or approves.',
    ...result.hints.map((hint) => `- ${hint.label}: ${hint.command} (${hint.source})`),
    '[/Project command hints]',
  ].join('\n');
}

async function readPackageJson(workspacePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(path.join(workspacePath, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function inferPackageManager(workspacePath: string): Promise<ProjectPackageManager> {
  if (await pathExists(path.join(workspacePath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (
    await pathExists(path.join(workspacePath, 'bun.lockb')) ||
    await pathExists(path.join(workspacePath, 'bun.lock'))
  ) {
    return 'bun';
  }
  if (await pathExists(path.join(workspacePath, 'yarn.lock'))) return 'yarn';
  if (await pathExists(path.join(workspacePath, 'package-lock.json'))) return 'npm';
  return 'npm';
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function packageScriptCommand(packageManager: ProjectPackageManager, scriptName: string): string {
  if (packageManager === 'npm') {
    return scriptName === 'test' ? 'npm test' : `npm run ${scriptName}`;
  }
  if (packageManager === 'yarn') {
    return `yarn ${scriptName}`;
  }
  if (packageManager === 'bun') {
    return `bun run ${scriptName}`;
  }
  if (packageManager === 'pnpm') {
    return `pnpm run ${scriptName}`;
  }
  return `npm run ${scriptName}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
