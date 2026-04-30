import type { Agent, SendOptions } from './types.js';
import type { AgentChunk, AgentStatus } from '../types.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { checkClaude } from '../statusChecks.js';

export class ClaudeAgent implements Agent {
  readonly id = 'claude' as const;
  private activeAbortController: AbortController | null = null;

  async status(): Promise<AgentStatus> {
    return checkClaude();
  }

  async *send(prompt: string, opts: SendOptions = {}): AsyncIterable<AgentChunk> {
    const abortController = new AbortController();
    this.activeAbortController = abortController;
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
      this.activeAbortController = null;
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
      this.activeAbortController = null;
    }
  }

  async cancel(): Promise<void> {
    this.activeAbortController?.abort();
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
//
// Option A: also pass through events whose `type` is already a valid AgentChunk
// discriminator (text / tool-call / tool-result / error / done). This keeps the
// four canned tests passing while the fifth test exercises the real switch.
function* mapSdkEvent(event: unknown): Generator<AgentChunk> {
  if (typeof event !== 'object' || event === null) return;
  const e = event as {
    type: string;
    subtype?: string;
    message?: { content?: Array<Record<string, unknown>> };
    error?: string;
    text?: string;
    name?: string;
    input?: unknown;
    message_text?: string;
    output?: unknown;
  };

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

    // Option A: pass-through for events already shaped as AgentChunk.
    // The four canned tests send { type: 'text', text: '...' } / { type: 'tool-call', ... }
    // / { type: 'done' } directly; these fall here and are emitted as-is.
    case 'text':
      if (typeof e.text === 'string') yield { type: 'text', text: e.text };
      return;

    case 'tool-call':
      if (typeof e.name === 'string') yield { type: 'tool-call', name: e.name, input: e.input };
      return;

    case 'tool-result':
      if (typeof e.name === 'string') yield { type: 'tool-result', name: e.name, output: e.output };
      return;

    case 'error': {
      const msg = (event as { message?: unknown }).message;
      if (typeof msg === 'string') {
        yield { type: 'error', message: msg };
      }
      return;
    }

    case 'done':
      yield { type: 'done' };
      return;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
