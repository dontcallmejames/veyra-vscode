# Veyra Docked View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy floating Veyra webview panel with a docked VS Code Veyra view while preserving the existing webview UI, session behavior, and `@veyra` native chat participant.

**Architecture:** Contribute a `veyra` panel view container and `veyra.chatView` webview view in `package.json`, register a `WebviewViewProvider`, and extract the current `ChatPanel` webview behavior into a reusable controller that can bind to the contributed view. Keep the existing `veyra.openPanel` command id as a compatibility command that reveals the docked view.

**Tech Stack:** VS Code Extension API (`viewsContainers`, `views`, `WebviewViewProvider`, commands), TypeScript, Preact webview bundle, Vitest, existing Veyra session/diff/checkpoint services.

---

## File Structure

- Create: `src/veyraWebviewController.ts`
  - Owns shared webview behavior currently embedded in `src/panel.ts`: HTML rendering, init, status updates, webview message handling, onboarding prompts, workspace file opening, dispatch-event forwarding, watcher/subscription cleanup.
- Create: `src/veyraView.ts`
  - Defines `VEYRA_VIEW_ID`, `VEYRA_VIEW_CONTAINER_ID`, `VEYRA_VIEW_CONTAINER_COMMAND`, and `VeyraViewProvider`.
  - Registers/attaches the shared controller to `vscode.WebviewView`.
  - Provides `revealVeyraView()` for the compatibility command.
- Modify: `src/panel.ts`
  - Remove normal `createWebviewPanel` implementation.
  - Either delete after tests move, or keep a tiny compatibility re-export only if imports need one release to transition.
- Modify: `src/extension.ts`
  - Import/register `VeyraViewProvider`.
  - Change `veyra.openPanel` to reveal `workbench.view.extension.veyra`.
  - Ensure optional native chat/language model registration failures do not block view provider registration.
- Modify: `src/shared/protocol.ts`
  - No protocol changes expected. Keep as-is unless TypeScript extraction needs a shared host type.
- Modify: `package.json`
  - Add `onView:veyra.chatView`.
  - Add `contributes.viewsContainers.panel`.
  - Add `contributes.views.veyra` webview view.
  - Keep `onCommand:veyra.openPanel`.
- Modify: `tests/panel.test.ts`
  - Rename or rewrite around the new controller/provider behavior. The test file can stay named `panel.test.ts` for a compatibility release if that keeps the diff smaller, but assertions should refer to the docked view.
- Modify: `tests/extension.test.ts`
  - Cover provider registration and command reveal wiring.
- Modify: `tests/manifest.test.ts`
  - Cover view contribution, activation event, and packaged icon path.
- Modify: `README.md`
  - Replace user-facing "Open Panel" wording with "Open the Veyra view" while still mentioning the compatibility command when helpful.
- Modify: `docs/vscode-smoke-test.md`
  - Update manual smoke steps to validate the docked Veyra view.
- Modify: `docs/goal-completion-audit.md` if it names "panel" as the only UI surface.

## Task 1: Manifest Contract for the Docked View

