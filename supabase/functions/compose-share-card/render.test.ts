// Tests for composeShareCardPng's asset-injection design (perf-audit round
// 4, this package's implementation report): binary assets (resvg wasm,
// font TTFs) are no longer base64-embedded/decoded inside this file -- the
// caller supplies raw bytes via the `assets` parameter. Production sources
// those bytes from R2 (index.ts, via assets-loader.ts); these tests read
// the SAME real binary files straight off disk
// (compose-share-card/assets/bin/* -- the upload script's source AND the
// manifest's sha256-covered content), so composeShareCardPng is exercised
// with the REAL fonts/wasm, not mocks, while never touching R2/network.
import { assertEquals, assertNotEquals } from 'jsr:@std/assert@1';

import {
  composeShareCardPng,
  type ShareCardRenderAssets,
} from './render.ts';
import { formatShareCardDateLabel, type ShareCardData } from './layout.ts';
import {
  BASE_SCALE,
  MIN_OUTPUT_SCALE,
  MIN_RASTER_WIDTH,
  resolveShareCardOutputWidthPx,
  SHARE_CARD_FULL_WIDTH,
  SHARE_CARD_PIXEL_BUDGET,
} from './scale.ts';

/** Reads width/height straight from a PNG's IHDR chunk (bytes 16-19 /
 * 20-23, big-endian uint32) -- avoids pulling in an image-decoding
 * dependency just to verify composeShareCardPng's ACTUAL raster dimensions
 * match what its returned `scale` predicts (scale.ts's continuous budget
 * fit, tail fix -- docs/plans/share-card-store-through.md's four-part
 * production fix). PNG signature + IHDR are always the first 24 bytes of
 * any valid PNG (spec-guaranteed), so this is exact, not a heuristic. */
