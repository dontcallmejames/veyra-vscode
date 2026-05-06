export interface ComposePromptInput {
  rules: string;
  sharedContext: string;
  fileBlocks: string;
  userText: string;
}

export function composePrompt(input: ComposePromptInput): string {
  const parts: string[] = [];

  if (input.rules.trim().length > 0) {
    parts.push(['[Workspace rules from agentchat.md]', input.rules.trimEnd(), '[/Workspace rules]'].join('\n'));
  }
  if (input.sharedContext.trim().length > 0) {
    parts.push(input.sharedContext.trimEnd());
  }
  if (input.fileBlocks.trim().length > 0) {
    parts.push(input.fileBlocks.trimEnd());
  }
  parts.push(input.userText);

  return parts.join('\n\n');
}
