import { assertEquals } from 'jsr:@std/assert@1';
import {
  parseSvgHeightPx,
  SHARE_CARD_FULL_WIDTH,
  SHARE_CARD_PIXEL_BUDGET,
  SHARE_CARD_REDUCED_SCALE,
  SHARE_CARD_REDUCED_WIDTH,
  shouldUseReducedScale,
} from './scale.ts';

Deno.test('SHARE_CARD_REDUCED_SCALE is exactly 720/1080', () => {
  assertEquals(SHARE_CARD_REDUCED_WIDTH / SHARE_CARD_FULL_WIDTH, SHARE_CARD_REDUCED_SCALE);
});

Deno.test('shouldUseReducedScale stays at 1080 under the pixel budget', () => {
  // 1080 * 2000 = 2,160,000 < 2,500,000
  assertEquals(shouldUseReducedScale(2000), false);
});

Deno.test('shouldUseReducedScale trips to 720 once the 1080-wide layout would exceed the pixel budget', () => {
  // 1080 * 2400 = 2,592,000 > 2,500,000
  assertEquals(shouldUseReducedScale(2400), true);
});

Deno.test('shouldUseReducedScale is exact at the boundary (budget itself does not trip)', () => {
  const exactHeight = SHARE_CARD_PIXEL_BUDGET / SHARE_CARD_FULL_WIDTH;
  assertEquals(shouldUseReducedScale(exactHeight), false);
  assertEquals(shouldUseReducedScale(exactHeight + 1), true);
});

Deno.test('shouldUseReducedScale matches the S0 spike worst-case caption (tall card trips reduced scale)', () => {
  // S0 spike measured worst-case (5000-char caption, 6 portraits, photo)
  // heights well past 2314px at 1080 width -- representative tall-card
  // height used here.
  assertEquals(shouldUseReducedScale(6000), true);
});

Deno.test('parseSvgHeightPx reads the integer height attribute from a satori SVG root', () => {
  const svg = '<svg width="1080" height="2431" viewBox="0 0 1080 2431" xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
  assertEquals(parseSvgHeightPx(svg), 2431);
});

Deno.test('parseSvgHeightPx returns null for a string with no height attribute', () => {
  assertEquals(parseSvgHeightPx('<svg><rect/></svg>'), null);
});
