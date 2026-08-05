// Self-hosted Twemoji emoji-image support.
//
// DEVICE REPORT: a caption containing a flag emoji (e.g. 🇪🇸) rendered on
// the share card as the two letters "E S" instead of a flag. Root cause:
// the rebuilt NotoEmoji subset font DOES contain the individual
// regional-indicator glyphs (that's exactly how "E" and "S" rendered --
// each glyph shaped on its own), but satori's text shaper never applies
// emoji LIGATURE rules (regional-indicator pairs, ZWJ sequences, keycap
// combining marks) the way a real text-shaping engine (HarfBuzz, browser
// text layout) does -- so NO font, however complete its glyph coverage,
// can ever make satori render a flag/family/keycap as one glyph through
// ordinary text shaping. This is a satori limitation, not a missing-font
// problem.
//
// Satori's actual mechanism for this is `graphemeImages`
// (SatoriOptions.graphemeImages: Record<string, string>, satori's own
// dist/index.d.ts) -- a map from the LITERAL grapheme text (e.g. the exact
// string "🇪🇸") to an image source (a URL or data URI) substituted in
// place of font-shaped glyphs whenever that exact grapheme is encountered.
// This file resolves which graphemes in a caption need one, and what
// Twemoji SVG file each maps to; supabase/functions/compose-share-card/
// index.ts wires the actual R2 fetch + satori option into the compose
// pipeline (see its "Emoji grapheme images" section).
//
// SELF-HOSTED, not twemoji-from-CDN: a request-time fetch to a third-party
// CDN keyed by emoji codepoint would leak which emoji (and therefore
// something about caption content) a given request touches to that third
// party -- AGENTS.md's "Child & family PII / no logging of memory content"
// discipline extends to never SENDING content-derived data externally
// either, not just not logging it. Twemoji SVGs are instead uploaded once
// to this project's own R2 bucket (supabase/scripts/upload-twemoji-assets.ts,
// key prefix `_assets/twemoji/v1/`) and fetched from there like any other
// R2-hosted asset.
//
// FILENAME MAPPING is a careful, deliberate port of twemoji-parser's own
// `toCodePoints`/`removeVS16s` (MIT license, Twitter/jdecked --
// https://github.com/jdecked/twemoji-parser/blob/master/LICENSE.md) --
// verified BYTE-FOR-BYTE against its published dist/index.js source
// (this package's implementation report), not reconstructed from memory,
// because getting the VS16-drop rule wrong silently breaks every emoji
// whose grapheme text differs from its canonical filename.

// Explicit \u escapes (never a literal invisible character in source) --
// same caution twemoji-parser's own source takes for exactly this reason.
const ZERO_WIDTH_JOINER = '\u200D';
const VARIATION_SELECTOR_16 = '\uFE0F';
const COMBINING_ENCLOSING_KEYCAP = 0x20e3;
const REGIONAL_INDICATOR_MIN = 0x1f1e6;
const REGIONAL_INDICATOR_MAX = 0x1f1ff;

// Unicode TR51's own recommended technique for grapheme-aware emoji
// detection: `\p{Extended_Pictographic}` is a superset property covering
// every current AND reserved-for-future emoji candidate (standalone
// pictographs like 😀, and -- verified empirically, see this package's
// implementation report -- symbols like ❤ U+2764 that need VS16 to render
// as emoji but are still Extended_Pictographic either way). It does NOT
// cover regional-indicator symbols (flags) or plain ASCII keycap bases
// ('0'-'9', '#', '*'), so those two cases are checked separately below.
const EXTENDED_PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u;

function isRegionalIndicatorCodePoint(codePoint: number): boolean {
  return codePoint >= REGIONAL_INDICATOR_MIN && codePoint <= REGIONAL_INDICATOR_MAX;
}

