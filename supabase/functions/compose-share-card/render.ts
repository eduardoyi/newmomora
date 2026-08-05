// Satori (SVG layout) + @resvg/resvg-wasm (PNG raster) pipeline for the
// memory share card. Vendoring pattern per the S0 gating spike
// (docs/plans/offline-awareness-and-share-cards.md S0): all binary assets
// are base64 string modules, statically imported -- see assets/*.ts and
// supabase/functions/compose-share-card-spike/index.ts for why
// Deno.readFile/readDirSync/fetch(import.meta.url) don't work under
// `supabase functions deploy --use-api`.
import satoriImport from 'npm:satori@0.29.0';
import { initWasm, Resvg } from 'npm:@resvg/resvg-wasm@2.6.2';

import { RESVG_WASM_B64 } from './assets/resvg-wasm-b64.ts';
import { NEWSREADER_REGULAR_B64 } from './assets/font-newsreader-regular-b64.ts';
import { NEWSREADER_REGULAR_ITALIC_B64 } from './assets/font-newsreader-regular-italic-b64.ts';
import { NEWSREADER_MEDIUM_B64 } from './assets/font-newsreader-medium-b64.ts';
import { JAKARTA_REGULAR_B64 } from './assets/font-jakarta-regular-b64.ts';
import { JAKARTA_BOLD_B64 } from './assets/font-jakarta-bold-b64.ts';
import { NOTO_EMOJI_SUBSET_B64 } from './assets/font-noto-emoji-subset-b64.ts';
import { buildShareCardTree, type ShareCardData } from './layout.ts';
import {
  SHARE_CARD_FULL_WIDTH,
  SHARE_CARD_REDUCED_SCALE,
  parseSvgHeightPx,
  shouldUseReducedScale,
} from './scale.ts';

type SatoriFn = (
  tree: ReturnType<typeof buildShareCardTree>,
  options: {
    width: number;
    fonts: Array<{ name: string; data: Uint8Array; weight: number; style: 'normal' | 'italic' }>;
  },
) => Promise<string>;

const satori = satoriImport as unknown as SatoriFn;

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

interface ShareCardFonts {
  newsreaderRegular: Uint8Array;
  newsreaderItalic: Uint8Array;
  newsreaderMedium: Uint8Array;
  jakartaRegular: Uint8Array;
  jakartaBold: Uint8Array;
  notoEmoji: Uint8Array;
}

let initPromise: Promise<ShareCardFonts> | null = null;

// Module-scope init, run once per isolate (S3 spec: "cold-start cost: satori
// + resvg-wasm init once per isolate; compose target < ~1.5s warm").
async function initialize(): Promise<ShareCardFonts> {
  const wasmBytes = base64ToBytes(RESVG_WASM_B64);
  await initWasm(wasmBytes);

  return {
    newsreaderRegular: base64ToBytes(NEWSREADER_REGULAR_B64),
    newsreaderItalic: base64ToBytes(NEWSREADER_REGULAR_ITALIC_B64),
    newsreaderMedium: base64ToBytes(NEWSREADER_MEDIUM_B64),
    jakartaRegular: base64ToBytes(JAKARTA_REGULAR_B64),
    jakartaBold: base64ToBytes(JAKARTA_BOLD_B64),
    notoEmoji: base64ToBytes(NOTO_EMOJI_SUBSET_B64),
  };
}

function getFonts(): Promise<ShareCardFonts> {
  if (!initPromise) {
    initPromise = initialize().catch((error) => {
      initPromise = null;
      throw error;
    });
  }
  return initPromise;
}

function satoriFontList(fonts: ShareCardFonts) {
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
    // instead of tofu. See the S3 emoji privacy decision in
    // assets/font-noto-emoji-subset-b64.ts's header comment.
    { name: 'NotoEmoji', data: fonts.notoEmoji, weight: 400, style: 'normal' as const },
  ];
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
 */
export async function composeShareCardPng(data: ShareCardData): Promise<Uint8Array> {
  const fonts = await getFonts();
  const fontList = satoriFontList(fonts);

  const fullTree = buildShareCardTree(data, SHARE_CARD_FULL_WIDTH, 1);
  const fullSvg = await satori(fullTree, { width: SHARE_CARD_FULL_WIDTH, fonts: fontList });
  const fullHeight = parseSvgHeightPx(fullSvg);

  let finalSvg = fullSvg;
  let finalWidth = SHARE_CARD_FULL_WIDTH;

  if (fullHeight !== null && shouldUseReducedScale(fullHeight)) {
    const reducedWidth = Math.round(SHARE_CARD_FULL_WIDTH * SHARE_CARD_REDUCED_SCALE);
    const reducedTree = buildShareCardTree(data, SHARE_CARD_FULL_WIDTH, SHARE_CARD_REDUCED_SCALE);
    finalSvg = await satori(reducedTree, { width: reducedWidth, fonts: fontList });
    finalWidth = reducedWidth;
  }

  const resvg = new Resvg(finalSvg, { fitTo: { mode: 'width', value: finalWidth } });
  const rendered = resvg.render();
  return rendered.asPng();
}
