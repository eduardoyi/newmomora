// Geometry of the holiday card front's app render. The expected numbers were
// computed by running book-renderer/src/card/geometry.ts (`cardGeometry`,
// `fitBoxToImage`, `coverCrop`, `ptToMm`) and the constants in document.ts
// `buildFront` for the same inputs, then shifted from page to trim coordinates
// (the app draws the trim only).
import type { KeepsakesCardFront } from '@/services/keepsakes';
import {
  buildHolidayCardFrontLayout,
  cardAspectRatio,
  defaultGreetingText,
  fitBoxToImage,
  focalToContentPosition,
  holidayCardFrontSize,
  holidayCardFrontText,
  holidayCardObjectLayout,
  holidayCardWidthToFit,
  type BorderedFrontLayout,
  type FullBleedFrontLayout,
} from '@/utils/holiday-card-front';

jest.mock('@/lib/supabase', () => ({ supabase: { rpc: jest.fn() } }));

function front(overrides: Partial<KeepsakesCardFront> = {}): KeepsakesCardFront {
  return {
    card_id: 'card-1',
    year: 2026,
    image_key: 'family/front.jpg',
    width: 4000,
    height: 3000,
    layout: 'bordered',
    orientation: 'landscape',
    focal: null,
    greeting: 'holidays',
    language: 'en',
    greeting_text: null,
    subline_text: null,
    greeting_position: 'bottom-left',
    ...overrides,
  };
}

// 177.8 px wide landscape / 127 px wide portrait = exactly 1 px per mm.
const LANDSCAPE_1PX = 177.8;
const PORTRAIT_1PX = 127;

describe('fitBoxToImage (port of geometry.ts)', () => {
  // The print area in PAGE coordinates: 8 mm margin + 4 mm bleed, 8 + 21 mm of band.
  const landscapeArea = { x: 12, y: 12, w: 161.8, h: 98 };
  const portraitArea = { x: 12, y: 12, w: 111, h: 148.8 };

  it('landscape area: 4:3, 16:9, square and portrait pictures (max crop 0.15)', () => {
    expect(fitBoxToImage(landscapeArea, 4000 / 3000, 0.15)).toEqual({ x: 16.04, y: 12, w: 153.73, h: 98 });
    expect(fitBoxToImage(landscapeArea, 1920 / 1080, 0.15)).toEqual({ x: 12, y: 12, w: 161.8, h: 98 });
    expect(fitBoxToImage(landscapeArea, 1, 0.15)).toEqual({ x: 35.25, y: 12, w: 115.29, h: 98 });
    expect(fitBoxToImage(landscapeArea, 3000 / 4000, 0.15)).toEqual({ x: 49.66, y: 12, w: 86.47, h: 98 });
  });

  it('portrait area: matching, wide and tall pictures', () => {
    expect(fitBoxToImage(portraitArea, 3000 / 4000, 0.15)).toEqual({ x: 12, y: 12, w: 111, h: 148.8 });
    expect(fitBoxToImage(portraitArea, 4000 / 3000, 0.15)).toEqual({ x: 12, y: 12, w: 111, h: 97.94 });
    expect(fitBoxToImage(portraitArea, 1000 / 2000, 0.15)).toEqual({ x: 23.74, y: 12, w: 87.53, h: 148.8 });
  });

  it('maxCrop 0 keeps the whole picture, letterboxed', () => {
    const box = fitBoxToImage(landscapeArea, 1, 0);
    expect(box.w).toBeCloseTo(98, 2);
    expect(box.h).toBeCloseTo(98, 2);
  });
});

