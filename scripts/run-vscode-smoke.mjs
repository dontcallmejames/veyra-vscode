import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export function smokePaths(rootDir = process.cwd()) {
  const testRoot = join(rootDir, '.vscode-test');
  return {
    rootDir,
    userDataDir: join(testRoot, 'user-data'),
    extensionsDir: join(testRoot, 'extensions'),
    workspaceDir: join(testRoot, 'workspace'),
    smokeResultPath: join(testRoot, 'smoke-result.json'),
    extensionEntryPath: join(rootDir, 'dist', 'extension.js'),
    extensionTestsPath: join(rootDir, 'tests', 'extension-host', 'smoke.js'),
  };
}

export function buildCodeSmokeArgs(paths) {
  return [
    '--new-window',
    '--wait',
    '--disable-extensions',
    '--disable-workspace-trust',
    '--disable-gpu',
    '--disable-chromium-sandbox',
    '--skip-welcome',
    '--skip-release-notes',
    `--extensionDevelopmentPath=${paths.rootDir}`,
    `--extensionTestsPath=${paths.extensionTestsPath}`,
    `--user-data-dir=${paths.userDataDir}`,
    `--extensions-dir=${paths.extensionsDir}`,
    paths.workspaceDir,
  ];
}

export function buildCodeSmokeEnv(paths, baseEnv = process.env) {
  return {
    ...baseEnv,
    VSCODE_GAMBIT_SMOKE: '1',
    VSCODE_GAMBIT_SMOKE_RESULT: paths.smokeResultPath,
  };
}

export function buildCodeSpawnInvocation(codeCommand, args, platform = process.platform) {
  if (platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        'call',
        codeCommand,
        ...args,
      ],
      shell: false,
    };
  }

  return {
    command: codeCommand,
    args,
    shell: false,
  };
}

export function resolveCodeCommand(codeCommand, platform = process.platform, execFile = execFileSync) {
  if (platform !== 'win32' || codeCommand !== 'code') return codeCommand;

  try {
    const source = execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', '(Get-Command code -ErrorAction Stop).Source'],
      { encoding: 'utf8', windowsHide: true },
    ).toString().trim();
    return source || codeCommand;
  } catch {
    return codeCommand;
  }
}

export function findMissingSmokePrerequisites(paths, fileExists = existsSync) {
  return [
    paths.extensionEntryPath,
    paths.extensionTestsPath,
  ].filter((filePath) => !fileExists(filePath));
}

export const requiredSmokeLanguageModels = {
  'gambit-orchestrator': {
    name: 'Gambit',
    family: 'gambit',
    version: 'local-cli',
    maxInputTokens: 128000,
  },
  'gambit-review': {
    name: 'Gambit Review',
    family: 'gambit',
    version: 'local-cli',
    maxInputTokens: 128000,
  },
  'gambit-debate': {
    name: 'Gambit Debate',
    family: 'gambit',
    version: 'local-cli',
    maxInputTokens: 128000,
  },
  'gambit-implement': {
    name: 'Gambit Implement',
    family: 'gambit',
    version: 'local-cli',
    maxInputTokens: 128000,
  },
  'gambit-claude': {
    name: 'Claude via Gambit',
    family: 'claude',
    version: 'local-cli',
    maxInputTokens: 128000,
  },
  'gambit-codex': {
    name: 'Codex via Gambit',
    family: 'codex',
    version: 'local-cli',
    maxInputTokens: 128000,
  },
  'gambit-gemini': {
    name: 'Gemini via Gambit',
    family: 'gemini',
    version: 'local-cli',
    maxInputTokens: 128000,
  },
};

export const requiredSmokeChatParticipants = {
  'gambit.gambit': {
    name: 'gambit',
    commands: ['review', 'debate', 'implement'],
  },
  'gambit.claude': {
    name: 'claude',
    commands: [],
  },
  'gambit.codex': {
    name: 'codex',
    commands: [],
  },
  'gambit.gemini': {
    name: 'gemini',
    commands: [],
  },
};

