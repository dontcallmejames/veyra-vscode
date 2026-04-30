# CLI integration spike findings — 2026-04-29

This document consolidates the findings from spikes A2, A3, and A4 of Plan 1
(`docs/superpowers/plans/2026-04-29-agent-chat-v1-plan-1-foundation.md`).
It is the source of truth for adapter implementations B4, B5, and B6.

## Claude — Claude Agent SDK

- **Package:** @anthropic-ai/claude-agent-sdk@0.2.123  (note: renamed from "Claude Code SDK")
- **Import:** `import { query } from '@anthropic-ai/claude-agent-sdk';`
- **Call:** `query({ prompt: 'text' })` — returns a `Query` which extends `AsyncGenerator<SDKMessage, void>`; optional: `query({ prompt, options: { abortController, allowedTools, ... } })`
- **Auth:** automatic from `~/.claude/`; `apiKeySource: "none"` in the init event confirms subscription billing, no API key needed
- **In-process:** yes — no subprocess or PTY from the caller's perspective; the SDK internally spawns a native binary (win32-x64), cold-start ~3 s
- **Event types observed** (in order for a simple prompt):
  1. `type:"system", subtype:"hook_started"` — fires once per registered hook at session start (0 or more)
  2. `type:"system", subtype:"hook_response"` — result of each hook execution (0 or more)
  3. `type:"system", subtype:"init"` — session initialization: lists cwd, model, tools, mcp_servers, permissionMode, apiKeySource
  4. `type:"assistant"` — model response; contains `message.content[]` with `type:"text"` blocks and usage stats
  5. `type:"rate_limit_event"` — rate limit status info (always emitted)
  6. `type:"result", subtype:"success"` — terminal event; contains result string, stop_reason, duration_ms, total_cost_usd, num_turns
- **AgentChunk mapping:**
  - SDK event `type:"assistant"` → for each `message.content[]` item where `item.type === "text"`: emit `{ type: 'text', text: item.text }`
  - SDK event `type:"assistant"` → for each `message.content[]` item where `item.type === "tool_use"`: emit `{ type: 'tool-call', name: item.name, input: item.input }`
  - SDK event `type:"user"` with `tool_use_result` set → emit `{ type: 'tool-result', name: ..., output: ... }`
  - SDK event `type:"result", subtype:"success"` → emit `{ type: 'done' }` (terminal)
  - SDK event `type:"result", subtype:"error"` → emit `{ type: 'error', message: ... }`
  - SDK events `type:"system"` (any subtype), `type:"rate_limit_event"` → ignore
- **Cancellation:** `AbortController` passed via `options.abortController`; alternatively call `gen.interrupt()` (graceful stop, waits for clean shutdown)
- **Quirks:**
  - Package name mismatch: `@anthropic-ai/claude-code` is the CLI binary only (no JS exports); the programmatic SDK is `@anthropic-ai/claude-agent-sdk`
  - The `Query` object also exposes `setPermissionMode()` and `setModel()` control methods
  - `message.stop_reason` is `null` during streaming; true stop_reason appears in the `result` event
  - Even a 1-token prompt creates 33k+ cache-creation tokens due to the large system prompt; first-call costs are high
  - Hook events (`type:"system"`) fire at session start from any Claude Code hooks configured in `~/.claude/`; filter them in production

## Codex CLI — ChatGPT subscription

- **Working invocation:** `node <codex.js path> exec --json '<prompt>'`  (see Windows quirk below)
- **Stdin handling:** argument — prompt is passed as a positional arg to the `exec` subcommand; stdin piping also works but triggers informational stderr noise
- **Output format:** JSONL on stdout
- **PTY required?** no — `codex exec --json` is fully non-interactive; JSONL streams cleanly on piped stdout
- **Windows quirk:** `spawn('codex', args)` fails with ENOENT because codex is an npm shim (`.cmd` file). Two approaches, one is preferred:
  - **Preferred (B5 adapter):** `spawn('node', [path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), ...args])` — works cleanly without shell
  - Fallback: `shell: true` — works but triggers DeprecationWarning DEP0190 about argument escaping; also risks arg-splitting on prompt spaces
- **Sample fixture path:** `tests/agents/fixtures/codex-sample.txt`
- **Event types observed:**
  - `{"type":"thread.started","thread_id":"<uuid>"}` — session start; carries ID
  - `{"type":"turn.started"}` — turn begin; informational
  - `{"type":"item.completed","item":{"id":"...","type":"agent_message","text":"..."}}` — full response text (no token streaming)
  - `{"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,"output_tokens":N,"reasoning_output_tokens":N}}` — terminal signal + usage stats
