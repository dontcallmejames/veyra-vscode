import { execFileSync } from 'node:child_process';
import { accessSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SETUP = {
  code: 'Install VS Code and ensure the `code` command is on PATH.',
  node: 'Install Node.js and ensure the `node` command is on PATH so Gambit can launch wrapped Codex/Gemini JS-bundle CLIs, or configure native Codex/Gemini executable paths.',
  claudeInstall: 'Install Claude Code, then run `claude /login`.',
  claudeAuth: 'Run `claude /login`.',
  codexInstall: 'Install with `npm install -g @openai/codex`, then run `codex login`.',
  codexAuth: 'Run `codex login`.',
  geminiInstall: 'Install with `npm install -g @google/gemini-cli`, then run `gemini` once.',
  geminiAuth: 'Run `gemini` once to complete OAuth.',
};

export function evaluateLiveReadiness(input) {
  input = normalizeReadinessInput(input);
  const nodeCheck = checkNode(input);
  const checks = [
    checkCommand('VS Code CLI', 'code', input.commandAvailable, SETUP.code),
    nodeCheck,
    checkClaude(input),
    checkCodex(input),
    checkGemini(input),
  ];

  return {
    ok: checks.every((check) => check.status === 'ready'),
    checks,
    diagnostics: readinessDiagnostics(input),
  };
}

function checkCommand(name, command, commandAvailable, setup) {
  return commandAvailable(command)
    ? { name, status: 'ready', detail: '' }
    : { name, status: 'not-installed', detail: setup };
}

function checkNode(input) {
  if (input.commandAvailable('node')) {
    return { name: 'Node.js CLI', status: 'ready', detail: '' };
  }
  if (selectedCliPathsRequireNode(input)) {
    return { name: 'Node.js CLI', status: 'not-installed', detail: SETUP.node };
  }
  return {
    name: 'Node.js CLI',
    status: 'ready',
    detail: 'not required because Codex and Gemini resolve to native executable paths.',
  };
}

function selectedCliPathsRequireNode(input) {
  return selectedCodexPathRequiresNode(input) || selectedGeminiPathRequiresNode(input);
}

function selectedCodexPathRequiresNode(input) {
  return selectedWindowsCliPathRequiresNode(input, 'codex', 'codex.exe');
}

function selectedGeminiPathRequiresNode(input) {
  return selectedWindowsCliPathRequiresNode(input, 'gemini', 'gemini.exe');
}

function selectedWindowsCliPathRequiresNode(input, runtime, nativeCommand) {
  const override = input.cliOverrides?.[runtime];
  if (override) return requiresNode(override);
  if (input.platform !== 'win32') return true;

  const nativeStatus = windowsNativeExecutableStatus(input, nativeCommand);
  if (nativeStatus.status === 'exists' || nativeStatus.status === 'inaccessible') return false;
  const shimStatus = windowsNpmShimStatus(input, runtime);
  if (shimStatus.status === 'exists' || shimStatus.status === 'inaccessible') return true;
  return Boolean(input.npmRoot);
}

function checkClaude(input) {
  if (!input.commandAvailable('claude')) {
    return { name: 'Claude Code', status: 'not-installed', detail: SETUP.claudeInstall };
  }
  const authPath = join(input.homeDir, '.claude', '.credentials.json');
  const authStatus = fileProbeStatus(input, authPath);
  if (authStatus === 'inaccessible') {
    return { name: 'Claude Code', status: 'inaccessible', detail: inaccessibleDetail(authPath) };
  }
  if (authStatus === 'missing') {
    return { name: 'Claude Code', status: 'unauthenticated', detail: SETUP.claudeAuth };
  }
  return { name: 'Claude Code', status: 'ready', detail: '' };
}

function checkCodex(input) {
  if (input.platform === 'win32') {
    if (!input.cliOverrides?.codex) {
      const nativeStatus = windowsNativeExecutableStatus(input, 'codex.exe');
      if (nativeStatus.status === 'exists') {
        return checkCodexAuth(input);
      }
      if (nativeStatus.status === 'inaccessible') {
        return {
          name: 'Codex CLI',
          status: 'inaccessible',
          detail: inaccessibleDetail(nativeStatus.path, 'GAMBIT_CODEX_CLI_PATH', 'gambit.codexCliPath'),
        };
      }
      const shimStatus = windowsNpmShimStatus(input, 'codex');
      if (shimStatus.status === 'exists') {
        return checkCodexAuth(input);
      }
      if (shimStatus.status === 'inaccessible') {
        return {
          name: 'Codex CLI',
          status: 'inaccessible',
          detail: inaccessibleDetail(shimStatus.path, 'GAMBIT_CODEX_CLI_PATH', 'gambit.codexCliPath'),
        };
      }
    }
    const bundle = input.cliOverrides?.codex || (input.npmRoot ? join(input.npmRoot, '@openai', 'codex', 'bin', 'codex.js') : null);
    if (!bundle) {
      return { name: 'Codex CLI', status: 'not-installed', detail: SETUP.codexInstall };
    }
    if (input.cliOverrides?.codex && isUnsupportedWindowsCommandShim(bundle)) {
      return { name: 'Codex CLI', status: 'inaccessible', detail: windowsShimOverrideDetail('Codex', 'GAMBIT_CODEX_CLI_PATH', 'gambit.codexCliPath') };
    }
    if (input.cliOverrides?.codex) {
      const misconfiguration = cliPathMisconfiguration('codex', bundle);
      if (misconfiguration) {
        return { name: 'Codex CLI', status: 'misconfigured', detail: misconfiguration };
      }
    }
    const bundleStatus = fileProbeStatus(input, bundle);
    if (bundleStatus === 'inaccessible') {
      return { name: 'Codex CLI', status: 'inaccessible', detail: inaccessibleDetail(bundle, 'GAMBIT_CODEX_CLI_PATH', 'gambit.codexCliPath', 'codex.exe') };
    }
    if (bundleStatus === 'missing') {
      return { name: 'Codex CLI', status: 'not-installed', detail: SETUP.codexInstall };
    }
  } else if (!input.commandAvailable('codex')) {
    return { name: 'Codex CLI', status: 'not-installed', detail: SETUP.codexInstall };
  }

  return checkCodexAuth(input);
}

function checkCodexAuth(input) {
  const authPath = join(input.homeDir, '.codex', 'auth.json');
  const authStatus = fileProbeStatus(input, authPath);
  if (authStatus === 'inaccessible') {
    return { name: 'Codex CLI', status: 'inaccessible', detail: inaccessibleDetail(authPath) };
  }
  if (authStatus === 'missing') {
    return { name: 'Codex CLI', status: 'unauthenticated', detail: SETUP.codexAuth };
  }
  return { name: 'Codex CLI', status: 'ready', detail: '' };
}

function checkGemini(input) {
  if (input.platform === 'win32') {
    if (!input.cliOverrides?.gemini) {
      const nativeStatus = windowsNativeExecutableStatus(input, 'gemini.exe');
      if (nativeStatus.status === 'exists') {
        return checkGeminiAuth(input);
      }
      if (nativeStatus.status === 'inaccessible') {
        return {
          name: 'Gemini CLI',
          status: 'inaccessible',
          detail: inaccessibleDetail(nativeStatus.path, 'GAMBIT_GEMINI_CLI_PATH', 'gambit.geminiCliPath'),
        };
      }
      const shimStatus = windowsNpmShimStatus(input, 'gemini');
      if (shimStatus.status === 'exists') {
        return checkGeminiAuth(input);
      }
      if (shimStatus.status === 'inaccessible') {
        return {
          name: 'Gemini CLI',
          status: 'inaccessible',
          detail: inaccessibleDetail(shimStatus.path, 'GAMBIT_GEMINI_CLI_PATH', 'gambit.geminiCliPath'),
        };
      }
    }
    const bundle = input.cliOverrides?.gemini || (input.npmRoot ? join(input.npmRoot, '@google', 'gemini-cli', 'bundle', 'gemini.js') : null);
    if (!bundle) {
      return { name: 'Gemini CLI', status: 'not-installed', detail: SETUP.geminiInstall };
    }
    if (input.cliOverrides?.gemini && isUnsupportedWindowsCommandShim(bundle)) {
      return { name: 'Gemini CLI', status: 'inaccessible', detail: windowsShimOverrideDetail('Gemini', 'GAMBIT_GEMINI_CLI_PATH', 'gambit.geminiCliPath') };
    }
    if (input.cliOverrides?.gemini) {
      const misconfiguration = cliPathMisconfiguration('gemini', bundle);
      if (misconfiguration) {
        return { name: 'Gemini CLI', status: 'misconfigured', detail: misconfiguration };
      }
    }
    const bundleStatus = fileProbeStatus(input, bundle);
    if (bundleStatus === 'inaccessible') {
      return { name: 'Gemini CLI', status: 'inaccessible', detail: inaccessibleDetail(bundle, 'GAMBIT_GEMINI_CLI_PATH', 'gambit.geminiCliPath', 'gemini.exe') };
    }
    if (bundleStatus === 'missing') {
      return { name: 'Gemini CLI', status: 'not-installed', detail: SETUP.geminiInstall };
    }
  } else if (!input.commandAvailable('gemini')) {
    return { name: 'Gemini CLI', status: 'not-installed', detail: SETUP.geminiInstall };
  }

  return checkGeminiAuth(input);
}

function checkGeminiAuth(input) {
  const authPath = join(input.homeDir, '.gemini', 'oauth_creds.json');
  const authStatus = fileProbeStatus(input, authPath);
  if (authStatus === 'inaccessible') {
    return { name: 'Gemini CLI', status: 'inaccessible', detail: inaccessibleDetail(authPath) };
  }
  if (authStatus === 'missing') {
    return { name: 'Gemini CLI', status: 'unauthenticated', detail: SETUP.geminiAuth };
  }
  return { name: 'Gemini CLI', status: 'ready', detail: '' };
}

function windowsNativeExecutableStatus(input, command) {
  if (!input.commandAvailable(command)) return { status: 'missing' };
  if (typeof input.commandPath !== 'function') return { status: 'exists' };

  const resolvedPath = input.commandPath(command);
  if (!resolvedPath) return { status: 'exists' };
  if (!resolvedPath.toLowerCase().endsWith(command.toLowerCase())) return { status: 'missing' };

  const status = fileProbeStatus(input, resolvedPath);
  return status === 'inaccessible'
    ? { status, path: resolvedPath }
    : { status, path: resolvedPath };
}

function windowsNpmShimStatus(input, runtime) {
  for (const shimName of windowsNpmShimNames(runtime)) {
    if (!input.commandAvailable(shimName)) continue;
    if (typeof input.commandPath !== 'function') continue;

    const shimPath = input.commandPath(shimName);
    if (!shimPath || !isWindowsNpmShimPath(runtime, shimPath)) continue;

    const bundle = normalizeCliPathOverride(runtime, shimPath);
    const status = fileProbeStatus(input, bundle);
    if (status === 'exists' || status === 'inaccessible') {
      return { status, path: bundle, shimPath };
    }
  }

  return { status: 'missing' };
}

function fileProbeStatus(input, filePath) {
  if (typeof input.fileStatus === 'function') {
    return input.fileStatus(filePath);
  }
  return input.fileExists(filePath) ? 'exists' : 'missing';
}

function fileStatus(filePath) {
  try {
    accessSync(filePath);
    return 'exists';
  } catch (error) {
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      return 'inaccessible';
    }
    return 'missing';
  }
}

