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
  const normalizedInput = input.trim();
  const targets = new Set<AgentId>();
  let cursor = 0;
  let consumedAny = false;

  while (cursor < normalizedInput.length) {
    const tokenStart = skipWhitespace(normalizedInput, cursor);
    if (normalizedInput[tokenStart] !== '@') break;
    const tokenEnd = nextWhitespace(normalizedInput, tokenStart);
    const token = normalizedInput.slice(tokenStart, tokenEnd);
    const name = token.slice(1).replace(/[,:;]+$/, '').toLowerCase();
    const resolved = MENTION_TO_AGENT[name];
    if (resolved === undefined) break;
    if (resolved === 'all') {
      ALL_AGENTS.forEach((a) => targets.add(a));
    } else {
      targets.add(resolved);
    }
    cursor = tokenEnd;
    consumedAny = true;
  }

  const remainingText = consumedAny ? normalizedInput.slice(cursor).trim() : normalizedInput;
  return { targets: orderedTargets(targets), remainingText };
}

function skipWhitespace(input: string, start: number): number {
  let i = start;
  while (i < input.length && /\s/.test(input[i])) i++;
  return i;
}

function nextWhitespace(input: string, start: number): number {
  let i = start;
  while (i < input.length && !/\s/.test(input[i])) i++;
  return i;
}

function orderedTargets(targets: Set<AgentId>): AgentId[] {
  return ALL_AGENTS.filter((a) => targets.has(a));
}
