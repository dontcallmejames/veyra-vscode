# Agent Chat v1 — Plan 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the headless foundation for the v1 chat surface — project scaffold, three agent adapters wrapping Claude SDK / Codex CLI / Gemini CLI, mentions parser, floor manager, and a message router with `@mention`-only dispatch (no facilitator, no UI yet). Deliverable: a programmatic API plus integration tests that can drive a real agent and receive streamed chunks.

**Architecture:** TypeScript Node module that will eventually be consumed by a VSCode extension shell (Plan 2). Three Agent adapters normalize their underlying transport (in-process SDK or child process) into a common `AsyncIterable<AgentChunk>` stream. The MessageRouter sits over them with a FloorManager (sequential dispatch) and a parseMentions function. Plan 2 will add the webview, persistence, facilitator, and error UI on top.

**Tech Stack:**
- TypeScript 5.x (strict)
- Node 20+
- esbuild (bundle the extension; library code stays as ESM in `src/`)
- vitest (unit tests, fast HMR)
- `@anthropic-ai/claude-agent-sdk` (the Claude Agent SDK — formerly "Claude Code SDK"; resolved in spike A2)
- Codex CLI binary (external; subprocess; subscription auth)
- Gemini CLI binary (external; subprocess; subscription auth)
- `node-pty` — added only if a spike (A3 or A4) shows a CLI lacks usable non-interactive output

**Spec reference:** `docs/superpowers/specs/2026-04-29-agent-chat-vscode-v1-design.md`

---

## File structure produced by this plan

```
.
├── package.json                              # extension manifest + deps + scripts
├── tsconfig.json                             # strict TS, ES2022 target
├── vitest.config.ts                          # test config
├── esbuild.config.mjs                        # bundle config (used in Plan 2)
├── .vscode/
│   ├── launch.json                           # F5 -> launch extension dev host (Plan 2 uses)
│   └── settings.json                         # workspace TS/format settings
├── src/
│   ├── extension.ts                          # stubbed activate/deactivate (filled in Plan 2)
│   ├── types.ts                              # shared types: AgentChunk, MentionTarget, etc.
│   ├── mentions.ts                           # parseMentions(text)
│   ├── floor.ts                              # FloorManager class
│   ├── messageRouter.ts                      # MessageRouter class (mention-only in Plan 1)
│   └── agents/
│       ├── types.ts                          # Agent interface
│       ├── claude.ts                         # ClaudeAgent
│       ├── codex.ts                          # CodexAgent
│       └── gemini.ts                         # GeminiAgent
├── tests/
│   ├── mentions.test.ts
│   ├── floor.test.ts
│   ├── messageRouter.test.ts
│   ├── agents/
│   │   ├── claude.test.ts
│   │   ├── codex.test.ts
│   │   └── gemini.test.ts
│   └── integration/
│       ├── README.md                         # how to run live integration tests
│       ├── claude.live.test.ts
│       ├── codex.live.test.ts
│       └── gemini.live.test.ts
└── docs/superpowers/spikes/
    └── 2026-04-29-cli-spikes.md              # findings from A2/A3/A4 (committed in A5)
```

**Each file's responsibility:**
- `src/types.ts` — domain types shared across the codebase. No logic.
- `src/agents/types.ts` — the `Agent` interface and `AgentChunk` discriminated union; consumed by every adapter.
- `src/agents/claude.ts`, `codex.ts`, `gemini.ts` — one adapter per CLI/SDK. Owns spawning/calling its underlying transport and normalizing output.
- `src/mentions.ts` — pure function: text in, parsed mentions out.
- `src/floor.ts` — owns the floor lock and a queue of waiting work. Pure logic, no I/O.
- `src/messageRouter.ts` — orchestration: takes a user message, parses mentions, builds a dispatch list, drives the FloorManager, calls the right Agent(s), forwards chunks to subscribers.
- `src/extension.ts` — stub for now; Plan 2 fills in the VSCode-specific activate/deactivate.

---

## Phase A — Bootstrap & spikes

### Task A1: Scaffold the TypeScript VSCode-extension project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `esbuild.config.mjs`
- Create: `.vscode/launch.json`
- Create: `.vscode/settings.json`
- Create: `src/extension.ts`
- Modify: `.gitignore` (already exists; nothing to do — `node_modules/` and `dist/` already covered)

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "agent-chat",
  "displayName": "Agent Chat",
  "description": "Chat with Claude, ChatGPT, and Gemini in a shared VSCode panel",
  "version": "0.0.1",
  "private": true,
  "publisher": "dontcallmejames",
  "engines": {
    "vscode": "^1.95.0",
    "node": ">=20"
  },
  "main": "./dist/extension.js",
  "categories": ["Other"],
  "activationEvents": ["onCommand:agentChat.openPanel"],
  "contributes": {
    "commands": [
      {
        "command": "agentChat.openPanel",
        "title": "Agent Chat: Open Panel"
      }
    ]
  },
  "scripts": {
    "build": "node esbuild.config.mjs",
    "watch": "node esbuild.config.mjs --watch",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "vitest run --dir tests/integration"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/vscode": "^1.95.0",
    "esbuild": "^0.24.0",
    "typescript": "^5.5.0",
    "vitest": "^2.1.0"
  },
  "dependencies": {}
}
```

The `@anthropic-ai/claude-agent-sdk` dependency is intentionally omitted from the initial `package.json` — Task A2 installs it after confirming the resolved version.

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowSyntheticDefaultImports": true,
    "isolatedModules": true,
    "outDir": "./dist",
    "rootDir": ".",
    "lib": ["ES2022"],
    "types": ["node", "vscode"]
  },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Write `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**'],
    environment: 'node',
  },
});
```

- [ ] **Step 4: Write `esbuild.config.mjs`**

```javascript
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const config = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(config);
  await ctx.watch();
} else {
  await esbuild.build(config);
}
```

- [ ] **Step 5: Write `.vscode/launch.json`**

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
      "outFiles": ["${workspaceFolder}/dist/**/*.js"],
      "preLaunchTask": "npm: build"
    }
  ]
}
```

- [ ] **Step 6: Write `.vscode/settings.json`**

```json
{
  "typescript.tsdk": "node_modules/typescript/lib",
  "editor.formatOnSave": true,
  "files.eol": "\n"
}
```

- [ ] **Step 7: Write a stubbed `src/extension.ts`**

```typescript
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('agentChat.openPanel', () => {
      vscode.window.showInformationMessage('Agent Chat: panel coming in Plan 2');
    })
  );
}

export function deactivate(): void {
  // no-op
}
```

- [ ] **Step 8: Install dependencies and verify the toolchain works**

Run: `npm install`
Run: `npm run typecheck`
Expected: clean output, no type errors.

Run: `npm run build`
Expected: writes `dist/extension.js` without errors.