export const requiredSmokeLanguageModelResponseMarkers = {
  'gambit-orchestrator': [
    'Routed to Codex',
    '[smoke:codex] write-capable request reached Gambit provider.',
  ],
  'gambit-review': [
    '[smoke:claude] read-only request reached Gambit provider.',
    '[smoke:codex] read-only request reached Gambit provider.',
    '[smoke:gemini] read-only request reached Gambit provider.',
  ],
  'gambit-debate': [
    '[smoke:claude] read-only request reached Gambit provider.',
    '[smoke:codex] read-only request reached Gambit provider.',
    '[smoke:gemini] read-only request reached Gambit provider.',
  ],
  'gambit-implement': [
    '[smoke:claude] write-capable request reached Gambit provider.',
    '[smoke:codex] write-capable request reached Gambit provider.',
    '[smoke:gemini] write-capable request reached Gambit provider.',
  ],
  'gambit-claude': [
    '[smoke:claude] write-capable request reached Gambit provider.',
  ],
  'gambit-codex': [
    '[smoke:codex] write-capable request reached Gambit provider.',
  ],
  'gambit-gemini': [
    '[smoke:gemini] write-capable request reached Gambit provider.',
  ],
};

export const requiredSmokeNativeWorkflows = {
  review: { forcedTarget: 'gambit', readOnly: true },
  debate: { forcedTarget: 'gambit', readOnly: true },
  implement: { forcedTarget: 'gambit', readOnly: false },
};

export const requiredSmokeNativeChatResponseMarkers = {
  'gambit.gambit': [
    'Routed to Codex',
    '[smoke:codex] write-capable request reached Gambit provider.',
  ],
  'gambit.gambit/review': [
    '[smoke:claude] read-only request reached Gambit provider.',
    '[smoke:codex] read-only request reached Gambit provider.',
    '[smoke:gemini] read-only request reached Gambit provider.',
  ],
  'gambit.gambit/debate': [
    '[smoke:claude] read-only request reached Gambit provider.',
    '[smoke:codex] read-only request reached Gambit provider.',
    '[smoke:gemini] read-only request reached Gambit provider.',
  ],
  'gambit.gambit/implement': [
    '[smoke:claude] write-capable request reached Gambit provider.',
    '[smoke:codex] write-capable request reached Gambit provider.',
    '[smoke:gemini] write-capable request reached Gambit provider.',
  ],
  'gambit.claude': [
    '[smoke:claude] write-capable request reached Gambit provider.',
  ],
  'gambit.codex': [
    '[smoke:codex] write-capable request reached Gambit provider.',
  ],
  'gambit.gemini': [
    '[smoke:gemini] write-capable request reached Gambit provider.',
  ],
};

const readOnlySmokeLanguageModels = new Set(['gambit-review', 'gambit-debate']);
const readOnlySmokeNativeChatRequests = new Set(['gambit.gambit/review', 'gambit.gambit/debate']);
const smokeAgentEditFiles = {
  claude: 'src/gambit-smoke-claude.ts',
  codex: 'src/gambit-smoke-codex.ts',
  gemini: 'src/gambit-smoke-gemini.ts',
};
const smokeConflictFilePath = 'src/gambit-smoke-conflict.ts';
const smokeAgentLabels = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
};
const requiredSharedContextMarkers = [
  '[smoke:codex] saw prior Claude reply in shared context.',
  '[smoke:gemini] saw prior Claude and Codex replies in shared context.',
];
const requiredToolContextMarker = '[smoke:codex] saw VS Code request tool workspaceSearch in provider context.';
const requiredModelOptionsContextMarker = '[smoke:codex] saw VS Code model option temperature in provider context.';
const requiredSmokeNativeVisibleEditEvidence = {
  'gambit.gambit': ['codex'],
  'gambit.gambit/implement': ['claude', 'codex', 'gemini'],
  'gambit.claude': ['claude'],
  'gambit.codex': ['codex'],
  'gambit.gemini': ['gemini'],
};
const requiredSmokeLanguageModelVisibleEditEvidence = {
  'gambit-orchestrator': ['codex'],
  'gambit-implement': ['claude', 'codex', 'gemini'],
  'gambit-claude': ['claude'],
  'gambit-codex': ['codex'],
  'gambit-gemini': ['gemini'],
};

