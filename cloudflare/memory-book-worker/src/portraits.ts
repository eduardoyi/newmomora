/**
 * Portrait sampling for multi-year ("everything") books --
 * docs/plans/memory-book-everything-phase2.md §2.5 (D4). Pure and
 * deterministic: no env, no IO, no clock. Not yet wired into manifest.ts
 * (WP-B1 calls it after the portraits loop, gated on
 * `context.book.scopeKind === 'everything'`; year-book scopes are untouched).
 *
 * A multi-year child can have 17+ portrait versions; the ThroughTheYears
 * spread shows at most `PORTRAIT_MAX` (partitioned into <= 2 spreads by the
 * renderer). The sample is evenly spread in TIME, always includes the first
 * and the last portrait (the last is also used on the cover), and is returned
 * sorted by date. The input shape is generic: anything with a `date`
 * (`YYYY-MM-DD`) works, so the manifest's `ManifestPortrait` passes straight
 * through and the result keeps the same element type.
 */

/** One sampled portrait per this many months of span. */
export const PORTRAIT_MONTHS_PER_SAMPLE = 6;

/** Hard cap on sampled portraits (renders as two spreads of three). */
export const PORTRAIT_MAX = 6;

export interface DatedPortrait {
  /** `YYYY-MM-DD` (an ISO timestamp also works: only the first 10 chars are read). */
  date: string;
}

const MS_PER_DAY = 86_400_000;

function dayNumber(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) throw new Error(`samplePortraitsForMultiYear: unexpected date "${date}"`);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / MS_PER_DAY;
}

function monthIndex(date: string): number {
  const match = /^(\d{4})-(\d{2})/.exec(date);
  if (!match) throw new Error(`samplePortraitsForMultiYear: unexpected date "${date}"`);
  return Number(match[1]) * 12 + Number(match[2]) - 1;
}

/** `min(PORTRAIT_MAX, max(1, ceil(spanMonths / PORTRAIT_MONTHS_PER_SAMPLE)))`. */
export function portraitSampleSize(spanMonths: number): number {
  return Math.min(PORTRAIT_MAX, Math.max(1, Math.ceil(spanMonths / PORTRAIT_MONTHS_PER_SAMPLE)));
}

/**
 * Samples a multi-year child's portraits for the ThroughTheYears spread.
 *
 * - Sort by date (stable: same-date portraits keep their input order).
 * - `n = portraitSampleSize(spanMonths)`, where `spanMonths` is the calendar
 *   month difference between the first and last portrait.
 * - If there are <= n portraits, keep them all.
 * - Otherwise ALWAYS keep the first and the last, then fill the remaining
 *   slots with targets evenly spaced in time between them, each taking the
 *   nearest still-unused portrait (equidistant -> the earlier one).
 *
 * Deliberate reading of the spec's two invariants: when `n` computes to 1
 * (span <= 6 months) but there are several portraits, "always keep first and
 * last" wins, so the sample is `max(n, 2)` -- first and last only. Never more
 * than `PORTRAIT_MAX`, never a duplicate, always date-sorted. Does not
 * mutate its input.
 */
export function samplePortraitsForMultiYear<T extends DatedPortrait>(portraits: readonly T[]): T[] {
  const sorted = portraits
    .map((portrait, index) => ({ portrait, index }))
    .sort((a, b) => a.portrait.date.localeCompare(b.portrait.date) || a.index - b.index)
    .map((entry) => entry.portrait);

  if (sorted.length <= 1) return sorted;

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const spanMonths = monthIndex(last.date) - monthIndex(first.date);
  const n = portraitSampleSize(spanMonths);
  if (sorted.length <= n) return sorted;

  const keepCount = Math.max(n, 2);
  const used = new Set<number>([0, sorted.length - 1]);
  const firstDay = dayNumber(first.date);
  const lastDay = dayNumber(last.date);
  const days = sorted.map((p) => dayNumber(p.date));

  for (let i = 1; i < keepCount - 1; i++) {
    const target = firstDay + ((lastDay - firstDay) * i) / (keepCount - 1);
    let best = -1;
    let bestDistance = Infinity;
    for (let j = 1; j < sorted.length - 1; j++) {
      if (used.has(j)) continue;
      const distance = Math.abs(days[j] - target);
      if (distance < bestDistance) {
        best = j;
        bestDistance = distance;
      }
    }
    if (best === -1) break;
    used.add(best);
  }

  return [...used].sort((a, b) => a - b).map((index) => sorted[index]);
}
