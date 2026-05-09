import { describe, expect, it } from 'vitest';
import { MENTION_ITEMS } from '../src/webview/components/MentionAutocomplete.js';

describe('MentionAutocomplete', () => {
  it('advertises Codex instead of the legacy GPT alias', () => {
    expect(MENTION_ITEMS.map((item) => item.token)).toEqual([
      '@claude',
      '@codex',
      '@gemini',
      '@all',
    ]);
  });
});
