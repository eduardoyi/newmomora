// Onboarding copy helpers (docs/plans/onboarding-implementation.md WP0
// §0.3). Pure -- no React or Supabase imports -- so every branch unit-tests
// without a device. Every string here is copied exactly from the design
// brief (docs/plans/onboarding-design-brief.md), including the no-em-dash
// rule.

/**
 * `''` | `'Lila'` | `'Lila & Miguel'` | `'Lila, Miguel & Teo'`. Blank/empty
 * entries are dropped defensively -- callers pass draft state that should
 * already be trimmed, but a stray blank name must never surface as a
 * dangling "& " in the joined phrase.
 */
export function kidsPhrase(names: string[]): string {
  const trimmed = names.map((name) => name.trim()).filter(Boolean);

  if (trimmed.length === 0) {
    return '';
  }

  if (trimmed.length === 1) {
    return trimmed[0];
  }

  return `${trimmed.slice(0, -1).join(', ')} & ${trimmed[trimmed.length - 1]}`;
}

/**
 * English possessive of a single name/phrase: trailing "'s", or just "'"
 * when the phrase already ends in "s" (e.g. "Chris'" not "Chris's") --
 * the one rule, applied consistently everywhere this module needs a
 * possessive, per the plan's "pick one rule, test it" instruction.
 */
export function possessive(phrase: string): string {
  if (!phrase) {
    return phrase;
  }

  return /s$/i.test(phrase) ? `${phrase}'` : `${phrase}'s`;
}

/**
 * S7 family-name prefill: possessive of up to the first 3 kids' names +
 * " Family". `''` when there are no names yet (nothing to default from).
 */
export function defaultFamilyName(names: string[]): string {
  const phrase = kidsPhrase(names.slice(0, 3));

  if (!phrase) {
    return '';
  }

  return `${possessive(phrase)} Family`;
}

// Neutral fallback (verbatim from the handoff's multi-kid capture prompt,
// src/screens/onboarding-capture.jsx) for whenever there's no name to
// personalize with -- S6 should make this unreachable (a kid name is
// required to reach S9 at all), but it's the same defensive gap
// `kidsPhrase` guards against, so `capturePrompt` never emits a dangling
// double space for an empty/out-of-range name.
const CAPTURE_PROMPT_FALLBACK = "What's something small from this week that made you smile?";

/**
 * S9 capture prompt. Single-kid families always ask about that kid.
 * Multi-kid families personalize by how many kids are tagged for this
 * memory: one selected -> that kid's name; two -> "the two of them";
 * three or more (or, defensively, none selected) -> "all of them".
 */
export function capturePrompt(names: string[], selectedIndexes: number[]): string {
  if (names.length <= 1) {
    const name = (names[0] ?? '').trim();
    return name
      ? `What's something small ${name} did this week that made you smile?`
      : CAPTURE_PROMPT_FALLBACK;
  }

  if (selectedIndexes.length === 1) {
    const name = (names[selectedIndexes[0]] ?? '').trim();
    return name
      ? `What's something small ${name} did this week that made you smile?`
      : CAPTURE_PROMPT_FALLBACK;
  }

  if (selectedIndexes.length === 2) {
    return "What's something small the two of them did this week that made you smile?";
  }

  return "What's something small all of them did this week that made you smile?";
}

/**
 * S10 aha caption, keyed off which kids are tagged on the captured memory
 * (not the full kid list) -- one tagged kid gets their name, more than one
 * gets the neutral "Their".
 */
export function firstPageCaption(selectedNames: string[]): string {
  if (selectedNames.length === 1) {
    return `${possessive(selectedNames[0])} first page. Imagine a year of these.`;
  }

  return 'Their first page. Imagine a year of these.';
}

/**
 * S7 headline: "{name}'s stories need a home." for one kid, "Their stories
 * need a home." for more than one.
 */
export function possessiveHeadline(names: string[]): string {
  if (names.length === 1) {
    return `${possessive(names[0])} stories need a home.`;
  }

  return 'Their stories need a home.';
}
