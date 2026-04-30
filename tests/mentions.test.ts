import { describe, it, expect } from 'vitest';
import { parseMentions } from '../src/mentions.js';

describe('parseMentions', () => {
  it('returns no targets when no @ mentions', () => {
    expect(parseMentions('hello there')).toEqual({
      targets: [],
      remainingText: 'hello there',
    });
  });

  it('parses a single @claude mention', () => {
    expect(parseMentions('@claude review this')).toEqual({
      targets: ['claude'],
      remainingText: 'review this',
    });
  });

  it('parses @gpt as codex', () => {
    expect(parseMentions('@gpt run the tests')).toEqual({
      targets: ['codex'],
      remainingText: 'run the tests',
    });
  });

  it('parses @gemini', () => {
    expect(parseMentions('@gemini search docs')).toEqual({
      targets: ['gemini'],
      remainingText: 'search docs',
    });
  });

  it('parses multiple specific mentions', () => {
    expect(parseMentions('@claude @gemini compare these')).toEqual({
      targets: ['claude', 'gemini'],
      remainingText: 'compare these',
    });
  });

  it('parses @all', () => {
    expect(parseMentions('@all what do you think')).toEqual({
      targets: ['claude', 'codex', 'gemini'],
      remainingText: 'what do you think',
    });
  });

  it('only treats leading mentions as routing; mid-sentence @claude is text', () => {
    expect(parseMentions('hey @claude is a name')).toEqual({
      targets: [],
      remainingText: 'hey @claude is a name',
    });
  });

  it('deduplicates repeated mentions', () => {
    expect(parseMentions('@claude @claude review')).toEqual({
      targets: ['claude'],
      remainingText: 'review',
    });
  });

  it('@all combined with specific mentions returns all', () => {
    expect(parseMentions('@claude @all rundown')).toEqual({
      targets: ['claude', 'codex', 'gemini'],
      remainingText: 'rundown',
    });
  });

  it('trims whitespace from remainingText', () => {
    expect(parseMentions('@claude    review')).toEqual({
      targets: ['claude'],
      remainingText: 'review',
    });
  });
});
