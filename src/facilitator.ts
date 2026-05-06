import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentId, AgentStatus } from './types.js';

const ROUTING_ERROR = 'Routing unavailable; please prefix with @claude / @gpt / @gemini / @all';
const NO_AGENTS_ERROR = 'No agents currently authenticated; check the health pills';

export type FacilitatorDecision =
  | { agent: AgentId; reason: string }
  | { error: string };

export type FacilitatorFn = (
  userMessage: string,
  availability: Record<AgentId, AgentStatus>,
  sharedContext?: string,
) => Promise<FacilitatorDecision>;

const PROFILES: Record<AgentId, string> = {
  claude: 'code reasoning, refactors, code review, planning, design discussion',
  codex: 'execution — running tests, scripts, terminal commands, file edits',
  gemini: 'research, current events, large-context document reading',
};

export const chooseFacilitatorAgent: FacilitatorFn = async (
  userMessage,
  availability,
  sharedContext = '',
) => {
  const available = (Object.entries(availability) as Array<[AgentId, AgentStatus]>)
    .filter(([, status]) => status === 'ready' || status === 'busy')
    .map(([id]) => id);

  if (available.length === 0) {
    return { error: NO_AGENTS_ERROR };
  }

  const profileLines = available.map((id) => `- ${id}: ${PROFILES[id]}`).join('\n');

  const systemPromptParts = [
    "You are a routing assistant for a multi-agent chat tool. Pick the single best agent for the user's message and explain your choice in 4-8 words.",
    '',
    'Available agents:',
    profileLines,
    '',
  ];
  if (sharedContext.trim().length > 0) {
    systemPromptParts.push('Recent conversation context (for follow-up routing):');
    systemPromptParts.push(sharedContext);
    systemPromptParts.push('');
  }
  systemPromptParts.push('Respond with EXACTLY this JSON shape and nothing else:');
  systemPromptParts.push(
    '{ "agent": "<one of: ' + available.join(' | ') + '>", "reason": "<brief reason>" }',
  );

  const systemPrompt = systemPromptParts.join('\n');

  let responseText = '';
  try {
    const stream = query({
      prompt: userMessage,
      options: { systemPrompt },
    });
    for await (const event of stream as AsyncIterable<unknown>) {
      const e = event as { type?: string; message?: { content?: Array<Record<string, unknown>> } };
      if (e.type === 'assistant') {
        for (const item of e.message?.content ?? []) {
          if (item.type === 'text' && typeof item.text === 'string') {
            responseText += item.text as string;
          }
        }
      }
    }
  } catch {
    return { error: ROUTING_ERROR };
  }

  const cleaned = responseText
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { error: ROUTING_ERROR };
  }

  if (
    typeof parsed !== 'object' || parsed === null ||
    typeof (parsed as { agent?: unknown }).agent !== 'string' ||
    typeof (parsed as { reason?: unknown }).reason !== 'string'
  ) {
    return { error: ROUTING_ERROR };
  }

  const decision = parsed as { agent: string; reason: string };
  if (!available.includes(decision.agent as AgentId)) {
    return { error: ROUTING_ERROR };
  }

  return { agent: decision.agent as AgentId, reason: decision.reason };
};
