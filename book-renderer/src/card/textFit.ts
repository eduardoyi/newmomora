import { ptToMm } from './geometry';

/**
 * Pure text fitting for the card (no DOM): greedy word wrap against an injected
 * width function, a balanced re-wrap for a nicer rag, and the letter auto-fit
 * (largest font size in [minPt, maxPt] whose text fits a box). The browser
 * supplies a canvas-based `MeasureFn` (see `measure.ts`); tests supply a stub.
 * Lines are rendered explicitly by the components, so the browser never
 * re-wraps: preview, print and these numbers agree.
 */

export interface FontSpec {
  family: 'Newsreader' | 'Plus Jakarta Sans' | 'Caveat';
  weight: 300 | 400 | 500 | 600 | 700;
  style: 'normal' | 'italic';
}

/** Width in mm of `text` set in `font` at `sizePt`. */
export type MeasureFn = (text: string, font: FontSpec, sizePt: number) => number;

/** Greedy word wrap at `maxWidthMm`. A single word wider than the box stays on its own line. */
export function wrapLines(text: string, font: FontSpec, sizePt: number, maxWidthMm: number, measure: MeasureFn): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && measure(candidate, font, sizePt) > maxWidthMm) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Wraps greedily; when the last line is short (under 45% of the measure) it
 * narrows the measure as far as it can go without adding a line: the same
 * number of lines with an even rag and no one-word last line.
 */
export function wrapBalanced(text: string, font: FontSpec, sizePt: number, maxWidthMm: number, measure: MeasureFn): string[] {
  const greedy = wrapLines(text, font, sizePt, maxWidthMm, measure);
  if (greedy.length < 2) return greedy;
  // A full-looking last line needs no help: only fix a short (widow-like) one.
  if (measure(greedy[greedy.length - 1], font, sizePt) >= maxWidthMm * 0.45) return greedy;
  let lo = maxWidthMm * 0.55;
  let hi = maxWidthMm;
  let best = greedy;
  for (let i = 0; i < 14; i += 1) {
    const mid = (lo + hi) / 2;
    const lines = wrapLines(text, font, sizePt, mid, measure);
    if (lines.length <= greedy.length) {
      best = lines;
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return best;
}

/** Paragraphs of a letter: blank-line separated, inner newlines collapsed to spaces. */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);
}

export interface LetterFitInput {
  text: string;
  font: FontSpec;
  /** Width of the text column, mm. */
  widthMm: number;
  /** Height available to the letter body only, mm. */
  heightMm: number;
  minPt: number;
  maxPt: number;
  /** Line height as a multiple of the font size. */
  lineHeight: number;
  /** Gap between paragraphs as a multiple of the line height. */
  paragraphGap: number;
  measure: MeasureFn;
  /** Font-size search step, pt. */
  stepPt?: number;
}

export interface LetterFit {
  fontPt: number;
  lineHeightMm: number;
  paragraphGapMm: number;
  /** Lines per paragraph. */
  paragraphs: string[][];
  lineCount: number;
  /** Height the text occupies at `fontPt`, mm. */
  heightMm: number;
  /** False when even `minPt` does not fit (the text overflows at `minPt`). */
  fits: boolean;
  /** True when the text could grow past `maxPt` (there is free space left). */
  cappedByMax: boolean;
}

/** Layout of the letter at one font size. */
export function layoutLetter(input: LetterFitInput, fontPt: number): LetterFit & { fits: boolean } {
  const paragraphs = splitParagraphs(input.text).map((p) => wrapBalanced(p, input.font, fontPt, input.widthMm, input.measure));
  const lineCount = paragraphs.reduce((n, p) => n + p.length, 0);
  const lineHeightMm = ptToMm(fontPt) * input.lineHeight;
  const paragraphGapMm = lineHeightMm * input.paragraphGap;
  const heightMm = lineCount * lineHeightMm + Math.max(0, paragraphs.length - 1) * paragraphGapMm;
  return {
    fontPt,
    lineHeightMm,
    paragraphGapMm,
    paragraphs,
    lineCount,
    heightMm,
    fits: heightMm <= input.heightMm + 1e-6,
    cappedByMax: false,
  };
}

/**
 * The largest font size in [minPt, maxPt] (step 0.25 pt by default) at which
 * the letter fits `heightMm`. If even `minPt` overflows, returns the `minPt`
 * layout with `fits: false` so the caller can refuse to print it (never
 * silently shrinks below the readable minimum).
 */
export function fitLetter(input: LetterFitInput): LetterFit {
  const step = input.stepPt ?? 0.25;
  const steps = Math.floor((input.maxPt - input.minPt) / step + 1e-9);
  for (let i = steps; i >= 0; i -= 1) {
    const pt = round2(input.minPt + i * step);
    const layout = layoutLetter(input, pt);
    if (layout.fits) return { ...layout, cappedByMax: i === steps };
  }
  return { ...layoutLetter(input, input.minPt), fits: false, cappedByMax: false };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
