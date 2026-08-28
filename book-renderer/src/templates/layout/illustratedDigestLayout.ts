import { DIGEST_ROW_GAP_MM, digestRowMetrics } from '../mm';

/**
 * Deterministic geometry for `illustrated-digest` (round-12: promotes the
 * preview demo composition to a real fitter-emitted one). Pure functions —
 * no DOM — shared by `templates/IllustratedDigest.tsx` (the render) and
 * `model/audit.ts`'s own regression check, so the two can never disagree
 * about where a row actually lands.
 */

export interface DigestLayoutEntry {
  text: string;
  illustrationAspect: number;
}

export interface DigestRowRect {
  topMm: number;
  heightMm: number;
}

export interface DigestColumnLayout {
  rows: DigestRowRect[];
  /** The column's own total content height (last row's bottom edge) — 0 for an empty column. */
  totalHeightMm: number;
}

/**
 * Splits a digest SPREAD's entries into its two page-columns — the SAME
 * split `IllustratedDigest.tsx` renders with and the audit recomputes from
 * (left page gets the first, larger-or-equal half; the right page gets the
 * rest — mirrors `partitionPortraits`/`partitionQuoteRun`'s own "first half
 * gets any remainder" convention). Only meaningful for the spread variant
 * (always exactly 4 entries -> 2+2); a SINGLE-page digest never calls this
 * directly — see `digestColumnsForPage`.
 */
export function splitDigestColumns<T>(entries: readonly T[]): [T[], T[]] {
  const half = Math.ceil(entries.length / 2);
  return [entries.slice(0, half), entries.slice(half)];
}

/**
 * Owner round-12 extension: the ONE function that decides how a digest
 * page's entries map to columns for EITHER basis — a SPREAD (isSpread
 * true) splits 2-per-page via `splitDigestColumns`; a SINGLE page
 * (isSpread false) is just one page, so all of its entries (always exactly
 * 2) sit in ONE column. `IllustratedDigest.tsx` and `audit.ts`'s
 * illustrated-digest check both call this instead of duplicating the
 * branch, so the two can never disagree about column shape.
 */
export function digestColumnsForPage<T>(entries: readonly T[], isSpread: boolean): T[][] {
  return isSpread ? splitDigestColumns(entries) : [Array.from(entries)];
}

/**
 * Packs one column's rows top-down, each sized by `digestRowMetrics` (the
 * illustration's own fixed-width height, or the text block's estimated
 * height, whichever is taller), separated by `DIGEST_ROW_GAP_MM`. Pure
 * function: same input always produces the same rects.
 */
export function layoutDigestColumn(entries: readonly DigestLayoutEntry[], columnWidthMm: number): DigestColumnLayout {
  let top = 0;
  const rows: DigestRowRect[] = entries.map((entry) => {
    const { rowHeightMm } = digestRowMetrics(entry.text.length, entry.illustrationAspect, columnWidthMm);
    const row: DigestRowRect = { topMm: top, heightMm: rowHeightMm };
    top += rowHeightMm + DIGEST_ROW_GAP_MM;
    return row;
  });
  return { rows, totalHeightMm: rows.length > 0 ? top - DIGEST_ROW_GAP_MM : 0 };
}
