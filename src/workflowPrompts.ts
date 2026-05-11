export type VeyraWorkflowCommand = 'review' | 'debate' | 'consensus' | 'implement';

export function veyraWorkflowPrompt(command: VeyraWorkflowCommand, prompt: string): string {
  if (command === 'review') {
    return [
      '@all',
      'Workflow: review',
      'Review this request independently, then build on prior agents where useful.',
      'Claude: review architecture, requirements fit, and correctness risks.',
      'Codex: review implementation details, test coverage, and likely regression points.',
      'Gemini: review edge cases, alternate interpretations, and missed invisible-change risks.',
      'Read-only workflow: Do not create, edit, rename, or delete files.',
      'Each agent should organize findings under these headings: Blocking issues, Advisory risks, Missing tests, Follow-up suggestions.',
      'Gemini runs last. After its own review, Gemini must add a Veyra Synthesis section with Recommendation, Blocking issues, Missing tests, and Next action.',
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
      'Each agent should use these headings: Recommendation, Tradeoffs, Concerns with prior replies, Next action.',
      'Gemini runs last. After its own position, Gemini must add a Veyra Synthesis section with Recommended approach, Why, Risks, and Next action.',
      prompt,
    ].join('\n\n');
  }

  if (command === 'consensus') {
    return [
      '@all',
      'Workflow: consensus',
      'Reach a concrete recommendation before implementation.',
      'Claude: identify architecture, product, and correctness constraints.',
      'Codex: identify implementation cost, tests, migration risk, and operational failure modes.',
      'Gemini: compare prior positions, challenge assumptions, and produce the final recommendation.',
      'Read-only workflow: Do not create, edit, rename, or delete files.',
      'Each agent should use these headings: Position, Evidence, Risks, Next action.',
      'Gemini runs last. After its own position, Gemini must add a Consensus Recommendation section with Decision, Rationale, Tradeoffs, Risks, and Next action.',
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
    'Gemini runs last and must end with a Handoff Summary covering What changed, Verification status, Remaining risks, and Recommended next action.',
    'Do not pause for brainstorming or approval checkpoints unless the next action is unsafe or impossible.',
    prompt,
  ].join('\n\n');
}
