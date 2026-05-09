export type GambitWorkflowCommand = 'review' | 'debate' | 'implement';

export function gambitWorkflowPrompt(command: GambitWorkflowCommand, prompt: string): string {
  if (command === 'review') {
    return [
      '@all',
      'Workflow: review',
      'Review this request independently, then build on prior agents where useful.',
      'Claude: review architecture, requirements fit, and correctness risks.',
      'Codex: review implementation details, test coverage, and likely regression points.',
      'Gemini: review edge cases, alternate interpretations, and missed invisible-change risks.',
      'Read-only workflow: Do not create, edit, rename, or delete files.',
      'Call out correctness risks, edit conflicts, missing tests, and invisible changes.',
      prompt,
    ].join('\n\n');
  }

  if (command === 'debate') {
    return [
      '@all',
      'Workflow: debate',
      'Debate the best approach before implementation.',
      'Claude: argue from architecture, product intent, and long-term correctness.',
      'Codex: argue from concrete implementation cost, tests, and failure modes.',
      'Gemini: argue from alternatives, edge cases, and adversarial review.',
      'Read-only workflow: Do not create, edit, rename, or delete files.',
      'Each agent should state its recommendation, concerns with prior replies, and the concrete next action it would take.',
      prompt,
    ].join('\n\n');
  }

  return [
    '@all',
    'Workflow: implement',
    'Work as a serial implementation team with minimal human blocking.',
    'Claude: state the approach, assumptions, and correctness risks.',
    'Codex: implement the smallest safe code change and tests.',
    'Gemini: review the result for missed cases, edit conflicts, and invisible changes.',
    'Each agent must build on prior replies, preserve shared context, and surface file changes clearly.',
    'Do not pause for brainstorming or approval checkpoints unless the next action is unsafe or impossible.',
    prompt,
  ].join('\n\n');
}
