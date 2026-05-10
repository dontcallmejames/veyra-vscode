const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const EXTENSION_ID = 'dontcallmejames.gambit-vscode';

async function run() {
  const executedCommands = [];
  const uiEvidence = {};
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Expected ${EXTENSION_ID} to be loaded as the development extension.`);

  await extension.activate();
  assert.equal(extension.isActive, true, 'Gambit extension should activate in the Extension Development Host.');

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    'gambit.openPanel',
    'gambit.checkStatus',
    'gambit.showSetupGuide',
    'gambit.showLiveValidationGuide',
    'gambit.configureCliPaths',
    'gambit.installCommitHook',
    'gambit.uninstallCommitHook',
    'gambit.showCommitHookSnippet',
  ]) {
    assert.ok(commands.includes(command), `Expected command ${command} to be registered.`);
  }

  assert.deepEqual(
    extension.packageJSON.contributes.chatParticipants.map((participant) => ({
      id: participant.id,
      name: participant.name,
      commands: (participant.commands ?? []).map((command) => command.name),
    })),
    [
      { id: 'gambit.gambit', name: 'gambit', commands: ['review', 'debate', 'implement'] },
      { id: 'gambit.claude', name: 'claude', commands: [] },
      { id: 'gambit.codex', name: 'codex', commands: [] },
      { id: 'gambit.gemini', name: 'gemini', commands: [] },
    ],
    'Expected all native chat participants to be contributed.',
  );
  const chatParticipants = extension.packageJSON.contributes.chatParticipants.map((participant) => ({
    id: participant.id,
    name: participant.name,
    commands: (participant.commands ?? []).map((command) => command.name),
  }));
  const smokeDiagnostics = await withTimeout(
    vscode.commands.executeCommand('gambit.internalSmokeDiagnostics'),
    10_000,
    'Timed out collecting Gambit internal smoke diagnostics.',
  );

  const models = await vscode.lm.selectChatModels({ vendor: 'gambit' });
  assert.deepEqual(
    models.map((model) => model.id).sort(),
    [
      'gambit-claude',
      'gambit-codex',
      'gambit-debate',
      'gambit-gemini',
      'gambit-implement',
      'gambit-orchestrator',
      'gambit-review',
    ],
    'Expected all Gambit language models to be selectable.',
  );
  const languageModelTokenCounts = {};
  const languageModelMetadata = {};
  const languageModelResponses = {};
  for (const model of models) {
    const count = await withTimeout(
      model.countTokens('Gambit provider smoke token count'),
      10_000,
      `Timed out counting tokens for ${model.id} in the Extension Development Host.`,
    );
    assert.equal(typeof count, 'number', `Expected ${model.id} token count to be numeric.`);
    assert.ok(count > 0, `Expected ${model.id} token count to be positive.`);
    languageModelTokenCounts[model.id] = count;
    languageModelMetadata[model.id] = {
      name: model.name,
      family: model.family,
      version: model.version,
      maxInputTokens: model.maxInputTokens,
    };
    languageModelResponses[model.id] = await collectLanguageModelResponse(model);
  }
  const implementModel = models.find((model) => model.id === 'gambit-implement');
  assert.ok(implementModel, 'Expected gambit-implement language model for edit conflict smoke validation.');
  const orchestratorModel = models.find((model) => model.id === 'gambit-orchestrator');
  assert.ok(orchestratorModel, 'Expected gambit-orchestrator language model for request-tool context smoke validation.');
  const editConflictEvidence = {
    nativeChat: smokeDiagnostics.nativeChatResponses?.['gambit.gambit/conflict'] ?? '',
    languageModel: await collectLanguageModelResponse(
      implementModel,
      'Gambit Language Model edit conflict smoke request. [gambit-smoke-conflict]',
    ),
  };
  const sharedContextEvidence = {
    nativeChat: smokeDiagnostics.nativeChatResponses?.['gambit.gambit/shared-context'] ?? '',
    languageModel: await collectLanguageModelResponse(
      implementModel,
      'Gambit Language Model shared context smoke request. [gambit-smoke-shared-context]',
    ),
  };
  const languageModelToolContextEvidence = await collectLanguageModelResponse(
    orchestratorModel,
    'Gambit Language Model request-tool context smoke request. [gambit-smoke-tool-context]',
    {
      modelOptions: {
        temperature: 0.2,
      },
      tools: [
        {
          name: 'workspaceSearch',
          description: 'Search indexed workspace symbols.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
            },
          },
        },
      ],
      toolMode: vscode.LanguageModelChatToolMode.Auto,
    },
  );

  for (const command of [
    'gambit.checkStatus',
    'gambit.openPanel',
    'gambit.showSetupGuide',
    'gambit.showLiveValidationGuide',
    'gambit.configureCliPaths',
    'gambit.showCommitHookSnippet',
  ]) {
    await withTimeout(
      vscode.commands.executeCommand(command),
      10_000,
      `Timed out executing ${command} in the Extension Development Host.`,
    );
    executedCommands.push(command);
    if (command === 'gambit.openPanel') {
      uiEvidence.gambitPanelOpened = await waitFor(
        () => hasOpenTabLabel('Gambit'),
        5_000,
        'Timed out waiting for the Gambit webview tab to open.',
      );
      assert.equal(uiEvidence.gambitPanelOpened, true, 'Expected Gambit: Open Panel to create a Gambit webview tab.');
    }
  }

  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(workspacePath, 'Expected smoke test workspace folder to be open.');
  const hookPath = path.join(workspacePath, '.git', 'hooks', 'prepare-commit-msg');
  const activeDispatchPath = path.join(workspacePath, '.vscode', 'gambit', 'active-dispatch');
  const dispatchSentinelObserved = await observeActiveDispatchSentinel(
    models.find((model) => model.id === 'gambit-codex'),
    activeDispatchPath,
  );
  const dispatchSentinelCleared = await waitFor(
    () => !existsSync(activeDispatchPath),
    5_000,
    'Timed out waiting for the active dispatch sentinel to clear after the smoke request.',
  );
  await withTimeout(
    vscode.commands.executeCommand('gambit.installCommitHook'),
    10_000,
    'Timed out executing gambit.installCommitHook in the Extension Development Host.',
  );
  executedCommands.push('gambit.installCommitHook');
  const installed = existsSync(hookPath);
  const commitMessageAttributed = installed
    ? verifyCommitHookAttribution(workspacePath, activeDispatchPath)
    : false;

  await withTimeout(
    vscode.commands.executeCommand('gambit.uninstallCommitHook'),
    10_000,
    'Timed out executing gambit.uninstallCommitHook in the Extension Development Host.',
  );
  executedCommands.push('gambit.uninstallCommitHook');
  const removed = !existsSync(hookPath);

  if (process.env.VSCODE_GAMBIT_SMOKE_RESULT) {
    writeFileSync(
      process.env.VSCODE_GAMBIT_SMOKE_RESULT,
      JSON.stringify({
        ok: true,
        extensionId: EXTENSION_ID,
        executedCommands,
        chatParticipants,
        nativeChatRegistrations: smokeDiagnostics.nativeChatRegistrations,
        nativeWorkflowDiagnostics: smokeDiagnostics.nativeWorkflowDiagnostics,
        nativeChatResponses: smokeDiagnostics.nativeChatResponses,
        editConflictEvidence,
        sharedContextEvidence,
        languageModelToolContextEvidence,
        languageModelTokenCounts,
        languageModelMetadata,
        languageModelResponses,
        commitHookLifecycle: {
          installed,
          removed,
          dispatchSentinelObserved,
          dispatchSentinelCleared,
          commitMessageAttributed,
        },
        uiEvidence,
      }, null, 2),
    );
  }
}

function hasOpenTabLabel(label) {
  return vscode.window.tabGroups.all.some((group) =>
    group.tabs.some((tab) => tab.label === label)
  );
}

async function waitFor(predicate, timeoutMs, message) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]);
}

async function observeActiveDispatchSentinel(model, activeDispatchPath) {
  assert.ok(model, 'Expected the gambit-codex language model to be available for sentinel smoke validation.');
  const cts = new vscode.CancellationTokenSource();
  try {
    const responsePromise = model.sendRequest(
      [
        vscode.LanguageModelChatMessage.User('Gambit active-dispatch sentinel smoke request.'),
      ],
      {
        justification: 'Validate Gambit active dispatch sentinel lifecycle in an Extension Development Host smoke test.',
      },
      cts.token,
    );

    let observed = false;
    let responseSettled = false;
    void responsePromise.finally(() => {
      responseSettled = true;
    });
    const startedAt = Date.now();
    while (!responseSettled && Date.now() - startedAt < 10_000) {
      if (existsSync(activeDispatchPath) && readFileSync(activeDispatchPath, 'utf8').trim().length > 0) {
        observed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const response = await withTimeout(
      responsePromise,
      10_000,
      'Timed out starting language model request for active dispatch sentinel validation.',
    );
    for await (const _chunk of response.text) {
      if (existsSync(activeDispatchPath) && readFileSync(activeDispatchPath, 'utf8').trim().length > 0) {
        observed = true;
      }
    }
    assert.equal(observed, true, 'Expected active-dispatch sentinel to exist during a smoke dispatch.');
    return observed;
  } finally {
    cts.dispose();
  }
}

function verifyCommitHookAttribution(workspacePath, activeDispatchPath) {
  try {
    execFileSync('git', ['-C', workspacePath, 'init'], { stdio: 'pipe' });
    execFileSync('git', ['-C', workspacePath, 'config', 'user.name', 'Gambit Smoke'], { stdio: 'pipe' });
    execFileSync('git', ['-C', workspacePath, 'config', 'user.email', 'gambit-smoke@local'], { stdio: 'pipe' });

    mkdirSync(path.dirname(activeDispatchPath), { recursive: true });
    writeFileSync(activeDispatchPath, 'codex\n');

    const relativeFile = 'gambit-smoke-commit.txt';
    writeFileSync(path.join(workspacePath, relativeFile), `Gambit smoke commit ${Date.now()}\n`);
    execFileSync('git', ['-C', workspacePath, 'add', relativeFile], { stdio: 'pipe' });
    execFileSync('git', ['-C', workspacePath, 'commit', '-m', 'Gambit smoke commit'], {
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Gambit Smoke',
        GIT_AUTHOR_EMAIL: 'gambit-smoke@local',
        GIT_COMMITTER_NAME: 'Gambit Smoke',
        GIT_COMMITTER_EMAIL: 'gambit-smoke@local',
      },
    });
    const commitBody = execFileSync('git', ['-C', workspacePath, 'log', '-1', '--pretty=%B'], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return commitBody.includes('Co-Authored-By: Gambit (codex) <gambit@local>');
  } catch {
    return false;
  } finally {
    rmSync(activeDispatchPath, { force: true });
  }
}

async function collectLanguageModelResponse(
  model,
  prompt = `Gambit Extension Host smoke request for ${model.id}.`,
  requestOptions = {},
) {
  const cts = new vscode.CancellationTokenSource();
  try {
    const response = await withTimeout(
      model.sendRequest(
        [
          vscode.LanguageModelChatMessage.User(prompt),
        ],
        {
          justification: 'Validate the Gambit language model provider in an Extension Development Host smoke test.',
          ...requestOptions,
        },
        cts.token,
      ),
      10_000,
      `Timed out starting language model request for ${model.id} in the Extension Development Host.`,
    );

    let text = '';
    for await (const chunk of response.text) {
      text += chunk;
    }
    assert.ok(text.trim().length > 0, `Expected ${model.id} to stream language model text.`);
    return text;
  } finally {
    cts.dispose();
  }
}

module.exports = { run };