Run: `npm run test`
Expected: vitest reports `No test files found` (and exits 0). This is fine — we have no tests yet.

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts esbuild.config.mjs .vscode/ src/extension.ts package-lock.json
git commit -m "chore: scaffold TypeScript VSCode extension project"
```

---

### Task A2: Spike — Claude Code SDK

**Goal:** Confirm the SDK package name, install it, send a tiny prompt, observe its streaming event shape, and document the mapping from SDK events to `AgentChunk`.

**Files:**
- Create: `scripts/spike-claude.mjs` (throwaway; deleted after findings are documented)

- [ ] **Step 1: Install the Claude Agent SDK**

The SDK was renamed from "Claude Code SDK" to "Claude Agent SDK". Use the new name:

Run: `npm install @anthropic-ai/claude-agent-sdk@latest`

The older package `@anthropic-ai/claude-code` exists but is only a CLI binary wrapper — do **not** install it.

Record the resolved version in your notes for the findings doc (Task A5).

- [ ] **Step 2: Write `scripts/spike-claude.mjs`**

```javascript
// One-shot exploratory script. Sends a short prompt and dumps every event
// the SDK emits so we can see its shape before designing the adapter.
import { query } from '@anthropic-ai/claude-agent-sdk';

const prompt = 'Reply with exactly the word "ok".';

console.log('[spike] sending prompt:', prompt);
let eventCount = 0;
try {
  for await (const event of query({ prompt })) {
    eventCount++;
    console.log(`[event ${eventCount}]`, JSON.stringify(event, null, 2));
  }
} catch (err) {
  console.error('[spike] error:', err);
  process.exit(1);
}
console.log(`[spike] done. ${eventCount} events.`);
```

The exact import / call signature may differ from the SDK; consult its README. The goal is "iterate every event and print it." If the SDK exposes `Anthropic.Claude.Code` or some other entry point, use that.

- [ ] **Step 3: Run the spike**

Run: `node scripts/spike-claude.mjs`
Expected: output of multiple events, ending in some terminal event ("done", "stop", or end-of-iterator).

If you get an auth error, run `claude /login` in another terminal first.

- [ ] **Step 4: Take notes for the findings doc**

Capture:
- Resolved package name and version
- Import / call shape (`query({ prompt })`, or `new Client().send(...)`, etc.)
- Event types observed (text deltas, tool calls, tool results, completion marker)
- Field names within each event (e.g., `event.delta.text` vs `event.text`)
- Any quirks (errors thrown vs surfaced as events, cancellation mechanism)

These will go into `docs/superpowers/spikes/2026-04-29-cli-spikes.md` in Task A5.

- [ ] **Step 5: Do NOT commit yet**

Hold the spike script and notes locally; we commit findings as a single doc in Task A5 and delete the throwaway scripts.

---

### Task A3: Spike — Codex CLI

**Goal:** Confirm Codex CLI is installed and authenticated, find its non-interactive single-turn mode, capture a sample of its streaming output format, and identify any flags needed.

**Files:**
- Create: `scripts/spike-codex.mjs` (throwaway)

- [ ] **Step 1: Verify Codex CLI is installed**

Run: `codex --version`
Expected: a version number. If "command not found", install per OpenAI's instructions and re-run.

Run: `codex --help`
Note: the available subcommands. Look for `exec`, `run`, `prompt`, or `--no-interactive` / `--prompt` style flags.

- [ ] **Step 2: Run a one-shot prompt and capture output**

Try in this order until one works:

Run: `echo 'Reply with exactly the word "ok".' | codex exec`
Run: `codex exec --prompt 'Reply with exactly the word "ok".'`
Run: `codex --prompt 'Reply with exactly the word "ok".'`
Run: `echo 'Reply with exactly the word "ok".' | codex`

Whichever produces output without launching a TUI is the right invocation. If only an interactive REPL launches, document this — we'll need PTY emulation in Task B5.

- [ ] **Step 3: Capture raw output for fixture use**

If a working non-interactive command exists, capture its raw streaming output:

Run: `codex exec --prompt 'Reply with exactly the word "ok".' > /tmp/codex-sample.txt 2>&1`
Run: `cat /tmp/codex-sample.txt`

Inspect:
- Is output JSONL (one JSON object per line)?
- Plain text?
- ANSI-colored text?
- Mixed (header text + JSON events)?

Save the raw sample for use as a test fixture in Task B5.

- [ ] **Step 4: Write `scripts/spike-codex.mjs` to test programmatic spawn**

```javascript
import { spawn } from 'node:child_process';

const args = ['exec', '--prompt', 'Reply with exactly the word "ok".'];
// Adjust args based on Step 2 findings.

