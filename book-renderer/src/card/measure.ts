import { EXPECTED_PRINT_FACES } from '../print/fonts/expectedFaces';
import { assertPrintFontsLoaded } from '../print/fonts/expectedFaces';
import { DEFAULT_CARD_FONTS, type CardFontFamilies } from './fonts';
import { PT_TO_MM } from './geometry';
import type { FontSpec, MeasureFn } from './textFit';

/**
 * Browser text measurement for the card fit: canvas `measureText` at a 200 px
 * reference size, scaled linearly to the requested point size. Needs the
 * vendored faces loaded first (`ensureCardFonts`), otherwise the canvas would
 * measure a fallback font and the fit would be wrong.
 */
let canvas: HTMLCanvasElement | null = null;

const REF_PX = 200;

/** The canvas `font` string for a spec, with the family mapped through the injected names (default = the spec's own). */
export function canvasFontString(font: FontSpec, families: CardFontFamilies = DEFAULT_CARD_FONTS): string {
  return `${font.style} ${font.weight} ${REF_PX}px "${families[font.family]}"`;
}

/** The slice of a 2d context the measure needs (a test can pass a stub). */
export interface MeasureContext {
  font: string;
  measureText(text: string): { width: number };
}

export function createCanvasMeasure(families: CardFontFamilies = DEFAULT_CARD_FONTS, context?: MeasureContext): MeasureFn {
  const ctx = context ?? (canvas ??= document.createElement('canvas')).getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  const cache = new Map<string, number>();
  return (text: string, font: FontSpec, sizePt: number) => {
    const key = `${font.family}|${font.weight}|${font.style}|${text}`;
    let width = cache.get(key);
    if (width === undefined) {
      ctx.font = canvasFontString(font, families);
      width = ctx.measureText(text).width;
      cache.set(key, width);
    }
    // canvas px at REF_PX -> em -> pt -> mm
    return (width / REF_PX) * sizePt * PT_TO_MM;
  };
}

/** Loads every vendored face (same hard-fail check as the book print pipeline). */
export async function ensureCardFonts(): Promise<void> {
  await assertPrintFontsLoaded();
  // Force the exact faces the card uses through the canvas path too.
  await Promise.all(EXPECTED_PRINT_FACES.map((f) => document.fonts.load(`${f.style} ${f.weight} 20px "${f.family}"`, 'Aa Ññ¡')));
}
