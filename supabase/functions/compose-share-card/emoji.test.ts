import { assertEquals } from 'jsr:@std/assert@1';

import {
  buildTwemojiObjectKey,
  extractDistinctEmojiGraphemes,
  type FetchedObjectEntry,
  graphemeToTwemojiFilename,
  isEmojiGrapheme,
  resolveGraphemeImages,
  TWEMOJI_ASSET_PREFIX,
} from './emoji.ts';

// `\u{...}` escapes throughout (matching layout.test.ts's own convention
// for emoji test fixtures, e.g. its flag-sequence tests) rather than
// literal pasted glyphs -- keeps invisible codepoints (ZWJ, VS16)
// unambiguous in source.
const FLAG_ES = '\u{1F1EA}\u{1F1F8}'; // 🇪🇸
const FLAG_FR = '\u{1F1EB}\u{1F1F7}'; // 🇫🇷
const HEART_VS16 = '\u{2764}\u{FE0F}'; // ❤️
const HEART_BARE = '\u{2764}'; // ❤ (no VS16 to begin with)
const FAMILY_ZWJ = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}'; // 👨‍👩‍👧
const KEYCAP_ONE = '\u{0031}\u{FE0F}\u{20E3}'; // 1️⃣
const HEART_ON_FIRE = '\u{2764}\u{FE0F}\u{200D}\u{1F525}'; // ❤️‍🔥 (VS16 + ZWJ both present)
const GRINNING_FACE = '\u{1F600}'; // 😀
const LONE_REGIONAL_INDICATOR = '\u{1F1EA}'; // not a pair -- not a renderable flag

// ── graphemeToTwemojiFilename (twemoji-parser's toCodePoints/removeVS16s,
// verified byte-for-byte against its real source -- see emoji.ts's header
// comment) ──────────────────────────────────────────────────────────────

Deno.test('graphemeToTwemojiFilename: flag sequence (regional indicator pair), no VS16/ZWJ involved', () => {
  assertEquals(graphemeToTwemojiFilename(FLAG_ES), '1f1ea-1f1f8.svg');
});

Deno.test('graphemeToTwemojiFilename: VS16-bearing, non-ZWJ emoji drops the VS16', () => {
  assertEquals(graphemeToTwemojiFilename(HEART_VS16), '2764.svg');
});

Deno.test('graphemeToTwemojiFilename: a bare emoji with no VS16 to begin with is unaffected', () => {
  assertEquals(graphemeToTwemojiFilename(HEART_BARE), '2764.svg');
});

Deno.test('graphemeToTwemojiFilename: ZWJ sequence keeps every codepoint (family emoji)', () => {
  assertEquals(graphemeToTwemojiFilename(FAMILY_ZWJ), '1f468-200d-1f469-200d-1f467.svg');
});

Deno.test('graphemeToTwemojiFilename: keycap sequence drops VS16 but keeps the combining keycap mark', () => {
  assertEquals(graphemeToTwemojiFilename(KEYCAP_ONE), '31-20e3.svg');
});

Deno.test('graphemeToTwemojiFilename: a ZWJ sequence that ALSO carries VS16 keeps the VS16 (VS16-drop is ZWJ-gated)', () => {
  // "heart on fire" -- verified against the real twemoji-parser source
  // (removeVS16s only strips VS16 when there is NO ZWJ present).
  assertEquals(graphemeToTwemojiFilename(HEART_ON_FIRE), '2764-fe0f-200d-1f525.svg');
});

Deno.test('buildTwemojiObjectKey: prefixes the filename with the R2 asset prefix', () => {
  assertEquals(buildTwemojiObjectKey(FLAG_ES), `${TWEMOJI_ASSET_PREFIX}1f1ea-1f1f8.svg`);
  assertEquals(TWEMOJI_ASSET_PREFIX, '_assets/twemoji/v1/');
});

// ── isEmojiGrapheme / extractDistinctEmojiGraphemes ─────────────────────

Deno.test('isEmojiGrapheme: a flag (regional indicator pair) is emoji', () => {
  assertEquals(isEmojiGrapheme(FLAG_ES), true);
});

Deno.test('isEmojiGrapheme: a plain pictograph is emoji', () => {
  assertEquals(isEmojiGrapheme(GRINNING_FACE), true);
});

Deno.test('isEmojiGrapheme: a VS16-bearing non-pictograph-only symbol is emoji (Extended_Pictographic covers it)', () => {
  assertEquals(isEmojiGrapheme(HEART_VS16), true);
  assertEquals(isEmojiGrapheme(HEART_BARE), true);
});

Deno.test('isEmojiGrapheme: a ZWJ family sequence is emoji', () => {
  assertEquals(isEmojiGrapheme(FAMILY_ZWJ), true);
});

Deno.test('isEmojiGrapheme: a keycap sequence is emoji', () => {
  assertEquals(isEmojiGrapheme(KEYCAP_ONE), true);
});

Deno.test('isEmojiGrapheme: a lone regional indicator (not a pair) is NOT emoji', () => {
  assertEquals(isEmojiGrapheme(LONE_REGIONAL_INDICATOR), false);
});

