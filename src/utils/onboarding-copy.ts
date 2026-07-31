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

/**
 * Possessive fragment ("Enzo's" | "their") for a set of kid names, without
 * composing a full sentence around it -- the same single-vs-several split
 * `possessiveHeadline`/`firstPageCaption` already encode, exposed here as a
 * bare fragment for call sites that build their own copy around it (S8
 * bridge.tsx's body, which runs before S9's capture/tagging exists so it
 * resolves off the full kid list rather than a tagged subset; S10 aha.tsx
 * and S10b year.tsx, which already narrow to the tagged subset before
 * calling this). Trims/filters blanks the same way `kidsPhrase` does, so a
 * stray blank entry can't slip through as a false "single kid" match.
 * Always the lowercase neutral 'their' -- capitalize at the call site (via
 * `capitalizeFragment`) for sentence-initial use; named possessives are
 * already capitalized as proper nouns, so that capitalization is always a
 * safe no-op for them too.
 */
export function kidsPossessive(names: string[]): string {
  const trimmed = names.map((name) => name.trim()).filter(Boolean);
  return trimmed.length === 1 ? possessive(trimmed[0]) : 'their';
}

/**
 * Journal-flavored possessive: converts a resolved possessive fragment
 * ("Enzo's" | "their"/"Their") into the flavor used specifically where a
 * screen builds the phrase "{X} journal" -- second-person "your" for
 * several kids, instead of the neutral third-person "their" this module
 * uses everywhere else multi-kid copy neutralizes (`possessiveHeadline`'s
 * "Their stories need a home.", `firstPageCaption`'s "Their first page.").
 *
 * Reported from a live build, 2026-07-31: two screens (S8 bridge.tsx, S14
 * included.tsx) leaked a single kid's name into "{name}'s journal" for
 * families with more than one child -- re-enacting the disparity wound
 * naming this feature exists to avoid (docs/features/onboarding.md decision
 * 8). The reconciliation applied consistently everywhere this module builds
 * a "journal" phrase (also S10 aha.tsx's saved caption and S10b year.tsx's
 * body, both already correctly neutral but with the *other* pronoun):
 * "their journal" reads as belonging to the kids, and even when correctly
 * neutralized it undersells that this is the parent's own journal to write
 * in. "Your" is warmer, unambiguous, and never requires singling out one
 * kid over another (owner decision). Every other multi-kid screen in this
 * module keeps the third-person "their" unchanged -- this transform is
 * deliberately scoped to the literal word "journal", not a general
 * their-to-your swap.
 *
 * Named possessives pass through unchanged; the casing of a neutral input
 * ('their' vs 'Their') is preserved in the output.
 */
export function journalPossessive(resolvedPossessive: string): string {
  if (resolvedPossessive === 'their') {
    return 'your';
  }
  if (resolvedPossessive === 'Their') {
    return 'Your';
  }
  return resolvedPossessive;
}

/**
 * Capitalizes the first character of an already-resolved possessive
 * fragment for sentence-initial use (S8 bridge.tsx's body, S10 aha.tsx's
 * "saved · {X} journal" caption). A no-op for named possessives, which are
 * already capitalized as proper nouns -- this only ever changes anything
 * for the lowercase neutral 'their'/'your' case.
 */
export function capitalizeFragment(fragment: string): string {
  if (!fragment) {
    return fragment;
  }
  return fragment.charAt(0).toUpperCase() + fragment.slice(1);
}
