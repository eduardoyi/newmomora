import { describe, expect, it } from 'vitest';
import {
  PORTRAIT_MAX,
  PORTRAIT_MONTHS_PER_SAMPLE,
  portraitSampleSize,
  samplePortraitsForMultiYear,
} from '../src/portraits';

interface P {
  file: string;
  sourceFile: string;
  date: string;
  ageLabel: string;
}

function portrait(date: string, file = `portrait-${date}.png`): P {
  return { file, sourceFile: `src-${file}`, date, ageLabel: `age@${date}` };
}

describe('portraitSampleSize', () => {
  it('constants and the min(6, max(1, ceil(span/6))) rule', () => {
    expect(PORTRAIT_MONTHS_PER_SAMPLE).toBe(6);
    expect(PORTRAIT_MAX).toBe(6);
    expect(portraitSampleSize(0)).toBe(1);
    expect(portraitSampleSize(6)).toBe(1);
    expect(portraitSampleSize(7)).toBe(2);
    expect(portraitSampleSize(24)).toBe(4);
    expect(portraitSampleSize(36)).toBe(6);
    expect(portraitSampleSize(47)).toBe(6);
    expect(portraitSampleSize(240)).toBe(6);
  });
});

describe('samplePortraitsForMultiYear', () => {
  it('17 portraits over ~47 months -> 6, date-sorted, first and last kept, no duplicates', () => {
    // Shuffled input: roughly every 2.8 months from 2022-11-05 to 2026-10-20.
    const dates: string[] = [];
    for (let i = 0; i < 17; i++) {
      const monthOffset = Math.round((i * 47) / 16);
      const total = 2022 * 12 + 10 + monthOffset; // Nov 2022 + offset (0-based month 10)
      const year = Math.floor(total / 12);
      const month = (total % 12) + 1;
      dates.push(`${year}-${String(month).padStart(2, '0')}-${String(5 + (i % 15)).padStart(2, '0')}`);
    }
    // Unsorted input: odd indices first, then even indices reversed.
    const shuffled = [...dates.filter((_, i) => i % 2 === 1), ...dates.filter((_, i) => i % 2 === 0).reverse()];
    const input = shuffled.map((d, i) => portrait(d, `f${i}.png`));
    const sortedDates = [...dates].sort();

    const sampled = samplePortraitsForMultiYear(input);
    expect(sampled).toHaveLength(6);
    const sampledDates = sampled.map((p) => p.date);
    expect(sampledDates).toEqual([...sampledDates].sort());
    expect(sampledDates[0]).toBe(sortedDates[0]);
    expect(sampledDates[5]).toBe(sortedDates[sortedDates.length - 1]);
    expect(new Set(sampled.map((p) => p.file)).size).toBe(6);
    // Elements are the SAME objects (manifest shape preserved untouched).
    for (const p of sampled) expect(input).toContain(p);
  });

  it('spreads the middle picks across time (not clustered at one end)', () => {
    // 17 monthly-ish portraits clustered early + a long tail: dense Jan-Jun 2023, sparse after.
    const dates = [
      '2023-01-01', '2023-01-15', '2023-02-01', '2023-02-15', '2023-03-01', '2023-03-15',
      '2023-04-01', '2023-04-15', '2023-05-01', '2023-05-15', '2023-06-01', '2023-06-15',
      '2024-03-01', '2025-01-01', '2025-09-01', '2026-03-01', '2026-10-01',
    ];
    const sampled = samplePortraitsForMultiYear(dates.map((d) => portrait(d)));
    expect(sampled).toHaveLength(6);
    expect(sampled[0].date).toBe('2023-01-01');
    expect(sampled[5].date).toBe('2026-10-01');
    // At least two of the four middle picks come from the sparse tail (after 2023).
    const tailPicks = sampled.slice(1, 5).filter((p) => p.date > '2023-12-31');
    expect(tailPicks.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps all portraits when there are no more than n', () => {
    const input = [portrait('2023-01-01'), portrait('2024-01-01'), portrait('2025-01-01')]; // span 24 -> n=4
    const sampled = samplePortraitsForMultiYear(input);
    expect(sampled.map((p) => p.date)).toEqual(['2023-01-01', '2024-01-01', '2025-01-01']);
  });

  it('fewer than n still returns them date-sorted', () => {
    const sampled = samplePortraitsForMultiYear([portrait('2025-01-01'), portrait('2023-01-01')]);
    expect(sampled.map((p) => p.date)).toEqual(['2023-01-01', '2025-01-01']);
  });

  it('a single portrait is returned as-is; an empty list is empty', () => {
    const only = portrait('2024-05-05');
    expect(samplePortraitsForMultiYear([only])).toEqual([only]);
    expect(samplePortraitsForMultiYear([])).toEqual([]);
  });

  it('a short span (n=1) with many portraits keeps first and last only', () => {
    const input = ['2024-01-01', '2024-02-01', '2024-03-01', '2024-04-01', '2024-05-01'].map((d) => portrait(d));
    const sampled = samplePortraitsForMultiYear(input);
    expect(sampled.map((p) => p.date)).toEqual(['2024-01-01', '2024-05-01']);
  });

  it('same-date portraits: no duplicates, first and last of the stable order are kept', () => {
    const input = [portrait('2024-01-01', 'a'), portrait('2024-01-01', 'b'), portrait('2024-01-01', 'c')];
    const sampled = samplePortraitsForMultiYear(input);
    expect(sampled.map((p) => p.file)).toEqual(['a', 'c']);
  });

  it('same-date portraits within a long span keep distinct entries', () => {
    const input = [
      portrait('2023-01-01', 'a'),
      portrait('2024-06-01', 'b1'),
      portrait('2024-06-01', 'b2'),
      portrait('2024-06-01', 'b3'),
      portrait('2026-01-01', 'z'),
    ]; // span 36 -> n=6 >= 5 portraits -> keep all
    expect(samplePortraitsForMultiYear(input).map((p) => p.file)).toEqual(['a', 'b1', 'b2', 'b3', 'z']);

    const many = [
      portrait('2022-01-01', 'a'),
      ...['b1', 'b2', 'b3', 'b4', 'b5', 'b6'].map((f) => portrait('2024-01-01', f)),
      portrait('2026-01-01', 'z'),
    ]; // span 48 -> n=6, 8 portraits
    const sampled = samplePortraitsForMultiYear(many);
    expect(sampled).toHaveLength(6);
    expect(new Set(sampled.map((p) => p.file)).size).toBe(6);
    expect(sampled[0].file).toBe('a');
    expect(sampled[5].file).toBe('z');
  });

  it('equidistant targets pick the earlier portrait; deterministic regardless of input order', () => {
    const dates = ['2022-01-01', '2022-07-01', '2023-01-01', '2023-07-01', '2024-01-01', '2024-07-01', '2025-01-01', '2025-07-01', '2026-01-01'];
    const a = samplePortraitsForMultiYear(dates.map((d) => portrait(d)));
    const b = samplePortraitsForMultiYear([...dates].reverse().map((d) => portrait(d)));
    expect(a.map((p) => p.date)).toEqual(b.map((p) => p.date));
    expect(a).toHaveLength(6);
    expect(a[0].date).toBe('2022-01-01');
    expect(a[5].date).toBe('2026-01-01');
  });

  it('does not mutate its input', () => {
    const input = [portrait('2025-01-01'), portrait('2023-01-01'), portrait('2024-01-01')];
    samplePortraitsForMultiYear(input);
    expect(input.map((p) => p.date)).toEqual(['2025-01-01', '2023-01-01', '2024-01-01']);
  });

  it('throws on an unparseable date rather than silently mis-sampling', () => {
    expect(() => samplePortraitsForMultiYear([portrait('nope'), portrait('2024-01-01')])).toThrow();
  });
});
