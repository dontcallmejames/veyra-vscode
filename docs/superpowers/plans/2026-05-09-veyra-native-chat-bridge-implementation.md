# Veyra Native Chat Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add native VS Code Chat participants for Veyra while preserving the existing panel, shared context, file badges, and commit attribution.

**Architecture:** Extract the current panel dispatch pipeline into a reusable `VeyraSessionService`. The webview panel and native VS Code Chat participants both consume the same service event stream, so there is one path for prompt composition, session persistence, file edit detection, badge registration, cancellation, and commit sentinel lifecycle.

**Tech Stack:** TypeScript, VS Code extension API, `vscode.chat.createChatParticipant`, Vitest, existing Veyra agent adapters, existing Preact webview.

**Spec:** `docs/superpowers/specs/2026-05-09-veyra-native-chat-bridge-design.md`

---

## File Structure

- Create `src/veyraService.ts`
  - Owns `SessionStore`, `MessageRouter`, prompt composition, file mention embedding, workspace rules, sentinel lifecycle, file badge registration, hang/watchdog-adjacent dispatch state, and dispatch events.
- Create `src/nativeChat.ts`
  - Registers `@veyra`, `@claude`, `@codex`, and `@gemini` participants and renders `VeyraDispatchEvent` values to `ChatResponseStream`.
- Modify `src/panel.ts`
  - Keeps webview creation and webview message translation.
  - Delegates dispatch work to `VeyraSessionService`.
- Modify `src/extension.ts`
  - Creates shared agents, shared `FileBadgesController`, shared `VeyraSessionService`, panel command, commit hook commands, and native chat participants.
- Modify `src/shared/protocol.ts`
  - Add no new protocol unless panel event translation requires a small compatibility shim.
- Modify `package.json`
  - Add `onChatParticipant:*` activation events and `contributes.chatParticipants`.
- Create `tests/veyraService.test.ts`
  - Unit coverage for dispatch service behavior.
- Create `tests/nativeChat.test.ts`
  - Unit coverage for participant registration and event rendering.
- Update `tests/panel.test.ts`
  - Verify the panel still emits the same webview protocol messages through the new service.

---

## Task 1: Extract Service Types And Pure Event Translation

**Files:**
- Create: `src/veyraService.ts`
- Test: `tests/veyraService.test.ts`

- [ ] **Step 1: Add a failing test for forced target routing shape**

Create `tests/veyraService.test.ts` with this initial test. This test defines the expected public contract before implementation.

```ts
import { describe, it, expect, vi } from 'vitest';
import type { Agent } from '../src/agents/types.js';
import type { AgentChunk, AgentId } from '../src/types.js';
import { toRoutedInput } from '../src/veyraService.js';

function fakeAgent(id: AgentId, chunks: AgentChunk[] = []): Agent {
  return {
    id,
    status: vi.fn().mockResolvedValue('ready'),
    cancel: vi.fn().mockResolvedValue(undefined),
    async *send() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

describe('toRoutedInput', () => {
  it('prefixes direct specialist dispatches without changing displayed text', () => {
    expect(toRoutedInput('add tests', 'codex')).toBe('@codex add tests');
    expect(toRoutedInput('review design', 'claude')).toBe('@claude review design');
    expect(toRoutedInput('check docs', 'gemini')).toBe('@gemini check docs');
  });

  it('leaves orchestrator dispatch text unchanged', () => {
    expect(toRoutedInput('decide who should handle this', 'veyra')).toBe('decide who should handle this');
  });

  it('leaves unforced panel dispatch text unchanged', () => {
    expect(toRoutedInput('@all hello', undefined)).toBe('@all hello');
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```powershell
npm test -- veyraService
```

Expected: failure because `../src/veyraService.js` does not exist.

- [ ] **Step 3: Create the minimal service module**

Create `src/veyraService.ts`:

```ts
import type { AgentId } from './types.js';
import type { AgentMessage, SystemMessage, UserMessage } from './shared/protocol.js';

export type VeyraDispatchSource = 'panel' | 'chat';
export type VeyraForcedTarget = AgentId | 'veyra';

export interface VeyraDispatchRequest {
  text: string;
  source: VeyraDispatchSource;
  forcedTarget?: VeyraForcedTarget;
  cwd: string;
}

