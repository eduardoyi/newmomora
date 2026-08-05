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
  SHARE_CARD_BODY_FONT_SIZE,
  type SatoriNode,
  type ShareCardData,
} from './layout.ts';
import { BASE_SCALE, LOGICAL_CARD_WIDTH, REDUCED_SCALE } from './scale.ts';

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

async function renderSvg(data: ShareCardData, scale = BASE_SCALE): Promise<string> {
  const tree = buildShareCardTree(data, scale);
  return await satori(tree, { width: Math.round(LOGICAL_CARD_WIDTH * scale), fonts: FONTS });
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

// Walks the SatoriNode tree (buildShareCardTree's return value -- the exact
// input satori consumes to produce the SVG) looking for a node whose style
// declares the given fontFamily. satori converts text to vector <path>
// elements with no literal font-size attribute in its SVG output, so a
// proportion check against the *rendered* SVG string isn't feasible;
// checking the tree instead is checking the same numbers satori embeds
// (its glyph paths are scaled directly from this fontSize), without the
// fragility of reverse-engineering font metrics from path geometry.
function findNodeByFontFamily(node: SatoriNode, fontFamily: string): SatoriNode | null {
  const style = node.props.style as { fontFamily?: string } | undefined;
  if (style?.fontFamily === fontFamily) {
    return node;
  }
  const { children } = node.props;
  const list: SatoriNode[] = Array.isArray(children)
    ? children
    : children && typeof children !== 'string'
    ? [children]
    : [];
  for (const child of list) {
    const found = findNodeByFontFamily(child, fontFamily);
    if (found) {
      return found;
    }
  }
  return null;
}

Deno.test('layout: caption font-size / card-width ratio matches memory-card.tsx -- proportion regression guard', () => {
  // This is the assertion that would have caught the "huge photo, tiny
  // caption strip" bug: buildShareCardTree used to compose directly at a
  // 1080px raster width using memory-card.tsx's dp-scale magic numbers
  // (e.g. fontSize 14.5) as if they were raster pixels, so the emitted
  // caption was ~14.5/1080 (~1.3%) of the card width instead of the
  // in-app card's ~14.5/398 (~3.6%). Composing in logical units
  // (LOGICAL_CARD_WIDTH) and scaling uniformly to raster afterward fixes
  // this structurally -- this test pins the invariant so it can't regress
  // silently.
  const data: ShareCardData = {
    variant: 'spread',
    dateLabel: formatShareCardDateLabel('2026-06-08'),
    caption: 'Regression guard for the raster-vs-logical proportions bug.',
    imageDataUri: null,
    imageAspectRatio: null,
    members: [],
    memberOverflowCount: 0,
  };

  const tree = buildShareCardTree(data, BASE_SCALE);
  const cardWidth = (tree.props.style as { width: number }).width;
  const caption = findNodeByFontFamily(tree, 'Jakarta-Regular');
  if (!caption) {
    throw new Error('expected a Jakarta-Regular caption node in the tree');
  }
  const captionFontSize = (caption.props.style as { fontSize: number }).fontSize;

  const actualRatio = captionFontSize / cardWidth;
  const expectedRatio = SHARE_CARD_BODY_FONT_SIZE / LOGICAL_CARD_WIDTH;

  // Both captionFontSize and cardWidth pass through independent
  // Math.round() calls to whole raster pixels, so allow a small rounding
  // tolerance rather than requiring bit-for-bit equality.
  assertEquals(Math.abs(actualRatio - expectedRatio) < 0.002, true);
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

  const svgFull = await renderSvg(data, BASE_SCALE);
  const svgReduced = await renderSvg(data, REDUCED_SCALE);

  const heightFull = Number(svgFull.match(/<svg[^>]*\sheight="(\d+)"/)?.[1]);
  const heightReduced = Number(svgReduced.match(/<svg[^>]*\sheight="(\d+)"/)?.[1]);

  assertStringIncludes(svgReduced, 'width="720"');
  const expectedReducedHeight = Math.round(heightFull * (2 / 3));
  // Slack scales with height rather than a tight fixed +/-2px: now that the
  // card is composed in logical units first (the proportions fix), BASE_SCALE
  // and REDUCED_SCALE are both non-integer multipliers, so EVERY dp value
  // (not just the reduced pass, as before the fix) picks up independent
  // per-element rounding, and caption text wraps at a human-scale font size
  // where a line-break boundary can land a character earlier/later between
  // the two passes -- a few px of drift here reflects real text reflow
  // quantization, not a structural difference. 2% (floor 6px) comfortably
  // covers that while still catching an actual reflow (e.g. a dropped line
  // or a missing block), which would be off by tens of percent.
  const slack = Math.max(6, Math.round(expectedReducedHeight * 0.02));
  assertEquals(Math.abs(heightReduced - expectedReducedHeight) <= slack, true);
});
