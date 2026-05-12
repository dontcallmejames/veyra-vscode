# VS Code Smoke Test

Use this checklist after `npm run verify` passes to validate the extension in a real VS Code Extension Development Host.

For the broader active-goal audit, evidence checklist, and remaining live-backend gate, see `docs/goal-completion-audit.md`.

## Prerequisites

- VS Code `1.118.0` or newer.
- Node.js with the `node` command on PATH, required for JS bundle CLI paths and Extension Host launches.
- Claude, Codex, and Gemini CLIs/accounts configured locally if you want to run live agent prompts.
- If Windows npm global package paths are inaccessible from the extension host, run `Veyra: Configure Codex/Gemini CLI paths` or set `veyra.codexCliPath` and `veyra.geminiCliPath` to the JS bundle paths, native executables, or Windows npm shim paths. Veyra auto-detects native PATH executables first, then recognized PATH npm shims such as `codex.cmd` and `gemini.ps1`; shim paths are resolved to the underlying JS bundle before launch. Veyra skips stale PATH shims whose derived bundle targets are missing and falls back to `npm root -g`.
- `npm run build` has completed, or you will use the `Run Extension` launch configuration in `.vscode/launch.json`, whose `npm: build` prelaunch task builds first.

## Launch

For the automated activation/provider smoke test, run:

```powershell
npm run test:vscode-smoke
```

That command builds the extension, launches VS Code with isolated `.vscode-test` user data, activates Veyra in an Extension Development Host, records native chat participant IDs plus slash workflow commands, records native chat registration evidence from activation, records native chat workflow diagnostics for `/review`, `/debate`, `/consensus`, and `/implement`, sends deterministic no-paid smoke requests through the native chat handler path for direct `@veyra`, `/review`, `/debate`, `/consensus`, `/implement`, `@claude`, `@codex`, and `@gemini`, verifies write-capable native chat smoke responses include visible file edit progress plus file references, verifies language model IDs, records language model metadata (`name, family, version, and maxInputTokens`), calls token counting on every Veyra language model, sends deterministic no-paid smoke requests through every Veyra language model, validates workflow-mode response markers for review, debate, consensus, implement, orchestrator, and direct models, verifies write-capable language model smoke responses include workspace file links for agent edits, verifies `.vscode/veyra/active-dispatch` appears during a smoke dispatch and clears afterward, executes core Veyra commands, records docked-view manifest evidence for the Veyra Secondary Side Bar container and `veyra.chatView`, verifies `Veyra: Open Panel` completes without relying on an editor tab, verifies `Veyra: Copy Diagnostic Report` returns command and backend evidence, installs and removes the managed commit hook in the isolated smoke workspace, and verifies the hook adds a Veyra `Co-Authored-By` trailer to an actual smoke commit, then exits without sending paid model prompts.

Terminal awareness stays contextual in the no-paid smoke path. Unit tests cover terminal selections and project command hints, while this smoke test continues to avoid hidden terminal command execution. Do not run suggested commands from command hints unless the user explicitly asks or approves.

For the interactive end-to-end checklist:

1. Open this repository in VS Code.
2. Press `F5` or run the `Run Extension` launch configuration from `.vscode/launch.json`.
3. In the Extension Development Host, open a workspace folder you can safely modify.

## External Tester Checklist

Use this shorter checklist when validating the Marketplace extension outside the development host:

1. Install or update to the latest Veyra release that includes the docked view.
2. Run `Developer: Reload Window` after installing or updating.
3. Open a real project folder, not an empty window.
4. Run `Veyra: Open Panel` and confirm the Veyra docked view opens or reveals.
5. Run `Veyra: Check agent status` and capture the reported Claude, Codex, and Gemini statuses.
6. Run `Veyra: Copy Diagnostic Report` and keep the copied report with the test notes.
7. In VS Code Chat, send `@veyra are you here?` and confirm Veyra answers locally.
8. Try one read-only workflow such as `@veyra /review inspect this workspace and report risks only`.

If anything fails, collect:

