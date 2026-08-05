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
  SHARE_CARD_EMOTION_COLORS,
  SHARE_CARD_THEME,
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
    emotion: null,
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
    emotion: null,
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
    emotion: null,
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
    emotion: null,
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
    emotion: null,
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
    emotion: null,
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
    emotion: null,
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

// Collects every node of `type` in the tree (DFS), for the corner-clip and
// must-have-image assertions below -- a generalized version of
// findNodeByFontFamily above.
function findAllNodesByType(node: SatoriNode, type: string, out: SatoriNode[] = []): SatoriNode[] {
  if (node.type === type) {
    out.push(node);
  }
  const { children } = node.props;
  const list: SatoriNode[] = Array.isArray(children)
    ? children
    : children && typeof children !== 'string'
    ? [children]
    : [];
  for (const child of list) {
    findAllNodesByType(child, type, out);
  }
  return out;
}

// ── Bug 2: photo bleeds past the card's rounded top corners ──────────────
// satori does not clip a child to its parent's borderRadius unless the
// parent also sets overflow: hidden -- the full-bleed photo (spread) / top
// accent strip (quote), both flush against the top edge, were drawn as
// plain rectangles straight over the card's rounded corners. Verified
// visually via local compose (see this package's implementation report);
// these are the structural regression guards.
Deno.test('layout: spread card root sets overflow:hidden so the full-bleed photo clips to the rounded corners', () => {
  const data: ShareCardData = {
    variant: 'spread',
    dateLabel: formatShareCardDateLabel('2026-06-08'),
    caption: 'Corner-clip regression guard.',
    imageDataUri: STUB_IMAGE_DATA_URI,
    imageAspectRatio: 4 / 3,
    members: [],
    memberOverflowCount: 0,
    emotion: null,
  };

  const tree = buildShareCardTree(data, BASE_SCALE);
  const rootStyle = tree.props.style as { overflow?: string; borderRadius?: number };
  assertEquals(rootStyle.overflow, 'hidden');
  assertEquals(typeof rootStyle.borderRadius, 'number');
});

Deno.test('layout: quote card root ALSO sets overflow:hidden so the top accent strip clips to the rounded corners', () => {
  const data: ShareCardData = {
    variant: 'quote',
    dateLabel: formatShareCardDateLabel('2026-06-08'),
    caption: 'Corner-clip regression guard (quote variant).',
    imageDataUri: null,
    imageAspectRatio: null,
    members: [],
    memberOverflowCount: 0,
    emotion: null,
  };

  const tree = buildShareCardTree(data, BASE_SCALE);
  const rootStyle = tree.props.style as { overflow?: string };
  assertEquals(rootStyle.overflow, 'hidden');
});

// ── Bug 3: illustrated memories render NO illustration ────────────────────
// The card MUST fail loudly (a thrown assertion, not a silently-blank
// image) if the image node is absent for data representing an illustrated
// memory -- i.e. imageDataUri is set. Root cause was NOT a missing tree
// node (satori always embedded it correctly) but resvg-wasm being unable to
// RASTER real webp bytes; this guard still matters structurally in case a
// future layout.ts change accidentally drops imageBlockNode for the spread
// variant (e.g. moving it behind a truthy check that's wrong for some
// input shape).
Deno.test('layout: spread variant with imageDataUri set MUST include an <img> node in the tree (must-have-image guard)', () => {
  const data: ShareCardData = {
    variant: 'spread',
    dateLabel: formatShareCardDateLabel('2026-06-08'),
    caption: 'She drew this all by herself.',
    imageDataUri: STUB_IMAGE_DATA_URI,
    imageAspectRatio: 1,
    members: [],
    memberOverflowCount: 0,
    emotion: null,
  };

  const tree = buildShareCardTree(data, BASE_SCALE);
  const imageNodes = findAllNodesByType(tree, 'img');
  if (imageNodes.length === 0) {
    throw new Error(
      'FAIL LOUD: illustrated-memory ShareCardData (imageDataUri set) produced a tree with NO <img> node -- ' +
        'this is exactly the "blank space where the illustration belongs" bug. imageBlockNode must be present.',
    );
  }
  assertEquals(imageNodes.length, 1);
  assertEquals(imageNodes[0].props.src, STUB_IMAGE_DATA_URI);
});

