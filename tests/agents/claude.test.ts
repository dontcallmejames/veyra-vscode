import { describe, it, expect, vi } from 'vitest';
import { ClaudeAgent } from '../../src/agents/claude.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';

const mockedQuery = query as unknown as ReturnType<typeof vi.fn>;

// NOTE: the canned events below are AgentChunk-shaped for simplicity. The
// real SDK emits `assistant` / `result` / `system` events with nested
// `message.content[]` arrays — see the A5 findings doc for the real shape.
// Replace these mock events with realistic SDK events when implementing.
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

  it('maps a realistic assistant event with text + tool_use into chunks', async () => {
    mockedQuery.mockReturnValueOnce(
      fromArray([
        { type: 'system', subtype: 'init' }, // ignored
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Looking at the file...' },
              { type: 'tool_use', name: 'read_file', input: { path: 'a.ts' } },
            ],
          },
        },
        { type: 'result', subtype: 'success' },
      ])
    );

    const agent = new ClaudeAgent();
    const chunks = [];
    for await (const c of agent.send('hi')) chunks.push(c);

    expect(chunks).toEqual([
      { type: 'text', text: 'Looking at the file...' },
      { type: 'tool-call', name: 'read_file', input: { path: 'a.ts' } },
      { type: 'done' },
    ]);
  });
});
