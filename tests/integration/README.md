# Live integration tests

These tests run against the **real** CLIs/SDKs using your subscription auth.

## Prerequisites
- Node.js installed so the `node` command is on PATH for npm/Vitest and JS-bundle CLI paths
- Claude Code logged in: `claude /login`
- Codex CLI installed and logged in: `npm install -g @openai/codex`, then `codex login`
- Gemini CLI installed and logged in: `npm install -g @google/gemini-cli`, then run `gemini` once and complete OAuth

## Run

For the full goal-completion gate, including non-paid verification, VS Code smoke, live readiness, and these live suites, run:

```powershell
$env:VEYRA_RUN_LIVE = '1'
npm run verify:goal
Remove-Item Env:\VEYRA_RUN_LIVE -ErrorAction SilentlyContinue
```

To run only the live integration suites:

```powershell
$env:VEYRA_RUN_LIVE = '1'
npm run test:integration:live
Remove-Item Env:\VEYRA_RUN_LIVE -ErrorAction SilentlyContinue
```

In Bash-compatible shells, use:

```bash
VEYRA_RUN_LIVE=1 npm run verify:goal
```

Or only the live integration suites:

```bash
VEYRA_RUN_LIVE=1 npm run test:integration:live
```

This command first requires the explicit `VEYRA_RUN_LIVE=1` paid-prompt opt-in, then automatically runs `npm run verify:live-ready`. If readiness reports a missing, unauthenticated, or inaccessible backend, the command stops before sending paid prompts.

The live suites also install the same readiness guard internally. If you bypass npm and invoke Vitest directly with `VEYRA_RUN_LIVE=1`, the tests fail in `beforeAll` before any paid model prompts are sent unless all live prerequisites are ready.

After `npm run test:integration:live` passes, npm runs `posttest:integration:live` and prints the remaining manual Extension Host gate. To reprint that checklist without rerunning paid prompts, use:

```powershell
npm run manual:extension-host-check
```

That final manual check is still required before the goal can be marked complete.

On Windows, Veyra first uses native `codex.exe` and `gemini.exe` executables on PATH, then recognized PATH npm shims such as `codex.cmd` and `gemini.ps1`, then falls back to `npm root -g` package probes. For PATH shims, missing derived bundle targets are skipped so stale shim entries do not block a valid npm-root package probe. If that package tree is inaccessible from the shell, set explicit JS bundle paths, native executables, or Windows npm shim paths through workspace settings or environment variables first. Native executable paths do not need the JS-bundle Node launcher.

Recognized npm shim paths such as `codex.cmd`, `codex.ps1`, `gemini.cmd`, and `gemini.ps1` are resolved to the underlying JS bundle before readiness and runtime launch, so Veyra still invokes Codex and Gemini without a shell.

```json
{
  "veyra.codexCliPath": "C:\\Users\\<you>\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
  "veyra.geminiCliPath": "C:\\Users\\<you>\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js"
}
```

```powershell
$env:VEYRA_CODEX_CLI_PATH = 'C:\Users\<you>\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js'
$env:VEYRA_GEMINI_CLI_PATH = 'C:\Users\<you>\AppData\Roaming\npm\node_modules\@google\gemini-cli\bundle\gemini.js'
```

## What they verify
- Each agent responds to a minimal "say ok" prompt
- The chunk stream begins, contains some text, and ends with `{ type: 'done' }`
- The all-agent Veyra handoff dispatches one opt-in read-only live prompt through Claude, Codex, and Gemini in sequence, then verifies shared-context relay by requiring Codex to echo Claude's generated marker and Gemini to echo both Claude's and Codex's generated markers
- The all-agent Veyra implementation path dispatches one opt-in write-capable implementation prompt in a disposable workspace, then verifies a visible `file-edited` event and a marker written to `veyra-live-implementation.txt`

## What they do NOT verify
- Long conversations / multi-turn context
- Performance / rate limits

## Cost
The per-agent tests consume one tiny prompt each. The read-only all-agent Veyra handoff consumes one tiny prompt per backend, and the write-capable implementation validation consumes one tiny implementation prompt per backend. Don't run in a tight loop.