describe('focalToContentPosition', () => {
  // geometry.ts coverCrop: draw.x = -(dw - boxW) * focal.x, so the focal is the
  // fraction of the crop slack that is cut off before the window = CSS
  // object-position, which is what expo-image's percentages mean.
  function printOffsets(imgW: number, imgH: number, boxW: number, boxH: number, focal: { x: number; y: number }) {
    const scale = Math.max(boxW / imgW, boxH / imgH);
    const dw = imgW * scale;
    const dh = imgH * scale;
    return { slackX: dw - boxW, slackY: dh - boxH, x: -(dw - boxW) * focal.x, y: -(dh - boxH) * focal.y };
  }

  it('maps the focal point 1:1 to object-position percentages', () => {
    expect(focalToContentPosition({ x: 0.3, y: 0.7 })).toEqual({ left: '30%', top: '70%' });
    expect(focalToContentPosition({ x: 0, y: 1 })).toEqual({ left: '0%', top: '100%' });
  });

  it('defaults to the centre and clamps out-of-range values', () => {
    expect(focalToContentPosition(null)).toEqual({ left: '50%', top: '50%' });
    expect(focalToContentPosition({ x: -2, y: 9 })).toEqual({ left: '0%', top: '100%' });
  });

  it('agrees with the print crop: a 4:3 picture in the landscape bordered box loses 15% of its height', () => {
    const offsets = printOffsets(4000, 3000, 153.73, 98, { x: 0.3, y: 0.7 });
    expect(offsets.slackX).toBeCloseTo(0, 6);
    expect(offsets.slackY).toBeCloseTo(17.3, 1);
    // draw.y = -12.11 in the print file (0.7 of the slack).
    expect(offsets.y).toBeCloseTo(-12.11, 2);
    expect(offsets.y / -offsets.slackY).toBeCloseTo(0.7, 6);
  });
});

describe('holidayCardFrontText', () => {
  it('defaults: the language greeting and the year', () => {
    expect(holidayCardFrontText(front())).toEqual({ greeting: 'Happy Holidays', subline: '2026' });
    expect(holidayCardFrontText(front({ language: 'es', greeting: 'christmas' }))).toEqual({
      greeting: 'Feliz Navidad',
      subline: '2026',
    });
    expect(holidayCardFrontText(front({ language: 'es', greeting: 'new-year' })).greeting).toBe('Feliz Año Nuevo');
  });

  it('uses the edited texts; an empty subline is hidden', () => {
    expect(holidayCardFrontText(front({ greeting_text: 'Con cariño', subline_text: 'Los Pérez' }))).toEqual({
      greeting: 'Con cariño',
      subline: 'Los Pérez',
    });
    expect(holidayCardFrontText(front({ subline_text: '' })).subline).toBeNull();
    expect(holidayCardFrontText(front({ subline_text: '   ' })).subline).toBeNull();
  });

  it('a blank greeting falls back to the default', () => {
    expect(holidayCardFrontText(front({ greeting_text: ' ' })).greeting).toBe('Happy Holidays');
  });

  it('defaultGreetingText mirrors greetings.ts', () => {
    expect(defaultGreetingText('en', 'holidays')).toBe('Happy Holidays');
    expect(defaultGreetingText('es', 'holidays')).toBe('Felices fiestas');
  });
});

describe('holidayCardFrontSize', () => {
  it('follows the trim aspect (5R: 177.8 x 127 mm)', () => {
    expect(cardAspectRatio('portrait')).toBeCloseTo(1.4, 6);
    expect(cardAspectRatio('landscape')).toBeCloseTo(0.714286, 5);
    expect(holidayCardFrontSize({ orientation: 'portrait' }, 100)).toEqual({ width: 100, height: 140 });
    expect(holidayCardFrontSize({ orientation: 'landscape' }, 150)).toEqual({ width: 150, height: 107 });
    expect(holidayCardFrontSize({ orientation: 'portrait' }, 104)).toEqual({ width: 104, height: 146 });
  });
});

