// Shared loudness math for audio memories (docs/plans/audio-trim-import.md,
// "Shared waveform math" + "Energy bucket spec").
//
// ONE implementation on purpose: the app (composer, trim sheet), the
// waveform backfill script and the native modules' bucketing all have to
// produce the same contour for the same clip, or backfilled waveforms would
// look different from freshly recorded ones. The native side only decodes and
// measures per-bucket mean-square energy; every dB/normalisation decision
// lives here.
//
// CONSTRAINT: no `@/` alias imports and no React Native imports. The Deno
// backfill (supabase/scripts/backfill-audio-waveforms.ts) imports this file
// by relative path, and Deno resolves neither. Keep it dependency-free.

/** Stored/rendered waveform resolution. The DB check allows 16..256, the app writes exactly this. */
export const WAVEFORM_BUCKETS = 64;

/** Quietest level that still draws above the floor; anything below reads as silence. */
const FLOOR_DB = -50;
/** Trim suggestion treats anything this far below the loudest bucket as dead air. */
const SUGGEST_THRESHOLD_DB = -35;
const SUGGEST_PAD_MS = 250;
const SUGGEST_MIN_REMOVED_MS = 600;
const SUGGEST_MIN_KEPT_MS = 1000;
/** Silence still draws a thin line (matches the seeded envelope's floor). */
const TRACE_FLOOR = 0.06;

export interface PcmEnergies {
  /** Decoded length, `round(n * 1000 / sampleRate)`: the value the app trusts. */
  durationMs: number;
  bucketMs: number;
  /** Mean-square (mean of x^2) of mono Float32 PCM per bucket. */
  energies: number[];
}

/**
 * TS reference for the native `analyze` bucketing. Swift, Kotlin and the
 * backfill must match this exactly (golden fixture: __fixtures__/waveform-golden.json).
 *
 * - `bucketMs = max(minBucketMs, ceil(estimate / maxBuckets))`; the estimate
 *   defaults to the exact decoded duration. Native callers pass container
 *   metadata, which may be slightly off, so `energies.length` can exceed
 *   `maxBuckets` by a bucket or two; consumers must not assume otherwise.
 * - Buckets are sample-aligned at the DECODED rate (no resampling for
 *   analysis); the last bucket may be partial and its mean is over its own
 *   samples only.
 */
export function energiesFromPcm(
  samples: Float32Array,
  sampleRate: number,
  opts: { maxBuckets: number; minBucketMs: number; durationMsEstimate?: number },
): PcmEnergies {
  const sampleCount = samples.length;
  const durationMs = Math.round((sampleCount * 1000) / sampleRate);
  const estimateMs = opts.durationMsEstimate ?? durationMs;
  const bucketMs = Math.max(opts.minBucketMs, Math.ceil(estimateMs / opts.maxBuckets));
  const samplesPerBucket = Math.max(1, Math.round((bucketMs * sampleRate) / 1000));
  const count = Math.ceil(sampleCount / samplesPerBucket);

  const energies: number[] = [];
  for (let bucket = 0; bucket < count; bucket++) {
    const from = bucket * samplesPerBucket;
    const to = Math.min(from + samplesPerBucket, sampleCount);
    // Float64 accumulation: summing thousands of squared Float32 values in
    // Float32 would drift between platforms.
    let sum = 0;
    for (let i = from; i < to; i++) {
      const x = samples[i];
      sum += x * x;
    }
    energies.push(sum / (to - from));
  }

  return { durationMs, bucketMs, energies };
}

/**
 * Collapses fine mean-square buckets into `buckets` (default 64) 0..255
 * loudness values. Pipeline: merge equal spans (mean of mean-squares) -> RMS
 * -> dBFS -> clamp [-50, 0] -> 0..1 -> divide by the loudest bucket -> round.
 * Normalising by the loudest bucket makes a quiet recording draw as tall as a
 * loud one; an all-silent clip is all zeros (never divide by zero).
 *
 * `startIndex`/`endIndex` (end exclusive) select a slice of `energies`, so a
 * trimmed selection can be re-bucketed without re-analysing.
 */
export function waveformFromEnergies(
  energies: number[],
  opts: { buckets?: number; startIndex?: number; endIndex?: number } = {},
): number[] {
  const buckets = opts.buckets ?? WAVEFORM_BUCKETS;
  const start = Math.max(0, Math.floor(opts.startIndex ?? 0));
  const end = Math.min(energies.length, Math.floor(opts.endIndex ?? energies.length));
  const fineCount = end - start;
  if (fineCount <= 0) {
    return new Array<number>(buckets).fill(0);
  }

  const levels: number[] = [];
  for (let j = 0; j < buckets; j++) {
    const lo = Math.floor((j * fineCount) / buckets);
    const hi = Math.floor(((j + 1) * fineCount) / buckets);
    let meanSquare: number;
    if (hi > lo) {
      let sum = 0;
      for (let i = lo; i < hi; i++) {
        sum += energies[start + i];
      }
      meanSquare = sum / (hi - lo);
    } else {
      // Fewer fine buckets than outputs (short clip): reuse the nearest one.
      const nearest = Math.min(fineCount - 1, Math.floor(((j + 0.5) * fineCount) / buckets));
      meanSquare = energies[start + nearest];
    }
    levels.push(meanSquareToLevel(meanSquare));
  }

  const loudest = Math.max(...levels);
  if (!(loudest > 0)) {
    return new Array<number>(buckets).fill(0);
  }
  return levels.map((level) => Math.round((level / loudest) * 255));
}

