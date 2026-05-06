import { describe, it, expect, vi } from 'vitest';
import { chooseFacilitatorAgent } from '../src/facilitator.js';
import type { AgentStatus } from '../src/types.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
const mockedQuery = query as unknown as ReturnType<typeof vi.fn>;

async function* sdkResponse(text: string) {
  yield {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  };
  yield { type: 'result', subtype: 'success' };
}

const allReady: Record<'claude' | 'codex' | 'gemini', AgentStatus> = {
  claude: 'ready', codex: 'ready', gemini: 'ready',
};

describe('chooseFacilitatorAgent', () => {
  it('returns parsed { agent, reason } on well-formed JSON response', async () => {
    mockedQuery.mockReturnValueOnce(sdkResponse('{"agent":"gemini","reason":"current events"}'));
    const decision = await chooseFacilitatorAgent('what is the news?', allReady);
    expect(decision).toEqual({ agent: 'gemini', reason: 'current events' });
  });

  it('strips markdown code fences before parsing', async () => {
    const fenced = '```json\n{"agent":"claude","reason":"code review"}\n```';
    mockedQuery.mockReturnValueOnce(sdkResponse(fenced));
    const decision = await chooseFacilitatorAgent('review this', allReady);
    expect(decision).toEqual({ agent: 'claude', reason: 'code review' });
  });

  it('returns error on malformed JSON', async () => {
    mockedQuery.mockReturnValueOnce(sdkResponse('not even close to json'));
    const decision = await chooseFacilitatorAgent('hello', allReady);
    expect(decision).toMatchObject({ error: expect.stringContaining('Routing unavailable') });
  });

  it('returns error on invalid agent name', async () => {
    mockedQuery.mockReturnValueOnce(sdkResponse('{"agent":"GPT-9000","reason":"ok"}'));
    const decision = await chooseFacilitatorAgent('hi', allReady);
    expect(decision).toMatchObject({ error: expect.stringContaining('Routing unavailable') });
  });

  it('returns error on agent that is unavailable', async () => {
    mockedQuery.mockReturnValueOnce(sdkResponse('{"agent":"codex","reason":"run tests"}'));
    const decision = await chooseFacilitatorAgent(
      'run tests',
      { claude: 'ready', codex: 'unauthenticated', gemini: 'ready' },
    );
    // Facilitator picked unavailable; we treat as error.
    expect(decision).toMatchObject({ error: expect.stringContaining('Routing unavailable') });
  });

  it('returns error without calling SDK when all agents unavailable', async () => {
    mockedQuery.mockClear();
    const decision = await chooseFacilitatorAgent(
      'anything',
      { claude: 'unauthenticated', codex: 'unauthenticated', gemini: 'not-installed' },
    );
    expect(decision).toMatchObject({ error: expect.stringContaining('No agents currently authenticated') });
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it('returns error when SDK throws', async () => {
    mockedQuery.mockImplementationOnce(() => { throw new Error('auth fail'); });
    const decision = await chooseFacilitatorAgent('hi', allReady);
    expect(decision).toMatchObject({ error: expect.stringContaining('Routing unavailable') });
  });

  it('passes shared context into the system prompt when provided', async () => {
    let capturedSystemPrompt = '';
    let capturedUserPrompt = '';
    mockedQuery.mockImplementationOnce(({ prompt, options }: { prompt: string; options: { systemPrompt: string } }) => {
      capturedSystemPrompt = options.systemPrompt;
      capturedUserPrompt = prompt;
      return sdkResponse('{"agent":"claude","reason":"r"}');
    });

    const sharedContext = '[Conversation so far]\nuser: prior\n[/Conversation so far]';
    await chooseFacilitatorAgent('what next', allReady, sharedContext);

    expect(capturedSystemPrompt).toContain('Conversation so far');
    expect(capturedSystemPrompt).toContain('user: prior');
    expect(capturedUserPrompt).toBe('what next');
  });

  it('omits shared-context block from system prompt when sharedContext is empty', async () => {
    let capturedSystemPrompt = '';
    mockedQuery.mockImplementationOnce(({ options }: { options: { systemPrompt: string } }) => {
      capturedSystemPrompt = options.systemPrompt;
      return sdkResponse('{"agent":"claude","reason":"r"}');
    });

    await chooseFacilitatorAgent('hi', allReady, '');

    expect(capturedSystemPrompt).not.toContain('Recent conversation context');
  });
});