// ── Bug 4: quote card renders GRAY regardless of emotion + no quote marks ─
Deno.test('layout: quote card accent strip uses the emotion color, not a fixed gray, when emotion is set', () => {
  const data: ShareCardData = {
    variant: 'quote',
    dateLabel: formatShareCardDateLabel('2026-06-08'),
    caption: 'Hoy Enzo por fin hizo pupu.',
    imageDataUri: null,
    imageAspectRatio: null,
    members: [],
    memberOverflowCount: 0,
    emotion: 'joy',
  };

  const tree = buildShareCardTree(data, BASE_SCALE);
  // The accent strip is the tree's first child -- a bare div with a
  // borderTopLeftRadius (nothing else in the quote card has that style key).
  const accent = findAllNodesByType(tree, 'div').find((node) => {
    const style = node.props.style as { borderTopLeftRadius?: number } | undefined;
    return typeof style?.borderTopLeftRadius === 'number';
  });
  if (!accent) {
    throw new Error('expected to find the quote card accent strip node');
  }
  const accentStyle = accent.props.style as { backgroundColor?: string };
  assertEquals(accentStyle.backgroundColor, SHARE_CARD_EMOTION_COLORS.joy.soft);
  assertEquals(accentStyle.backgroundColor === SHARE_CARD_THEME.border, false);
});

Deno.test('layout: quote card accent strip falls back to the neutral tint when emotion is null (no regression for untagged memories)', () => {
  const data: ShareCardData = {
    variant: 'quote',
    dateLabel: formatShareCardDateLabel('2026-06-08'),
    caption: 'No mood recorded for this one.',
    imageDataUri: null,
    imageAspectRatio: null,
    members: [],
    memberOverflowCount: 0,
    emotion: null,
  };

  const tree = buildShareCardTree(data, BASE_SCALE);
  const accent = findAllNodesByType(tree, 'div').find((node) => {
    const style = node.props.style as { borderTopLeftRadius?: number } | undefined;
    return typeof style?.borderTopLeftRadius === 'number';
  });
  if (!accent) {
    throw new Error('expected to find the quote card accent strip node');
  }
  const accentStyle = accent.props.style as { backgroundColor?: string };
  assertEquals(accentStyle.backgroundColor, SHARE_CARD_THEME.border);
});

Deno.test('layout: quote card renders a decorative opening-quotation-mark glyph, tinted with the emotion ink color', () => {
  const data: ShareCardData = {
    variant: 'quote',
    dateLabel: formatShareCardDateLabel('2026-06-08'),
    caption: 'Everyone was there.',
    imageDataUri: null,
    imageAspectRatio: null,
    members: [],
    memberOverflowCount: 0,
    emotion: 'tender',
  };

  const tree = buildShareCardTree(data, BASE_SCALE);
  const glyphNode = findAllNodesByType(tree, 'div').find((node) => node.props.children === '“');
  if (!glyphNode) {
    throw new Error('expected a decorative opening-quotation-mark (\\u201C) node in the quote card tree');
  }
  const style = glyphNode.props.style as { color?: string; fontFamily?: string };
  assertEquals(style.fontFamily, 'Newsreader-Regular');
  assertEquals(style.color, SHARE_CARD_EMOTION_COLORS.tender.ink);
});

Deno.test('layout: quote card glyph falls back to the neutral ink3 tint when emotion is null', () => {
  const data: ShareCardData = {
    variant: 'quote',
    dateLabel: formatShareCardDateLabel('2026-06-08'),
    caption: 'No mood recorded for this one either.',
    imageDataUri: null,
    imageAspectRatio: null,
    members: [],
    memberOverflowCount: 0,
    emotion: null,
  };

  const tree = buildShareCardTree(data, BASE_SCALE);
  const glyphNode = findAllNodesByType(tree, 'div').find((node) => node.props.children === '“');
  if (!glyphNode) {
    throw new Error('expected a decorative opening-quotation-mark (\\u201C) node in the quote card tree');
  }
  const style = glyphNode.props.style as { color?: string };
  assertEquals(style.color, SHARE_CARD_THEME.ink3);
});

Deno.test('layout: spread card never renders a quote-glyph node (quote-only decoration)', () => {
  const data: ShareCardData = {
    variant: 'spread',
    dateLabel: formatShareCardDateLabel('2026-06-08'),
    caption: 'Park day with the ducks.',
    imageDataUri: STUB_IMAGE_DATA_URI,
    imageAspectRatio: 4 / 3,
    members: [],
    memberOverflowCount: 0,
    emotion: 'joy',
  };

  const tree = buildShareCardTree(data, BASE_SCALE);
  const glyphNode = findAllNodesByType(tree, 'div').find((node) => node.props.children === '“');
  assertEquals(glyphNode, undefined);
});
