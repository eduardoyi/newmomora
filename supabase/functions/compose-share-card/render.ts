// Satori (SVG layout) + @resvg/resvg-wasm (PNG raster) pipeline for the
// memory share card.
//
// PERF-AUDIT ROUND 4 (this package's implementation report): binary assets
// (resvg wasm, font TTFs) used to be base64 string modules statically
// imported here (S0 gating spike's vendoring pattern -- Deno.readFile/
// readDirSync/fetch(import.meta.url) don't survive `supabase functions
// deploy --use-api`, so the module graph was the only channel that did).
// That worked, but a control experiment (a trivial hello-world function on
// the SAME project, hammered the same way: 15/15 success) isolated the
// ~4.8MB of base64 TEXT those modules added to this function's own module
// graph -- V8 has to PARSE all of it on every cold boot, since no warm
// isolate has ever been observed (S0) -- as the actual cause of ~48%
// bodyless 546 failures (bodyless: no Server-Timing header at all, proof
// they died before this function's handler ever ran). Fix: evict the
// assets from the module graph entirely. They're now fetched from R2 at
// request time (assets-loader.ts) and passed into composeShareCardPng as a
// plain argument -- this file no longer imports any binary asset, static or
// dynamic, and no longer knows or cares where the bytes came from (that's
// what makes it trivially testable with local fixture bytes -- see
// render.test.ts -- without touching R2 at all).
import satoriImport from 'npm:satori@0.29.0';
import { initWasm, Resvg } from 'npm:@resvg/resvg-wasm@2.6.2';

import { buildShareCardTree, type ShareCardData } from './layout.ts';
import {
  BASE_SCALE,
  REDUCED_SCALE,
  SHARE_CARD_FULL_WIDTH,
  SHARE_CARD_REDUCED_WIDTH,
  parseSvgHeightPx,
  shouldUseReducedScale,
} from './scale.ts';

type SatoriFn = (
  tree: ReturnType<typeof buildShareCardTree>,
  options: {
    width: number;
    fonts: Array<{ name: string; data: Uint8Array; weight: number; style: 'normal' | 'italic' }>;
    /** Grapheme -> image-source (data URI) overrides -- see emoji.ts's
     * header comment for why this is the ONLY way satori can render
     * flags/ZWJ-sequence/keycap emoji correctly (no font, however complete
     * its glyph coverage, can produce them through ordinary text shaping). */
    graphemeImages?: Record<string, string>;
  },
) => Promise<string>;

const satori = satoriImport as unknown as SatoriFn;

export interface ShareCardFontBytes {
  newsreaderRegular: Uint8Array;
  newsreaderItalic: Uint8Array;
  newsreaderMedium: Uint8Array;
  jakartaRegular: Uint8Array;
  jakartaBold: Uint8Array;
  notoEmoji: Uint8Array;
}

/** Everything composeShareCardPng needs that isn't `data` -- the caller
 * (index.ts, via assets-loader.ts's loadShareCardAssets()) is responsible
 * for getting these bytes from wherever; this file just consumes them. */
export interface ShareCardRenderAssets {
  resvgWasm: Uint8Array;
  fonts: ShareCardFontBytes;
}

// ── Lazy resvg-wasm compile (perf-audit round 3, refined round 4) ────────
// initWasm (resvg's wasm COMPILE -- the single most expensive CPU step in
// this whole pipeline) only ever runs once per isolate, on the first
// composeShareCardPng() call -- i.e. request-scoped, not module-scope,
// exactly like round 3 verified. Round 4 removes the base64 DECODE step
// entirely (bytes now arrive as raw Uint8Array straight from R2 -- no
// atob() needed anywhere in this file anymore); the wasm COMPILE is the
// only remaining one-time cost, still memoized here and still timed
// separately as `initMs` so a first-request cost spike reads as "init," not
// "satori is slow."
let resvgInitPromise: Promise<void> | null = null;

function ensureResvgInitialized(wasmBytes: Uint8Array): Promise<void> {
  if (!resvgInitPromise) {
    resvgInitPromise = initWasm(wasmBytes.buffer as ArrayBuffer).catch((error) => {
      resvgInitPromise = null;
      throw error;
    });
  }
  return resvgInitPromise;
}