export function validateSmokeResultContent(content) {
  const requiredCommands = [
    'gambit.checkStatus',
    'gambit.openPanel',
    'gambit.showSetupGuide',
    'gambit.showLiveValidationGuide',
    'gambit.configureCliPaths',
    'gambit.installCommitHook',
    'gambit.uninstallCommitHook',
    'gambit.showCommitHookSnippet',
  ];
  const errors = [];
  let result;
  try {
    result = JSON.parse(content);
  } catch {
    return ['Smoke result is not valid JSON.'];
  }

  if (result.ok !== true) {
    errors.push('Smoke result did not report ok: true.');
  }
  if (result.extensionId !== 'dontcallmejames.gambit-vscode') {
    errors.push('Smoke result did not report extensionId dontcallmejames.gambit-vscode.');
  }

  const executed = new Set(Array.isArray(result.executedCommands) ? result.executedCommands : []);
  for (const command of requiredCommands) {
    if (!executed.has(command)) {
      errors.push(`Missing smoke command execution: ${command}`);
    }
  }

  const tokenCounts = result.languageModelTokenCounts;
  const metadata = result.languageModelMetadata;
  const responses = result.languageModelResponses;
  const participants = Array.isArray(result.chatParticipants) ? result.chatParticipants : [];
  const registeredParticipants = new Set(
    Array.isArray(result.nativeChatRegistrations) ? result.nativeChatRegistrations : [],
  );
  const nativeWorkflowDiagnostics = result.nativeWorkflowDiagnostics;
  const nativeChatResponses = result.nativeChatResponses;
  for (const [participantId, expectedParticipant] of Object.entries(requiredSmokeChatParticipants)) {
    const actualParticipant = participants.find((participant) => participant?.id === participantId);
    if (!actualParticipant || typeof actualParticipant !== 'object') {
      errors.push(`Missing native chat participant evidence: ${participantId}`);
      continue;
    }
    if (actualParticipant.name !== expectedParticipant.name) {
      errors.push(`Unexpected native chat participant metadata for ${participantId}: name`);
    }
    const actualCommands = Array.isArray(actualParticipant.commands) ? actualParticipant.commands : [];
    for (const command of expectedParticipant.commands) {
      if (!actualCommands.includes(command)) {
        errors.push(`Missing native chat participant command evidence: ${participantId}/${command}`);
      }
    }
    if (!registeredParticipants.has(participantId)) {
      errors.push(`Missing native chat registration evidence: ${participantId}`);
    }
  }
  for (const [command, expected] of Object.entries(requiredSmokeNativeWorkflows)) {
    const actual = nativeWorkflowDiagnostics?.[command];
    if (!actual || typeof actual !== 'object') {
      errors.push(`Missing native chat workflow diagnostic: ${command}`);
      continue;
    }
    if (actual.forcedTarget !== expected.forcedTarget) {
      errors.push(`Unexpected native chat workflow diagnostic: ${command} must route through ${expected.forcedTarget}.`);
    }
    if (actual.readOnly !== expected.readOnly) {
      errors.push(`Unexpected native chat workflow diagnostic: ${command} must be ${expected.readOnly ? 'read-only' : 'write-capable'}.`);
    }
    if (actual.containsAllMention !== true) {
      errors.push(`Unexpected native chat workflow diagnostic: ${command} must include @all.`);
    }
    if (actual.containsWorkflowMarker !== true) {
      errors.push(`Unexpected native chat workflow diagnostic: ${command} must include its workflow marker.`);
    }
  }
  for (const [requestKey, markers] of Object.entries(requiredSmokeNativeChatResponseMarkers)) {
    const responseText = nativeChatResponses?.[requestKey];
    if (typeof responseText !== 'string' || responseText.trim().length === 0) {
      errors.push(`Missing native chat response evidence: ${requestKey}`);
      continue;
    }
    for (const marker of markers) {
      if (!responseText.includes(marker)) {
        errors.push(`Unexpected native chat response evidence: ${requestKey} missing ${marker}`);
      }
    }
    if (readOnlySmokeNativeChatRequests.has(requestKey) && responseText.includes('Read-only workflow violation:')) {
      errors.push(`Unexpected native chat response evidence: ${requestKey} reported a read-only workflow violation.`);
    }
    if (readOnlySmokeNativeChatRequests.has(requestKey) && containsSmokeEditFilePath(responseText)) {
      errors.push(`Unexpected native chat response evidence: ${requestKey} surfaced smoke edit evidence during a read-only workflow.`);
    }
    if (containsGambitInternalStatePath(responseText)) {
      errors.push(`Unexpected native chat response evidence: ${requestKey} exposed Gambit internal state path.`);
    }
    for (const agentId of requiredSmokeNativeVisibleEditEvidence[requestKey] ?? []) {
      const missingEvidence = missingNativeSmokeEditEvidence(requestKey, agentId, responseText);
      if (missingEvidence) errors.push(missingEvidence);
    }
  }
  for (const [modelId, expectedMetadata] of Object.entries(requiredSmokeLanguageModels)) {
    const count = tokenCounts?.[modelId];
    if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) {
      errors.push(`Missing language model token count: ${modelId}`);
    }
    const responseText = responses?.[modelId];
    if (typeof responseText !== 'string' || responseText.trim().length === 0) {
      errors.push(`Missing language model response evidence: ${modelId}`);
    } else {
      for (const marker of requiredSmokeLanguageModelResponseMarkers[modelId] ?? []) {
        if (!responseText.includes(marker)) {
          errors.push(`Unexpected language model response evidence: ${modelId} missing ${marker}`);
        }
      }
      if (readOnlySmokeLanguageModels.has(modelId) && responseText.includes('Read-only workflow violation:')) {
        errors.push(`Unexpected language model response evidence: ${modelId} reported a read-only workflow violation.`);
      }
      if (readOnlySmokeLanguageModels.has(modelId) && containsSmokeEditFilePath(responseText)) {
        errors.push(`Unexpected language model response evidence: ${modelId} surfaced smoke edit evidence during a read-only workflow.`);
      }
      if (containsGambitInternalStatePath(responseText)) {
        errors.push(`Unexpected language model response evidence: ${modelId} exposed Gambit internal state path.`);
      }
      for (const agentId of requiredSmokeLanguageModelVisibleEditEvidence[modelId] ?? []) {
        const missingEvidence = missingLanguageModelSmokeEditEvidence(modelId, agentId, responseText);
        if (missingEvidence) errors.push(missingEvidence);
      }
    }
    const actualMetadata = metadata?.[modelId];
    if (!actualMetadata || typeof actualMetadata !== 'object') {
      errors.push(`Missing language model metadata: ${modelId}`);
      continue;
    }
    for (const [key, expectedValue] of Object.entries(expectedMetadata)) {
      if (actualMetadata[key] !== expectedValue) {
        errors.push(`Unexpected language model metadata for ${modelId}: ${key}`);
      }
    }
  }
  if (result.commitHookLifecycle?.installed !== true || result.commitHookLifecycle?.removed !== true) {
    errors.push('Missing commit hook lifecycle evidence.');
  }
  if (
    result.commitHookLifecycle?.dispatchSentinelObserved !== true ||
    result.commitHookLifecycle?.dispatchSentinelCleared !== true
  ) {
    errors.push('Missing active dispatch sentinel lifecycle evidence.');
  }
  if (result.commitHookLifecycle?.commitMessageAttributed !== true) {
    errors.push('Missing commit hook commit-message attribution evidence.');
  }
  if (result.uiEvidence?.gambitPanelOpened !== true) {
    errors.push('Missing Gambit panel-open evidence.');
  }
  validateEditConflictEvidence(result.editConflictEvidence, errors);
  validateSharedContextEvidence(result.sharedContextEvidence, errors);
  validateLanguageModelToolContextEvidence(result.languageModelToolContextEvidence, errors);
  return errors;
}