- **AgentChunk mapping:**
  - `{"type":"item.completed","item":{"type":"agent_message","text":"..."}}` → `{ type: 'text', text: item.text }`
  - `{"type":"item.completed","item":{"type":"tool_call",...}}` → `{ type: 'tool-call', name: ..., input: ... }` (not observed in simple prompts; shape TBD from docs)
  - `{"type":"turn.completed"}` → `{ type: 'done' }` (reliable terminal signal; process also exits 0)
  - `{"type":"thread.started"}` → metadata / ignore
  - `{"type":"turn.started"}` → informational / ignore
- **Auth:** `C:\Users\jford\.codex\auth.json` (`auth_mode: "chatgpt"` for Plus/Pro subscription billing; keys: auth_mode, tokens, last_refresh). Model in use: gpt-5.5 (OpenAI provider via ChatGPT subscription).
- **Quirks:**
  - No token streaming: the full response text arrives in one `item.completed` event. User sees nothing until the full message is ready.
  - `--json` flag is required for machine-readable output; without it, output is human-readable plain text with ANSI formatting
  - Stderr noise (both safe to ignore): "Reading additional input from stdin..." startup check; `codex_core::session: failed to record rollout items` telemetry failure
  - Input context is ~24k tokens even for trivial prompts (Codex injects workspace context, git state, etc.)
  - CLI version tested: codex-cli 0.125.0

## Gemini CLI — Google account

- **Working invocation:** `node <gemini.js path> -p '<prompt>' -o stream-json`  (see Windows quirk below)
- **Stdin handling:** argument — prompt passed via `-p` flag; `-o stream-json` selects JSONL output mode
- **Output format:** JSONL on stdout (with `-o stream-json`); without this flag, output is interactive/human-readable with ANSI and non-parseable
- **PTY required?** no — with `-o stream-json` flag, output streams cleanly on piped stdout
- **Windows quirk:** `spawn('gemini')` → ENOENT (sh shim not directly executable); `spawn('gemini.cmd', args, { shell: true })` → arg-concatenation bug (Node concatenates args unsafely so `-p "text"` splits and "text" is treated as a positional, triggering "Cannot use both..." error). Solution:
  - **Preferred (B6 adapter):** `spawn(process.execPath, [npmGlobalModules + '/@google/gemini-cli/bundle/gemini.js', ...promptArgs])` — spawns node directly with the gemini.js bundle; no shell, no arg-splitting
  - On non-Windows: plain `spawn('gemini', args)` works via the sh shim
- **Sample fixture path:** `tests/agents/fixtures/gemini-sample.txt`
- **Event types observed** (in order for a simple prompt):
  - `{"type":"init","timestamp":"...","session_id":"<uuid>","model":"auto-gemini-3"}` — session initialization
  - `{"type":"message","timestamp":"...","role":"user","content":"..."}` — echo of user prompt
  - `{"type":"message","timestamp":"...","role":"assistant","content":"...","delta":true}` — assistant response text (streaming delta)
  - `{"type":"result","timestamp":"...","status":"success","stats":{...}}` — terminal event; contains total_tokens, input_tokens, output_tokens, cached, duration_ms, tool_calls, per-model breakdown
- **AgentChunk mapping:**
  - `{"type":"message","role":"assistant","content":"...","delta":true}` → `{ type: 'text', text: event.content }`
  - `{"type":"result","status":"success"}` → `{ type: 'done' }` (terminal)
  - `{"type":"result","status":"error"}` → `{ type: 'error', message: ... }`
  - `{"type":"init"}` → ignore (session metadata)
  - `{"type":"message","role":"user"}` → ignore (echo of input)
- **Auth:** `~/.gemini/` (Google account via Gemini CLI login flow). No API key path; subscription billing via Google account.
- **Quirks:**
  - Model is `auto-gemini-3` (router) which dispatches across `gemini-2.5-flash-lite` and `gemini-3-flash-preview` based on request; both appear in the `result.stats.models` breakdown
  - Stderr may include warning lines ("True color (24-bit) support not detected", "Ripgrep is not available") — safe to ignore; filter before JSONL parsing
  - `delta:true` on assistant messages indicates streaming delta; collect and concatenate if partial streaming is observed
  - Input context is ~9k tokens even for trivial prompts

## Plan adjustments already applied

- Spec §5.1 / §5.2 / §5.3 updated with corrected invocations and event mappings.
- Plan tasks B4 / B5 / B6 updated with realistic test fixtures and implementation logic.
- `@anthropic-ai/claude-code` removed from `package.json` dependencies (it is the CLI binary, not the SDK we want; A2 confirmed `@anthropic-ai/claude-agent-sdk` is the correct package).