**Files:**
- Modify: `tests/manifest.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing manifest tests**

Add a new test near the other manifest contribution tests in `tests/manifest.test.ts`:

```ts
  it('contributes the docked Veyra webview in the Panel area', () => {
    expect(manifest.activationEvents).toContain('onView:veyra.chatView');

    expect(manifest.contributes.viewsContainers.panel).toContainEqual({
      id: 'veyra',
      title: 'Veyra',
      icon: 'resources/icon.png',
    });

    expect(manifest.contributes.views.veyra).toContainEqual({
      id: 'veyra.chatView',
      name: 'Veyra',
      type: 'webview',
      visibility: 'visible',
      contextualTitle: 'Veyra',
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npx vitest run --environment node tests/manifest.test.ts
```

Expected: FAIL because `viewsContainers.panel`, `views.veyra`, and `onView:veyra.chatView` are not present.

- [ ] **Step 3: Add manifest contributions**

In `package.json`, add an activation event after `onCommand:veyra.openPanel`:

```json
"onView:veyra.chatView",
```

Inside `contributes`, add:

```json
"viewsContainers": {
  "panel": [
    {
      "id": "veyra",
      "title": "Veyra",
      "icon": "resources/icon.png"
    }
  ]
},
"views": {
  "veyra": [
    {
      "id": "veyra.chatView",
      "name": "Veyra",
      "type": "webview",
      "visibility": "visible",
      "contextualTitle": "Veyra"
    }
  ]
},
```

Place these before `commands` for readability. Preserve existing `commands`, `chatParticipants`, `languageModelChatProviders`, and configuration blocks.

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npx vitest run --environment node tests/manifest.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
git add package.json tests/manifest.test.ts
git commit -m "feat: contribute Veyra docked view"
```

## Task 2: Extract Shared Webview Controller

**Files:**
- Create: `src/veyraWebviewController.ts`
- Modify: `src/panel.ts`
- Modify: `tests/panel.test.ts`

- [ ] **Step 1: Write failing controller-oriented panel test**

In `tests/panel.test.ts`, change the existing import:

```ts
import { ChatPanel } from '../src/panel.js';
```

to:

```ts
import { VeyraWebviewController } from '../src/veyraWebviewController.js';
```

Add this helper below `ctx`:

```ts
function fakeControllerHost(service: any = defaultService()) {
  const send = vi.fn((message: any) => (vscode as any).__test.messages.push(message));
  const host = {
    webview: (vscode as any).__test.fakePanel.webview,
    send,
    onDidDispose: vi.fn((handler: () => void) => ({ dispose: vi.fn(), handler })),
  };
  const controller = new VeyraWebviewController({
    context: ctx,
    workspacePath: '/fake/workspace',
    extensionUri: ctx.extensionUri,
    service,
  });
  return { controller, host, service, send };
}

function defaultService() {
  return {
    loadSession: vi.fn().mockResolvedValue({ messages: [] }),
    onFloorChange: vi.fn(() => vi.fn()),
    onStatusChange: vi.fn(() => vi.fn()),
    onWriteError: vi.fn(() => vi.fn()),
    isFirstSession: vi.fn(() => false),
    respondLocally: vi.fn().mockResolvedValue(undefined),
    dispatch: vi.fn().mockResolvedValue(undefined),
    cancelAll: vi.fn().mockResolvedValue(undefined),
    notifyStatusChange: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    updateOptions: vi.fn(),
  };
}
```

Update one existing init test to use the controller directly:

```ts
  it('controller attaches the webview and posts an init message', async () => {
    const { controller, host } = fakeControllerHost();

    await controller.attach(host);

    const msgs = (vscode as any).__test.messages;
    expect(host.webview.html).toContain('<html>');
    expect(msgs[0].kind).toBe('init');
    expect(msgs[0].session.messages).toEqual([]);
    expect(msgs[0].status).toMatchObject({
      claude: expect.any(String),
      codex: expect.any(String),
      gemini: expect.any(String),
    });
    expect(msgs[0].settings.toolCallRenderStyle).toBe('compact');
  });
```

Leave the older `ChatPanel.show()` tests temporarily; they will fail until Task 3 removes or adapts them.

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npx vitest run --environment node tests/panel.test.ts
```

Expected: FAIL because `src/veyraWebviewController.ts` does not exist.

- [ ] **Step 3: Create `VeyraWebviewController`**

Create `src/veyraWebviewController.ts` by moving the non-host-specific code from `src/panel.ts`.

The constructor shape should be:

```ts
export interface VeyraWebviewControllerOptions {
  context: vscode.ExtensionContext;
  workspacePath: string;
  extensionUri: vscode.Uri;
  service: VeyraSessionService;
  badgeController?: FileBadgesController;
  badgeControllerProvider?: () => FileBadgesController | undefined;
}

export interface VeyraWebviewHost {
  webview: vscode.Webview;
  send(message: FromExtension): Thenable<boolean> | boolean;
  onDidDispose(listener: () => void): vscode.Disposable;
}

export class VeyraWebviewController {
  private disposables: vscode.Disposable[] = [];
  private onboardingPromptsStarted = false;

  constructor(private readonly options: VeyraWebviewControllerOptions) {}

  async attach(host: VeyraWebviewHost): Promise<void> {
    host.webview.html = this.renderHtml(host.webview);
    this.disposables.push(
      host.onDidDispose(() => this.dispose()),
      host.webview.onDidReceiveMessage((message: FromWebview) => this.handleFromWebview(message)),
    );
    await this.initialize();
  }

  dispose(): void {
    this.options.service.flush().catch(() => { /* best-effort */ });
    this.disposables.forEach((disposable) => disposable.dispose());
    this.disposables = [];
  }
}
```

Move these methods from `ChatPanel` into the controller, updating references from instance fields to `this.options` and host `send`:

- `initialize`
- `send`
- `currentBadgeController`
- `readSettings`
- `handleFromWebview`
- `resolveOpenWorkspaceFilePath`
- `openExternalUrl`
- `dispatchUserMessage`
- `startOnboardingPrompts`
- `handleDispatchEvent`
- `maybeShowGitignorePrompt`
- `maybeShowVeyraMdTip`
- `maybeShowCommitHookPrompt`
- `renderHtml`

The `renderHtml` signature should take the active webview:

```ts
private renderHtml(webview: vscode.Webview): string {
  const htmlPath = path.join(this.options.extensionUri.fsPath, 'dist', 'index.html');
  const jsUri = webview.asWebviewUri(
    vscode.Uri.joinPath(this.options.extensionUri, 'dist', 'webview.js'),
  );
  const nonce = cspNonce();
  let html = fs.readFileSync(htmlPath, 'utf8');
  html = html
    .replace(/{{NONCE}}/g, nonce)
    .replace(/{{CSP_SOURCE}}/g, webview.cspSource)
    .replace(/{{WEBVIEW_JS_URI}}/g, jsUri.toString());
  return html;
}
```

The local heartbeat path must remain before onboarding:

```ts
private async dispatchUserMessage(text: string): Promise<void> {
  const localResponse = localVeyraResponseForPrompt(text);
  if (localResponse) {
    await this.options.service.respondLocally(
      text,
      localResponse,
      (event) => this.handleDispatchEvent(event),
    );
    return;
  }

  if (this.options.service.isFirstSession()) {
    this.startOnboardingPrompts();
  }

  await this.options.service.dispatch(
    {
      text,
      source: 'panel',
      cwd: this.options.workspacePath,
    },
    (event) => this.handleDispatchEvent(event),
  );
}
```

- [ ] **Step 4: Update `ChatPanel` to delegate to the controller**

Keep `src/panel.ts` compiling during the transition by changing it to a thin wrapper:

```ts
export class ChatPanel {
  private static current: ChatPanel | undefined;
  private readonly controller: VeyraWebviewController;
  private readonly panel: vscode.WebviewPanel;

  static async show(
    context: vscode.ExtensionContext,
    agentsOverride?: AgentRegistry,
    badgeController?: FileBadgesController,
    serviceOverride?: VeyraSessionService,
    badgeControllerProvider?: () => FileBadgesController | undefined,
  ): Promise<void> {
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal();
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showErrorMessage('Veyra requires an open workspace folder.');
      return;
    }
    const panel = vscode.window.createWebviewPanel('veyra', 'Veyra', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
    });
    const activeBadgeController = badgeControllerProvider
      ? badgeControllerProvider()
      : fileBadgesEnabled() ? badgeController : undefined;
    const service = serviceOverride ?? createVeyraSessionService(folder.uri.fsPath, activeBadgeController, agentsOverride);
    const instance = new ChatPanel(panel, context, folder.uri.fsPath, service, badgeController, badgeControllerProvider);
    ChatPanel.current = instance;
    await instance.controller.attach({
      webview: panel.webview,
      send: (message) => panel.webview.postMessage(message),
      onDidDispose: (listener) => panel.onDidDispose(listener),
    });
  }
}
```

This keeps behavior stable for this task. Task 3 removes normal use of `ChatPanel.show`.

- [ ] **Step 5: Run panel tests**

Run:

```powershell
npx vitest run --environment node tests/panel.test.ts
```

Expected: PASS. If failures occur, fix imports/mocks so all old behavior still passes through the controller.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src/veyraWebviewController.ts src/panel.ts tests/panel.test.ts
git commit -m "refactor: share Veyra webview controller"
```

## Task 3: Add Docked View Provider and Replace Open Command Behavior

**Files:**
- Create: `src/veyraView.ts`
- Modify: `src/extension.ts`
- Modify: `tests/extension.test.ts`
- Modify: `tests/panel.test.ts`

- [ ] **Step 1: Write failing extension registration test**

In `tests/extension.test.ts`, extend the VS Code mock to include:

```ts
const webviewViewProviders = new Map<string, any>();

window: {
  ...existingWindowMock,
  registerWebviewViewProvider: vi.fn((viewId: string, provider: any) => {
    webviewViewProviders.set(viewId, provider);
    return { dispose: vi.fn() };
  }),
},
__test: {
  ...existingTestExports,
  webviewViewProviders,
},
```

Add a test:

```ts
  it('registers the docked Veyra webview provider', async () => {
    const context = fakeExtensionContext();

    activate(context as any);

    expect((vscode as any).window.registerWebviewViewProvider).toHaveBeenCalledWith(
      'veyra.chatView',
      expect.anything(),
      expect.objectContaining({
        webviewOptions: expect.objectContaining({
          retainContextWhenHidden: true,
        }),
      }),
    );
  });
```

Use `retainContextWhenHidden: true` in this first implementation to preserve active streaming state from the legacy panel. Later we can revisit persisted webview state if memory/resource usage becomes a problem.

- [ ] **Step 2: Write failing open command test**

In `tests/extension.test.ts`, add:

```ts
  it('openPanel reveals the docked Veyra view instead of opening an editor panel', async () => {
    const context = fakeExtensionContext();
    activate(context as any);

    const openPanelHandler = commandHandlers.get('veyra.openPanel');
    expect(openPanelHandler).toBeTypeOf('function');

    await openPanelHandler();

    expect((vscode as any).commands.executeCommand).toHaveBeenCalledWith('workbench.view.extension.veyra');
    expect((vscode as any).window.createWebviewPanel).not.toHaveBeenCalled();
  });
```

If `tests/extension.test.ts` has a different command-handler helper, adapt the snippet to the existing helper names, but keep the expected behavior.

- [ ] **Step 3: Run tests to verify they fail**

Run:

```powershell
npx vitest run --environment node tests/extension.test.ts
```

Expected: FAIL because `registerWebviewViewProvider` is not called and `openPanel` still calls `ChatPanel.show`.

- [ ] **Step 4: Create `src/veyraView.ts`**

Create:

```ts
import * as vscode from 'vscode';
import { VeyraWebviewController } from './veyraWebviewController.js';
import type { VeyraSessionService } from './veyraService.js';
import type { FileBadgesController } from './fileBadges.js';

export const VEYRA_VIEW_CONTAINER_ID = 'veyra';
export const VEYRA_VIEW_ID = 'veyra.chatView';
export const VEYRA_VIEW_CONTAINER_COMMAND = 'workbench.view.extension.veyra';

export interface VeyraViewProviderOptions {
  context: vscode.ExtensionContext;
  getRegistration(): { workspacePath: string; service: VeyraSessionService } | undefined;
  getBadgeController(): FileBadgesController | undefined;
}

export class VeyraViewProvider implements vscode.WebviewViewProvider {
  private controller: VeyraWebviewController | undefined;

  constructor(private readonly options: VeyraViewProviderOptions) {}

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    const registration = this.options.getRegistration();
    if (!registration) {
      webviewView.webview.html = '<!doctype html><html><body>Open a workspace folder before using Veyra.</body></html>';
      return;
    }

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.options.context.extensionUri, 'dist')],
    };

    this.controller?.dispose();
    this.controller = new VeyraWebviewController({
      context: this.options.context,
      workspacePath: registration.workspacePath,
      extensionUri: this.options.context.extensionUri,
      service: registration.service,
      badgeControllerProvider: this.options.getBadgeController,
    });
    await this.controller.attach({
      webview: webviewView.webview,
      send: (message) => webviewView.webview.postMessage(message),
      onDidDispose: (listener) => webviewView.onDidDispose(listener),
    });
  }

  dispose(): void {
    this.controller?.dispose();
    this.controller = undefined;
  }
}

export async function revealVeyraView(): Promise<void> {
  await vscode.commands.executeCommand(VEYRA_VIEW_CONTAINER_COMMAND);
}
```

- [ ] **Step 5: Register provider and replace command**

In `src/extension.ts`, replace the `ChatPanel` import:

```ts
import { ChatPanel } from './panel.js';
```

with:

```ts
import { revealVeyraView, VeyraViewProvider, VEYRA_VIEW_ID } from './veyraView.js';
```

After `ensureNativeRegistration` is defined, create and register the provider before command registration:

```ts
  const viewProvider = new VeyraViewProvider({
    context,
    getRegistration: ensureNativeRegistration,
    getBadgeController: ensureBadgeController,
  });
  context.subscriptions.push(
    viewProvider,
    vscode.window.registerWebviewViewProvider(VEYRA_VIEW_ID, viewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
```

Change the command body:

```ts
    vscode.commands.registerCommand('veyra.openPanel', async () => {
      if (!ensureNativeRegistration()) {
        vscode.window.showErrorMessage('Veyra requires an open workspace folder.');
        return;
      }
      await revealVeyraView();
    }),
```

- [ ] **Step 6: Remove normal `ChatPanel.show` use from tests**

In `tests/panel.test.ts`, convert remaining `ChatPanel.show(...)` calls to direct `VeyraWebviewController` attach calls where the test is really about webview message handling.

For example, replace:

```ts
await ChatPanel.show(ctx, { claude, codex, gemini } as any);
const onDidReceive = (vscode as any).__test.onDidReceive.handler;
```

with:

```ts
const service = createRealServiceForTest({ claude, codex, gemini });
const { controller, host } = fakeControllerHost(service);
await controller.attach(host);
const onDidReceive = (vscode as any).__test.onDidReceive.handler;
```

If using real `VeyraSessionService` in these tests is too broad, keep the current service stub for command-forwarding tests and reserve full dispatch tests for `tests/veyraService.test.ts`.

- [ ] **Step 7: Run focused tests**

Run:

```powershell
npx vitest run --environment node tests/extension.test.ts tests/panel.test.ts tests/manifest.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```powershell
git add src/veyraView.ts src/extension.ts tests/extension.test.ts tests/panel.test.ts tests/manifest.test.ts package.json
git commit -m "feat: open Veyra as a docked view"
```

## Task 4: Remove Legacy Floating Panel Surface

**Files:**
- Modify/Delete: `src/panel.ts`
- Modify: `tests/panel.test.ts`
- Modify: `tests/manifest.test.ts`

- [ ] **Step 1: Search for remaining legacy panel dependencies**

Run:

```powershell
rg "ChatPanel|createWebviewPanel|Veyra: Open Panel|open panel|Open Panel" src tests README.md docs package.json
```

Expected: only intentional compatibility references remain: command id `veyra.openPanel`, maybe command title, and docs explaining compatibility.

- [ ] **Step 2: Delete or reduce `src/panel.ts`**

If no imports require `ChatPanel`, delete `src/panel.ts`.

If deleting causes too much churn, reduce it to:

```ts
export { VeyraWebviewController } from './veyraWebviewController.js';
```

Prefer deletion if all imports can be updated cleanly.

- [ ] **Step 3: Update tests to avoid `createWebviewPanel`**

In `tests/panel.test.ts`, rename the describe block from:

```ts
describe('ChatPanel', () => {
```

to:

```ts
describe('VeyraWebviewController', () => {
```

Remove assertions that require `vscode.window.createWebviewPanel`.

Add an assertion to the extension command test that `createWebviewPanel` is not called, as specified in Task 3.

- [ ] **Step 4: Run search and tests**

Run:

```powershell
rg "createWebviewPanel|ChatPanel" src tests
npx vitest run --environment node tests/panel.test.ts tests/extension.test.ts
```

Expected:

- `rg` returns no source references to `createWebviewPanel` or `ChatPanel`.
- Tests PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src tests
git commit -m "refactor: remove legacy Veyra panel host"
```

## Task 5: Documentation and Smoke Checklist

**Files:**
- Modify: `README.md`
- Modify: `docs/vscode-smoke-test.md`
- Modify: `docs/goal-completion-audit.md`
- Modify: `tests/manifest.test.ts`

- [ ] **Step 1: Write failing documentation assertions**

In `tests/manifest.test.ts`, add assertions to an existing docs test:

```ts
    expect(readme).toContain('Veyra view');
    expect(readme).toContain('Veyra: Open Panel');
    expect(smokeChecklist).toContain('Veyra docked view');
    expect(smokeChecklist).toContain('@veyra are you here?');
```

Run:

```powershell
npx vitest run --environment node tests/manifest.test.ts
```

Expected: FAIL until docs are updated.

- [ ] **Step 2: Update README**

Replace user-facing quickstart references to the old panel with language like:

```md
Open the docked Veyra view with `Veyra: Open Panel` from the Command Palette. The command name is kept for compatibility, but it now reveals the Veyra view instead of opening a separate editor panel.
```

Keep native chat docs clear:

```md
Use `@veyra` in VS Code Chat for lightweight native-chat workflows, or use the docked Veyra view for the full orchestration UI with statuses, checkpoints, and pending changes.
```

- [ ] **Step 3: Update smoke test doc**

In `docs/vscode-smoke-test.md`, update the manual extension-host gate so it includes:

```md
1. Run `Veyra: Open Panel`; confirm it reveals the docked Veyra view.
2. In the Veyra docked view, send `@veyra are you here?`.
3. Confirm the response is local (`Yes, here.`) with no Codex/Claude/Gemini dispatch, no shell cards, no checkpoint, and no pending changes.
4. Open VS Code Chat and send `@veyra are you here?`; confirm the same local response.
```

- [ ] **Step 4: Update audit wording**

If `docs/goal-completion-audit.md` refers to the legacy panel, replace it with "docked Veyra view" while preserving historical evidence. For historical sections, use "legacy panel" only when referring to pre-change behavior.

- [ ] **Step 5: Run docs tests**

Run:

```powershell
npx vitest run --environment node tests/manifest.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```powershell
git add README.md docs/vscode-smoke-test.md docs/goal-completion-audit.md tests/manifest.test.ts
git commit -m "docs: describe docked Veyra view"
```

## Task 6: Verification, Package, and Manual Dev Host Check

**Files:**
- No code files expected unless verification reveals a defect.

- [ ] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: PASS with typecheck, unit tests, build, package dry-run, integration tests, and `git diff --check`.

- [ ] **Step 2: Run VS Code smoke script**

Run:

```powershell
npm run test:vscode-smoke
```

Expected: PASS. If the smoke script needs a new diagnostic for view registration, add it in the same task and rerun.

- [ ] **Step 3: Package local VSIX**

Run:

```powershell
npm run package:vsix
```

Expected: creates a VSIX for the current package version and verifies package files.

- [ ] **Step 4: Manual Extension Development Host check**

In VS Code:

1. Press F5 or run the "Run Extension" launch config.
2. In the Extension Development Host, run `Veyra: Open Panel`.
3. Confirm it reveals the docked Veyra view, not an editor webview tab.
4. Send `@veyra are you here?` in the Veyra view.
5. Confirm: local `Yes, here.`, no agent dispatch bubble, no shell cards, no checkpoint, no pending changes.
6. Send `@veyra are you here?` in native VS Code Chat.
7. Confirm: local `Yes, here.`.
8. Run `Veyra: Copy Diagnostic Report` and confirm commands still show registered.

- [ ] **Step 5: Commit final verification docs if changed**

If `docs/vscode-smoke-test.md` or `docs/goal-completion-audit.md` receives fresh evidence, run:

```powershell
git add docs/vscode-smoke-test.md docs/goal-completion-audit.md
git commit -m "docs: record docked view smoke evidence"
```

- [ ] **Step 6: Final status check**

Run:

```powershell
git status --short
git log --oneline -5
```

Expected: clean status or only intentionally ignored VSIX artifacts; recent commits show the docked-view implementation sequence.

## Self-Review

### Spec Coverage

- Docked view contribution: Task 1 and Task 3.
- Replacement of old floating panel behavior: Task 3 and Task 4.
- Native `@veyra` retained: Task 6 verification includes native chat; no task removes native chat.
- Existing UI reused: Task 2 extracts current webview behavior.
- Compatibility command: Task 3 keeps `veyra.openPanel` and changes reveal behavior.
- Heartbeat fix preserved: Task 2 and Task 6 cover local heartbeat behavior.
- Docs and smoke updates: Task 5 and Task 6.

### Completeness Scan

The plan has no unresolved placeholder markers or vague "implement later" steps. Each task includes concrete files, code snippets, commands, and expected results.

### Type Consistency

Planned identifiers are consistent across tasks:

- View container id: `veyra`
- View id: `veyra.chatView`
- Reveal command: `workbench.view.extension.veyra`
- Provider class: `VeyraViewProvider`
- Shared controller class: `VeyraWebviewController`
- Compatibility command id: `veyra.openPanel`