describe('buildHolidayCardFrontLayout: full-bleed', () => {
  it('landscape, 1 px per mm: 27pt greeting, 7pt subline, 12 mm margin, 2 mm gap, 52.7 mm scrim', () => {
    const layout = buildHolidayCardFrontLayout(
      front({ layout: 'full-bleed', greeting_position: 'top-right' }),
      LANDSCAPE_1PX,
    ) as FullBleedFrontLayout;
    expect(layout.kind).toBe('full-bleed');
    expect(layout.scale).toBeCloseTo(1, 9);
    expect({ w: layout.width, h: layout.height }).toEqual({ w: 177.8, h: 127 });
    expect(layout.image).toEqual({ x: 0, y: 0, w: 177.8, h: 127 });
    // ptToMm(27) = 9.525; x1.15 line; ptToMm(7) = 2.4694; x1.2 line; 0.32em spacing.
    expect(layout.text.greetingFontPx).toBeCloseTo(9.525, 3);
    expect(layout.text.greetingLinePx).toBeCloseTo(10.954, 3);
    expect(layout.text.sublineFontPx).toBeCloseTo(2.4694, 4);
    expect(layout.text.sublineLinePx).toBeCloseTo(2.9633, 4);
    expect(layout.text.sublineSpacingPx).toBeCloseTo(0.7902, 4);
    expect(layout.marginPx).toBe(12);
    expect(layout.gapPx).toBe(2);
    expect(layout.edge).toBe('top');
    expect(layout.align).toBe('right');
    // 42% of the 135 mm page minus the 4 mm of it that is bleed.
    expect(layout.scrim.edge).toBe('top');
    expect(layout.scrim.heightPx).toBeCloseTo(52.7, 6);
  });

  it('portrait uses a 24pt greeting and a taller scrim; bottom-center sits on the bottom margin', () => {
    const layout = buildHolidayCardFrontLayout(
      front({ layout: 'full-bleed', orientation: 'portrait', greeting_position: 'bottom-center' }),
      PORTRAIT_1PX,
    ) as FullBleedFrontLayout;
    expect(layout.text.greetingFontPx).toBeCloseTo(8.4667, 4);
    expect(layout.edge).toBe('bottom');
    expect(layout.align).toBe('center');
    expect(layout.scrim.edge).toBe('bottom');
    // 42% of the 185.8 mm page minus the bleed.
    expect(layout.scrim.heightPx).toBeCloseTo(74.036, 3);
  });

  it('scales every millimetre by width / trim width and has no gap without a subline', () => {
    const layout = buildHolidayCardFrontLayout(
      front({ layout: 'full-bleed', subline_text: '' }),
      LANDSCAPE_1PX * 2,
    ) as FullBleedFrontLayout;
    expect(layout.scale).toBeCloseTo(2, 9);
    expect(layout.marginPx).toBe(24);
    expect(layout.gapPx).toBe(0);
    expect(layout.subline).toBeNull();
  });
});

