# VS Code Smoke Test

Use this checklist after `npm run verify` passes to validate the extension in a real VS Code Extension Development Host.

For the broader active-goal audit, evidence checklist, and remaining live-backend gate, see `docs/goal-completion-audit.md`.

## Prerequisites

- VS Code `1.118.0` or newer.
- Node.js with the `node` command on PATH, required for JS bundle CLI paths and Extension Host launches.
- Claude, Codex, and Gemini CLIs/accounts configured locally if you want to run live agent prompts.
- If Windows npm global package paths are inaccessible from the extension host, run `Gambit: Configure Codex/Gemini CLI paths` or set `gambit.codexCliPath` and `gambit.geminiCliPath` to the JS bundle paths, native executables, or Windows npm shim paths. Gambit auto-detects native PATH executables first, then recognized PATH npm shims such as `codex.cmd` and `gemini.ps1`; shim paths are resolved to the underlying JS bundle before launch. Gambit skips stale PATH shims whose derived bundle targets are missing and falls back to `npm root -g`.
- `npm run build` has completed, or you will use the `Run Extension` launch configuration in `.vscode/launch.json`, whose `npm: build` prelaunch task builds first.

## Launch

For the automated activation/provider smoke test, run:

```powershell
npm run test:vscode-smoke
```

That command builds the extension, launches VS Code with isolated `.vscode-test` user data, activates Gambit in an Extension Development Host, records native chat participant IDs plus slash workflow commands, records native chat registration evidence from activation, records native chat workflow diagnostics for `/review`, `/debate`, and `/implement`, sends deterministic no-paid smoke requests through the native chat handler path for direct `@gambit`, `/review`, `/debate`, `/implement`, `@claude`, `@codex`, and `@gemini`, verifies write-capable native chat smoke responses include visible file edit progress plus file references, verifies language model IDs, records language model metadata (`name, family, version, and maxInputTokens`), calls token counting on every Gambit language model, sends deterministic no-paid smoke requests through every Gambit language model, validates workflow-mode response markers for review, debate, implement, orchestrator, and direct models, verifies write-capable language model smoke responses include workspace file links for agent edits, verifies `.vscode/gambit/active-dispatch` appears during a smoke dispatch and clears afterward, executes core Gambit commands, verifies `Gambit: Open Panel` creates a `Gambit` webview tab, installs and removes the managed commit hook in the isolated smoke workspace, and verifies the hook adds a Gambit `Co-Authored-By` trailer to an actual smoke commit, then exits without sending paid model prompts.

For the interactive end-to-end checklist:

1. Open this repository in VS Code.
2. Press `F5` or run the `Run Extension` launch configuration from `.vscode/launch.json`.
3. In the Extension Development Host, open a workspace folder you can safely modify.

## Command Palette

1. Run `Gambit: Check agent status`.
2. Confirm it reports statuses for Claude, Codex, and Gemini.
3. If Codex or Gemini reports inaccessible, misconfigured, or Node.js missing on Windows, run `Gambit: Configure Codex/Gemini CLI paths`. If detection cannot inspect the package tree, choose `Enter paths manually` and paste JS bundle paths, native executable paths, or npm shim paths such as `codex.cmd` and `gemini.ps1`. For Node.js missing, install Node.js or switch to native executable paths, then rerun `Gambit: Check agent status`.
4. Run `Gambit: Open Panel`.
5. Confirm the Gambit panel opens and shows the same three agent statuses.

## Native Chat

Open VS Code Chat in the Extension Development Host and verify these participants are available:

- `@gambit`
- `@claude`
- `@codex`
- `@gemini`

Before sending prompts that can reach paid backends, run `Gambit: Show live validation guide` in VS Code or run the readiness gate from PowerShell:

```powershell
npm run verify:live-ready
```

Continue only when Claude, Codex, and Gemini all report `ready`; inaccessible entries mean the CLI path or sandbox problem must be fixed first.

To run the full goal-completion gate once readiness is green, opt in to paid prompts and run:

```powershell
$env:GAMBIT_RUN_LIVE = '1'
npm run verify:goal
Remove-Item Env:\GAMBIT_RUN_LIVE -ErrorAction SilentlyContinue
```

Run `/debate` first in a disposable workspace, then continue only if it does not end with `Gambit completed with errors.`:

```text
@gambit /debate choose a safe test-only change for this project
```

If `/debate` is clean, run the remaining prompts:

```text
@gambit /review inspect this workspace and report risks only
@gambit /implement make a tiny test-only change, then review it
```

Expected behavior:

- `/review`, `/debate`, and `/implement` route through all three agents.
- `/review` and `/debate` are read-only workflows; they report findings or tradeoffs without creating, editing, renaming, or deleting files.
- `/implement` is the workflow that may make file edits.
- Agents use their available model and CLI capabilities while respecting read-only or edit-permitted instructions.
- Broad actionable implementation requests proceed from reasonable assumptions instead of turning into brainstorming or approval checkpoints.
- Later agents reference earlier agent replies.
- File edits appear as progress/reference events.
- If two agents touch the same file, an edit-conflict notice appears.

## Language Model Provider

From another extension or VS Code API scratch harness, request models for vendor `gambit` and confirm these model IDs are returned:

- `gambit-orchestrator`
- `gambit-review`
- `gambit-debate`
- `gambit-implement`
- `gambit-claude`
- `gambit-codex`
- `gambit-gemini`

Send a minimal request to each model in a disposable workspace and confirm responses stream through Gambit. The review and debate models should behave like the read-only native chat workflows; the implement model may edit files.

## Commit Attribution

1. Run `Gambit: Install commit hook`.
2. Start an agent turn that edits a file.
3. Confirm `.vscode/gambit/active-dispatch` exists only during the dispatch.
4. Commit the agent-made change and confirm the commit message receives Gambit attribution.