function containsGambitInternalStatePath(value) {
  return value.includes('.vscode/gambit/') || value.includes('.vscode\\gambit\\');
}

function containsSmokeEditFilePath(value) {
  return Object.values(smokeAgentEditFiles).some((filePath) => value.includes(filePath));
}

function missingNativeSmokeEditEvidence(requestKey, agentId, responseText) {
  const label = smokeAgentLabels[agentId];
  const filePath = smokeAgentEditFiles[agentId];
  const hasProgress = responseText.includes(`${label} created ${filePath}`);
  const hasReference = responseText.includes('[reference:') && responseText.includes(`/${filePath}]`);
  return hasProgress && hasReference
    ? null
    : `Missing native chat visible edit evidence: ${requestKey} must show ${label} created ${filePath} with a file reference.`;
}

function missingLanguageModelSmokeEditEvidence(modelId, agentId, responseText) {
  const label = smokeAgentLabels[agentId];
  const filePath = smokeAgentEditFiles[agentId];
  return responseText.includes(`${label} created [${filePath}](`)
    ? null
    : `Missing language model visible edit evidence: ${modelId} must show ${label} created ${filePath} as a workspace link.`;
}

function validateEditConflictEvidence(evidence, errors) {
  if (!evidence || typeof evidence !== 'object') {
    errors.push('Missing edit conflict smoke evidence.');
    return;
  }

  const nativeChat = evidence.nativeChat;
  if (typeof nativeChat !== 'string' || nativeChat.trim().length === 0) {
    errors.push('Missing native chat edit conflict smoke evidence.');
  } else {
    if (!nativeChat.includes('**Edit conflict:**')) {
      errors.push('Missing native chat edit conflict marker.');
    }
    if (!nativeChat.includes(`Codex created ${smokeConflictFilePath}`)) {
      errors.push(`Missing native chat Codex edit evidence for ${smokeConflictFilePath}.`);
    }
    if (!nativeChat.includes(`Codex created ${smokeConflictFilePath}, which was already edited by Claude in this session.`)) {
      errors.push('Missing native chat prior-editor conflict wording.');
    }
    if (!(nativeChat.includes('[reference:') && nativeChat.includes(`/${smokeConflictFilePath}]`))) {
      errors.push(`Missing native chat edit conflict file reference for ${smokeConflictFilePath}.`);
    }
  }

  const languageModel = evidence.languageModel;
  if (typeof languageModel !== 'string' || languageModel.trim().length === 0) {
    errors.push('Missing language model edit conflict smoke evidence.');
  } else {
    if (!languageModel.includes('_Edit conflict:')) {
      errors.push('Missing language model edit conflict marker.');
    }
    if (!languageModel.includes(`Codex created [${smokeConflictFilePath}](`)) {
      errors.push(`Missing language model Codex edit link for ${smokeConflictFilePath}.`);
    }
    if (!languageModel.includes('which was already edited by') || !languageModel.includes('Claude')) {
      errors.push('Missing language model prior-editor conflict wording.');
    }
  }
}

