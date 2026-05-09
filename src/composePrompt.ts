export interface ComposePromptInput {
  rules: string;
  autonomyPolicy?: string;
  sharedContext: string;
  editAwareness?: string;
  fileBlocks: string;
  attachmentErrors?: Array<{ path: string; reason: string }>;
  userText: string;
}

export const DEFAULT_AUTONOMY_POLICY = [
  '[Autonomy policy]',
  'When the request is actionable, proceed using reasonable assumptions instead of asking for confirmation.',
  'Do not turn broad actionable requests into brainstorming or approval checkpoints.',
  'Ask the user only when missing information makes the next change unsafe or impossible.',
  'Preserve context, inspect files before editing, and report visible file changes plus verification.',
  '[/Autonomy policy]',
].join('\n');

export function composePrompt(input: ComposePromptInput): string {
  const parts: string[] = [];

  if (input.rules.trim().length > 0) {
    parts.push(['[Workspace rules from gambit.md]', input.rules.trimEnd(), '[/Workspace rules]'].join('\n'));
  }
  if (input.autonomyPolicy?.trim().length) {
    parts.push(input.autonomyPolicy.trimEnd());
  }
  if (input.sharedContext.trim().length > 0) {
    parts.push(input.sharedContext.trimEnd());
  }
  if (input.editAwareness?.trim().length) {
    parts.push(input.editAwareness.trimEnd());
  }
  if (input.fileBlocks.trim().length > 0) {
    parts.push(input.fileBlocks.trimEnd());
  }
  if (input.attachmentErrors && input.attachmentErrors.length > 0) {
    parts.push(formatAttachmentErrors(input.attachmentErrors));
  }
  parts.push(input.userText);

  return parts.join('\n\n');
}

function formatAttachmentErrors(errors: Array<{ path: string; reason: string }>): string {
  return [
    '[File attachment problems]',
    ...errors.map((error) => `- ${error.path}: ${error.reason}`),
    '[/File attachment problems]',
  ].join('\n');
}
