import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const allowedPackageFiles = [
  '.vscodeignore',
  'package.json',
  'README.md',
  'dist/extension.js',
  'dist/extension.js.map',
  'dist/webview.js',
  'dist/webview.js.map',
  'dist/index.html',
  'docs/vscode-smoke-test.md',
  'docs/goal-completion-audit.md',
];
const allowed = new Set(allowedPackageFiles);
const required = allowedPackageFiles;
const forbiddenPrefixes = [
  '.claude/',
  '.npm-cache/',
  '.superpowers/',
  '.vscode/',
  '.vscode-test/',
  'docs/superpowers/',
  'scripts/',
  'src/',
  'tests/',
];
const forbiddenFiles = new Set(['foo.ts']);
const ignoredRuntimeExternalPackages = new Set(['vscode']);
const builtinModuleNames = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
]);

export function verifyPackageFiles(fileList) {
  const files = new Set(fileList);
  const missing = required.filter((file) => !files.has(file));
  const forbidden = [...files].filter((file) =>
    forbiddenFiles.has(file) ||
    forbiddenPrefixes.some((prefix) => file.startsWith(prefix)));
  const unexpected = [...files].filter((file) => !allowed.has(file));
  return {
    ok: missing.length === 0 && forbidden.length === 0 && unexpected.length === 0,
    missing,
    forbidden,
    unexpected,
  };
}

export function verifyRuntimeExternalDependencies(bundleText, dependencies) {
  const declaredDependencies = new Set(Object.keys(dependencies ?? {}));
  const missing = [...runtimeExternalPackageNames(bundleText)]
    .filter((packageName) => !declaredDependencies.has(packageName))
    .sort();

  return {
    ok: missing.length === 0,
    missing,
  };
}

function runtimeExternalPackageNames(bundleText) {
  const packageNames = new Set();
  const requirePattern = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g;

  for (const match of bundleText.matchAll(requirePattern)) {
    const packageName = packageNameFromSpecifier(match[2]);
    if (packageName) {
      packageNames.add(packageName);
    }
  }

  return packageNames;
}

function packageNameFromSpecifier(specifier) {
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('file:') ||
    specifier.startsWith('node:') ||
    builtinModuleNames.has(specifier)
  ) {
    return undefined;
  }

  const packageName = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];

  return ignoredRuntimeExternalPackages.has(packageName) ? undefined : packageName;
}

function main() {
  const cachePath = join(process.cwd(), 'node_modules', '.cache', 'gambit-npm-pack');
  mkdirSync(cachePath, { recursive: true });
  const npmArgs = ['pack', '--dry-run', '--json'];
  const npmCommand = resolveNpmCommand(process.env, process.execPath);

  const result = spawnSync(
    npmCommand.command,
    [...npmCommand.args, ...npmArgs],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: packageCacheEnv(process.env, cachePath),
      shell: npmCommand.shell,
    },
  );

  if (result.status !== 0) {
    if (result.error) process.stderr.write(`${result.error}\n`);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  let packuments;
  try {
    packuments = JSON.parse(result.stdout);
  } catch {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error('npm pack --dry-run --json did not return JSON');
  }

  const files = (packuments[0]?.files ?? []).map((file) => file.path);
  const verification = verifyPackageFiles(files);
  const runtimeDependencies = verifyRuntimeExternalDependencies(
    readFileSync(join(process.cwd(), 'dist', 'extension.js'), 'utf8'),
    JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).dependencies,
  );

  if (!verification.ok) {
    writeVerificationErrors(verification);
    process.exit(1);
  }
  if (!runtimeDependencies.ok) {
    writeRuntimeDependencyErrors(runtimeDependencies);
    process.exit(1);
  }

  process.stdout.write(`Package dry-run verified ${files.length} files.\n`);
}

function writeVerificationErrors(verification) {
  if (verification.missing.length > 0) {
    process.stderr.write(`Package is missing required files:\n${verification.missing.map((file) => `- ${file}`).join('\n')}\n`);
  }
  if (verification.forbidden.length > 0) {
    process.stderr.write(`Package includes forbidden files:\n${verification.forbidden.map((file) => `- ${file}`).join('\n')}\n`);
  }
  if (verification.unexpected.length > 0) {
    process.stderr.write(`Package includes unexpected files:\n${verification.unexpected.map((file) => `- ${file}`).join('\n')}\n`);
  }
}

function writeRuntimeDependencyErrors(verification) {
  process.stderr.write(`Package runtime bundle references undeclared dependencies:\n${verification.missing.map((file) => `- ${file}`).join('\n')}\n`);
}

function resolveNpmCommand(env, nodeExecPath) {
  if (env.npm_execpath) {
    return { command: nodeExecPath, args: [env.npm_execpath], shell: false };
  }

  if (process.platform === 'win32') {
    const npmCli = join(dirname(nodeExecPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (existsSync(npmCli)) {
      return { command: nodeExecPath, args: [npmCli], shell: false };
    }
  }

  return { command: 'npm', args: [], shell: false };
}

function packageCacheEnv(env, cache) {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (key.toLowerCase() === 'npm_config_cache') {
      delete next[key];
    }
  }
  next.npm_config_cache = cache;
  return next;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