export type VeyraDispatchEvent =
  | { kind: 'user-message'; message: UserMessage }
  | { kind: 'system-message'; message: SystemMessage }
  | { kind: 'dispatch-start'; agentId: AgentId; messageId: string; timestamp: number }
  | { kind: 'text'; agentId: AgentId; messageId: string; text: string }
  | { kind: 'tool-call'; agentId: AgentId; messageId: string; name: string; input: unknown }
  | { kind: 'tool-result'; agentId: AgentId; messageId: string; name: string; output: unknown }
  | { kind: 'agent-error'; agentId: AgentId; messageId: string; message: string }
  | { kind: 'dispatch-end'; agentId: AgentId; message: AgentMessage };

export function toRoutedInput(text: string, forcedTarget?: VeyraForcedTarget): string {
  if (!forcedTarget || forcedTarget === 'veyra') return text;
  return `@${forcedTarget} ${text}`.trim();
}
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```powershell
npm test -- veyraService
```

Expected: the `toRoutedInput` tests pass.

- [ ] **Step 5: Commit this slice**

Run:

```powershell
git add src/veyraService.ts tests/veyraService.test.ts
git commit -m "feat: add Veyra dispatch service contract"
```

If Git cannot create `.git/index.lock` due to local permissions, leave the files uncommitted and report the exact Git error.

---

## Task 2: Move Dispatch Pipeline Into `VeyraSessionService`

**Files:**
- Modify: `src/veyraService.ts`
- Test: `tests/veyraService.test.ts`

- [ ] **Step 1: Add failing service dispatch tests**

Extend `tests/veyraService.test.ts` with service-level tests. Keep the existing `toRoutedInput` tests.

```ts
import { VeyraSessionService } from '../src/veyraService.js';

describe('VeyraSessionService', () => {
  it('dispatches a forced specialist request and emits persisted message events', async () => {
    const claude = fakeAgent('claude');
    const codex = fakeAgent('codex', [
      { type: 'text', text: 'done' },
      { type: 'done' },
    ]);
    const gemini = fakeAgent('gemini');

    const service = new VeyraSessionService({
      workspacePath: '/fake/workspace',
      agents: { claude, codex, gemini },
      badgeController: undefined,
      workspaceState: { get: vi.fn(), update: vi.fn() },
      config: {
        fileEmbedMaxLines: 500,
        sharedContextWindow: 25,
        commitSignatureEnabled: false,
      },
    });
    await service.load();

    const events = [];
    for await (const event of service.dispatch({
      text: 'add tests',
      source: 'chat',
      forcedTarget: 'codex',
      cwd: '/fake/workspace',
    })) {
      events.push(event);
    }

    expect(codex.send).toHaveBeenCalledTimes(1);
    expect(claude.send).not.toHaveBeenCalled();
    expect(gemini.send).not.toHaveBeenCalled();
    expect(events.map((e) => e.kind)).toContain('user-message');
    expect(events.map((e) => e.kind)).toContain('dispatch-start');
    expect(events.map((e) => e.kind)).toContain('text');
    expect(events.map((e) => e.kind)).toContain('dispatch-end');
  });

  it('uses the facilitator for unforced orchestrator chat', async () => {
    const facilitator = vi.fn().mockResolvedValue({ agent: 'claude', reason: 'best reviewer' });
    const claude = fakeAgent('claude', [{ type: 'done' }]);
    const service = new VeyraSessionService({
      workspacePath: '/fake/workspace',
      agents: {
        claude,
        codex: fakeAgent('codex'),
        gemini: fakeAgent('gemini'),
      },
      facilitator,
      badgeController: undefined,
      workspaceState: { get: vi.fn(), update: vi.fn() },
      config: {
        fileEmbedMaxLines: 500,
        sharedContextWindow: 25,
        commitSignatureEnabled: false,
      },
    });
    await service.load();

    for await (const _event of service.dispatch({
      text: 'who should review this?',
      source: 'chat',
      forcedTarget: 'veyra',
      cwd: '/fake/workspace',
    })) {
      // drain
    }

    expect(facilitator).toHaveBeenCalled();
    expect(claude.send).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```powershell