/**
 * True when `segment` -- a SINGLE `Intl.Segmenter` grapheme cluster, never
 * a raw multi-character string -- is an emoji. Three independent checks,
 * verified against real Intl.Segmenter output (this package's
 * implementation report) rather than assumed:
 *   - An Extended_Pictographic codepoint anywhere in the cluster. Covers
 *     standalone pictographs AND every ZWJ sequence (a ZWJ sequence's base
 *     character -- e.g. "👨" in the family emoji below -- is itself
 *     Extended_Pictographic, so this single check subsumes ZWJ detection;
 *     no separate ZWJ check is needed).
 *   - A pair of regional-indicator codepoints (a flag). Intl.Segmenter
 *     already groups exactly two RIs per grapheme cluster per UAX #29 --
 *     verified against "🇪🇸🇫🇷" segmenting as ["🇪🇸", "🇫🇷"], never one
 *     four-RI cluster or four separate one-RI clusters.
 *   - The combining-enclosing-keycap codepoint (U+20E3). Keycap sequences
 *     (digit/#/* + optional VS16 + U+20E3) are already grouped into one
 *     cluster by Intl.Segmenter since U+20E3 is a combining mark that
 *     attaches to its preceding base character automatically.
 */
export function isEmojiGrapheme(segment: string): boolean {
  if (EXTENDED_PICTOGRAPHIC_RE.test(segment)) {
    return true;
  }
  const codePoints = [...segment].map((ch) => ch.codePointAt(0)!);
  if (codePoints.includes(COMBINING_ENCLOSING_KEYCAP)) {
    return true;
  }
  return codePoints.filter(isRegionalIndicatorCodePoint).length >= 2;
}

/**
 * Distinct emoji grapheme clusters present in `text`, in first-occurrence
 * order (order has no functional effect on the resulting `graphemeImages`
 * map -- kept deterministic purely so tests/logs are stable).
 * `Intl.Segmenter({ granularity: 'grapheme' })` does the hard part (RI
 * pairing, ZWJ grouping, combining-mark attachment) -- see isEmojiGrapheme
 * above and this file's header comment.
 */
export function extractDistinctEmojiGraphemes(text: string): string[] {
  if (!text) {
    return [];
  }
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  const seen = new Set<string>();
  const result: string[] = [];
  for (const { segment } of segmenter.segment(text)) {
    if (isEmojiGrapheme(segment) && !seen.has(segment)) {
      seen.add(segment);
      result.push(segment);
    }
  }
  return result;
}

/**
 * twemoji-parser's `removeVS16s`: a VARIATION SELECTOR-16 is stripped from
 * the grapheme UNLESS it also contains a ZERO WIDTH JOINER -- a ZWJ
 * sequence's VS16 is part of its canonical filename and must be kept
 * (e.g. "heart on fire", ❤️‍🔥, files as `2764-fe0f-200d-1f525.svg`, VS16
 * retained -- verified against the real twemoji-parser source).
 */
function removeVs16UnlessZwjSequence(grapheme: string): string {
  return grapheme.includes(ZERO_WIDTH_JOINER)
    ? grapheme
    : grapheme.replaceAll(VARIATION_SELECTOR_16, '');
}

/**
 * twemoji-parser's `toCodePoints(...).join('-')`: lowercase hex codepoints,
 * NO zero-padding (a codepoint's natural hex width is used as-is -- e.g.
 * digit '1' is U+0031, which maps to "31", never "0031" -- verified
 * against the real twemoji-parser source, which does NOT pad).
 */
function toTwemojiCodePoints(text: string): string {
  return [...text].map((ch) => ch.codePointAt(0)!.toString(16)).join('-');
}

/**
 * `{filename}.svg` for a single emoji grapheme, e.g. "🇪🇸" ->
 * "1f1ea-1f1f8.svg", "❤️" -> "2764.svg" (VS16 dropped), "👨‍👩‍👧" ->
 * "1f468-200d-1f469-200d-1f467.svg" (ZWJ retained, no VS16 present to
 * drop), "1️⃣" -> "31-20e3.svg" (VS16 dropped, keycap base + combining
 * mark kept).
 */
