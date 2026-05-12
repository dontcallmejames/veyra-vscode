# Veyra Docked View Design

**Date:** 2026-05-12
**Status:** Draft for review
**Author:** Codex

## 1. Summary

Veyra should replace its floating editor-style chat panel with a docked VS Code view that can sit with the other agent extension tabs. The existing `@veyra` native chat participant remains available in VS Code Chat, but the richer Veyra orchestration UI becomes a proper workbench view instead of a separate webview editor panel.

The goal is one coherent Veyra surface:

- `@veyra` in VS Code Chat for lightweight chat and slash workflows.
- A dedicated docked Veyra view for the full orchestration UI: agent statuses, session history, pending changes, checkpoints, setup prompts, and workflow controls.
- `Veyra: Open Panel` preserved as a compatibility command that reveals the docked view.

## 2. Product Goal

Using Veyra should feel like using the other agent extensions in the same workbench area, not like opening a separate custom editor tab. The user should be able to park Veyra next to Codex and Claude, keep it visible while coding, and treat it as the home for multi-agent coordination.

This also reduces conceptual duplication. Today "Veyra chat" can mean the native `@veyra` participant or the legacy Veyra panel. After this change, the language should be:

- **Veyra Chat participant:** the native `@veyra` entry inside VS Code Chat.
- **Veyra view:** the dedicated docked UI.

## 3. Non-Goals

- Do not remove the native `@veyra`, `@claude`, `@codex`, or `@gemini` chat participants.
- Do not build a new chat UI from scratch.
- Do not create a second independent session store.
- Do not attempt to control the exact position of Codex or Claude extension views. VS Code decides and the user can rearrange docked views.
- Do not keep the old floating/editor panel as a long-term product surface.

## 4. Architecture

The current `ChatPanel` owns three responsibilities:

- Creating the webview host through `vscode.window.createWebviewPanel`.
- Initializing and wiring `VeyraSessionService`.
- Handling messages between the webview and extension host.

The new design should split host-specific work from shared webview behavior.

### Shared Controller

Introduce a shared controller for Veyra webview behavior. It should own:

- Rendering the existing webview HTML with CSP nonce and script URI.
- Loading the session and status.
- Posting init/status/session messages to the webview.
- Handling webview messages such as send, cancel, status reload, checkpoint actions, diff preview actions, setup guide, live guide, and open workspace file.
- Managing service subscriptions and watchers.
- Running the same heartbeat local-response path introduced in `0.0.9`.

The controller should not care whether the host is a `WebviewPanel` or a `WebviewView`.

### Docked View Provider

Add a `VeyraViewProvider` that implements `vscode.WebviewViewProvider`.

It should:

- Register with `vscode.window.registerWebviewViewProvider`.
- Create or attach the shared webview controller in `resolveWebviewView`.
- Use the same workspace service registration as native chat and the old panel.
- Set `webview.options.enableScripts = true`.
- Use local resource roots for the packaged `dist` assets.
- Prefer webview state restoration over `retainContextWhenHidden` unless testing shows the current UI loses critical in-progress state.

### Legacy Command Compatibility

Keep the command id `veyra.openPanel` so existing users and docs do not break. Change the command behavior to reveal the docked view by executing the contributed view command.

The command title can remain `Veyra: Open Panel` for one release if desired, but the docs and future command title should move toward `Veyra: Open View`.

## 5. Manifest Contributions

Add a contributed Veyra view container in the Panel area:

- `contributes.viewsContainers.panel`
  - `id`: `veyra`
  - `title`: `Veyra`
  - `icon`: reuse `resources/icon.png` or add a simple monochrome SVG if VS Code renders PNG poorly in the panel tab.

Add a webview view inside that container:

- `contributes.views.veyra`
  - `id`: `veyra.chatView`
  - `name`: `Veyra`
  - `type`: `webview`
  - `visibility`: `visible`
  - `contextualTitle`: `Veyra`

Add activation:

- `onView:veyra.chatView`

This follows VS Code's documented view model: views can appear in Sidebar or Panel containers, custom view containers can be contributed to `panel`, and webview views are registered with `registerWebviewViewProvider`.

References:

- https://code.visualstudio.com/api/ux-guidelines/views
- https://code.visualstudio.com/api/ux-guidelines/panel
- https://code.visualstudio.com/api/references/contribution-points
- https://code.visualstudio.com/api/references/vscode-api