function readPngDimensions(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const ASSETS_BIN_DIR = new URL('./assets/bin/', import.meta.url);

async function readAssetBin(fileName: string): Promise<Uint8Array> {
  return await Deno.readFile(new URL(fileName, ASSETS_BIN_DIR));
}

async function loadTestAssets(): Promise<ShareCardRenderAssets> {
  const [resvgWasm, newsreaderRegular, newsreaderItalic, newsreaderMedium, jakartaRegular, jakartaBold, notoEmoji] = await Promise.all([
    readAssetBin('resvg.wasm'),
    readAssetBin('newsreader-regular.ttf'),
    readAssetBin('newsreader-italic.ttf'),
    readAssetBin('newsreader-medium.ttf'),
    readAssetBin('jakarta-regular.ttf'),
    readAssetBin('jakarta-bold.ttf'),
    readAssetBin('noto-emoji-subset.ttf'),
  ]);
  return {
    resvgWasm,
    fonts: { newsreaderRegular, newsreaderItalic, newsreaderMedium, jakartaRegular, jakartaBold, notoEmoji },
  };
}

const TEST_ASSETS = await loadTestAssets();

function textOnlyCardData(caption: string): ShareCardData {
  return {
    variant: 'quote',
    dateLabel: formatShareCardDateLabel('2026-06-08'),
    caption,
    imageDataUri: null,
    imageAspectRatio: null,
    members: [],
    memberOverflowCount: 0,
    emotion: null,
  };
}

// NOTE on test ordering/state: @resvg/resvg-wasm's initWasm() can only ever
// be called ONCE per Deno process ("Already initialized" is a hard throw on
// a second real call) -- this is a global constraint of the underlying wasm
// runtime, not something render.ts's own `resvgInitPromise` bookkeeping
// controls. `_resetResvgInitForTests()` only clears render.ts's OWN memo
// (useful for testing render.ts's memoization LOGIC in isolation, e.g. via
// a mocked initWasm elsewhere), so these tests deliberately do NOT call it
// around real composeShareCardPng invocations -- the very first
// composeShareCardPng call across ALL tests in this file is the only one
// that may trigger a real initWasm(); every test after it relies on that
// same already-initialized module (Deno runs tests within one file
// sequentially, in one process, by default).

Deno.test('composeShareCardPng renders a real PNG from injected asset bytes, and memoizes the resvg-wasm-compile cost across calls (no R2/network access)', async () => {
  // This is the FIRST composeShareCardPng call in the whole test run -- the
  // only one that pays a real initWasm() compile.
  const first = await composeShareCardPng(textOnlyCardData('A real render, using local fixture bytes.'), TEST_ASSETS);

  // PNG signature -- proof this is a real raster, not empty/garbage bytes.
  assertEquals(first.png[0], 0x89);
  assertEquals(first.png[1], 0x50);
  assertEquals(first.png[2], 0x4e);
  assertEquals(first.png[3], 0x47);
  assertEquals(first.png.length > 0, true);
  // BASE cap for short cards (tail fix, docs/plans/share-card-store-through.md's
  // four-part production fix): a card comfortably under budget must still
  // render at EXACTLY the primary 1080px width, unchanged from before the
  // two-tier-to-continuous rewrite.
  assertEquals(first.scale, BASE_SCALE);
  assertEquals(readPngDimensions(first.png).width, SHARE_CARD_FULL_WIDTH);

  // A second call reuses the already-compiled module (ensureResvgInitialized's
  // memoization, render.ts) -- its initMs should be small (an await on an
  // already-settled promise), not a repeat of the real compile cost.
  const second = await composeShareCardPng(textOnlyCardData('Second compose, same process.'), TEST_ASSETS);
  assertEquals(second.initMs < 5, true);
});

// Real words (not one giant unbroken run) repeated to a target length, so
// satori actually WRAPS the text across many lines the way a real caption
// would -- an unbroken run of repeated characters doesn't wrap at
// whitespace and so doesn't measure height the way real content does.
const WRAP_PHRASE = 'A perfectly ordinary Tuesday that somehow became one to remember. '; // 68 chars
function repeatedCaption(targetLength: number): string {
  return WRAP_PHRASE.repeat(Math.ceil(targetLength / WRAP_PHRASE.length) + 1).slice(0, targetLength);
}

Deno.test('composeShareCardPng: a caption long enough to exceed budget at 1080 scales DOWN continuously (not to a fixed 720 tier), landing back under budget', async () => {
  // Relies on resvg-wasm already being initialized by the test above (same
  // process) -- see this file's header note on why this test does NOT call
  // _resetResvgInitForTests().
  //
  // 2640 chars measured (this package's implementation report, a real
  // composeShareCardPng run against these exact fixtures) to scale=1.42427
  // (strictly between MIN_OUTPUT_SCALE ~1.206 and BASE_SCALE ~2.714) at
  // 567x2961 = 1,678,887px -- under the 1.9M budget, confirming the
  // continuous formula finds a real non-floor, non-BASE scale for
  // realistic "somewhat long" content, not just the two old fixed tiers.
  const result = await composeShareCardPng(textOnlyCardData(repeatedCaption(2640)), TEST_ASSETS);
  assertEquals(result.png[0], 0x89); // still a valid PNG

  assertEquals(result.scale < BASE_SCALE, true);
  assertEquals(result.scale > MIN_OUTPUT_SCALE, true); // strictly ABOVE the floor -- this caption does not need it

  const { width, height } = readPngDimensions(result.png);
  assertEquals(width, resolveShareCardOutputWidthPx(result.scale));
  // Budget-fit, not budget-EXCEEDED: independent int rounding of width and
  // height can land the real product a hair over the exact continuous
  // target, so a small tolerance (0.5%) absorbs that without masking an
  // actual regression (which would be off by tens of percent, e.g. a
  // scale-clamp bug reverting to BASE_SCALE).
  assertEquals(width * height <= SHARE_CARD_PIXEL_BUDGET * 1.005, true);
});

// ── Floor-clamp / "47-failure-class" regression (tail fix, docs/plans/
// share-card-store-through.md's four-part production fix) ────────────────
// Backfill telemetry across 823 real targets found 47 failed 546
// DETERMINISTICALLY (6/6 attempts -- impossible under the ~50% stochastic
// per-attempt rate): whole carousels with long captions exceeded the
// platform's real budget even at the OLD fixed 720px fallback. This test
// pins the ACTUAL measured numbers (this package's implementation report,
// a real composeShareCardPng run against these exact fixtures, NOT a hand
// estimate) for the worst realistic case -- a caption at
// validateMemoryContent's real 5000-char cap -- so a future change to the
// budget/floor constants is forced to re-examine this exact tradeoff
// rather than silently drifting it.
//
// HONEST RESULT, reported rather than silently shipped (per this fix's own
// design brief): the floor does NOT fully restore the budget guarantee for
// the longest realistic captions. A real 5000-char caption measures to
// logicalHeight ~4497 -- past the ~3282 crossover where MIN_OUTPUT_SCALE
// binds before the budget-fit formula would -- producing 480x5423 =
// 2,603,040px, ~37% OVER the 1.9M budget (worse than this fix's own
// ~2.1M back-of-envelope estimate; real word-wrap metrics differ from a
// rough per-character estimate). Still a REAL improvement: the OLD fixed
// 720px-wide fallback, given the SAME measured logical height, would have
// produced 720 x ~8135 = 5,856,840px -- 2.25x MORE pixels, and 2.3x over
// the OLD 2.5M budget -- squarely in the range that produced the 47
// deterministic failures this fix responds to. The residual risk here is
// real but substantially narrowed (only the longest few percent of
// captions), and is an explicit, disclosed tradeoff against the
// MIN_RASTER_WIDTH legibility floor (see scale.ts's doc comments) rather
// than an oversight.
Deno.test('composeShareCardPng: a real 5000-char (validateMemoryContent cap) caption clamps to the MIN_RASTER_WIDTH floor -- 2.25x smaller than the OLD fixed-720 fallback would have been, but the floor still leaves this specific worst case ~37% over the new budget (accepted, disclosed risk)', async () => {
  const result = await composeShareCardPng(textOnlyCardData(repeatedCaption(5000)), TEST_ASSETS);
  assertEquals(result.png[0], 0x89); // still a valid PNG

  assertEquals(result.scale, MIN_OUTPUT_SCALE);
  const { width, height } = readPngDimensions(result.png);
  assertEquals(width, MIN_RASTER_WIDTH);

  const pixelCount = width * height;
  assertEquals(pixelCount > SHARE_CARD_PIXEL_BUDGET, true); // the floor DOES cost us the budget guarantee here
  // Documented bound, not a brittle exact pin (exact word-wrap is
  // font/satori-version-sensitive): the measured real overage is ~37%;
  // this asserts comfortably above that (50%) so the test isn't flaky on
  // a harmless few-pixel wrap difference, while still catching an actual
  // regression (e.g. the floor clamp silently breaking), which would be
  // off by multiples, not tens of percent.
  assertEquals(pixelCount <= SHARE_CARD_PIXEL_BUDGET * 1.5, true);
});

// ── graphemeImages (emoji fix, docs/plans/share-card-store-through.md's
// four-part production fix) -- satori's ONLY mechanism for rendering
// flags/ZWJ-sequences/keycaps correctly (see emoji.ts's header comment).
// composeShareCardPng returns a RASTERIZED PNG, not the intermediate SVG,
// so this can't string-search for an embedded `<image>`/data-URI the way a
// satori-level test could -- instead it proves the parameter has a real
// effect end-to-end: the SAME caption/data renders to DIFFERENT PNG bytes
// depending on whether a graphemeImages override is supplied, which can
// only happen if render.ts is actually threading it into satori (both the
// full AND, implicitly, the reduced-scale pass share the same code path).
// A distinctive, deliberately non-photographic SVG (a solid red square) is
// used as the fixture so there's no ambiguity about whether the override
// was applied -- a subtler difference could plausibly come from unrelated
// rendering noise.
Deno.test('composeShareCardPng: a graphemeImages override for a caption emoji changes the rendered PNG bytes (proves the param reaches satori)', async () => {
  const flagGrapheme = '\u{1F1EA}\u{1F1F8}'; // matches emoji.ts's isEmojiGrapheme/extraction shape
  const caption = `Trip to Spain ${flagGrapheme} was unforgettable`;
  const tinyRedSquareSvgDataUri = `data:image/svg+xml;base64,${
    btoa('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>')
  }`;

  const withoutOverride = await composeShareCardPng(textOnlyCardData(caption), TEST_ASSETS);
  const withOverride = await composeShareCardPng(
    textOnlyCardData(caption),
    TEST_ASSETS,
    { [flagGrapheme]: tinyRedSquareSvgDataUri },
  );

  assertEquals(withOverride.png[0], 0x89); // still a valid PNG
  assertNotEquals(Array.from(withOverride.png), Array.from(withoutOverride.png));
});

Deno.test('composeShareCardPng: an empty graphemeImages object behaves identically to omitting it entirely (no accidental substitution)', async () => {
  const caption = 'No emoji in this caption at all.';
  const withEmptyMap = await composeShareCardPng(textOnlyCardData(caption), TEST_ASSETS, {});
  const withUndefined = await composeShareCardPng(textOnlyCardData(caption), TEST_ASSETS);

  assertEquals(Array.from(withEmptyMap.png), Array.from(withUndefined.png));
});