// NOTE: deliberately no `_resetResvgInitForTests` export here (round 3 had
// removed the earlier equivalent's real risk, round 4 re-confirmed it):
// @resvg/resvg-wasm's initWasm() throws ("Already initialized") on a SECOND
// real call within the same process, regardless of this module's own
// `resvgInitPromise` bookkeeping -- a reset-for-tests helper would silently
// invite a test to crash the whole suite the moment two tests in the same
// process both drive a real composeShareCardPng call. See render.test.ts's
// header comment for how its tests share the one real initWasm() call
// safely instead.
function satoriFontList(fonts: ShareCardFontBytes) {
  return [
    { name: 'Newsreader-Regular', data: fonts.newsreaderRegular, weight: 400, style: 'normal' as const },
    { name: 'Newsreader-Italic', data: fonts.newsreaderItalic, weight: 400, style: 'italic' as const },
    { name: 'Newsreader-Medium', data: fonts.newsreaderMedium, weight: 500, style: 'normal' as const },
    { name: 'Jakarta-Regular', data: fonts.jakartaRegular, weight: 400, style: 'normal' as const },
    { name: 'Jakarta-Bold', data: fonts.jakartaBold, weight: 700, style: 'normal' as const },
    // No fontFamily in layout.ts ever references "NotoEmoji" directly --
    // satori automatically falls back to any loaded font that covers a
    // glyph missing from the requested family, so simply including this in
    // the font list is enough for emoji in captions to render (monochrome)
    // instead of tofu. See the S3 emoji privacy decision, now documented in
    // _shared/share-card-assets-manifest.ts (the asset's original home,
    // assets/font-noto-emoji-subset-b64.ts, was deleted in round 4).
    { name: 'NotoEmoji', data: fonts.notoEmoji, weight: 400, style: 'normal' as const },
  ];
}

export interface ComposeShareCardResult {
  png: Uint8Array;
  /** The ONE-TIME per-isolate resvg-wasm-compile cost (ensureResvgInitialized
   * above). Near-zero on a cache hit; real cost on an isolate's first
   * compose -- which, per S0, is effectively every compose. */
  initMs: number;
  /** Layout-phase cost: the satori() layout call(s) only, NOT including
   * initMs above. */
  satoriMs: number;
  /** Raster-phase cost: `new Resvg(...).render()` only. */
  resvgMs: number;
  /** Which pass's output was used -- mirrors shouldUseReducedScale's decision. */
  scale: 'full' | 'reduced';
}

/**
 * Renders `data` to a PNG. Implements the S0-mandated two-pass reduced-scale
 * mitigation: lay out once at 1080px, and if the resulting height would push
 * total pixel count past the measured CPU/memory ceiling, re-lay-out the
 * IDENTICAL content at 720px (2/3 scale of every dimension) instead of
 * truncating anything. Satori (layout) is comparatively cheap -- the S0
 * spike found the CPU/memory ceiling is resvg's raster step, tracking pixel
 * count -- so doing the layout pass twice in the worst case is an accepted
 * cost, not a second expensive operation.
 *
 * `assets` -- resvg wasm bytes + every font buffer -- are passed in rather
 * than fetched/decoded here (round 4: this file no longer knows where bytes
 * come from). Production passes R2-fetched bytes (index.ts, via
 * assets-loader.ts); tests pass local fixture bytes directly (see
 * render.test.ts) -- neither touches R2 in a unit test.
 *
 * `graphemeImages` (emoji fix, docs/plans/share-card-store-through.md's
 * four-part production fix) -- a grapheme-text -> data-URI map, built by
 * index.ts from a caption's emoji graphemes (emoji.ts) -- is passed
 * straight through to BOTH satori passes below (full and, if it runs, the
 * reduced-scale re-layout) unchanged; satori substitutes these images for
 * the matching grapheme's font-shaped glyphs wherever it appears in the
 * tree, independent of scale.
 *
 * Returns per-phase timings (perf-audit instrumentation, this package's
 * implementation report) alongside the PNG so the caller (index.ts) can emit
 * a Server-Timing header + structured log line without this function
 * needing to know about HTTP responses or logging discipline.
 */
export async function composeShareCardPng(
  data: ShareCardData,
  assets: ShareCardRenderAssets,
  graphemeImages?: Record<string, string>,
): Promise<ComposeShareCardResult> {
  const initStart = performance.now();
  await ensureResvgInitialized(assets.resvgWasm);
  const initMs = performance.now() - initStart;
  const fontList = satoriFontList(assets.fonts);

  const satoriStart = performance.now();
  const fullTree = buildShareCardTree(data, BASE_SCALE);
  const fullSvg = await satori(fullTree, { width: SHARE_CARD_FULL_WIDTH, fonts: fontList, graphemeImages });
  const fullHeight = parseSvgHeightPx(fullSvg);

  let finalSvg = fullSvg;
  let finalWidth = SHARE_CARD_FULL_WIDTH;
  let scale: 'full' | 'reduced' = 'full';

  if (fullHeight !== null && shouldUseReducedScale(fullHeight)) {
    const reducedTree = buildShareCardTree(data, REDUCED_SCALE);
    finalSvg = await satori(reducedTree, { width: SHARE_CARD_REDUCED_WIDTH, fonts: fontList, graphemeImages });
    finalWidth = SHARE_CARD_REDUCED_WIDTH;
    scale = 'reduced';
  }
  const satoriMs = performance.now() - satoriStart;

  const resvgStart = performance.now();
  const resvg = new Resvg(finalSvg, { fitTo: { mode: 'width', value: finalWidth } });
  const rendered = resvg.render();
  const png = rendered.asPng();
  const resvgMs = performance.now() - resvgStart;

  return { png, initMs: Math.round(initMs), satoriMs: Math.round(satoriMs), resvgMs: Math.round(resvgMs), scale };
}
