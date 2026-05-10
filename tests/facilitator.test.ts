import { describe, it, expect, vi } from 'vitest';
import { chooseFacilitatorAgent } from '../src/facilitator.js';
import type { AgentStatus } from '../src/types.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

vi.mock('../src/findNode.js', () => ({
  findNode: vi.fn(() => 'C:\\node.exe'),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { findNode } from '../src/findNode.js';
const mockedQuery = query as unknown as ReturnType<typeof vi.fn>;
const mockedFindNode = findNode as unknown as ReturnType<typeof vi.fn>;

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

  it('falls back to deterministic routing on malformed JSON', async () => {
    mockedQuery.mockReturnValueOnce(sdkResponse('not even close to json'));
    const decision = await chooseFacilitatorAgent('run the tests', allReady);
    expect(decision).toMatchObject({ agent: 'codex', reason: expect.stringContaining('fallback') });
  });

  it('falls back to deterministic routing on invalid agent name', async () => {
    mockedQuery.mockReturnValueOnce(sdkResponse('{"agent":"GPT-9000","reason":"ok"}'));
    const decision = await chooseFacilitatorAgent('review this design', allReady);
    expect(decision).toMatchObject({ agent: 'claude', reason: expect.stringContaining('fallback') });
  });

  it('falls back to a ready agent when the facilitator selects an unavailable agent', async () => {
    mockedQuery.mockReturnValueOnce(sdkResponse('{"agent":"codex","reason":"run tests"}'));
    const decision = await chooseFacilitatorAgent(
      'research the latest VS Code chat API',
      { claude: 'ready', codex: 'unauthenticated', gemini: 'ready' },
    );
    expect(decision).toMatchObject({ agent: 'gemini', reason: expect.stringContaining('fallback') });
  });

  it('does not offer busy agents to the routing model and falls back if one is selected', async () => {
    let capturedSystemPrompt = '';
    mockedQuery.mockImplementationOnce(({ options }: { options: { systemPrompt: string } }) => {
      capturedSystemPrompt = options.systemPrompt;
      return sdkResponse('{"agent":"codex","reason":"run tests"}');
    });

    const decision = await chooseFacilitatorAgent(
      'review this design',
      { claude: 'ready', codex: 'busy', gemini: 'not-installed' },
    );

    expect(capturedSystemPrompt).toContain('- claude:');
    expect(capturedSystemPrompt).not.toContain('- codex:');
    expect(decision).toMatchObject({ agent: 'claude', reason: expect.stringContaining('fallback') });
  });

  it('returns error without calling SDK when all agents unavailable', async () => {
    mockedQuery.mockClear();
    const decision = await chooseFacilitatorAgent(
      'anything',
      { claude: 'unauthenticated', codex: 'unauthenticated', gemini: 'not-installed' },
    );
    expect(decision).toMatchObject({ error: expect.stringContaining('Veyra: Check agent status') });
    expect(decision).toMatchObject({ error: expect.stringContaining('Veyra: Show setup guide') });
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it('returns busy-specific guidance without calling SDK when every usable agent is busy', async () => {
    mockedQuery.mockClear();
    const decision = await chooseFacilitatorAgent(
      'review this',
      { claude: 'busy', codex: 'busy', gemini: 'not-installed' },
    );

    expect(decision).toMatchObject({ error: expect.stringContaining('busy') });
    expect(decision).toMatchObject({ error: expect.stringContaining('wait') });
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it('falls back to deterministic routing when SDK throws', async () => {
    mockedQuery.mockImplementationOnce(() => { throw new Error('auth fail'); });
    const decision = await chooseFacilitatorAgent('implement the fix', allReady);
    expect(decision).toMatchObject({ agent: 'codex', reason: expect.stringContaining('fallback') });
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

  it('keeps the facilitator system prompt ASCII-safe for extension-host logs', async () => {
    let capturedSystemPrompt = '';
    mockedQuery.mockImplementationOnce(({ options }: { options: { systemPrompt: string } }) => {
      capturedSystemPrompt = options.systemPrompt;
      return sdkResponse('{"agent":"codex","reason":"run tests"}');
    });

    await chooseFacilitatorAgent('run the tests', allReady);

    expect(capturedSystemPrompt).toContain('codex: execution - running tests, scripts, terminal commands, file edits');
    expect(capturedSystemPrompt).not.toMatch(/[^\x00-\x7F]/);
  });

  it('uses the real node executable when routing inside the VS Code extension host', async () => {
    const originalExecPath = process.execPath;
    const originalElectron = Object.getOwnPropertyDescriptor(process.versions, 'electron');
    Object.defineProperty(process.versions, 'electron', {
      configurable: true,
      value: '32.0.0',
    });
    let execPathDuringQuery = '';
    mockedFindNode.mockClear();
    mockedQuery.mockImplementationOnce(() => {
      execPathDuringQuery = process.execPath;
      return sdkResponse('{"agent":"claude","reason":"code review"}');
    });

    try {
      await chooseFacilitatorAgent('review this', allReady);
    } finally {
      if (originalElectron) {
        Object.defineProperty(process.versions, 'electron', originalElectron);
      } else {
        delete (process.versions as { electron?: string }).electron;
      }
    }

    expect(mockedFindNode).toHaveBeenCalledTimes(1);
    expect(execPathDuringQuery).toBe('C:\\node.exe');
    expect(process.execPath).toBe(originalExecPath);
  });
});
