import { describe, expect, it } from 'vitest';
import { printableCaption } from '../mm';

/**
 * Task 2 (round-17): a parent can paste a URL into a memory's caption — the
 * app renders it as a link card, but a PRINTED book must never show a raw
 * URL. `printableCaption` is the ONE shared sanitizer every caption-length
 * fitter decision, every template render, and the audit's own
 * caption-height recomputation all route through (see its own doc comment
 * in mm.ts). These tests exercise the pure function in isolation.
 */
describe('printableCaption', () => {
  it('returns empty for URL-only text', () => {
    expect(printableCaption('https://example.com/foo')).toBe('');
    expect(printableCaption('www.example.com')).toBe('');
    expect(printableCaption('http://example.com')).toBe('');
  });

  it('removes a mid-sentence URL and keeps the surrounding words intact', () => {
    expect(printableCaption('Check this out https://example.com it was amazing')).toBe(
      'Check this out it was amazing',
    );
  });

  it('never changes URL-free text — exact passthrough, not even whitespace normalization', () => {
    const text = 'No URL here, just  a normal caption.';
    expect(printableCaption(text)).toBe(text);
  });

  it('never changes text that merely contains "http" or "www" as part of an ordinary word', () => {
    const text = 'The hippo swam past a wwatermill.';
    expect(printableCaption(text)).toBe(text);
  });

  it('returns empty for empty/null-ish input', () => {
    expect(printableCaption('')).toBe('');
  });

  it('tidies a dangling trailing connective left after removing the URL it was introducing', () => {
    expect(printableCaption('Mira este video de https://example.com')).toBe('Mira este video');
  });

  it('tidies a dangling trailing punctuation mark left after removing the URL', () => {
    expect(printableCaption('Check out my blog: https://example.com')).toBe('Check out my blog');
  });

  it('handles multiple URLs in the same caption', () => {
    expect(printableCaption('See http://a.com and also http://b.com for more')).toBe('See and also for more');
  });

  it('collapses the whitespace a removed URL leaves behind, even with several spaces', () => {
    expect(printableCaption('Before   https://example.com   after')).toBe('Before after');
  });

  it('is idempotent — sanitizing an already-sanitized caption changes nothing further', () => {
    const once = printableCaption('Mira este video de https://example.com');
    expect(printableCaption(once)).toBe(once);
  });
});
