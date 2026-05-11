# Veyra Preview Demo Script

Use this checklist to demo the preview without sending paid prompts until you intentionally opt into live validation.

## 1. Verify The Workspace

1. Open the repository in VS Code.
2. Run `Veyra: Check agent status`.
3. If Codex or Gemini reports missing, inaccessible, misconfigured, or Node.js missing, run `Veyra: Configure Codex/Gemini CLI paths`.
4. Run `npm run test:vscode-smoke` from a terminal when you want a deterministic no-paid Extension Development Host smoke check.

## 2. Show Read-Only Workflows

Use small, safe prompts first:

```text
@veyra /review @codebase inspect the current change-safety flow for missing tests
@veyra /debate choose the safest next hardening task for the preview
@veyra /consensus decide whether this issue needs implementation or documentation
```

Point out that `/review`, `/debate`, and `/consensus` are read-only workflows. Veyra still shares workspace context, prior replies, and terminal selections, but it suppresses automatic edit approval for those modes.

## 3. Show A Write-Capable Flow

Use a disposable request in a clean branch or worktree:

```text
@veyra /implement add one focused test for this tiny behavior and make it pass
```

After the agents finish:

1. Use `Veyra: Open Pending Changes` to inspect the diff.
2. Use `Veyra: Accept Pending Changes` if the edits are good.
3. Use `Veyra: Reject Pending Changes` if you want Veyra to restore the pre-dispatch snapshot.
4. Use `Veyra: List Checkpoints` or `Veyra: Roll Back Latest Checkpoint` to show the larger safety net for write-capable dispatches.

## 4. Validate Before Sharing

For local no-paid validation:

```powershell
npm run verify
npm run test:vscode-smoke
```

For live backend readiness without sending paid prompts:

```powershell
npm run verify:live-ready
```

Only when you intentionally want paid live prompts:

```powershell
$env:VEYRA_RUN_LIVE = '1'
npm run test:integration:live
Remove-Item Env:\VEYRA_RUN_LIVE -ErrorAction SilentlyContinue
```

## 5. Demo Message

Veyra's preview pitch is narrow on purpose: it is the safest way to coordinate Claude, Codex, and Gemini inside VS Code when you want multiple agents to share context, expose edits, and leave you with a concrete handoff.
