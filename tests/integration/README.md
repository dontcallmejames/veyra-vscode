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