npm test -- veyraService
```

Expected: failure because `VeyraSessionService` is not implemented.

- [ ] **Step 3: Implement `VeyraSessionService` by moving panel logic**

Update `src/veyraService.ts`. Move the logic from `ChatPanel.dispatchUserMessage` into this service. Keep public constructor dependencies injectable so tests do not need a real VS Code host.

Required constructor shape:

```ts
import * as vscode from 'vscode';
import { ulid } from './ulid.js';
import { MessageRouter, type AgentRegistry } from './messageRouter.js';
import { chooseFacilitatorAgent, type FacilitatorFn } from './facilitator.js';
import { SessionStore } from './sessionStore.js';
import { SentinelWriter } from './commitHook.js';
import { buildSharedContext } from './sharedContext.js';
import { readWorkspaceRules } from './workspaceRules.js';
import { parseFileMentions, embedFiles } from './fileMentions.js';
import { composePrompt } from './composePrompt.js';
import { getEditedPath as getClaudeEditedPath } from './agents/claude.js';
import { getEditedPath as getCodexEditedPath } from './agents/codex.js';
import { getEditedPath as getGeminiEditedPath } from './agents/gemini.js';
import type { AgentId, AgentStatus } from './types.js';
import type { AgentMessage, SystemMessage, UserMessage } from './shared/protocol.js';
import type { FileBadgesController } from './fileBadges.js';

export interface VeyraServiceConfig {
  fileEmbedMaxLines: number;
  sharedContextWindow: number;
  commitSignatureEnabled: boolean;
  watchdogMinutes?: number;
}