function meanSquareToLevel(meanSquare: number): number {
  // NaN / negative (corrupt native output) reads as silence rather than
  // poisoning the whole contour.
  if (!(meanSquare > 0)) {
    return 0;
  }
  const db = 20 * Math.log10(Math.sqrt(meanSquare));
  const clamped = Math.min(0, Math.max(FLOOR_DB, db));
  return (clamped - FLOOR_DB) / -FLOOR_DB;
}

/**
 * Proposes cutting dead air from both ends: everything more than 35 dB below
 * the loudest bucket counts as quiet, padded by 250 ms of context. Returns
 * null unless the cut is worth offering (removes >= 600 ms in total) and the
 * result is still a usable clip (>= 1 s).
 *
 * The clip length is taken as `energies.length * bucketMs`; the final bucket
 * may be partial, so `endMs` can overshoot the true duration by < bucketMs.
 * Callers clamp to the real duration.
 */
export function suggestTrim(
  energies: number[],
  bucketMs: number,
): { startMs: number; endMs: number } | null {
  let peak = 0;
  for (const energy of energies) {
    if (energy > peak) peak = energy;
  }
  if (!(peak > 0)) {
    return null;
  }

  const threshold = peak * Math.pow(10, SUGGEST_THRESHOLD_DB / 10);
  let first = -1;
  let last = -1;
  for (let i = 0; i < energies.length; i++) {
    if (energies[i] >= threshold) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) {
    return null;
  }

  const totalMs = energies.length * bucketMs;
  const startMs = Math.max(0, first * bucketMs - SUGGEST_PAD_MS);
  const endMs = Math.min(totalMs, (last + 1) * bucketMs + SUGGEST_PAD_MS);

  const removedMs = startMs + (totalMs - endMs);
  if (removedMs < SUGGEST_MIN_REMOVED_MS || endMs - startMs < SUGGEST_MIN_KEPT_MS) {
    return null;
  }
  return { startMs, endMs };
}

/**
 * 0..255 waveform -> `points` drawing heights in [0.06, 1] for SoundTrace.
 * Linear resample, one light smoothing pass, floor so silence still draws a
 * thin line. Deliberately NO edge taper (the seeded envelope has one; real
 * data should show a clip that starts or ends loud as such).
 */
export function envelopeForTrace(waveform: number[], points: number): number[] {
  if (points <= 0) {
    return [];
  }
  if (waveform.length === 0) {
    return new Array<number>(points).fill(TRACE_FLOOR);
  }

  const resampled: number[] = [];
  const lastIndex = waveform.length - 1;
  for (let i = 0; i < points; i++) {
    const position = points === 1 ? 0 : (i * lastIndex) / (points - 1);
    const lo = Math.floor(position);
    const hi = Math.min(lastIndex, lo + 1);
    const fraction = position - lo;
    const value = waveform[lo] * (1 - fraction) + waveform[hi] * fraction;
    resampled.push(value / 255);
  }

  return resampled.map((value, i) => {
    const prev = resampled[Math.max(0, i - 1)];
    const next = resampled[Math.min(points - 1, i + 1)];
    const smoothed = (prev + value * 2 + next) / 4;
    return Math.min(1, Math.max(TRACE_FLOOR, smoothed));
  });
}

/**
 * Save-side guard: the waveform is cosmetic, so anything that is not exactly
 * 64 finite integers in 0..255 is dropped (null) instead of failing the save.
 * Native NaN energies serialise to JSON `null` elements, which this rejects.
 */
export function sanitizeWaveform(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== WAVEFORM_BUCKETS) {
    return null;
  }
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0 || entry > 255) {
      return null;
    }
  }
  return value as number[];
}

// --- Golden-fixture PCM recipe -------------------------------------------
// Synthetic only (tones + silence; the repo is public, no human audio). The
// recipe lives in __fixtures__/waveform-golden.json so the Jest test, the
// Deno backfill test and the macOS Swift harness can regenerate identical PCM.

export interface PcmRecipeSegment {
  durationMs: number;
  kind: 'silence' | 'sine';
  freqHz?: number;
  amplitude?: number;
}

export interface PcmRecipe {
  sampleRate: number;
  segments: PcmRecipeSegment[];
}

/** Mono Float32 PCM for a recipe. Each sine restarts at phase 0 at its segment start. */
export function synthesizeFromRecipe(recipe: PcmRecipe): Float32Array {
  const lengths = recipe.segments.map((segment) =>
    Math.round((segment.durationMs * recipe.sampleRate) / 1000),
  );
  const out = new Float32Array(lengths.reduce((sum, length) => sum + length, 0));

  let offset = 0;
  recipe.segments.forEach((segment, index) => {
    const length = lengths[index];
    if (segment.kind === 'sine') {
      const amplitude = segment.amplitude ?? 0;
      const step = (2 * Math.PI * (segment.freqHz ?? 0)) / recipe.sampleRate;
      for (let i = 0; i < length; i++) {
        out[offset + i] = amplitude * Math.sin(step * i);
      }
    }
    offset += length;
  });

  return out;
}
