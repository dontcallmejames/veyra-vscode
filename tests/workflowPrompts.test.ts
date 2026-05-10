import { describe, expect, it } from 'vitest';
import { veyraWorkflowPrompt } from '../src/workflowPrompts.js';

describe('veyraWorkflowPrompt', () => {
  it('assigns model-strength roles in review workflows without permitting edits', () => {
    const prompt = veyraWorkflowPrompt('review', 'Check the migration.');

    expect(prompt).toContain('@all');
    expect(prompt).toContain('Workflow: review');
    expect(prompt).toContain('Claude: review architecture, requirements fit, and correctness risks.');
    expect(prompt).toContain('Codex: review implementation details, test coverage, and likely regression points.');
    expect(prompt).toContain('Gemini: review edge cases, alternate interpretations, and missed invisible-change risks.');
    expect(prompt).toContain('Read-only workflow: Do not create, edit, rename, or delete files.');
    expect(prompt).toContain('Check the migration.');
  });

  it('assigns model-strength roles in debate workflows without permitting edits', () => {
    const prompt = veyraWorkflowPrompt('debate', 'Pick a refactor path.');

    expect(prompt).toContain('@all');
    expect(prompt).toContain('Workflow: debate');
    expect(prompt).toContain('Claude: argue from architecture, product intent, and long-term correctness.');
    expect(prompt).toContain('Codex: argue from concrete implementation cost, tests, and failure modes.');
    expect(prompt).toContain('Gemini: argue from alternatives, edge cases, and adversarial review.');
    expect(prompt).toContain('Read-only workflow: Do not create, edit, rename, or delete files.');
    expect(prompt).toContain('Pick a refactor path.');
  });

  it('assigns model-strength roles in implementation workflows', () => {
    const prompt = veyraWorkflowPrompt('implement', 'Fix the parser.');

    expect(prompt).toContain('@all');
    expect(prompt).toContain('Workflow: implement');
    expect(prompt).toContain('Claude: state the approach, assumptions, and correctness risks.');
    expect(prompt).toContain('Codex: implement the smallest safe code change and tests.');
    expect(prompt).toContain('Gemini: review the result for missed cases, edit conflicts, and invisible changes.');
    expect(prompt).toContain('Each agent must build on prior replies, preserve shared context, and surface file changes clearly.');
    expect(prompt).toContain('Do not pause for brainstorming or approval checkpoints unless the next action is unsafe or impossible.');
    expect(prompt).not.toContain('clarify the approach');
    expect(prompt).toContain('Fix the parser.');
  });
});