describe('buildHolidayCardFrontLayout: bordered', () => {
  it('landscape 4:3 picture: box 153.73 x 98 mm at (12.04, 8), 20pt text, 4 mm gap, 8.5 mm from the bottom', () => {
    const layout = buildHolidayCardFrontLayout(front(), LANDSCAPE_1PX) as BorderedFrontLayout;
    expect(layout.kind).toBe('bordered');
    expect(layout.imageMm).toEqual({ x: 12.04, y: 8, w: 153.73, h: 98 });
    expect(layout.image).toEqual(layout.imageMm); // 1 px per mm
    expect(layout.text.greetingFontPx).toBeCloseTo(7.0556, 4);
    expect(layout.text.greetingLinePx).toBeCloseTo(8.1139, 4);
    expect(layout.rowBottomPx).toBe(8.5);
    expect(layout.rowHeightPx).toBeCloseTo(8.1139, 4);
    expect(layout.gapPx).toBe(4);
  });

  it('landscape 16:9 fills the area; a square picture is narrowed; a portrait picture narrower still', () => {
    expect((buildHolidayCardFrontLayout(front({ width: 1920, height: 1080 }), LANDSCAPE_1PX) as BorderedFrontLayout).imageMm).toEqual({
      x: 8, y: 8, w: 161.8, h: 98,
    });
    expect((buildHolidayCardFrontLayout(front({ width: 1000, height: 1000 }), LANDSCAPE_1PX) as BorderedFrontLayout).imageMm).toEqual({
      x: 31.25, y: 8, w: 115.29, h: 98,
    });
    expect((buildHolidayCardFrontLayout(front({ width: 3000, height: 4000 }), LANDSCAPE_1PX) as BorderedFrontLayout).imageMm).toEqual({
      x: 45.66, y: 8, w: 86.47, h: 98,
    });
  });

  it('portrait card: 21pt text; matching, wide and tall pictures', () => {
    const portrait = (w: number, h: number) =>
      buildHolidayCardFrontLayout(front({ orientation: 'portrait', width: w, height: h }), PORTRAIT_1PX) as BorderedFrontLayout;
    expect(portrait(3000, 4000).imageMm).toEqual({ x: 8, y: 8, w: 111, h: 148.8 });
    expect(portrait(4000, 3000).imageMm).toEqual({ x: 8, y: 8, w: 111, h: 97.94 });
    expect(portrait(1000, 2000).imageMm).toEqual({ x: 19.74, y: 8, w: 87.53, h: 148.8 });
    expect(portrait(3000, 4000).text.greetingFontPx).toBeCloseTo(7.4083, 4);
  });

  it('an unknown picture size assumes the card orientation’s own aspect', () => {
    const landscape = buildHolidayCardFrontLayout(front({ width: null, height: null }), LANDSCAPE_1PX) as BorderedFrontLayout;
    expect(landscape.imageMm).toEqual({ x: 8.19, y: 8, w: 161.41, h: 98 });
    const portrait = buildHolidayCardFrontLayout(
      front({ orientation: 'portrait', width: null, height: null }),
      PORTRAIT_1PX,
    ) as BorderedFrontLayout;
    expect(portrait.imageMm).toEqual({ x: 8, y: 8, w: 111, h: 148.8 });
  });

  it('no subline: no gap', () => {
    const layout = buildHolidayCardFrontLayout(front({ subline_text: '' }), LANDSCAPE_1PX) as BorderedFrontLayout;
    expect(layout.gapPx).toBe(0);
    expect(layout.subline).toBeNull();
  });
});

describe('holidayCardObjectLayout', () => {
  it('portrait 5:7 keeps the old object: 1.27 x 1.54 of the card width', () => {
    expect(holidayCardObjectLayout(100, 140)).toEqual({
      outer: { width: 127, height: 154 },
      card: { left: 0, top: 14, width: 100, height: 140 },
      envelope: { left: 27, top: 0, width: 100, height: 115 },
    });
  });

  it('landscape peeks by the card’s shorter side', () => {
    const layout = holidayCardObjectLayout(150, 107);
    expect(layout.outer).toEqual({ width: 179, height: 122 });
    expect(layout.card).toEqual({ left: 0, top: 15, width: 150, height: 107 });
    expect(layout.envelope).toEqual({ left: 29, top: 0, width: 150, height: 88 });
  });
});

describe('holidayCardWidthToFit', () => {
  it.each(['portrait', 'landscape'] as const)('the widest %s object that fits, and one px more would not', (orientation) => {
    const maxWidth = 208;
    const maxHeight = 166;
    const width = holidayCardWidthToFit(orientation, maxWidth, maxHeight);
    const aspect = cardAspectRatio(orientation);
    const fits = (w: number) => {
      const { outer } = holidayCardObjectLayout(w, Math.round(w * aspect));
      return outer.width <= maxWidth && outer.height <= maxHeight;
    };
    expect(fits(width)).toBe(true);
    expect(fits(width + 1)).toBe(false);
  });

  it('is height-bound for portrait and width-bound for landscape in the storefront tile', () => {
    expect(holidayCardWidthToFit('portrait', 208, 166)).toBe(108);
    expect(holidayCardWidthToFit('landscape', 208, 166)).toBe(174);
  });
});
