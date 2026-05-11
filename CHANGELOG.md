# Changelog

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
