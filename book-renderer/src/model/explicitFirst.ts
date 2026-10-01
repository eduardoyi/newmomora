/**
 * Explicit first-time language detection.
 *
 * MIRRORS `hasExplicitFirstLanguage` in
 * cloudflare/memory-book-worker/src/firsts.ts (Phase 2e owner rule: the book
 * never asserts a "first" without the parent's own words or a parent
 * confirmation). book-renderer cannot import worker code, so the rule is
 * copied here VERBATIM; `__tests__/explicitFirst.parity.test.ts` feeds both
 * implementations the same cases so they cannot drift. Change both together.
 * Pure and deterministic: no env, no IO, no clock.
 */

/** Single words are enough: "por primera vez", "la primera vez", "el primer",
 * "first time", "for the first time", "pela primeira vez" all contain one of
 * these. Matched case/diacritic-insensitively on word boundaries, for the
 * journal languages es / en / pt. */
const EXPLICIT_FIRST_WORDS = [
  'primer',
  'primera',
  'primeros',
  'primeras',
  'first',
  'primeiro',
  'primeira',
  'primeiros',
  'primeiras',
];
const EXPLICIT_FIRST_RE = new RegExp(`\\b(?:${EXPLICIT_FIRST_WORDS.join('|')})\\b`);

function foldForMatch(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** True when the memory's own text explicitly says "first" (es/en/pt). */
export function hasExplicitFirstLanguage(text: string | null | undefined): boolean {
  if (!text) return false;
  return EXPLICIT_FIRST_RE.test(foldForMatch(text));
}
