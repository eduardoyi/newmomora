import { describe, expect, it } from 'vitest';
import { CARD_STYLE } from '../../../card/document';
import { cardFontStacks, DEFAULT_CARD_FONTS } from '../../../card/fonts';
import { canvasFontString, createCanvasMeasure, type MeasureContext } from '../../../card/measure';
import { EXPECTED_PRINT_FACES } from '../../../print/fonts/expectedFaces';
import { cardFaceDescriptors, isAliasedFamilySet, SHOP_CARD_FONTS } from '../cardFonts';

describe('shop card fonts (aliased, no leakage)', () => {
  it('uses the three MomoraCard aliases, none equal to a book-page family', () => {
    expect(SHOP_CARD_FONTS).toEqual({
      Newsreader: 'MomoraCard Newsreader',
      'Plus Jakarta Sans': 'MomoraCard Plus Jakarta Sans',
      Caveat: 'MomoraCard Caveat',
    });
    expect(isAliasedFamilySet(SHOP_CARD_FONTS)).toBe(true);
    expect(isAliasedFamilySet(DEFAULT_CARD_FONTS)).toBe(false);
  });

  it('registers every vendored print face under an alias, and only under an alias', () => {
    const faces = cardFaceDescriptors(SHOP_CARD_FONTS);
    // Both subsets, like the print page: a rare character must not fall back to a system font in the editor only.
    expect(faces).toHaveLength(EXPECTED_PRINT_FACES.length * 2);
    for (const face of EXPECTED_PRINT_FACES) {
      const alias = SHOP_CARD_FONTS[face.family];
      const mine = faces.filter((f) => f.family === alias && f.weight === face.weight && f.style === face.style);
      expect(mine.map((f) => f.subset).sort()).toEqual(['latin', 'latin-ext']);
      expect(new Set(mine.map((f) => f.url)).size).toBe(2);
      expect(mine.find((f) => f.subset === 'latin-ext')!.url).toContain('latin-ext');
    }
    const registered = new Set(faces.map((f) => f.family));
    expect(registered).toEqual(new Set(Object.values(SHOP_CARD_FONTS)));
    for (const face of faces) {
      expect(Object.values(DEFAULT_CARD_FONTS)).not.toContain(face.family);
      expect(face.url).toMatch(/\.woff2$/);
    }
  });

  it('every font the card measures with is registered under the exact alias the measurement uses', () => {
    const faces = cardFaceDescriptors(SHOP_CARD_FONTS);
    for (const [name, font] of Object.entries(CARD_STYLE.fonts)) {
      const alias = SHOP_CARD_FONTS[font.family];
      expect(canvasFontString(font, SHOP_CARD_FONTS), name).toContain(`"${alias}"`);
      expect(faces.some((f) => f.family === alias && f.weight === font.weight && f.style === font.style), `${name} ${font.family} ${font.weight} ${font.style}`).toBe(true);
    }
  });

  it('the canvas measure sets exactly the registered aliases (and the defaults stay the print names)', () => {
    const seen: string[] = [];
    const ctx: MeasureContext = {
      set font(v: string) {
        seen.push(v);
      },
      get font() {
        return seen[seen.length - 1] ?? '';
      },
      measureText: (t: string) => ({ width: t.length * 100 }),
    };
    const measure = createCanvasMeasure(SHOP_CARD_FONTS, ctx);
    for (const font of Object.values(CARD_STYLE.fonts)) measure('Feliz Navidad', font, 12);
    const families = new Set(seen.map((s) => /"([^"]+)"/.exec(s)![1]));
    expect(families).toEqual(new Set(Object.values(SHOP_CARD_FONTS)));

    seen.length = 0;
    const printMeasure = createCanvasMeasure(undefined, ctx);
    printMeasure('Feliz Navidad', CARD_STYLE.fonts.letter, 12);
    expect(seen[0]).toBe('normal 400 200px "Newsreader"');
  });

  it('the rendered CSS stacks use the same aliases; the defaults are today\'s strings exactly', () => {
    const shop = cardFontStacks(SHOP_CARD_FONTS);
    expect(shop.serif).toContain("'MomoraCard Newsreader'");
    expect(shop.sans).toContain("'MomoraCard Plus Jakarta Sans'");
    expect(shop.script).toContain("'MomoraCard Caveat'");
    expect(cardFontStacks()).toEqual({
      serif: "'Newsreader', Georgia, serif",
      sans: "'Plus Jakarta Sans', -apple-system, sans-serif",
      script: "'Caveat', cursive",
    });
  });
});