export interface WorkspaceStateLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export interface VeyraSessionServiceOptions {
  workspacePath: string;
  agents: AgentRegistry;
  facilitator?: FacilitatorFn;
  badgeController?: Pick<FileBadgesController, 'registerEdit'>;
  workspaceState: WorkspaceStateLike;
  config: VeyraServiceConfig;
}
```

Implementation requirements:

- `load()` calls `SessionStore.load()`.
- `snapshot()` returns `SessionStore.snapshot()`.
- `dispatch()` performs the same steps as current `ChatPanel.dispatchUserMessage`.
- `dispatch()` yields `VeyraDispatchEvent` values instead of webview messages.
- `cancelAll()` delegates to `MessageRouter.cancelAll()`.
- `updateConfig(config)` rebuilds `SentinelWriter` and stores new config.
- Write-class tool results use the existing `getEditedPath` helpers and `badgeController.registerEdit`.

The core dispatch loop should follow this structure:

```ts
async *dispatch(request: VeyraDispatchRequest): AsyncIterable<VeyraDispatchEvent> {
  const routedInput = toRoutedInput(request.text, request.forcedTarget);
  const { filePaths, remainingText } = parseFileMentions(routedInput);
  const embedResult = embedFiles(filePaths, this.workspacePath, {
    maxLines: this.config.fileEmbedMaxLines,
  });

  const userMsg: UserMessage = {
    id: ulid(),
    role: 'user',
    text: request.text,
    timestamp: Date.now(),
    ...(embedResult.attached.length > 0 ? { attachedFiles: embedResult.attached } : {}),
  };
  this.store.appendUser(userMsg);
  yield { kind: 'user-message', message: userMsg };

  for (const error of embedResult.errors) {
    const sys: SystemMessage = {
      id: ulid(),
      role: 'system',
      kind: 'error',
      text: `${error.path}: ${error.reason}`,
      timestamp: Date.now(),
    };
    this.store.appendSystem(sys);
    yield { kind: 'system-message', message: sys };
  }

  const composePromptForTarget = (_targetId: AgentId, baseText: string): string => {
    const sharedContext = buildSharedContext(this.store.snapshot(), {
      window: this.config.sharedContextWindow,
    });
    const rules = readWorkspaceRules(this.workspacePath);
    return composePrompt({
      rules,
      sharedContext,
      fileBlocks: embedResult.embedded,
      userText: baseText,
    });
  };

  const sharedContextForFacilitator = buildSharedContext(this.store.snapshot(), {
    window: this.config.sharedContextWindow,
  });

  const inProgressByAgent = new Map<AgentId, {
    id: string;
    text: string;
    toolEvents: AgentMessage['toolEvents'];
    agentId: AgentId;
    timestamp: number;
    error?: string;
  }>();

  for await (const event of this.router.handle(remainingText, {
    cwd: request.cwd,
    composePromptForTarget,
    sharedContextForFacilitator,
  })) {
    // Translate router events to VeyraDispatchEvent values.
  }
}
```

When translating router events, copy the existing panel behavior for:

- facilitator decisions as system messages
- routing-needed messages
- dispatch-start sentinel writes
- chunk text accumulation
- tool call/result recording
- file edit badge registration
- dispatch-end final `AgentMessage` persistence
- dispatch-end sentinel cleanup

- [ ] **Step 4: Run the service tests**

Run:

```powershell
npm test -- veyraService
```

Expected: all `veyraService` tests pass.

- [ ] **Step 5: Run existing router and prompt tests**

Run:

```powershell
npm test -- messageRouter composePrompt sharedContext fileMentions workspaceRules
```

Expected: all pass.

- [ ] **Step 6: Commit this slice**

Run:

```powershell
git add src/veyraService.ts tests/veyraService.test.ts
git commit -m "feat: extract Veyra dispatch service"
```

---

## Task 3: Refactor `ChatPanel` To Use The Service

**Files:**
- Modify: `src/panel.ts`
- Modify: `tests/panel.test.ts`

- [ ] **Step 1: Update `ChatPanel.show` and constructor to accept a service**

Change the panel constructor so it receives `VeyraSessionService`. Keep `agentsOverride` only as a test convenience if needed, but prefer building the service in `extension.ts` in Task 5.

Use this constructor direction:

```ts
private constructor(
  panel: vscode.WebviewPanel,
  private context: vscode.ExtensionContext,
  private workspacePath: string,
  private service: VeyraSessionService,
) {
  this.panel = panel;
  this.extensionUri = context.extensionUri;
  this.panel.webview.html = this.renderHtml();
}
```

Remove direct `SessionStore` ownership from `ChatPanel`. Use `service.load()`, `service.snapshot()`, and `service.isFirstSession()` for panel initialization and first-run prompts.

- [ ] **Step 2: Replace `dispatchUserMessage` body with service event translation**

`ChatPanel.dispatchUserMessage(text)` should become:

```ts
private async dispatchUserMessage(text: string): Promise<void> {
  if (this.service.isFirstSession()) {
    await this.maybeShowGitignorePrompt(this.workspacePath);
    await this.maybeShowVeyraMdTip();
    await this.maybeShowCommitHookPrompt();
  }

  try {
    for await (const event of this.service.dispatch({
      text,
      source: 'panel',
      cwd: this.workspacePath,
    })) {
      this.forwardServiceEvent(event);
    }
  } finally {
    this.currentDispatchInProgress = null;
  }
}
```

Add a private translator:

```ts
private forwardServiceEvent(event: VeyraDispatchEvent): void {
  switch (event.kind) {
    case 'user-message':
      this.send({ kind: 'user-message-appended', message: event.message });
      return;
    case 'system-message':
      this.send({ kind: 'system-message', message: event.message });
      return;
    case 'dispatch-start':
      this.send({
        kind: 'message-started',
        id: event.messageId,
        agentId: event.agentId,
        timestamp: event.timestamp,
      });
      return;
    case 'text':
      this.send({
        kind: 'message-chunk',
        id: event.messageId,
        chunk: { type: 'text', text: event.text },
      });
      return;
    case 'tool-call':
      this.send({
        kind: 'message-chunk',
        id: event.messageId,
        chunk: { type: 'tool-call', name: event.name, input: event.input },
      });
      return;
    case 'tool-result':
      this.send({
        kind: 'message-chunk',
        id: event.messageId,
        chunk: { type: 'tool-result', name: event.name, output: event.output },
      });
      return;
    case 'agent-error':
      this.send({
        kind: 'message-chunk',
        id: event.messageId,
        chunk: { type: 'error', message: event.message },
      });
      return;
    case 'dispatch-end':
      this.send({ kind: 'message-finalized', message: event.message });
      return;
  }
}
```

- [ ] **Step 3: Preserve cancel behavior**

Update `handleFromWebview`:

```ts
case 'cancel':
  await this.service.cancelAll();
  break;