export function graphemeToTwemojiFilename(grapheme: string): string {
  return `${toTwemojiCodePoints(removeVs16UnlessZwjSequence(grapheme))}.svg`;
}

/** R2 prefix uploaded by supabase/scripts/upload-twemoji-assets.ts. */
export const TWEMOJI_ASSET_PREFIX = '_assets/twemoji/v1/';

export function buildTwemojiObjectKey(grapheme: string): string {
  return `${TWEMOJI_ASSET_PREFIX}${graphemeToTwemojiFilename(grapheme)}`;
}

/** Per-isolate memo cap -- see index.ts's `emojiGraphemeImageMemo` (the
 * actual mutable cache; this file stays I/O-free/pure) for the eviction
 * policy. Tiny and bounded by design: this is cheap insurance against
 * re-fetching the same common handful of emoji across requests in one
 * warm isolate, not a general-purpose cache. */
export const MAX_EMOJI_GRAPHEME_MEMO_ENTRIES = 256;

/** Minimal shape this file needs from `getObjectBytesBatch`'s result
 * entries (`_shared/r2.ts`'s `ObjectBytesBatchEntry`) -- declared locally
 * so this file has no import-time dependency on r2.ts (keeps it a pure,
 * zero-I/O, trivially Deno-testable module, matching the rest of this
 * package's "pure processing of already-fetched bytes" helpers, e.g.
 * index.ts's buildTaggedMemberPortraits). */
export interface FetchedObjectEntry {
  ok: boolean;
  bytes?: Uint8Array;
}

export interface ResolveGraphemeImagesResult {
  /** Ready to pass straight to satori's `graphemeImages` option. */
  graphemeImages: Record<string, string>;
  /** Entries this call newly resolved (i.e. NOT already in `memo`) --
   * the caller (index.ts) is responsible for merging these into its real,
   * mutable, bounded per-isolate memo. Kept separate from `graphemeImages`
   * (which includes memo hits too) so the caller never re-inserts an
   * already-memoized entry and skews its FIFO eviction order for no
   * reason. */
  newlyResolved: Map<string, string>;
}

/**
 * Builds satori's `graphemeImages` map for `graphemes` from an
 * ALREADY-FETCHED bytes batch (mirrors buildTaggedMemberPortraits' shape:
 * no I/O of its own, so it's cheap to unit-test with a fake Map instead of
 * a fake R2 backend). A memo hit short-circuits before ever looking at
 * `fetchedBytesByKey` -- the caller is expected to have only fetched keys
 * for graphemes that MISSED the memo (see index.ts's compose-time
 * integration) -- but this function tolerates the memo/fetch sets not
 * lining up exactly (e.g. a stale/duplicate key) without erroring either
 * way.
 *
 * FAIL-OPEN per grapheme, same posture as buildTaggedMemberPortraits: a
 * missing/failed SVG fetch simply omits that grapheme from the returned
 * map -- satori then falls back to its normal (incomplete, ligature-less)
 * font-shaped rendering for that grapheme. Letters beat a broken image;
 * this must never fail the whole compose.
 */
export function resolveGraphemeImages(
  graphemes: string[],
  memo: ReadonlyMap<string, string>,
  fetchedBytesByKey: ReadonlyMap<string, FetchedObjectEntry>,
  encodeSvgDataUri: (bytes: Uint8Array) => string,
): ResolveGraphemeImagesResult {
  const graphemeImages: Record<string, string> = {};
  const newlyResolved = new Map<string, string>();

  for (const grapheme of graphemes) {
    const memoized = memo.get(grapheme);
    if (memoized) {
      graphemeImages[grapheme] = memoized;
      continue;
    }

    const entry = fetchedBytesByKey.get(buildTwemojiObjectKey(grapheme));
    if (!entry || !entry.ok || !entry.bytes) {
      continue;
    }

    const dataUri = encodeSvgDataUri(entry.bytes);
    graphemeImages[grapheme] = dataUri;
    newlyResolved.set(grapheme, dataUri);
  }

  return { graphemeImages, newlyResolved };
}
