const LOW_INTENT_VEYRA_PROMPTS = new Set([
  'hi',
  'hello',
  'hey',
  'ping',
  'test',
  'testing',
  'are you here',
  'are you there',
  'you here',
  'you there',
  'still there',
  'can you hear me',
  'can you see me',
  'is this working',
  'are we connected',
]);

export function localVeyraResponseForPrompt(prompt: string): string | null {
  const normalized = prompt
    .trim()
    .toLowerCase()
    .replace(/^@veyra\b\s*/, '')
    .replace(/[?!.\s]+$/g, '')
    .replace(/\s+/g, ' ');
  return LOW_INTENT_VEYRA_PROMPTS.has(normalized) ? 'Yes, here.' : null;
}
