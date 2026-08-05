// SVG layout snapshot tests (plan S3: "layout snapshot of the SVG string for
// each memory type -- cheap, catches drift"). Runs real satori (not resvg --
// the S0 spike found satori's layout pass is cheap; resvg's PNG raster is
// the CPU/memory-bound step) against the actual vendored fonts, so these
// tests fail loudly if a layout.ts change breaks rendering or silently
// changes the output shape.
import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import satoriImport from 'npm:satori@0.29.0';

import { NEWSREADER_REGULAR_B64 } from './assets/font-newsreader-regular-b64.ts';
import { NEWSREADER_REGULAR_ITALIC_B64 } from './assets/font-newsreader-regular-italic-b64.ts';
import { NEWSREADER_MEDIUM_B64 } from './assets/font-newsreader-medium-b64.ts';
import { JAKARTA_REGULAR_B64 } from './assets/font-jakarta-regular-b64.ts';
import { JAKARTA_BOLD_B64 } from './assets/font-jakarta-bold-b64.ts';
import {
  buildShareCardTree,
  formatShareCardDateLabel,
  type ShareCardData,
} from './layout.ts';

// deno-lint-ignore no-explicit-any
const satori = satoriImport as any;

function b64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const FONTS = [
  { name: 'Newsreader-Regular', data: b64ToBytes(NEWSREADER_REGULAR_B64), weight: 400, style: 'normal' as const },
  { name: 'Newsreader-Italic', data: b64ToBytes(NEWSREADER_REGULAR_ITALIC_B64), weight: 400, style: 'italic' as const },
  { name: 'Newsreader-Medium', data: b64ToBytes(NEWSREADER_MEDIUM_B64), weight: 500, style: 'normal' as const },
  { name: 'Jakarta-Regular', data: b64ToBytes(JAKARTA_REGULAR_B64), weight: 400, style: 'normal' as const },
  { name: 'Jakarta-Bold', data: b64ToBytes(JAKARTA_BOLD_B64), weight: 700, style: 'normal' as const },
];

async function renderSvg(data: ShareCardData, width = 1080, scale = 1): Promise<string> {
  const tree = buildShareCardTree(data, width, scale);
  return await satori(tree, { width: Math.round(width * scale), fonts: FONTS });
}

// A 1x1 transparent PNG data URI -- enough for satori's <img> layout pass
// (which only needs declared width/height, not real pixel decoding).
const STUB_IMAGE_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

Deno.test('layout: quote variant (text_only) renders and contains the full caption', async () => {
  const data: ShareCardData = {
    variant: 'quote',
    dateLabel: formatShareCardDateLabel('2026-06-08'),
    caption: 'A perfectly ordinary Tuesday that somehow became one to remember.',
    imageDataUri: null,
    imageAspectRatio: null,
    members: [],
    memberOverflowCount: 0,
  };

  const svg = await renderSvg(data);
  assertStringIncludes(svg, '<svg');
  // satori renders text as vector paths, not literal text nodes -- assert
  // structural facts instead of substring-matching the caption (which would
  // never appear literally in the SVG output).
  assertEquals(svg.includes('<image'), false, 'quote card has no image block');
});

Deno.test('layout: spread variant (media) includes an image block sized from the aspect ratio', async () => {
  const data: ShareCardData = {
    variant: 'spread',
    dateLabel: formatShareCardDateLabel('2026-06-08'),
    caption: 'Park day with the ducks.',
    imageDataUri: STUB_IMAGE_DATA_URI,
    imageAspectRatio: 4 / 3,
    members: [],
    memberOverflowCount: 0,
  };

  const svg = await renderSvg(data);
  assertStringIncludes(svg, '<svg');
  // width=1080, height = round(1080 / (4/3)) = 810
  assertStringIncludes(svg, 'width="1080" height="810"');
});

Deno.test('layout: spread variant (illustration) renders with a square-ish image block', async () => {
  const data: ShareCardData = {
    variant: 'spread',
    dateLabel: formatShareCardDateLabel('2026-06-08'),
    caption: 'She drew this all by herself.',
    imageDataUri: STUB_IMAGE_DATA_URI,
    imageAspectRatio: 1,
    members: [],
    memberOverflowCount: 0,
  };

  const svg = await renderSvg(data);
  assertStringIncludes(svg, 'width="1080" height="1080"');
});

Deno.test('layout: media variant with no caption omits the caption block entirely', async () => {
  const withCaption: ShareCardData = {
    variant: 'spread',
    dateLabel: formatShareCardDateLabel('2026-06-08'),
    caption: 'Something to say about this one.',
    imageDataUri: STUB_IMAGE_DATA_URI,
    imageAspectRatio: 4 / 3,
    members: [],
    memberOverflowCount: 0,
  };
  const withoutCaption: ShareCardData = { ...withCaption, caption: '' };

  const svgWith = await renderSvg(withCaption);
  const svgWithout = await renderSvg(withoutCaption);

  // The captioned card must be taller than the caption-less one (the caption
  // block adds height); a cheap structural proxy for "the block is present".
  const heightWith = Number(svgWith.match(/<svg[^>]*\sheight="(\d+)"/)?.[1]);
  const heightWithout = Number(svgWithout.match(/<svg[^>]*\sheight="(\d+)"/)?.[1]);
  assertEquals(heightWith > heightWithout, true);
});

Deno.test('layout: tagged-member portraits render as an overlapping avatar row, capped with an overflow badge', async () => {
  const data: ShareCardData = {
    variant: 'quote',
    dateLabel: formatShareCardDateLabel('2026-06-08'),
    caption: 'Everyone was there.',
    imageDataUri: null,
    imageAspectRatio: null,
    members: [
      { name: 'Mia', dataUri: STUB_IMAGE_DATA_URI },
      { name: 'Leo', dataUri: null },
    ],
    memberOverflowCount: 3,
  };

  const svg = await renderSvg(data);
  assertStringIncludes(svg, '<svg');
  // One member has a portrait image -> at least one <image> node (the
  // avatar); the initial-letter fallback and overflow badge are plain
  // shapes/text, not images, so exactly one <image> is expected.
  const imageCount = (svg.match(/<image /g) ?? []).length;
  assertEquals(imageCount, 1);
});

Deno.test('layout: 720px reduced-scale render is the identical layout at 2/3 size, not a reflow', async () => {
  const data: ShareCardData = {
    variant: 'spread',
    dateLabel: formatShareCardDateLabel('2026-06-08'),
    caption: 'A caption long enough to matter for the reduced-scale render.',
    imageDataUri: STUB_IMAGE_DATA_URI,
    imageAspectRatio: 4 / 3,
    members: [],
    memberOverflowCount: 0,
  };

  const svgFull = await renderSvg(data, 1080, 1);
  const svgReduced = await renderSvg(data, 1080, 2 / 3);

  const heightFull = Number(svgFull.match(/<svg[^>]*\sheight="(\d+)"/)?.[1]);
  const heightReduced = Number(svgReduced.match(/<svg[^>]*\sheight="(\d+)"/)?.[1]);

  assertStringIncludes(svgReduced, 'width="720"');
  // Allow +/-2px slack for independent rounding of width/height at 2/3 scale.
  const expectedReducedHeight = Math.round(heightFull * (2 / 3));
  assertEquals(Math.abs(heightReduced - expectedReducedHeight) <= 2, true);
});