```

- [ ] **Step 4: Run panel tests**

Run:

```powershell
npm test -- panel
```

Expected: existing panel round-trip, file-edited, and file attachment tests still pass.

- [ ] **Step 5: Commit this slice**

Run:

```powershell
git add src/panel.ts tests/panel.test.ts
git commit -m "refactor: route panel dispatch through Veyra service"
```

---

## Task 4: Add Native Chat Participant Registration

**Files:**
- Create: `src/nativeChat.ts`
- Create: `tests/nativeChat.test.ts`

- [ ] **Step 1: Write failing registration tests**

Create `tests/nativeChat.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

const participants: Array<{ id: string; handler: Function }> = [];

vi.mock('vscode', () => ({
  chat: {
    createChatParticipant: vi.fn((id: string, handler: Function) => {
      participants.push({ id, handler });
      return { id, dispose: vi.fn() };
    }),
  },
}));

import { registerNativeChatParticipants } from '../src/nativeChat.js';

describe('registerNativeChatParticipants', () => {
  it('registers orchestrator and three specialists', () => {
    participants.length = 0;
    const service = { dispatch: vi.fn() };
    const disposables = registerNativeChatParticipants(service as any);
    expect(participants.map((p) => p.id)).toEqual([
      'veyra',
      'veyra.claude',
      'veyra.codex',
      'veyra.gemini',
    ]);
    expect(disposables).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```powershell
npm test -- nativeChat
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement registration and renderer**

Create `src/nativeChat.ts`:

```ts
import * as vscode from 'vscode';
import type { AgentId } from './types.js';
import type {
  VeyraDispatchEvent,
  VeyraForcedTarget,
  VeyraSessionService,
} from './veyraService.js';

type ParticipantSpec = {
  id: string;
  target: VeyraForcedTarget;
};

const PARTICIPANTS: ParticipantSpec[] = [
  { id: 'veyra', target: 'veyra' },
  { id: 'veyra.claude', target: 'claude' },
  { id: 'veyra.codex', target: 'codex' },
  { id: 'veyra.gemini', target: 'gemini' },
];

export function registerNativeChatParticipants(
  service: Pick<VeyraSessionService, 'dispatch' | 'cancelAll'>,
): vscode.Disposable[] {
  return PARTICIPANTS.map((spec) => vscode.chat.createChatParticipant(
    spec.id,
    async (request, _context, response, token) => {
      const cancelSub = token.onCancellationRequested(() => {
        void service.cancelAll();
      });
      try {
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspacePath) {
          response.markdown('Open a workspace folder before using Veyra.');
          return { metadata: { veyra: true, status: 'no-workspace' } };
        }
        for await (const event of service.dispatch({
          text: request.prompt,
          source: 'chat',
          forcedTarget: spec.target,
          cwd: workspacePath,
        })) {
          renderDispatchEvent(response, event);
        }
        return { metadata: { veyra: true, participant: spec.id } };
      } finally {
        cancelSub.dispose();
      }
    },
  ));
}

export function renderDispatchEvent(
  response: Pick<vscode.ChatResponseStream, 'markdown' | 'progress'>,
  event: VeyraDispatchEvent,
): void {
  switch (event.kind) {
    case 'system-message':
      response.markdown(`\n\n> ${event.message.text}\n\n`);
      return;
    case 'dispatch-start':
      response.progress(`${displayAgent(event.agentId)} is working...`);
      return;
    case 'text':
      response.markdown(event.text);
      return;
    case 'tool-call':
      response.progress(`Running ${event.name}`);
      return;
    case 'tool-result':
      response.progress(`Finished ${event.name}`);
      return;
    case 'agent-error':
      response.markdown(`\n\n**${displayAgent(event.agentId)} error:** ${event.message}\n\n`);
      return;
    case 'user-message':
    case 'dispatch-end':
      return;
  }
}

function displayAgent(agentId: AgentId): string {
  if (agentId === 'codex') return 'Codex';
  if (agentId === 'claude') return 'Claude';
  return 'Gemini';
}
```

- [ ] **Step 4: Add rendering tests**

Extend `tests/nativeChat.test.ts`:

```ts
import { renderDispatchEvent } from '../src/nativeChat.js';

describe('renderDispatchEvent', () => {
  it('streams text as markdown', () => {
    const response = { markdown: vi.fn(), progress: vi.fn() };
    renderDispatchEvent(response as any, {
      kind: 'text',
      agentId: 'codex',
      messageId: 'm1',
      text: 'hello',
    });
    expect(response.markdown).toHaveBeenCalledWith('hello');
  });

  it('shows dispatch progress', () => {
    const response = { markdown: vi.fn(), progress: vi.fn() };
    renderDispatchEvent(response as any, {
      kind: 'dispatch-start',
      agentId: 'claude',
      messageId: 'm1',
      timestamp: 123,
    });
    expect(response.progress).toHaveBeenCalledWith('Claude is working...');
  });
});
```

- [ ] **Step 5: Run native chat tests**

Run:

```powershell
npm test -- nativeChat
```

Expected: all native chat tests pass.

- [ ] **Step 6: Commit this slice**

Run:

```powershell
git add src/nativeChat.ts tests/nativeChat.test.ts
git commit -m "feat: register Veyra native chat participants"
```

---

## Task 5: Wire Extension Activation And Manifest

**Files:**
- Modify: `src/extension.ts`
- Modify: `package.json`

- [ ] **Step 1: Update `package.json` activation and contributions**

Add these activation events:

```json
"onChatParticipant:veyra",
"onChatParticipant:veyra.claude",
"onChatParticipant:veyra.codex",
"onChatParticipant:veyra.gemini"
```

Add `contributes.chatParticipants`:

```json
"chatParticipants": [
  {
    "id": "veyra",
    "name": "veyra",
    "fullName": "Veyra",
    "description": "Coordinate Claude, Codex, and Gemini with shared context and visible edits.",
    "isSticky": true
  },
  {
    "id": "veyra.claude",
    "name": "claude",
    "fullName": "Veyra: Claude",
    "description": "Ask Claude through Veyra's shared context and edit tracking.",
    "isSticky": true
  },
  {
    "id": "veyra.codex",
    "name": "codex",
    "fullName": "Veyra: Codex",
    "description": "Ask Codex through Veyra's shared context and edit tracking.",
    "isSticky": true
  },
  {
    "id": "veyra.gemini",
    "name": "gemini",
    "fullName": "Veyra: Gemini",
    "description": "Ask Gemini through Veyra's shared context and edit tracking.",
    "isSticky": true
  }
]
```

- [ ] **Step 2: Update extension activation**

Modify `src/extension.ts` so activation creates shared agents and one service:

```ts
import { ClaudeAgent } from './agents/claude.js';
import { CodexAgent } from './agents/codex.js';
import { GeminiAgent } from './agents/gemini.js';
import { chooseFacilitatorAgent } from './facilitator.js';
import { VeyraSessionService } from './veyraService.js';
import { registerNativeChatParticipants } from './nativeChat.js';
```

Inside `activate`:

```ts
const agents = {
  claude: new ClaudeAgent(),
  codex: new CodexAgent(),
  gemini: new GeminiAgent(),
};

let service: VeyraSessionService | undefined;
if (folder) {
  service = new VeyraSessionService({
    workspacePath: folder.uri.fsPath,
    agents,
    facilitator: chooseFacilitatorAgent,
    badgeController,
    workspaceState: context.workspaceState,
    config: readServiceConfig(),
  });
  void service.load();
  context.subscriptions.push(...registerNativeChatParticipants(service));
}
```

Add helper:

```ts
function readServiceConfig(): VeyraServiceConfig {
  const config = vscode.workspace.getConfiguration('veyra');
  return {
    fileEmbedMaxLines: config.get<number>('fileEmbedMaxLines', 500),
    sharedContextWindow: config.get<number>('sharedContextWindow', 25),
    commitSignatureEnabled: config.get<boolean>('commitSignature.enabled', true),
    watchdogMinutes: config.get<number>('watchdogMinutes', 5),
  };
}
```

The panel command should pass the existing service:

```ts
vscode.commands.registerCommand('veyra.openPanel', () => {
  if (!service) {
    vscode.window.showErrorMessage('Veyra requires an open workspace folder.');
    return;
  }
  return ChatPanel.show(context, service);
})
```

- [ ] **Step 3: Run typecheck**

Run:

```powershell
npm run typecheck
```

Expected: no TypeScript errors.

- [ ] **Step 4: Run full tests**

Run:

```powershell
npm test
```

Expected: all unit tests pass.

- [ ] **Step 5: Commit this slice**

Run:

```powershell
git add package.json src/extension.ts
git commit -m "feat: wire native chat participants into activation"
```

---

## Task 6: Preserve Panel Behavior End To End

**Files:**
- Modify: `tests/veyraService.test.ts`
- Modify: `src/veyraService.ts`

- [ ] **Step 1: Add a cross-surface session test**

Add a test proving that service events written from a native-chat-like dispatch are visible to a later panel-like dispatch through shared context.

```ts
it('shares session context between chat and panel dispatches', async () => {
  const claude = {
    id: 'claude' as const,
    status: vi.fn().mockResolvedValue('ready'),
    cancel: vi.fn().mockResolvedValue(undefined),
    send: vi.fn((prompt: string) => (async function* () {
      yield { type: 'text', text: prompt.includes('chat wrote this') ? 'saw chat' : 'chat wrote this' };
      yield { type: 'done' };
    })()),
  };
  const service = new VeyraSessionService({
    workspacePath: '/fake/workspace',
    agents: { claude, codex: fakeAgent('codex'), gemini: fakeAgent('gemini') },
    badgeController: undefined,
    workspaceState: { get: vi.fn(), update: vi.fn() },
    config: {
      fileEmbedMaxLines: 500,
      sharedContextWindow: 25,
      commitSignatureEnabled: false,
    },
  });
  await service.load();

  for await (const _ of service.dispatch({
    text: 'first',
    source: 'chat',
    forcedTarget: 'claude',
    cwd: '/fake/workspace',
  })) {}

  for await (const _ of service.dispatch({
    text: 'second',
    source: 'panel',
    forcedTarget: 'claude',
    cwd: '/fake/workspace',
  })) {}

  const secondPrompt = (claude.send as any).mock.calls[1][0];
  expect(secondPrompt).toContain('claude: chat wrote this');
});
```

- [ ] **Step 2: Run focused tests**

Run:

```powershell
npm test -- veyraService panel nativeChat
```

Expected: all focused tests pass.

- [ ] **Step 3: Run full verification**

Run:

```powershell
npm run build
npm run typecheck
npm test
```

Expected: build, typecheck, and tests all pass.

- [ ] **Step 4: Commit final bridge verification**

Run:

```powershell
git add src tests package.json
git commit -m "test: verify native chat bridge preserves Veyra context"
```

---

## Manual Smoke Checklist

Run these in a VS Code Extension Development Host after automated verification passes:

- [ ] `@veyra hello` appears in native chat and routes through the facilitator or asks for explicit routing when no agent is available.
- [ ] `@claude hello` dispatches only Claude.
- [ ] `@codex hello` dispatches only Codex.
- [ ] `@gemini hello` dispatches only Gemini.
- [ ] A panel message appears in the context of a later native chat dispatch.
- [ ] A native chat message appears in the context of a later panel dispatch.
- [ ] `@codex review @src/foo.ts` embeds the file using existing file mention logic.
- [ ] A write-class tool call from native chat creates or updates a file badge.
- [ ] During a native chat dispatch, `.vscode/veyra/active-dispatch` appears and then clears.
- [ ] Cancelling a native chat response cancels the active agent dispatch.

---

## Self-Review Checklist

- [ ] Every native bridge success criterion in the spec maps to a task above.
- [ ] No task requires deleting or rewriting unrelated user files.
- [ ] `VeyraSessionService`, `VeyraDispatchRequest`, `VeyraDispatchEvent`, and `registerNativeChatParticipants` are named consistently.
- [ ] Language Model Chat Provider support is not mixed into this implementation phase.
- [ ] The plan preserves the current panel as a command center.
- [ ] Full verification includes `npm run build`, `npm run typecheck`, and `npm test`.
