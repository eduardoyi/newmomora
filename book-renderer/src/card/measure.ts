import { EXPECTED_PRINT_FACES } from '../print/fonts/expectedFaces';
import { assertPrintFontsLoaded } from '../print/fonts/expectedFaces';
import { PT_TO_MM } from './geometry';
import type { FontSpec, MeasureFn } from './textFit';

/**
 * Browser text measurement for the card fit: canvas `measureText` at a 200 px
 * reference size, scaled linearly to the requested point size. Needs the
 * vendored faces loaded first (`ensureCardFonts`), otherwise the canvas would
 * measure a fallback font and the fit would be wrong.
 */
let canvas: HTMLCanvasElement | null = null;

export function createCanvasMeasure(): MeasureFn {
  const ctx = (canvas ??= document.createElement('canvas')).getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  const REF_PX = 200;
  const cache = new Map<string, number>();
  return (text: string, font: FontSpec, sizePt: number) => {
    const key = `${font.family}|${font.weight}|${font.style}|${text}`;
    let width = cache.get(key);
    if (width === undefined) {
      ctx.font = `${font.style} ${font.weight} ${REF_PX}px "${font.family}"`;
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