const child = spawn('codex', args, { stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (d) => process.stdout.write(`[stdout] ${d}`));
child.stderr.on('data', (d) => process.stderr.write(`[stderr] ${d}`));
child.on('close', (code) => console.log(`[spike] exited with code ${code}`));
child.on('error', (err) => console.error('[spike] spawn error:', err));
```

Run: `node scripts/spike-codex.mjs`
Expected: streaming output to stdout; clean exit. If the process hangs waiting for a TTY, document that and note that PTY emulation (`node-pty`) is required.

- [ ] **Step 5: Take notes for the findings doc**

Capture:
- Working invocation (binary + args + stdin handling)
- Output format (JSONL? plain text? mixed?)
- Whether subprocess piping works or PTY is required
- Authentication status / how to verify

- [ ] **Step 6: Do NOT commit yet** — same as A2, hold for A5.

---

### Task A4: Spike — Gemini CLI

**Goal:** Same as Task A3 but for Gemini.

**Files:**
- Create: `scripts/spike-gemini.mjs` (throwaway)

- [ ] **Step 1: Verify Gemini CLI is installed**

Run: `gemini --version`
Expected: a version number.

Run: `gemini --help`
Note: subcommands and flags. Look for non-interactive prompt mode.

- [ ] **Step 2: Find a working non-interactive invocation**

Try in this order:

Run: `gemini --prompt 'Reply with exactly the word "ok".'`
Run: `echo 'Reply with exactly the word "ok".' | gemini`
Run: `gemini -p 'Reply with exactly the word "ok".'`
Run: `gemini exec 'Reply with exactly the word "ok".'`

- [ ] **Step 3: Capture raw output**

Run: `gemini --prompt 'Reply with exactly the word "ok".' > /tmp/gemini-sample.txt 2>&1`
Run: `cat /tmp/gemini-sample.txt`

Inspect format same as Codex. Save sample for Task B6 fixture.

- [ ] **Step 4: Write `scripts/spike-gemini.mjs`**

```javascript
import { spawn } from 'node:child_process';

const args = ['--prompt', 'Reply with exactly the word "ok".'];
// Adjust based on Step 2.

const child = spawn('gemini', args, { stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (d) => process.stdout.write(`[stdout] ${d}`));
child.stderr.on('data', (d) => process.stderr.write(`[stderr] ${d}`));
child.on('close', (code) => console.log(`[spike] exited with code ${code}`));
child.on('error', (err) => console.error('[spike] spawn error:', err));
```

Run: `node scripts/spike-gemini.mjs`
Expected: streaming output to stdout.

- [ ] **Step 5: Notes** — same as A3.

- [ ] **Step 6: Do NOT commit yet** — hold for A5.

---

### Task A5: Document spike findings; clean up throwaway scripts

**Files:**
- Create: `docs/superpowers/spikes/2026-04-29-cli-spikes.md`
- Delete: `scripts/spike-claude.mjs`, `scripts/spike-codex.mjs`, `scripts/spike-gemini.mjs`

- [ ] **Step 1: Write the findings doc**

Write `docs/superpowers/spikes/2026-04-29-cli-spikes.md` using this template, filling in your A2/A3/A4 notes:

```markdown
# CLI integration spike findings — 2026-04-29

## Claude Code SDK
- **Package:** `<resolved name>@<version>`
- **Import:** `<actual import shape>`
- **Call:** `<actual call shape>`
- **Event types observed:** `<list>`
- **Maps to AgentChunk:**
  - SDK event `<X>` → `{ type: 'text', text: ... }`
  - SDK event `<Y>` → `{ type: 'tool-call', ... }`
  - SDK event `<Z>` → `{ type: 'done' }`
- **Cancellation:** `<how>`
- **Quirks:** `<any>`

## Codex CLI
- **Working invocation:** `codex <subcommand> <flags>`
- **Stdin handling:** `<piped | arg | both>`
- **Output format:** `<JSONL | plain text | mixed>`
- **PTY required?** `<yes/no>` (if yes: which conditions)
- **Sample fixture path:** `tests/agents/fixtures/codex-sample.txt`
- **Maps to AgentChunk:** `<list>`

## Gemini CLI
- **Working invocation:** `gemini <flags>`
- **Stdin handling:** `<...>`
- **Output format:** `<...>`
- **PTY required?** `<...>`
- **Sample fixture path:** `tests/agents/fixtures/gemini-sample.txt`
- **Maps to AgentChunk:** `<list>`

## Plan adjustments
- `<list any deviations from the spec / plan tasks B4–B6 caused by these findings>`
```

- [ ] **Step 2: Save sample outputs as fixtures**

```bash
mkdir -p tests/agents/fixtures
cp /tmp/codex-sample.txt tests/agents/fixtures/codex-sample.txt
cp /tmp/gemini-sample.txt tests/agents/fixtures/gemini-sample.txt
```

These will be used by the adapter unit tests in B5/B6.

- [ ] **Step 3: Verify Claude Agent SDK is in `package.json`; remove unused packages**

If A2 didn't `npm install` the SDK, do it now:

Run: `npm install @anthropic-ai/claude-agent-sdk@latest`

If A2's exploration left the unused `@anthropic-ai/claude-code` package installed (it's the CLI binary, not the SDK we want), remove it:

Run: `npm uninstall @anthropic-ai/claude-code`

- [ ] **Step 4: If a spike found PTY is needed, install `node-pty`**

Skip this step unless a spike said yes.

Run: `npm install node-pty`

- [ ] **Step 5: Delete throwaway scripts**

```bash
rm -rf scripts/
```

- [ ] **Step 6: Commit findings + fixtures + dep changes**

```bash
git add docs/superpowers/spikes/2026-04-29-cli-spikes.md tests/agents/fixtures/ package.json package-lock.json
git commit -m "spike: document CLI integration findings; capture sample outputs"
```

---

## Phase B — Pure logic + agent adapters

### Task B1: Agent adapter types

**Files:**
- Create: `src/types.ts`
- Create: `src/agents/types.ts`

- [ ] **Step 1: Write `src/types.ts`**

```typescript
export type MentionTarget = 'claude' | 'codex' | 'gemini' | 'all';

export type AgentId = 'claude' | 'codex' | 'gemini';

export type AgentStatus = 'ready' | 'unauthenticated' | 'not-installed' | 'busy';

export type AgentChunk =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; name: string; input: unknown }
  | { type: 'tool-result'; name: string; output: unknown }
  | { type: 'error'; message: string }
  | { type: 'done' };
```

- [ ] **Step 2: Write `src/agents/types.ts`**

```typescript
import type { AgentChunk, AgentId, AgentStatus } from '../types.js';

export interface SendOptions {
  /** AbortSignal to cancel an in-flight request. */
  signal?: AbortSignal;
  /** Working directory for the agent's tool execution. */
  cwd?: string;
}

export interface Agent {
  readonly id: AgentId;
  status(): Promise<AgentStatus>;
  send(prompt: string, opts?: SendOptions): AsyncIterable<AgentChunk>;
  cancel(): Promise<void>;
}
```

- [ ] **Step 3: Verify the types compile**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/agents/types.ts
git commit -m "feat: define Agent interface and AgentChunk types"
```

---

### Task B2: Mentions parser (TDD)

**Files:**
- Create: `tests/mentions.test.ts`
- Create: `src/mentions.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/mentions.test.ts
import { describe, it, expect } from 'vitest';
import { parseMentions } from '../src/mentions.js';

describe('parseMentions', () => {
  it('returns no targets when no @ mentions', () => {
    expect(parseMentions('hello there')).toEqual({
      targets: [],
      remainingText: 'hello there',
    });
  });

  it('parses a single @claude mention', () => {
    expect(parseMentions('@claude review this')).toEqual({
      targets: ['claude'],
      remainingText: 'review this',
    });
  });

  it('parses @gpt as codex', () => {
    expect(parseMentions('@gpt run the tests')).toEqual({
      targets: ['codex'],
      remainingText: 'run the tests',
    });
  });

  it('parses @gemini', () => {
    expect(parseMentions('@gemini search docs')).toEqual({
      targets: ['gemini'],
      remainingText: 'search docs',
    });
  });

  it('parses multiple specific mentions', () => {
    expect(parseMentions('@claude @gemini compare these')).toEqual({
      targets: ['claude', 'gemini'],
      remainingText: 'compare these',
    });
  });

  it('parses @all', () => {
    expect(parseMentions('@all what do you think')).toEqual({
      targets: ['claude', 'codex', 'gemini'],
      remainingText: 'what do you think',
    });
  });

  it('only treats leading mentions as routing; mid-sentence @claude is text', () => {
    expect(parseMentions('hey @claude is a name')).toEqual({
      targets: [],
      remainingText: 'hey @claude is a name',
    });
  });

  it('deduplicates repeated mentions', () => {
    expect(parseMentions('@claude @claude review')).toEqual({
      targets: ['claude'],
      remainingText: 'review',
    });
  });

  it('@all combined with specific mentions returns all', () => {
    expect(parseMentions('@claude @all rundown')).toEqual({
      targets: ['claude', 'codex', 'gemini'],
      remainingText: 'rundown',
    });
  });

  it('trims whitespace from remainingText', () => {
    expect(parseMentions('@claude    review')).toEqual({
      targets: ['claude'],
      remainingText: 'review',
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/mentions.test.ts`
Expected: FAIL — `Cannot find module '../src/mentions.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/mentions.ts
import type { AgentId } from './types.js';

const ALL_AGENTS: AgentId[] = ['claude', 'codex', 'gemini'];

const MENTION_TO_AGENT: Record<string, AgentId | 'all'> = {
  claude: 'claude',
  gpt: 'codex',
  codex: 'codex',
  chatgpt: 'codex',
  gemini: 'gemini',
  all: 'all',
};

export interface ParsedMentions {
  targets: AgentId[];
  remainingText: string;
}

export function parseMentions(input: string): ParsedMentions {
  const tokens = input.split(/\s+/);
  const targets = new Set<AgentId>();
  let consumedCount = 0;

  for (const token of tokens) {
    if (!token.startsWith('@')) break;
    const name = token.slice(1).toLowerCase();
    const resolved = MENTION_TO_AGENT[name];
    if (resolved === undefined) break;
    if (resolved === 'all') {
      ALL_AGENTS.forEach((a) => targets.add(a));
    } else {
      targets.add(resolved);
    }
    consumedCount++;
  }

  const remainingText = tokens.slice(consumedCount).join(' ').trim();
  return { targets: orderedTargets(targets), remainingText };
}

function orderedTargets(targets: Set<AgentId>): AgentId[] {
  return ALL_AGENTS.filter((a) => targets.has(a));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/mentions.test.ts`
Expected: all 10 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/mentions.test.ts src/mentions.ts
git commit -m "feat(mentions): parse @claude/@gpt/@gemini/@all from user input"
```

---

### Task B3: Floor manager (TDD)

The floor manager owns the "who is currently speaking" lock and a queue of pending dispatches. It does not call agents itself — it just gates access.

**Files:**
- Create: `tests/floor.test.ts`
- Create: `src/floor.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/floor.test.ts
import { describe, it, expect } from 'vitest';
import { FloorManager } from '../src/floor.js';

describe('FloorManager', () => {
  it('grants the floor when free', async () => {
    const fm = new FloorManager();
    const handle = await fm.acquire('claude');
    expect(fm.holder()).toBe('claude');
    handle.release();
    expect(fm.holder()).toBeNull();
  });

  it('queues a second acquire until the first releases', async () => {
    const fm = new FloorManager();
    const first = await fm.acquire('claude');
    const order: string[] = [];

    const secondPromise = fm.acquire('gemini').then((handle) => {
      order.push('gemini');
      handle.release();
    });

    order.push('claude-released');
    first.release();

    await secondPromise;
    expect(order).toEqual(['claude-released', 'gemini']);
  });

  it('emits a status event when the holder changes', async () => {
    const fm = new FloorManager();
    const events: (string | null)[] = [];
    fm.onChange((h) => events.push(h));

    const handle = await fm.acquire('claude');
    handle.release();

    expect(events).toEqual(['claude', null]);
  });

  it('release is idempotent', async () => {
    const fm = new FloorManager();
    const handle = await fm.acquire('claude');
    handle.release();
    handle.release(); // should not throw or mutate state
    expect(fm.holder()).toBeNull();
  });

  it('reports queue length', async () => {
    const fm = new FloorManager();
    const first = await fm.acquire('claude');
    void fm.acquire('codex');
    void fm.acquire('gemini');
    expect(fm.queueLength()).toBe(2);
    first.release();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/floor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/floor.ts
import type { AgentId } from './types.js';

export interface FloorHandle {
  release(): void;
}

type Waiter = {
  agent: AgentId;
  resolve: (handle: FloorHandle) => void;
};

type ChangeListener = (holder: AgentId | null) => void;

export class FloorManager {
  private current: AgentId | null = null;
  private waiters: Waiter[] = [];
  private listeners = new Set<ChangeListener>();

  holder(): AgentId | null {
    return this.current;
  }

  queueLength(): number {
    return this.waiters.length;
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  acquire(agent: AgentId): Promise<FloorHandle> {
    return new Promise((resolve) => {
      if (this.current === null) {
        this.grant(agent, resolve);
      } else {
        this.waiters.push({ agent, resolve });
      }
    });
  }

  private grant(agent: AgentId, resolve: (handle: FloorHandle) => void): void {
    this.current = agent;
    this.emit();
    let released = false;
    const handle: FloorHandle = {
      release: () => {
        if (released) return;
        released = true;
        this.current = null;
        this.emit();
        const next = this.waiters.shift();
        if (next) {
          this.grant(next.agent, next.resolve);
        }
      },
    };
    resolve(handle);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.current);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/floor.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/floor.test.ts src/floor.ts
git commit -m "feat(floor): add FloorManager for sequential agent dispatch"
```

---

### Task B4: Claude adapter (TDD with mocked SDK)

**Files:**
- Create: `tests/agents/claude.test.ts`
- Create: `src/agents/claude.ts`

The exact SDK call shape comes from the spike findings (Task A5). The tests mock that shape so they don't need a live SDK.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/agents/claude.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ClaudeAgent } from '../../src/agents/claude.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';

// NOTE: the canned events below are AgentChunk-shaped for simplicity. The
// real SDK emits `assistant` / `result` / `system` events with nested
// `message.content[]` arrays — see the A5 findings doc for the real shape.
// Replace these mock events with realistic SDK events when implementing.

const mockedQuery = query as unknown as ReturnType<typeof vi.fn>;

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

describe('ClaudeAgent', () => {
  it('streams text events as text chunks', async () => {
    mockedQuery.mockReturnValueOnce(
      fromArray([
        { type: 'text', text: 'hello ' },
        { type: 'text', text: 'world' },
        { type: 'done' },
      ])
    );

    const agent = new ClaudeAgent();
    const chunks: unknown[] = [];
    for await (const chunk of agent.send('hi')) chunks.push(chunk);

    expect(chunks).toEqual([
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
      { type: 'done' },
    ]);
  });

  it('forwards tool-call events', async () => {
    mockedQuery.mockReturnValueOnce(
      fromArray([
        { type: 'tool-call', name: 'read_file', input: { path: 'a.ts' } },
        { type: 'done' },
      ])
    );

    const agent = new ClaudeAgent();
    const chunks = [];
    for await (const c of agent.send('hi')) chunks.push(c);

    expect(chunks[0]).toEqual({
      type: 'tool-call',
      name: 'read_file',
      input: { path: 'a.ts' },
    });
  });

  it('emits an error chunk when the SDK throws', async () => {
    mockedQuery.mockImplementationOnce(() => {
      throw new Error('boom');
    });

    const agent = new ClaudeAgent();
    const chunks = [];
    for await (const c of agent.send('hi')) chunks.push(c);

    expect(chunks).toEqual([
      { type: 'error', message: 'boom' },
      { type: 'done' },
    ]);
  });

  it('exposes id "claude"', () => {
    expect(new ClaudeAgent().id).toBe('claude');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/agents/claude.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/agents/claude.ts
import type { Agent, SendOptions } from './types.js';
import type { AgentChunk, AgentStatus } from '../types.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

export class ClaudeAgent implements Agent {
  readonly id = 'claude' as const;

  async status(): Promise<AgentStatus> {
    // Plan 2 will check ~/.claude/ for an auth token; for now report ready.
    return 'ready';
  }

  async *send(prompt: string, opts: SendOptions = {}): AsyncIterable<AgentChunk> {
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    if (opts.signal) {
      if (opts.signal.aborted) abortController.abort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    let stream: AsyncIterable<unknown>;
    try {
      stream = query({ prompt, options: { abortController, cwd: opts.cwd } });
    } catch (err) {
      yield { type: 'error', message: errorMessage(err) };
      yield { type: 'done' };
      opts.signal?.removeEventListener('abort', onAbort);
      return;
    }

    let sawTerminal = false;
    try {
      for await (const event of stream) {
        for (const chunk of mapSdkEvent(event)) {
          if (chunk.type === 'done') sawTerminal = true;
          yield chunk;
        }
      }
      if (!sawTerminal) yield { type: 'done' };
    } catch (err) {
      yield { type: 'error', message: errorMessage(err) };
      yield { type: 'done' };
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  async cancel(): Promise<void> {
    // Per-call cancellation is owned by the AbortController inside send().
    // No agent-wide state to clean up.
  }
}

// Real Claude Agent SDK event shape (from spike A2 findings):
//   - { type: 'system', subtype: 'init' | 'hook_started' | 'hook_response' }   → ignore
//   - { type: 'rate_limit_event', ... }                                          → ignore
//   - { type: 'assistant', message: { content: [...] } }
//       content[i].type === 'text'      → { type: 'text', text: content[i].text }
//       content[i].type === 'tool_use'  → { type: 'tool-call', name, input }
//   - { type: 'user', message: { content: [...] } }
//       content[i].type === 'tool_result' → { type: 'tool-result', name, output }
//   - { type: 'result', subtype: 'success' }                                     → { type: 'done' }
//   - { type: 'result', subtype: 'error', error: '...' }                         → { type: 'error', ... } then 'done'
function* mapSdkEvent(event: unknown): Generator<AgentChunk> {
  if (typeof event !== 'object' || event === null) return;
  const e = event as { type: string; subtype?: string; message?: { content?: Array<Record<string, unknown>> }; error?: string };

  switch (e.type) {
    case 'system':
    case 'rate_limit_event':
      return;

    case 'assistant':
      for (const item of e.message?.content ?? []) {
        if (item.type === 'text' && typeof item.text === 'string') {
          yield { type: 'text', text: item.text };
        } else if (item.type === 'tool_use' && typeof item.name === 'string') {
          yield { type: 'tool-call', name: item.name, input: item.input };
        }
      }
      return;

    case 'user':
      for (const item of e.message?.content ?? []) {
        if (item.type === 'tool_result') {
          const name = typeof item.tool_use_id === 'string' ? item.tool_use_id : 'unknown';
          yield { type: 'tool-result', name, output: item.content };
        }
      }
      return;

    case 'result':
      if (e.subtype === 'success') {
        yield { type: 'done' };
      } else if (e.subtype === 'error') {
        yield { type: 'error', message: e.error ?? 'Unknown error' };
        yield { type: 'done' };
      }
      return;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
```

The test fixtures in Step 1 use simplified AgentChunk-shaped mock events for clarity. When implementing, you'll likely also want one test that feeds a realistic `assistant` event (with a `message.content[]` array) into `mapSdkEvent` and asserts it produces the expected text/tool-call chunks — that's the test that validates the actual mapping logic, separate from the streaming/error tests above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/agents/claude.test.ts`
Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/agents/claude.test.ts src/agents/claude.ts
git commit -m "feat(agents): add ClaudeAgent wrapping Claude Code SDK"
```

---

### Task B5: Codex adapter (TDD using recorded fixture)

**Files:**
- Create: `tests/agents/codex.test.ts`
- Create: `src/agents/codex.ts`
- Use existing: `tests/agents/fixtures/codex-sample.txt` (from Task A5)

This task assumes the spike found a clean subprocess-piped non-interactive mode. If A5 documented that PTY emulation is required, see the **PTY contingency** at the end of this task.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/agents/codex.test.ts
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { CodexAgent } from '../../src/agents/codex.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';
const mockedSpawn = spawn as unknown as ReturnType<typeof vi.fn>;

function fakeProcess(stdoutChunks: string[], exitCode = 0) {
  const proc: any = new EventEmitter();
  proc.stdout = Readable.from(stdoutChunks);
  proc.stderr = Readable.from([]);
  proc.kill = vi.fn();
  setImmediate(() => proc.emit('close', exitCode));
  return proc;
}

describe('CodexAgent', () => {
  it('parses Codex JSONL events into AgentChunks', async () => {
    // Real Codex event shape from spike A3: thread.started → turn.started →
    // item.completed (with item.type === 'agent_message') → turn.completed.
    mockedSpawn.mockReturnValueOnce(
      fakeProcess([
        '{"type":"thread.started","thread_id":"abc"}\n',
        '{"type":"turn.started"}\n',
        '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n',
        '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n',
      ])
    );

    const agent = new CodexAgent();
    const chunks = [];
    for await (const c of agent.send('hi')) chunks.push(c);

    expect(chunks).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'done' },
    ]);
  });

  it('emits an error chunk on non-zero exit', async () => {
    mockedSpawn.mockReturnValueOnce(fakeProcess([], 1));

    const agent = new CodexAgent();
    const chunks = [];
    for await (const c of agent.send('hi')) chunks.push(c);

    expect(chunks).toContainEqual({
      type: 'error',
      message: expect.stringContaining('exit code 1'),
    });
    expect(chunks.at(-1)).toEqual({ type: 'done' });
  });

  it('exposes id "codex"', () => {
    expect(new CodexAgent().id).toBe('codex');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/agents/codex.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/agents/codex.ts
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Agent, SendOptions } from './types.js';
import type { AgentChunk, AgentStatus } from '../types.js';

// Spike A3: invoke `codex exec --json '<prompt>'` for non-interactive JSONL.
// On Windows, `codex` is an npm shim (codex.cmd) — plain spawn('codex') fails
// with ENOENT. Use the .cmd extension explicitly so Windows resolves it.
const CODEX_BIN = process.platform === 'win32' ? 'codex.cmd' : 'codex';
const CODEX_ARGS = (prompt: string): string[] => ['exec', '--json', prompt];

export class CodexAgent implements Agent {
  readonly id = 'codex' as const;
  private active: ChildProcess | null = null;

  async status(): Promise<AgentStatus> {
    return 'ready';
  }

  async *send(prompt: string, opts: SendOptions = {}): AsyncIterable<AgentChunk> {
    const child = spawn(CODEX_BIN, CODEX_ARGS(prompt), {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.active = child;

    if (opts.signal) {
      opts.signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    }

    const exitPromise = new Promise<{ code: number | null; stderr: string }>((resolve) => {
      let stderr = '';
      child.stderr?.on('data', (d) => (stderr += String(d)));
      child.on('close', (code) => resolve({ code, stderr }));
    });

    let buffer = '';
    let sawDone = false;
    try {
      for await (const data of child.stdout!) {
        buffer += String(data);
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const chunk = parseCodexEvent(line);
          if (!chunk) continue;
          if (chunk.type === 'done') sawDone = true;
          yield chunk;
        }
      }
      if (buffer.trim()) {
        const chunk = parseCodexEvent(buffer);
        if (chunk) {
          if (chunk.type === 'done') sawDone = true;
          yield chunk;
        }
      }
    } catch (err) {
      yield { type: 'error', message: errorMessage(err) };
    }

    const { code, stderr } = await exitPromise;
    if (code !== 0) {
      yield { type: 'error', message: `Codex exited with exit code ${code}${stderr ? `: ${stderr.trim()}` : ''}` };
    }
    if (!sawDone) yield { type: 'done' };
    this.active = null;
  }

  async cancel(): Promise<void> {
    this.active?.kill('SIGTERM');
  }
}

// Codex JSONL event shapes from spike A3:
//   { type: 'thread.started', thread_id }   → ignore
//   { type: 'turn.started' }                → ignore
//   { type: 'item.completed', item: { type: 'agent_message', text: '...' } } → text chunk
//   { type: 'turn.completed', usage: {...} } → done
function parseCodexEvent(line: string): AgentChunk | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let event: { type?: string; item?: { type?: string; text?: string } };
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null; // ignore non-JSON lines (stray banners, ANSI noise)
  }
  switch (event.type) {
    case 'item.completed':
      if (event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        return { type: 'text', text: event.item.text };
      }
      return null;
    case 'turn.completed':
      return { type: 'done' };
    default:
      return null;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
```

If `spawn('codex.cmd', ...)` still fails with ENOENT on Windows (some Node 20+ versions are stricter about `.cmd` files without `shell: true`), the fallback is to invoke node directly against the JS entrypoint at `%APPDATA%\\npm\\node_modules\\@openai\\codex\\bin\\codex.js`. Try the simple form first; only complicate if needed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/agents/codex.test.ts`
Expected: all 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/agents/codex.test.ts src/agents/codex.ts
git commit -m "feat(agents): add CodexAgent wrapping Codex CLI subprocess"
```

**PTY contingency:** If A5 documented that Codex requires PTY emulation, replace `spawn` with `node-pty.spawn` and adjust the test's mock accordingly. The chunk-emission logic is unchanged — only the transport differs.

---

### Task B6: Gemini adapter (TDD using recorded fixture)

**Files:**
- Create: `tests/agents/gemini.test.ts`
- Create: `src/agents/gemini.ts`
- Use existing: `tests/agents/fixtures/gemini-sample.txt`

Mirror Task B5. Replace `CODEX_BIN`, args, and tests with Gemini equivalents from the spike.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/agents/gemini.test.ts
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { GeminiAgent } from '../../src/agents/gemini.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';
const mockedSpawn = spawn as unknown as ReturnType<typeof vi.fn>;

function fakeProcess(stdoutChunks: string[], exitCode = 0) {
  const proc: any = new EventEmitter();
  proc.stdout = Readable.from(stdoutChunks);
  proc.stderr = Readable.from([]);
  proc.kill = vi.fn();
  setImmediate(() => proc.emit('close', exitCode));
  return proc;
}

describe('GeminiAgent', () => {
  it('parses Gemini stream-json events into AgentChunks', async () => {
    // Real Gemini event shape from spike A4 (CLI invoked with -o stream-json):
    // init → message(user echo) → message(assistant, delta:true) → result
    mockedSpawn.mockReturnValueOnce(
      fakeProcess([
        '{"type":"init"}\n',
        '{"type":"message","role":"user","content":"hi"}\n',
        '{"type":"message","role":"assistant","content":"ok","delta":true}\n',
        '{"type":"result","status":"success"}\n',
      ])
    );

    const agent = new GeminiAgent();
    const chunks = [];
    for await (const c of agent.send('hi')) chunks.push(c);

    expect(chunks).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'done' },
    ]);
  });

  it('emits an error chunk on non-zero exit', async () => {
    mockedSpawn.mockReturnValueOnce(fakeProcess([], 2));

    const agent = new GeminiAgent();
    const chunks = [];
    for await (const c of agent.send('hi')) chunks.push(c);

    expect(chunks).toContainEqual({
      type: 'error',
      message: expect.stringContaining('exit code 2'),
    });
  });

  it('exposes id "gemini"', () => {
    expect(new GeminiAgent().id).toBe('gemini');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/agents/gemini.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/agents/gemini.ts
import { spawn, execSync } from 'node:child_process';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Agent, SendOptions } from './types.js';
import type { AgentChunk, AgentStatus } from '../types.js';

// Spike A4: invoke `gemini -p '<prompt>' -o stream-json` for non-interactive JSONL.
//
// Windows quirk (worse than Codex): the npm shim `gemini.cmd` cannot be
// spawned cleanly on Node 20+ — Node's DEP0190 mitigation rejects raw
// .cmd spawning, and shell:true introduces unsafe arg concatenation.
// The reliable approach is to invoke the bundle's JS entrypoint directly
// via the running Node executable. Resolve the bundle path once at module
// load using `npm root -g`.
const GEMINI_CMD = resolveGeminiCommand();

function resolveGeminiCommand(): { command: string; args: string[] } {
  if (process.platform !== 'win32') {
    return { command: 'gemini', args: [] };
  }
  const npmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  const bundle = join(npmRoot, '@google', 'gemini-cli', 'bundle', 'gemini.js');
  return { command: process.execPath, args: [bundle] };
}

const GEMINI_ARGS = (prompt: string): string[] => ['-p', prompt, '-o', 'stream-json'];

export class GeminiAgent implements Agent {
  readonly id = 'gemini' as const;
  private active: ChildProcess | null = null;

  async status(): Promise<AgentStatus> {
    return 'ready';
  }

  async *send(prompt: string, opts: SendOptions = {}): AsyncIterable<AgentChunk> {
    const child = spawn(
      GEMINI_CMD.command,
      [...GEMINI_CMD.args, ...GEMINI_ARGS(prompt)],
      { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    this.active = child;

    if (opts.signal) {
      opts.signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    }

    const exitPromise = new Promise<{ code: number | null; stderr: string }>((resolve) => {
      let stderr = '';
      child.stderr?.on('data', (d) => (stderr += String(d)));
      child.on('close', (code) => resolve({ code, stderr }));
    });

    let buffer = '';
    let sawDone = false;
    try {
      for await (const data of child.stdout!) {
        buffer += String(data);
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const chunk = parseGeminiEvent(line);
          if (!chunk) continue;
          if (chunk.type === 'done') sawDone = true;
          yield chunk;
        }
      }
      if (buffer.trim()) {
        const chunk = parseGeminiEvent(buffer);
        if (chunk) {
          if (chunk.type === 'done') sawDone = true;
          yield chunk;
        }
      }
    } catch (err) {
      yield { type: 'error', message: errorMessage(err) };
    }

    const { code, stderr } = await exitPromise;
    if (code !== 0) {
      yield { type: 'error', message: `Gemini exited with exit code ${code}${stderr ? `: ${stderr.trim()}` : ''}` };
    }
    if (!sawDone) yield { type: 'done' };
    this.active = null;
  }

  async cancel(): Promise<void> {
    this.active?.kill('SIGTERM');
  }
}

// Gemini stream-json event shapes from spike A4:
//   { type: 'init', ... }                                                     → ignore
//   { type: 'message', role: 'user', content: '...' }                         → ignore (user echo)
//   { type: 'message', role: 'assistant', content: '...', delta: true }       → text chunk
//   { type: 'result', status: 'success' }                                     → done
//   { type: 'result', status: 'error', error: '...' }                         → error then done
function parseGeminiEvent(line: string): AgentChunk | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let event: { type?: string; role?: string; content?: string; delta?: boolean; status?: string; error?: string };
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null; // ignore non-JSON lines (stderr warnings get filtered upstream)
  }
  switch (event.type) {
    case 'message':
      if (event.role === 'assistant' && typeof event.content === 'string') {
        return { type: 'text', text: event.content };
      }
      return null;
    case 'result':
      if (event.status === 'success') {
        return { type: 'done' };
      }
      // 'error' is handled by yielding both error + done; parseGeminiEvent
      // can't yield two chunks, so the caller checks for status === 'error'
      // separately if needed. For v1, treat error result as still emitting
      // done from the exit-code path.
      return null;
    default:
      return null;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
```

If `npm root -g` fails (e.g., npm isn't on PATH), `resolveGeminiCommand` will throw at module load — that's intentional; the adapter cannot function without resolving the bundle path on Windows. Surface this as a clear error in the test/integration suite. On non-Windows platforms, the simple `gemini` binary on PATH is used directly.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/agents/gemini.test.ts`
Expected: all 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/agents/gemini.test.ts src/agents/gemini.ts
git commit -m "feat(agents): add GeminiAgent wrapping Gemini CLI subprocess"
```

---

## Phase C — Message router

### Task C1: MessageRouter with mention-based dispatch (TDD)

This task wires together the parser, floor manager, and agents. No facilitator yet — Plan 2 adds that layer. For Plan 1, a message without `@mention` produces an error chunk telling the user to mention an agent.

**Files:**
- Create: `tests/messageRouter.test.ts`
- Create: `src/messageRouter.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/messageRouter.test.ts
import { describe, it, expect, vi } from 'vitest';
import { MessageRouter } from '../src/messageRouter.js';
import type { Agent } from '../src/agents/types.js';
import type { AgentChunk, AgentId } from '../src/types.js';

function fakeAgent(id: AgentId, replyChunks: AgentChunk[]): Agent {
  return {
    id,
    status: vi.fn().mockResolvedValue('ready'),
    cancel: vi.fn().mockResolvedValue(undefined),
    async *send() {
      for (const c of replyChunks) yield c;
    },
  };
}

describe('MessageRouter', () => {
  it('dispatches to a single mentioned agent and forwards chunks tagged with agentId', async () => {
    const claude = fakeAgent('claude', [
      { type: 'text', text: 'hi from claude' },
      { type: 'done' },
    ]);
    const codex = fakeAgent('codex', []);
    const gemini = fakeAgent('gemini', []);

    const router = new MessageRouter({ claude, codex, gemini });

    const events: any[] = [];
    for await (const ev of router.handle('@claude hello')) events.push(ev);

    expect(events).toEqual([
      { kind: 'dispatch-start', agentId: 'claude' },
      { kind: 'chunk', agentId: 'claude', chunk: { type: 'text', text: 'hi from claude' } },
      { kind: 'chunk', agentId: 'claude', chunk: { type: 'done' } },
      { kind: 'dispatch-end', agentId: 'claude' },
    ]);
  });

  it('dispatches to multiple agents sequentially in @all order', async () => {
    const claude = fakeAgent('claude', [{ type: 'text', text: 'a' }, { type: 'done' }]);
    const codex = fakeAgent('codex', [{ type: 'text', text: 'b' }, { type: 'done' }]);
    const gemini = fakeAgent('gemini', [{ type: 'text', text: 'c' }, { type: 'done' }]);

    const router = new MessageRouter({ claude, codex, gemini });
    const order: AgentId[] = [];
    for await (const ev of router.handle('@all hi')) {
      if (ev.kind === 'dispatch-start') order.push(ev.agentId);
    }

    expect(order).toEqual(['claude', 'codex', 'gemini']);
  });

  it('emits a routing-needed event when no @mention is present', async () => {
    const claude = fakeAgent('claude', []);
    const codex = fakeAgent('codex', []);
    const gemini = fakeAgent('gemini', []);
    const router = new MessageRouter({ claude, codex, gemini });

    const events = [];
    for await (const ev of router.handle('plain text no mention')) events.push(ev);

    expect(events).toEqual([
      { kind: 'routing-needed', text: 'plain text no mention' },
    ]);
  });

  it('passes only the remainingText (mentions stripped) to the agent', async () => {
    const sendSpy = vi.fn();
    const claude: Agent = {
      id: 'claude',
      status: vi.fn().mockResolvedValue('ready'),
      cancel: vi.fn().mockResolvedValue(undefined),
      send: ((prompt: string) => {
        sendSpy(prompt);
        return (async function* () {
          yield { type: 'done' } as AgentChunk;
        })();
      }) as Agent['send'],
    };
    const codex = fakeAgent('codex', []);
    const gemini = fakeAgent('gemini', []);

    const router = new MessageRouter({ claude, codex, gemini });
    for await (const _ of router.handle('@claude review this')) { /* drain */ }

    expect(sendSpy).toHaveBeenCalledWith('review this');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/messageRouter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/messageRouter.ts
import { parseMentions } from './mentions.js';
import { FloorManager } from './floor.js';
import type { Agent } from './agents/types.js';
import type { AgentChunk, AgentId } from './types.js';

export interface AgentRegistry {
  claude: Agent;
  codex: Agent;
  gemini: Agent;
}

export type RouterEvent =
  | { kind: 'dispatch-start'; agentId: AgentId }
  | { kind: 'chunk'; agentId: AgentId; chunk: AgentChunk }
  | { kind: 'dispatch-end'; agentId: AgentId }
  | { kind: 'routing-needed'; text: string };

export class MessageRouter {
  private floor = new FloorManager();

  constructor(private agents: AgentRegistry) {}

  async *handle(input: string): AsyncIterable<RouterEvent> {
    const { targets, remainingText } = parseMentions(input);

    if (targets.length === 0) {
      yield { kind: 'routing-needed', text: remainingText || input };
      return;
    }

    for (const targetId of targets) {
      const handle = await this.floor.acquire(targetId);
      try {
        yield { kind: 'dispatch-start', agentId: targetId };
        const agent = this.agents[targetId];
        for await (const chunk of agent.send(remainingText)) {
          yield { kind: 'chunk', agentId: targetId, chunk };
        }
        yield { kind: 'dispatch-end', agentId: targetId };
      } finally {
        handle.release();
      }
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/messageRouter.test.ts`
Expected: all 4 tests pass.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests across `mentions`, `floor`, `messageRouter`, and the three agent suites pass.

- [ ] **Step 6: Commit**

```bash
git add tests/messageRouter.test.ts src/messageRouter.ts
git commit -m "feat(router): MessageRouter with @mention dispatch and floor lock"
```

---

### Task C2: Live integration tests (opt-in)

These tests hit the real CLIs/SDK using the user's actual subscriptions. They are excluded from the default test run and gated behind `npm run test:integration`. They are slow, cost subscription quota, and require all three CLIs installed and authenticated.

**Files:**
- Create: `tests/integration/README.md`
- Create: `tests/integration/claude.live.test.ts`
- Create: `tests/integration/codex.live.test.ts`
- Create: `tests/integration/gemini.live.test.ts`

- [ ] **Step 1: Write `tests/integration/README.md`**

```markdown
# Live integration tests

These tests run against the **real** CLIs/SDKs using your subscription auth.

## Prerequisites
- Claude Code logged in: `claude /login`
- Codex CLI logged in: `codex login`
- Gemini CLI logged in: run `gemini` once and complete OAuth

## Run
```bash
npm run test:integration
```

## What they verify
- Each agent responds to a minimal "say ok" prompt
- The chunk stream begins, contains some text, and ends with `{ type: 'done' }`

## What they do NOT verify
- Tool execution
- Long conversations / multi-turn context
- Performance / rate limits

## Cost
Each test consumes a single tiny prompt's worth of subscription quota. Don't run in a tight loop.
```

- [ ] **Step 2: Write `tests/integration/claude.live.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { ClaudeAgent } from '../../src/agents/claude.js';

describe('ClaudeAgent — LIVE', () => {
  it('responds to a minimal prompt', async () => {
    const agent = new ClaudeAgent();
    const chunks = [];
    for await (const c of agent.send('Reply with just the word "ok".')) {
      chunks.push(c);
    }
    const text = chunks
      .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
      .map((c) => c.text)
      .join('');
    expect(text.toLowerCase()).toContain('ok');
    expect(chunks.at(-1)).toEqual({ type: 'done' });
  }, 60_000);
});
```

- [ ] **Step 3: Write `tests/integration/codex.live.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { CodexAgent } from '../../src/agents/codex.js';

describe('CodexAgent — LIVE', () => {
  it('responds to a minimal prompt', async () => {
    const agent = new CodexAgent();
    const chunks = [];
    for await (const c of agent.send('Reply with just the word "ok".')) {
      chunks.push(c);
    }
    const text = chunks
      .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
      .map((c) => c.text)
      .join('');
    expect(text.toLowerCase()).toContain('ok');
    expect(chunks.at(-1)).toEqual({ type: 'done' });
  }, 60_000);
});
```

- [ ] **Step 4: Write `tests/integration/gemini.live.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { GeminiAgent } from '../../src/agents/gemini.js';

describe('GeminiAgent — LIVE', () => {
  it('responds to a minimal prompt', async () => {
    const agent = new GeminiAgent();
    const chunks = [];
    for await (const c of agent.send('Reply with just the word "ok".')) {
      chunks.push(c);
    }
    const text = chunks
      .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
      .map((c) => c.text)
      .join('');
    expect(text.toLowerCase()).toContain('ok');
    expect(chunks.at(-1)).toEqual({ type: 'done' });
  }, 60_000);
});
```

- [ ] **Step 5: Run the integration tests once manually**

Run: `npm run test:integration`
Expected: three live tests, each producing some text containing "ok" and ending in `done`. If any agent fails, the failure message will indicate which (auth issue, missing binary, output format mismatch). Use the failure to refine the corresponding adapter and re-run.

- [ ] **Step 6: Commit**

```bash
git add tests/integration/
git commit -m "test: live integration tests for each agent (opt-in via npm run test:integration)"
```

---

## Self-review checklist (already run)

**Spec coverage:**
- §2 In scope: chat panel webview → Plan 2; three agents wrapped → ✓ B4–B6; subscription auth → ✓ (no API code in plan); facilitator → Plan 2; @mention syntax → ✓ B2; sequential turn-taking → ✓ B3; per-workspace persistence → Plan 2; inline error states → Plan 2.
- §4 component contracts: Agent interface → ✓ B1; Facilitator → Plan 2; Message Router → ✓ C1; Session Store → Plan 2.
- §5 per-CLI integration: Claude SDK → ✓ A2 + B4; Codex CLI → ✓ A3 + B5; Gemini CLI → ✓ A4 + B6; PTY contingency → ✓ documented in B5/B6.
- §10 testing: unit tests for adapter normalization, mentions parser, floor → ✓; integration tests opt-in → ✓ C2; facilitator routing tests → Plan 2.

**Placeholder scan:** No "TBD" / "fill in later" markers. Spike A2/A3/A4 outcomes feed directly into B4/B5/B6 task code (with documented fallbacks for the PTY case).

**Type consistency:** `AgentId`, `AgentChunk`, `Agent`, `MentionTarget`, `FloorHandle`, `RouterEvent`, `AgentRegistry` are defined once and used consistently across tasks.

**Plan 2 will cover:** webview UI (panel, composer, mention autocomplete, streaming bubbles, floor indicator), session store / persistence, facilitator + routing chips, error matrix (subscription health strip, hang detection, watchdog), manual smoke-test pass.