## 6. UX Behavior

Opening Veyra should reveal the docked view.

Expected behavior:

- `Veyra: Open Panel` reveals the Veyra docked view.
- The Veyra view uses the existing chat UI, status strip, pending change controls, checkpoint notices, and composer.
- Fresh-session heartbeat prompts such as `@veyra are you here?` answer locally without onboarding prompts, agent dispatch, checkpoints, or pending changes.
- Onboarding prompts still run before real first-session dispatches.
- The view is moveable using normal VS Code layout controls. Users can park it next to Codex and Claude if their VS Code layout supports that grouping.

The first implementation can keep the existing command name and UI text if renaming would broaden the release. Documentation should use "Veyra view" going forward.

## 7. Data Flow

### Startup

1. Extension activates from command, native chat, language model provider, or `onView:veyra.chatView`.
2. Shared native registration is created or reused.
3. `VeyraViewProvider.resolveWebviewView` attaches the webview controller.
4. Controller loads session, checks agent status, posts `init`.

### Send

1. Webview sends `{ kind: 'send', text }`.
2. Controller checks for a local heartbeat response.
3. If local, service persists a local user/system response and returns.
4. If not local and first session, onboarding prompts can run.
5. Controller dispatches through `VeyraSessionService` as today.

### Reveal Command

1. User invokes `Veyra: Open Panel`.
2. Extension executes the view reveal command for `veyra.chatView`.
3. VS Code opens or focuses the docked Veyra view.

## 8. Error Handling

- If no workspace is open, show the existing "Veyra requires an open workspace folder" message.
- If optional native chat or language model provider registration fails, the Veyra view command must still work.
- If view reveal fails, fall back to showing a clear error with setup guidance rather than opening a second legacy panel.
- If a webview post or session write fails, preserve the existing system-message behavior.
- If the view is disposed and recreated, the controller should dispose subscriptions and reload persisted session state.

## 9. Testing

Coverage should include:

- Manifest has a `viewsContainers.panel` contribution for Veyra.
- Manifest has a `views.veyra` webview contribution with id `veyra.chatView`.
- Manifest activates on `onView:veyra.chatView`.
- Extension registers a `WebviewViewProvider`.
- `Veyra: Open Panel` reveals the contributed Veyra view instead of creating an editor webview panel.
- Webview message handling still sends user messages, status reloads, setup-guide commands, diff-preview commands, checkpoint commands, and open-file requests.
- First-session panel/view heartbeat remains local and does not start onboarding or dispatch.
- Existing native chat, language model provider, package verification, and smoke scripts continue to pass.

## 10. Migration

Existing persisted session history remains under `.vscode/veyra/sessions.json`. No data migration is needed because the service and webview protocol stay the same.

The old `ChatPanel` class can be removed or reduced to a compatibility shim during implementation. The preferred end state is no `createWebviewPanel` path for normal Veyra chat.

Documentation updates:

- README quickstart: "Open the Veyra view" instead of "Open Panel."
- Smoke test docs: validate the docked view and the native chat participant separately.
- Diagnostic report docs: list the docked view command/surface when relevant.

## 11. Risks

### Exact Placement May Vary

VS Code allows contributed views to be moved by the user, but the extension may not be able to guarantee that Veyra appears beside Codex or Claude on every machine. The mitigation is to contribute a proper panel view and document that it can be dragged/rearranged.

### Webview View Lifecycle Differs From Webview Panel

`WebviewView` content can be deallocated when hidden. The controller should reload from persisted session state and only use `retainContextWhenHidden` if the first implementation loses important user state.

### Refactor Could Break Existing Panel Behavior

The implementation should keep the webview protocol unchanged and add tests before replacing the host layer. The old command id should remain stable.

### Icon Requirements

Panel view containers expect an icon. The current PNG may be acceptable, but VS Code documentation recommends simple single-color icons for view containers. If the PNG renders poorly, add a small monochrome SVG in a follow-up or within this implementation if necessary.

## 12. Success Criteria

- Veyra appears as a docked VS Code view that can be parked with other agent extension tabs.
- `Veyra: Open Panel` opens/focuses that docked view.
- The old floating/editor webview panel is no longer used for the normal Veyra UI.
- `@veyra` native chat still works.
- The Veyra view preserves existing orchestration features.
- The `0.0.9` heartbeat fix remains intact in the new view.
- Full verification passes before release.
