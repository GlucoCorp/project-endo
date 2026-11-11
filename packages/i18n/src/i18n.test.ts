import { describe, expect, it } from 'vitest';
import { CATALOGUES, format, translator } from './index.ts';
import { en } from './en.ts';

describe('spec 21.9 strings', () => {
  it('translates by key and fills placeholders with plain text', () => {
    const t = translator('en');
    expect(t('enrol.start')).toBe('Start');
    // English is the default.
    expect(translator()('enrol.start')).toBe('Start');
    expect(() => t('no.such.key' as never)).toThrow(/unknown message/);
    expect(() => translator('xx' as never)).toThrow(/unknown locale/);
  });

  it('keeps to the voice rules: no exclamation marks, emoji or banned words', () => {
    for (const [key, text] of Object.entries(en)) {
      expect(text, key).not.toMatch(/!/);
      expect(text, key).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(text, key).not.toMatch(/\b(just|only|mild discomfort|oops|sorry)\b/i);
      // Sentence case: no all-caps words of three letters or more.
      expect(text, key).not.toMatch(/\b[A-Z]{3,}\b/);
    }
  });

  it('gives every language every key', () => {
    const keys = Object.keys(en).sort();
    for (const messages of Object.values(CATALOGUES))
      expect(Object.keys(messages).sort()).toEqual(keys);
  });

  it('fills placeholders and refuses a missing value', () => {
    expect(format('Next check-in on {date}.', { date: '12 November' })).toBe(
      'Next check-in on 12 November.',
    );
    expect(format('<b>{x}</b>', { x: '<script>' })).toBe('<b><script></b>'); // text, never parsed here
    expect(() => format('Due {date}', {})).toThrow(/missing value/);
  });
});
