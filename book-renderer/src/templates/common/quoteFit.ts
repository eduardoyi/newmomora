/**
 * Type sizing for the text-only "things you said" pages (QuoteCollection +
 * the TextPage pull quote). Pure and deterministic — the same estimate is used
 * by preview and print (single-renderer rule), so a quote can never be sized
 * differently on screen than on paper.
 *
 * Each quote starts at a size picked by its length (short lines get the big
 * editorial size, long ones step down), then every size on the page/spread is
 * scaled by one common factor until the stack fits the available height — so
 * hierarchy between quotes survives while nothing can overflow. The line
 * estimate is deliberately conservative (wide average glyph, extra wrap
 * slack): over-estimating only costs a half point of type, under-estimating
 * would overflow the page.
 */

const MM_PER_PT = 25.4 / 72;
/** Newsreader average advance, in em, with a margin for wide capitals/punctuation. */
const AVG_CHAR_EM = 0.4;
/** Ragged-right wrap slack: a line never fills to the last mm. */
const WRAP_SLACK = 1.04;

/** Starting size (pt) for a quote of `length` characters. */
export function baseQuotePt(length: number): number {
  if (length <= 45) return 32;
  if (length <= 80) return 29;
  if (length <= 120) return 26;
  if (length <= 170) return 23;
  if (length <= 230) return 20;
  return 18;
}

/** Estimated wrapped line count; an explicit newline (a dialogue turn) always starts a new line. */
export function estimateLines(text: string, sizePt: number, widthMm: number): number {
  const charsPerLine = Math.max(1, (widthMm / MM_PER_PT) / (AVG_CHAR_EM * sizePt * WRAP_SLACK));
  return text.split('\n').reduce((sum, part) => sum + Math.max(1, Math.ceil(part.length / charsPerLine)), 0);
}

export interface QuoteStackSpec {
  /** The quotes stacked in one column, in order. */
  texts: string[];
}

export interface QuoteFitOptions {
  /** Text measure (mm). */
  widthMm: number;
  /** Height (mm) available to one column's quote stack. */
  heightMm: number;
  /** Line-height multiplier applied to the quote text. */
  lineHeight: number;
  /** Fixed height (mm) of everything in an entry that is not the text (glyph + date row). */
  chromeMm: number;
  /** Minimum breathing room (mm) between neighbouring entries / the stack edges. */
  minGapMm: number;
  minPt: number;
}

/** Per-column sizes (pt), one common shrink factor across every column. */
export function fitQuoteColumns(columns: QuoteStackSpec[], o: QuoteFitOptions): number[][] {
  const sizesAt = (scale: number): number[][] =>
    columns.map((c) => c.texts.map((t) => Math.max(o.minPt, Math.round(baseQuotePt(t.length) * scale * 2) / 2)));
  const heightOf = (texts: string[], sizes: number[]): number =>
    texts.reduce((sum, t, i) => sum + o.chromeMm + estimateLines(t, sizes[i], o.widthMm) * sizes[i] * o.lineHeight * MM_PER_PT, 0) +
    (texts.length + 1) * o.minGapMm;
  let scale = 1;
  for (let guard = 0; guard < 40; guard += 1) {
    const sizes = sizesAt(scale);
    const fits = columns.every((c, i) => heightOf(c.texts, sizes[i]) <= o.heightMm);
    const atFloor = sizes.every((col) => col.every((s) => s <= o.minPt));
    if (fits || atFloor) return sizes;
    scale *= 0.95;
  }
  return sizesAt(scale);
}