function validateSharedContextEvidence(evidence, errors) {
  if (!evidence || typeof evidence !== 'object') {
    errors.push('Missing shared-context smoke evidence.');
    return;
  }

  const nativeChat = evidence.nativeChat;
  if (typeof nativeChat !== 'string' || nativeChat.trim().length === 0) {
    errors.push('Missing native chat shared-context smoke evidence.');
  } else {
    for (const marker of requiredSharedContextMarkers) {
      if (!nativeChat.includes(marker)) {
        errors.push(`Missing native chat shared-context marker: ${marker}`);
      }
    }
  }

  const languageModel = evidence.languageModel;
  if (typeof languageModel !== 'string' || languageModel.trim().length === 0) {
    errors.push('Missing language model shared-context smoke evidence.');
  } else {
    for (const marker of requiredSharedContextMarkers) {
      if (!languageModel.includes(marker)) {
        errors.push(`Missing language model shared-context marker: ${marker}`);
      }
    }
  }
}

function validateLanguageModelToolContextEvidence(evidence, errors) {
  if (typeof evidence !== 'string' || evidence.trim().length === 0) {
    errors.push('Missing language model request-tool context smoke evidence.');
    return;
  }

  if (!evidence.includes(requiredToolContextMarker)) {
    errors.push(`Missing language model request-tool context marker: ${requiredToolContextMarker}`);
  }
  if (!evidence.includes(requiredModelOptionsContextMarker)) {
    errors.push(`Missing language model request model-options context marker: ${requiredModelOptionsContextMarker}`);
  }
}

export function prepareSmokeDirectories(paths) {
  mkdirSync(paths.userDataDir, { recursive: true });
  mkdirSync(paths.extensionsDir, { recursive: true });
  rmSync(paths.workspaceDir, { recursive: true, force: true });
  mkdirSync(paths.workspaceDir, { recursive: true });
  mkdirSync(join(paths.workspaceDir, '.git'), { recursive: true });
}

function main() {
  const paths = smokePaths(process.cwd());
  const missing = findMissingSmokePrerequisites(paths);
  if (missing.length > 0) {
    process.stderr.write(`VS Code smoke test is missing required files:\n${missing.map((file) => `- ${file}`).join('\n')}\n`);
    process.stderr.write('Run `npm run build` before `npm run test:vscode-smoke`.\n');
    process.exit(1);
  }

  prepareSmokeDirectories(paths);
  rmSync(paths.smokeResultPath, { force: true });
  const codeCommand = resolveCodeCommand(process.env.VSCODE_SMOKE_CODE_COMMAND || 'code');
  const invocation = buildCodeSpawnInvocation(codeCommand, buildCodeSmokeArgs(paths));
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: paths.rootDir,
    env: buildCodeSmokeEnv(paths),
    shell: invocation.shell,
    stdio: 'inherit',
    timeout: Number(process.env.VSCODE_SMOKE_TIMEOUT_MS || 120000),
    windowsHide: true,
  });

  if (result.error) {
    process.stderr.write(`${result.error}\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  if (!existsSync(paths.smokeResultPath)) {
    process.stderr.write(`VS Code smoke test did not write ${paths.smokeResultPath}; the Extension Host test module may not have run.\n`);
    process.exit(1);
  }
  const resultErrors = validateSmokeResultContent(readFileSync(paths.smokeResultPath, 'utf8'));
  if (resultErrors.length > 0) {
    process.stderr.write(`VS Code smoke test result failed validation:\n${resultErrors.map((error) => `- ${error}`).join('\n')}\n`);
    process.exit(1);
  }
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