- OS, VS Code version, and Veyra version.
- The exact command or prompt that failed.
- The copied `Veyra: Copy Diagnostic Report` output, if available.
- A screenshot if there is a VS Code error dialog.
- `Developer: Show Logs...` -> `Extension Host` output around the failure.

## Command Palette

1. Run `Veyra: Check agent status`.
2. Confirm it reports statuses for Claude, Codex, and Gemini.
3. Run `Veyra: Copy Diagnostic Report` and confirm the clipboard text includes `veyra.openPanel: registered`.
4. If Codex or Gemini reports inaccessible, misconfigured, or Node.js missing on Windows, run `Veyra: Configure Codex/Gemini CLI paths`. If detection cannot inspect the package tree, choose `Enter paths manually` and paste JS bundle paths, native executable paths, or npm shim paths such as `codex.cmd` and `gemini.ps1`. For Node.js missing, install Node.js or switch to native executable paths, then rerun `Veyra: Check agent status`.
5. Run `Veyra: Open Panel`.
6. Confirm it reveals the Veyra docked view with the same three agent statuses.

## Docked View Heartbeat

1. Run `Veyra: Open Panel` and confirm it reveals the docked Veyra view.
2. In the Veyra docked view, send `@veyra are you here?`.
3. Confirm the response is local: `Yes, here.` There should be no dispatch, shell command, checkpoint, or pending changes.
4. Open VS Code Chat and send `@veyra are you here?`; confirm the same local response.

## Native Chat

Open VS Code Chat in the Extension Development Host and verify these participants are available:

- `@veyra`
- `@claude`
- `@codex`
- `@gemini`

Before sending prompts that can reach paid backends, run `Veyra: Show live validation guide` in VS Code or run the readiness gate from PowerShell:

```powershell
npm run verify:live-ready
```

Continue only when Claude, Codex, and Gemini all report `ready`; inaccessible entries mean the CLI path or sandbox problem must be fixed first.

To run the full goal-completion gate once readiness is green, opt in to paid prompts and run:

```powershell
$env:VEYRA_RUN_LIVE = '1'
npm run verify:goal
Remove-Item Env:\VEYRA_RUN_LIVE -ErrorAction SilentlyContinue
```

Run `/debate` first in a disposable workspace, then continue only if it does not end with `Veyra completed with errors.`:

```text
@veyra /debate choose a safe test-only change for this project
```

If `/debate` is clean, run the remaining prompts:

```text
@veyra /review inspect this workspace and report risks only
@veyra /consensus decide whether the test-only change should be made now
@veyra /implement make a tiny test-only change, then review it
```

Expected behavior:

- `/review`, `/debate`, `/consensus`, and `/implement` route through all three agents.
- `/review`, `/debate`, and `/consensus` are read-only workflows; they report findings, tradeoffs, or a consensus recommendation without creating, editing, renaming, or deleting files.
- `/implement` is the workflow that may make file edits.
- Agents use their available model and CLI capabilities while respecting read-only or edit-permitted instructions.
- Broad actionable implementation requests proceed from reasonable assumptions instead of turning into brainstorming or approval checkpoints.
- Later agents reference earlier agent replies.
- File edits appear as progress/reference events.
- If two agents touch the same file, an edit-conflict notice appears.

## Language Model Provider

From another extension or VS Code API scratch harness, request models for vendor `veyra` and confirm these model IDs are returned:

- `veyra-orchestrator`
- `veyra-review`
- `veyra-debate`
- `veyra-consensus`
- `veyra-implement`
- `veyra-claude`
- `veyra-codex`
- `veyra-gemini`

Send a minimal request to each model in a disposable workspace and confirm responses stream through Veyra. The review and debate models should behave like the read-only native chat workflows; the implement model may edit files.

## Commit Attribution

1. Run `Veyra: Install commit hook`.
2. Start an agent turn that edits a file.
3. Confirm `.vscode/veyra/active-dispatch` exists only during the dispatch.
4. Commit the agent-made change and confirm the commit message receives Veyra attribution.