Deno.test('isEmojiGrapheme: a plain letter, digit, or punctuation is not emoji', () => {
  for (const segment of ['a', 'H', '1', '#', '*', ' ', '.']) {
    assertEquals(isEmojiGrapheme(segment), false, `expected ${JSON.stringify(segment)} to not be emoji`);
  }
});

Deno.test('extractDistinctEmojiGraphemes: empty/no-emoji text returns an empty list', () => {
  assertEquals(extractDistinctEmojiGraphemes(''), []);
  assertEquals(extractDistinctEmojiGraphemes('Just a normal caption, no emoji here.'), []);
});

Deno.test('extractDistinctEmojiGraphemes: pulls a flag, a ZWJ family, and a keycap out of mixed text, in first-occurrence order', () => {
  const caption = `Trip to Spain ${FLAG_ES} with family ${FAMILY_ZWJ}, day ${KEYCAP_ONE} of the trip!`;
  assertEquals(extractDistinctEmojiGraphemes(caption), [FLAG_ES, FAMILY_ZWJ, KEYCAP_ONE]);
});

Deno.test('extractDistinctEmojiGraphemes: deduplicates a repeated emoji grapheme', () => {
  assertEquals(extractDistinctEmojiGraphemes(`${HEART_VS16} love it ${HEART_VS16} so much ${HEART_VS16}`), [HEART_VS16]);
});

Deno.test('extractDistinctEmojiGraphemes: two different flags stay distinct (back-to-back, no merging)', () => {
  assertEquals(extractDistinctEmojiGraphemes(`${FLAG_ES}${FLAG_FR}`), [FLAG_ES, FLAG_FR]);
});

// ── resolveGraphemeImages (fail-open, memo-aware, no I/O of its own) ────

function fakeEncodeSvgDataUri(bytes: Uint8Array): string {
  return `data:image/svg+xml;base64,FAKE(${bytes.length}bytes)`;
}

Deno.test('resolveGraphemeImages: a memo hit is used directly without consulting the fetched-bytes map at all', () => {
  const memo = new Map([[FLAG_ES, 'data:image/svg+xml;base64,MEMOIZED']]);
  const fetched = new Map<string, FetchedObjectEntry>(); // deliberately empty -- must not be needed

  const result = resolveGraphemeImages([FLAG_ES], memo, fetched, fakeEncodeSvgDataUri);

  assertEquals(result.graphemeImages, { [FLAG_ES]: 'data:image/svg+xml;base64,MEMOIZED' });
  assertEquals(result.newlyResolved.size, 0);
});

Deno.test('resolveGraphemeImages: a memo miss with a successful fetch resolves via the encoder and reports it as newly resolved', () => {
  const memo = new Map<string, string>();
  const fetched = new Map<string, FetchedObjectEntry>([
    [buildTwemojiObjectKey(HEART_VS16), { ok: true, bytes: new Uint8Array([1, 2, 3]) }],
  ]);

  const result = resolveGraphemeImages([HEART_VS16], memo, fetched, fakeEncodeSvgDataUri);

  assertEquals(result.graphemeImages, { [HEART_VS16]: 'data:image/svg+xml;base64,FAKE(3bytes)' });
  assertEquals(result.newlyResolved.get(HEART_VS16), 'data:image/svg+xml;base64,FAKE(3bytes)');
});

Deno.test('resolveGraphemeImages: a missing fetch entry (never fetched) is skipped, not an error -- fails open', () => {
  const result = resolveGraphemeImages([FLAG_ES], new Map(), new Map(), fakeEncodeSvgDataUri);
  assertEquals(result.graphemeImages, {});
  assertEquals(result.newlyResolved.size, 0);
});

Deno.test('resolveGraphemeImages: a failed fetch (ok: false) is skipped, not an error -- fails open', () => {
  const fetched = new Map<string, FetchedObjectEntry>([[buildTwemojiObjectKey(FLAG_ES), { ok: false }]]);
  const result = resolveGraphemeImages([FLAG_ES], new Map(), fetched, fakeEncodeSvgDataUri);
  assertEquals(result.graphemeImages, {});
  assertEquals(result.newlyResolved.size, 0);
});

Deno.test('resolveGraphemeImages: an ok:true entry with no bytes is skipped, not an error -- fails open', () => {
  const fetched = new Map<string, FetchedObjectEntry>([[buildTwemojiObjectKey(FLAG_ES), { ok: true }]]);
  const result = resolveGraphemeImages([FLAG_ES], new Map(), fetched, fakeEncodeSvgDataUri);
  assertEquals(result.graphemeImages, {});
});

Deno.test('resolveGraphemeImages: one missing grapheme never blocks another that resolved successfully -- partial success', () => {
  const fetched = new Map<string, FetchedObjectEntry>([
    [buildTwemojiObjectKey(HEART_VS16), { ok: true, bytes: new Uint8Array([9]) }],
    // FLAG_ES's key is deliberately absent -- simulates a failed/missing SVG.
  ]);

  const result = resolveGraphemeImages([HEART_VS16, FLAG_ES], new Map(), fetched, fakeEncodeSvgDataUri);

  assertEquals(Object.keys(result.graphemeImages), [HEART_VS16]);
});
