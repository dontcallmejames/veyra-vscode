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