function inaccessibleDetail(filePath, overrideVariable, settingKey, nativeExecutable) {
  const setting = settingKey ? ` or ${settingKey} in .vscode/settings.json` : '';
  const nativePath = nativeExecutable ? ` put native ${nativeExecutable} on PATH, or` : '';
  const override = overrideVariable ? ` If this is a sandboxed Windows npm global package path,${nativePath} set ${overrideVariable}${setting} to the CLI JS bundle, native executable, or Windows npm shim and retry.` : '';
  return `Cannot inspect ${filePath}. Check filesystem permissions or rerun outside the current sandbox, then retry.${override}`;
}

function isUnsupportedWindowsCommandShim(filePath) {
  return /\.(cmd|bat|ps1)$/i.test(filePath);
}

function normalizeReadinessInput(input) {
  return {
    ...input,
    cliOverrides: {
      codex: input.cliOverrides?.codex ? normalizeCliPathOverride('codex', input.cliOverrides.codex) : undefined,
      gemini: input.cliOverrides?.gemini ? normalizeCliPathOverride('gemini', input.cliOverrides.gemini) : undefined,
    },
  };
}

function normalizeCliPathOverride(runtime, filePath) {
  const trimmed = filePath.trim();
  if (!isWindowsNpmShimPath(runtime, trimmed)) return trimmed;
  return join(
    dirnameFromPath(trimmed),
    ...windowsNpmBundleSegments(runtime),
  );
}

