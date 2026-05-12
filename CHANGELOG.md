# Changelog

## 0.0.10

- Moves the rich Veyra webview into the VS Code Secondary Side Bar alongside agent views such as Codex and Claude.
- Preserves `Veyra: Open Panel` as the compatibility command while revealing the docked Veyra view.
- Updates smoke validation and docs to verify Secondary Side Bar manifest evidence instead of bottom Panel or editor-tab placement.

## 0.0.9

- Answers low-intent `@veyra` heartbeat prompts locally in both VS Code Chat and the Veyra panel.
- Prevents fresh-session panel heartbeats from dispatching a write-capable fallback agent or triggering onboarding file prompts.
- Adds regression coverage for panel heartbeat handling and local response persistence.

## 0.0.8

- Adds `Veyra: Copy Diagnostic Report` for external tester reports.
- Includes command registration, extension version, workspace trust, backend status, and optional surface evidence in the copied report.
- Extends VS Code smoke coverage and tester docs for diagnostic report collection.

## 0.0.7

- Adds a tester quickstart and troubleshooting checklist to the Marketplace/GitHub README.
- Adds an external tester checklist to the VS Code smoke-test documentation.

## 0.0.6

- Keeps the legacy Veyra panel command usable if optional native chat or language model provider registration fails during activation.
- Adds regression coverage for activation failures that previously could surface as `command 'veyra.openPanel' not found`.

## 0.0.5

- Fixes native chat transcript parsing so PowerShell-style arrays such as `@("package.json", "README.md")` are not surfaced as bogus file mention errors before agent output.
- Records the final manual Extension Development Host smoke pass for `/debate`, `/review`, `/consensus`, and `/implement` after the native chat fix.

## 0.0.4

- Adds Marketplace, source, and issue-tracker links to the README rendered by both GitHub and the Marketplace listing.
- Publishes the current preview docs and workflow surface, including `/consensus`, diff preview, checkpoints, terminal context, and the hardened preview quickstart.

## 0.0.3

- Makes the Veyra icon corners transparent for cleaner Marketplace display.

## 0.0.2

- Replaces the preview icon with the Veyra cyber-sigil app icon.

## 0.0.1

- Initial preview release candidate for Veyra.
- Adds VS Code Chat participants for `@veyra`, `@claude`, `@codex`, and `@gemini`.
- Adds `/review`, `/debate`, and `/implement` all-agent workflows.
- Adds the Veyra Language Model provider, shared context relay, visible file edit events, edit-conflict notices, and live-readiness checks.
