export type MentionTarget = 'claude' | 'codex' | 'gemini' | 'all';

export type AgentId = 'claude' | 'codex' | 'gemini';

export type AgentStatus = 'ready' | 'unauthenticated' | 'not-installed' | 'inaccessible' | 'misconfigured' | 'node-missing' | 'busy';

export type AgentChunk =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; name: string; input: unknown }
  | { type: 'tool-result'; name: string; output: unknown }
  | { type: 'error'; message: string }
  | { type: 'done' };