function isWindowsNpmShimPath(runtime, filePath) {
  const baseName = filePath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  return windowsNpmShimNames(runtime).includes(baseName);
}

function windowsNpmShimNames(runtime) {
  return [`${runtime}.cmd`, `${runtime}.bat`, `${runtime}.ps1`];
}

function dirnameFromPath(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  if (index < 0) return '.';
  return filePath.slice(0, index);
}

function windowsNpmBundleSegments(runtime) {
  return runtime === 'codex'
    ? ['node_modules', '@openai', 'codex', 'bin', 'codex.js']
    : ['node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js'];
}

function requiresNode(filePath) {
  return /\.js$/i.test(filePath);
}

function windowsShimOverrideDetail(label, overrideVariable, settingKey) {
  return `Windows npm command shims are not supported for live validation. Set ${overrideVariable} or ${settingKey} in .vscode/settings.json to the ${label} JS bundle or native executable instead.`;
}

export function cliPathMisconfiguration(runtime, filePath) {
  const baseName = filePath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  const expected = [`${runtime}.js`, `${runtime}.exe`, runtime];
  if (expected.includes(baseName)) return null;
  const label = runtime === 'codex' ? 'Codex' : 'Gemini';
  return `${label} CLI path override must point to ${formatExpectedNames(expected)}. Received ${filePath}.`;
}

function formatExpectedNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')}, or ${names[names.length - 1]}`;
}

function commandAvailable(command) {
  if (process.platform === 'win32') {
    try {
      execFileSync('where.exe', [command], { stdio: 'ignore', windowsHide: true });
      return true;
    } catch {
      if (!/^[A-Za-z0-9_.-]+$/.test(command)) return false;
      try {
        execFileSync(
          'powershell.exe',
          ['-NoProfile', '-Command', `Get-Command ${command} -ErrorAction Stop | Out-Null`],
          { stdio: 'ignore', windowsHide: true },
        );
        return true;
      } catch {
        return false;
      }
    }
  }

  try {
    execFileSync('which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function commandPath(command) {
  if (process.platform === 'win32') {
    try {
      const output = execFileSync('where.exe', [command], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      return firstCommandPath(output);
    } catch {
      if (!/^[A-Za-z0-9_.-]+$/.test(command)) return null;
      try {
        const output = execFileSync(
          'powershell.exe',
          ['-NoProfile', '-Command', `(Get-Command ${command} -ErrorAction Stop).Source`],
          {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
          },
        );
        return firstCommandPath(output);
      } catch {
        return null;
      }
    }
  }

  try {
    const output = execFileSync('which', [command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return firstCommandPath(output);
  } catch {
    return null;
  }
}

function firstCommandPath(output) {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean) ?? null;
}

export function npmRootGlobal(env = process.env, execFile = execFileSync, nodeExecPath = process.execPath) {
  try {
    const npmExecPath = env.npm_execpath;
    const command = npmExecPath ? nodeExecPath : 'npm';
    const args = npmExecPath ? [npmExecPath, 'root', '-g'] : ['root', '-g'];
    return execFile(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

export function resolveCliOverrides({
  env = process.env,
  cwd = process.cwd(),
  fileExists = existsSync,
  readFile = readFileSync,
} = {}) {
  const settings = readWorkspaceCliOverrides(cwd, fileExists, readFile);
  return {
    codex: normalizeOverride(env.GAMBIT_CODEX_CLI_PATH) || settings.codex,
    gemini: normalizeOverride(env.GAMBIT_GEMINI_CLI_PATH) || settings.gemini,
  };
}

function readWorkspaceCliOverrides(cwd, fileExists, readFile) {
  const settingsPath = join(cwd, '.vscode', 'settings.json');
  if (!fileExists(settingsPath)) return {};

  try {
    const settings = JSON.parse(stripTrailingCommas(stripJsonComments(readFile(settingsPath, 'utf8'))));
    return {
      codex: normalizeOverride(settings['gambit.codexCliPath']),
      gemini: normalizeOverride(settings['gambit.geminiCliPath']),
    };
  } catch {
    return {};
  }
}

function normalizeOverride(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function currentLiveReadiness({
  env = process.env,
  cwd = process.cwd(),
  fileExists = existsSync,
  readFile = readFileSync,
  fileStatusProbe = fileStatus,
  commandProbe = commandAvailable,
  commandPathProbe = commandPath,
  homeDir = homedir(),
  npmRoot = npmRootGlobal(env),
  platform = process.platform,
} = {}) {
  const cliOverrides = resolveCliOverrides({ env, cwd, fileExists, readFile });
  return evaluateLiveReadiness({
    commandAvailable: commandProbe,
    commandPath: commandPathProbe,
    fileExists,
    fileStatus: fileStatusProbe,
    homeDir,
    npmRoot,
    platform,
    cliOverrides,
  });
}

export function liveReadinessFailure(result) {
  return [
    'No paid model prompts were sent. Fix the items below before running live integration tests.',
    ...formatLiveTestCommandGuidance(),
    '',
    'Gambit live readiness:',
    ...formatCheckLines(result),
    ...formatDiagnosticSection(result),
    ...formatUnrestrictedPowerShellDiagnostics(result),
  ].join('\n');
}

export function liveReadinessSuccess(_result, env = process.env) {
  const lines = [
    '',
    'All live prerequisites are ready.',
  ];

  if (env.npm_lifecycle_event !== 'pretest:integration:live') {
    lines.push(
      '',
      'Next paid validation step:',
      "  $env:GAMBIT_RUN_LIVE = '1'",
      '  npm run test:integration:live',
      '  Remove-Item Env:\\GAMBIT_RUN_LIVE -ErrorAction SilentlyContinue',
    );
  }

  return lines.join('\n');
}

export function assertLiveReadiness(result = currentLiveReadiness()) {
  if (!result.ok) {
    throw new Error(liveReadinessFailure(result));
  }
}

function stripJsonComments(source) {
  let output = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];

    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      if (i < source.length) output += '\n';
      continue;
    }

    if (char === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') output += '\n';
        i++;
      }
      i++;
      continue;
    }

    output += char;
  }

  return output;
}

function stripTrailingCommas(source) {
  let output = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];

    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === ',') {
      let j = i + 1;
      while (j < source.length && /\s/.test(source[j])) j++;
      if (source[j] === '}' || source[j] === ']') continue;
    }

    output += char;
  }

  return output;
}

function formatCheckLines(result) {
  return result.checks.map((check) => {
    const detail = check.detail ? ` - ${check.detail}` : '';
    return `[${check.status}] ${check.name}${detail}`;
  });
}

function formatDiagnosticSection(result) {
  if (!Array.isArray(result.diagnostics) || result.diagnostics.length === 0) return [];
  return [
    '',
    'Readiness context:',
    ...result.diagnostics.map((line) => `- ${line}`),
  ];
}

function readinessDiagnostics(input) {
  const lines = [
    `GAMBIT_CODEX_CLI_PATH / gambit.codexCliPath: ${formatCliOverride(input.cliOverrides?.codex)}`,
    `GAMBIT_GEMINI_CLI_PATH / gambit.geminiCliPath: ${formatCliOverride(input.cliOverrides?.gemini)}`,
  ];

  if (input.platform === 'win32') {
    lines.push(`Windows native codex.exe: ${formatNativeExecutableStatus(windowsNativeExecutableStatus(input, 'codex.exe'))}`);
    lines.push(`Windows native gemini.exe: ${formatNativeExecutableStatus(windowsNativeExecutableStatus(input, 'gemini.exe'))}`);
    lines.push(`Windows npm Codex shim: ${formatWindowsNpmShimStatus(windowsNpmShimStatus(input, 'codex'))}`);
    lines.push(`Windows npm Gemini shim: ${formatWindowsNpmShimStatus(windowsNpmShimStatus(input, 'gemini'))}`);
    lines.push(`npm global Codex shim: ${formatNpmGlobalShimStatus(npmGlobalShimStatus(input, 'codex'))}`);
    lines.push(`npm global Gemini shim: ${formatNpmGlobalShimStatus(npmGlobalShimStatus(input, 'gemini'))}`);
  }

  lines.push(`npm root -g: ${input.npmRoot || 'unavailable'}`);
  return lines;
}

function formatCliOverride(value) {
  return value ? `set to ${value}` : 'unset';
}

function formatNativeExecutableStatus(status) {
  if (status.status === 'exists') return status.path ? `found at ${status.path}` : 'found';
  if (status.status === 'inaccessible') return `inaccessible at ${status.path}`;
  return 'missing';
}

function formatWindowsNpmShimStatus(status) {
  if (status.status === 'exists') return `found at ${status.shimPath} -> ${status.path}`;
  if (status.status === 'inaccessible') return `found at ${status.shimPath} but target is inaccessible at ${status.path}`;
  return 'missing';
}

function npmGlobalShimStatus(input, runtime) {
  if (!input.npmRoot) return { status: 'unavailable' };
  const npmBin = dirnameFromPath(input.npmRoot);
  for (const shimName of windowsNpmShimNames(runtime)) {
    const shimPath = join(npmBin, shimName);
    const status = fileProbeStatus(input, shimPath);
    if (status === 'exists' || status === 'inaccessible') {
      return { status, path: shimPath };
    }
  }
  return { status: 'missing' };
}

function formatNpmGlobalShimStatus(status) {
  if (status.status === 'exists') return `found at ${status.path}`;
  if (status.status === 'inaccessible') return `inaccessible at ${status.path}`;
  if (status.status === 'unavailable') return 'not checked because npm root is unavailable';
  return 'missing';
}

function printReadiness(result) {
  process.stdout.write('Gambit live readiness:\n');
  process.stdout.write(`${formatCheckLines(result).join('\n')}\n`);
  if (result.ok) {
    process.stdout.write(`${liveReadinessSuccess(result, process.env)}\n`);
  }
  if (!result.ok && result.diagnostics?.length) {
    process.stdout.write(`\nReadiness context:\n${result.diagnostics.map((line) => `- ${line}`).join('\n')}\n`);
  }
  if (!result.ok) {
    const diagnostics = formatUnrestrictedPowerShellDiagnostics(result);
    if (diagnostics.length) {
      process.stdout.write(`${diagnostics.join('\n')}\n`);
    }
  }
  if (!result.ok) {
    process.stdout.write(`\nNo paid model prompts were sent. Fix the items above before running live integration tests.\n${formatLiveTestCommandGuidance().join('\n')}\n`);
  }
}

function formatUnrestrictedPowerShellDiagnostics(result) {
  const paths = inaccessibleCliPaths(result);
  if (!paths.codex && !paths.gemini) return [];

  const lines = [
    '',
    'Unrestricted PowerShell diagnostics:',
    '  # Run these from a normal PowerShell terminal in this workspace.',
  ];
  if (paths.codex) {
    lines.push(`  Test-Path -LiteralPath ${powerShellSingleQuoted(paths.codex)}`);
  }
  if (paths.gemini) {
    lines.push(`  Test-Path -LiteralPath ${powerShellSingleQuoted(paths.gemini)}`);
  }
  lines.push('  # If Test-Path returns True, point Gambit at the exact inspectable CLI paths:');
  if (paths.codex) {
    lines.push(`  $env:GAMBIT_CODEX_CLI_PATH = ${powerShellSingleQuoted(paths.codex)}`);
  }
  if (paths.gemini) {
    lines.push(`  $env:GAMBIT_GEMINI_CLI_PATH = ${powerShellSingleQuoted(paths.gemini)}`);
  }
  lines.push('  npm run verify:live-ready');
  return lines;
}

function inaccessibleCliPaths(result) {
  const paths = {};
  for (const check of result.checks ?? []) {
    if (check.status !== 'inaccessible' || typeof check.detail !== 'string') continue;
    const match = check.detail.match(/^Cannot inspect (.+?)\. Check filesystem permissions/);
    if (!match) continue;
    if (check.name === 'Codex CLI') paths.codex = match[1];
    if (check.name === 'Gemini CLI') paths.gemini = match[1];
  }
  return paths;
}

function powerShellSingleQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function formatLiveTestCommandGuidance() {
  return [
    '',
    'PowerShell:',
    "  $env:GAMBIT_RUN_LIVE = '1'",
    '  npm run verify:goal',
    '  Remove-Item Env:\\GAMBIT_RUN_LIVE -ErrorAction SilentlyContinue',
    '',
    'Or run only the live integration suite:',
    "  $env:GAMBIT_RUN_LIVE = '1'",
    '  npm run test:integration:live',
    '  Remove-Item Env:\\GAMBIT_RUN_LIVE -ErrorAction SilentlyContinue',
    '',
    'Bash-compatible shells:',
    '  GAMBIT_RUN_LIVE=1 npm run verify:goal',
    '',
    'Or run only the live integration suite:',
    '  GAMBIT_RUN_LIVE=1 npm run test:integration:live',
  ];
}

function main() {
  const result = currentLiveReadiness();
  printReadiness(result);
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
