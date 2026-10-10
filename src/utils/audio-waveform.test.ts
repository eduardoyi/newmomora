import golden from './__fixtures__/waveform-golden.json';
import {
  energiesFromPcm,
  envelopeForTrace,
  sanitizeWaveform,
  suggestTrim,
  synthesizeFromRecipe,
  WAVEFORM_BUCKETS,
  waveformFromEnergies,
  type PcmRecipe,
} from './audio-waveform';

function dbToEnergy(db: number): number {
  return Math.pow(10, db / 10);
}

describe('energiesFromPcm', () => {
  it('buckets by the spec: bucketMs = max(minBucketMs, ceil(estimate / maxBuckets))', () => {
    const samples = new Float32Array(48000).fill(0.5); // exactly 1 s
    const result = energiesFromPcm(samples, 48000, { maxBuckets: 4000, minBucketMs: 20 });

    expect(result.durationMs).toBe(1000);
    expect(result.bucketMs).toBe(20);
    expect(result.energies).toHaveLength(50);
    expect(result.energies[0]).toBeCloseTo(0.25, 10);
  });

  it('widens buckets so the count stays within maxBuckets', () => {
    const samples = new Float32Array(48000 * 10);
    const result = energiesFromPcm(samples, 48000, { maxBuckets: 100, minBucketMs: 20 });

    expect(result.bucketMs).toBe(100);
    expect(result.energies).toHaveLength(100);
  });

  it('uses the caller estimate for the bucket size (container metadata) but the decoded length for durationMs', () => {
    const samples = new Float32Array(48000 * 2);
    const result = energiesFromPcm(samples, 48000, {
      maxBuckets: 10,
      minBucketMs: 1,
      durationMsEstimate: 2500,
    });

    expect(result.durationMs).toBe(2000);
    expect(result.bucketMs).toBe(250);
    expect(result.energies).toHaveLength(8);
  });

  it('averages a partial last bucket over its own samples only', () => {
    // 1.5 buckets of 1000 samples at 1 kHz: second bucket is half-length.
    const samples = new Float32Array(1500);
    samples.fill(1, 0, 1000);
    samples.fill(0.5, 1000);
    const result = energiesFromPcm(samples, 1000, { maxBuckets: 100, minBucketMs: 1000 });

    expect(result.bucketMs).toBe(1000);
    expect(result.energies).toEqual([1, 0.25]);
    expect(result.durationMs).toBe(1500);
  });

  it('returns no buckets for empty input', () => {
    const result = energiesFromPcm(new Float32Array(0), 48000, { maxBuckets: 10, minBucketMs: 20 });
    expect(result).toEqual({ durationMs: 0, bucketMs: 20, energies: [] });
  });
});

describe('waveformFromEnergies', () => {
  it('returns 64 zeros for all-silent input', () => {
    expect(waveformFromEnergies(new Array(100).fill(0))).toEqual(new Array(WAVEFORM_BUCKETS).fill(0));
  });

  it('returns zeros for empty or empty-range input', () => {
    expect(waveformFromEnergies([])).toEqual(new Array(WAVEFORM_BUCKETS).fill(0));
    expect(waveformFromEnergies([1, 1], { startIndex: 2, endIndex: 2 })).toEqual(
      new Array(WAVEFORM_BUCKETS).fill(0),
    );
  });

  it('normalises to the loudest bucket (a quiet clip is as tall as a loud one)', () => {
    const quiet = waveformFromEnergies(new Array(64).fill(dbToEnergy(-30)));
    const loud = waveformFromEnergies(new Array(64).fill(1));

    expect(Math.max(...quiet)).toBe(255);
    expect(loud).toEqual(quiet);
  });

  it('isolates a single loud bucket against silence', () => {
    const energies = new Array(64).fill(0);
    energies[10] = 0.25;
    const wave = waveformFromEnergies(energies);

    expect(wave[10]).toBe(255);
    expect(wave.filter((v) => v > 0)).toHaveLength(1);
  });

  it('maps dBFS linearly between the -50 dB floor and 0 dB, relative to the peak', () => {
    // RMS levels: -50 dB (floor), -25 dB (half), 0 dB (peak).
    const wave = waveformFromEnergies([dbToEnergy(-50), dbToEnergy(-25), 1], { buckets: 3 });

    expect(wave).toEqual([0, 128, 255]);
  });

  it('clamps anything below -50 dB to zero', () => {
    const wave = waveformFromEnergies([dbToEnergy(-80), 1], { buckets: 2 });
    expect(wave).toEqual([0, 255]);
  });

  it('merges fine buckets by the mean of mean-squares', () => {
    // Two fine buckets (energy 1 and 0) merge into one with mean 0.5 (-3 dB).
    const merged = waveformFromEnergies([1, 0, 1, 1], { buckets: 2 });
    // Bucket 0 = mean(1, 0) = 0.5 -> -3.01 dB; bucket 1 = 1 -> 0 dB.
    expect(merged[1]).toBe(255);
    expect(merged[0]).toBe(Math.round(((50 - 3.0103) / 50 / 1) * 255));
  });

  it('slices by startIndex/endIndex (end exclusive)', () => {
    const energies = [0, 0, 1, 1, 0, 0];
    const wave = waveformFromEnergies(energies, { buckets: 2, startIndex: 2, endIndex: 4 });
    expect(wave).toEqual([255, 255]);
  });

  it('reuses the nearest fine bucket when there are fewer fine buckets than outputs', () => {
    const wave = waveformFromEnergies([0, 1], { buckets: 4 });
    // j=0: lo=0,hi=0 -> nearest floor(0.5*2/4)=0 ; j=1: nearest floor(1.5*2/4)=0 ;
    // j=2: nearest floor(2.5*2/4)=1 ; j=3: nearest min(1, floor(3.5*2/4)=1)=1
    expect(wave).toEqual([0, 0, 255, 255]);
  });

  it('treats NaN and negative energies as silence rather than poisoning the contour', () => {
    const wave = waveformFromEnergies([Number.NaN, -1, 1], { buckets: 3 });
    expect(wave).toEqual([0, 0, 255]);
  });

  it('always yields integers in 0..255 of the requested length', () => {
    const energies = Array.from({ length: 277 }, (_, i) => Math.abs(Math.sin(i / 7)) * 0.3);
    const wave = waveformFromEnergies(energies);

    expect(wave).toHaveLength(WAVEFORM_BUCKETS);
    expect(wave.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)).toBe(true);
    expect(sanitizeWaveform(wave)).toEqual(wave);
  });
});

describe('suggestTrim', () => {
  // 10 fine buckets of 100 ms, loud in the middle, dead air around it.
  function clip(lead: number, loud: number, tail: number): number[] {
    return [
      ...new Array(lead).fill(dbToEnergy(-60)),
      ...new Array(loud).fill(1),
      ...new Array(tail).fill(dbToEnergy(-60)),
    ];
  }

  it('returns null for silence and for empty input', () => {
    expect(suggestTrim([], 100)).toBeNull();
    expect(suggestTrim(new Array(50).fill(0), 100)).toBeNull();
  });

  it('cuts dead air from both ends with 250 ms of padding', () => {
    // 1.0 s lead, 3.0 s loud, 2.0 s tail @ 100 ms buckets.
    expect(suggestTrim(clip(10, 30, 20), 100)).toEqual({ startMs: 750, endMs: 4250 });
  });

  it('clamps padding at the clip edges', () => {
    // 100 ms lead -> start clamps to 0; only the tail is removable.
    const result = suggestTrim(clip(1, 30, 20), 100);
    expect(result).toEqual({ startMs: 0, endMs: 3350 });
  });

  it('treats quiet-but-audible speech (above -35 dB from peak) as content', () => {
    const energies = [...new Array(10).fill(dbToEnergy(-30)), ...new Array(10).fill(1), ...new Array(10).fill(dbToEnergy(-30))];
    expect(suggestTrim(energies, 100)).toBeNull();
  });

  it('returns null when the cut removes less than 600 ms in total', () => {
    // 800 ms lead - 250 ms pad = 550 ms removed, nothing at the tail.
    expect(suggestTrim(clip(16, 60, 0), 50)).toBeNull();
    // 850 ms lead -> exactly 600 ms removed: offered.
    expect(suggestTrim(clip(17, 60, 0), 50)).toEqual({ startMs: 600, endMs: 3850 });
  });

  it('returns null when the result would be shorter than 1 s', () => {
    // 300 ms of speech padded to 800 ms, with lots of removable silence.
    expect(suggestTrim(clip(30, 3, 30), 100)).toBeNull();
    // 500 ms of speech padded to exactly 1000 ms is allowed.
    expect(suggestTrim(clip(30, 5, 30), 100)).toEqual({ startMs: 2750, endMs: 3750 });
  });
});

describe('envelopeForTrace', () => {
  it('resamples to the requested point count within 0.06..1', () => {
    const env = envelopeForTrace(waveformFromEnergies(new Array(100).fill(0.1)), 52);

    expect(env).toHaveLength(52);
    expect(Math.min(...env)).toBeGreaterThanOrEqual(0.06);
    expect(Math.max(...env)).toBeLessThanOrEqual(1);
  });

  it('floors silence so it still draws a thin line', () => {
    expect(envelopeForTrace(new Array(64).fill(0), 10)).toEqual(new Array(10).fill(0.06));
    expect(envelopeForTrace([], 4)).toEqual(new Array(4).fill(0.06));
  });

  it('does not taper the edges (a clip that starts loud draws loud)', () => {
    const env = envelopeForTrace(new Array(64).fill(255), 40);
    expect(env[0]).toBe(1);
    expect(env[39]).toBe(1);
  });

  it('applies one light smoothing pass', () => {
    // A single spike of 1.0 at index 2 among zeros: neighbours get 0.25, peak keeps 0.5.
    const env = envelopeForTrace([0, 0, 255, 0, 0], 5);
    expect(env[1]).toBeCloseTo(0.25, 10);
    expect(env[2]).toBeCloseTo(0.5, 10);
    expect(env[3]).toBeCloseTo(0.25, 10);
    expect(env[0]).toBe(0.06);
  });

  it('handles degenerate point counts', () => {
    expect(envelopeForTrace([255, 255], 0)).toEqual([]);
    expect(envelopeForTrace([255, 255], 1)).toEqual([1]);
  });
});

describe('sanitizeWaveform', () => {
  const valid = Array.from({ length: 64 }, (_, i) => i * 4);

  it('accepts exactly 64 integers in 0..255', () => {
    expect(sanitizeWaveform(valid)).toEqual(valid);
  });

  it('rejects wrong length, non-arrays and nullish values', () => {
    expect(sanitizeWaveform(valid.slice(1))).toBeNull();
    expect(sanitizeWaveform([...valid, 1])).toBeNull();
    expect(sanitizeWaveform(null)).toBeNull();
    expect(sanitizeWaveform(undefined)).toBeNull();
    expect(sanitizeWaveform('1,2,3')).toBeNull();
  });

  it('rejects NaN, Infinity, null elements, fractions, out-of-range and non-numbers', () => {
    const withAt = (value: unknown) => valid.map((v, i) => (i === 7 ? value : v));
    expect(sanitizeWaveform(withAt(Number.NaN))).toBeNull();
    expect(sanitizeWaveform(withAt(Number.POSITIVE_INFINITY))).toBeNull();
    expect(sanitizeWaveform(withAt(null))).toBeNull();
    expect(sanitizeWaveform(withAt(1.5))).toBeNull();
    expect(sanitizeWaveform(withAt(256))).toBeNull();
    expect(sanitizeWaveform(withAt(-1))).toBeNull();
    expect(sanitizeWaveform(withAt('12'))).toBeNull();
  });
});

describe('golden fixture (shared with the Deno backfill and the macOS harness)', () => {
  const recipe = golden.recipe as PcmRecipe;
  const pcm = synthesizeFromRecipe(recipe);

  it('synthesizes the documented number of samples', () => {
    expect(pcm.length).toBe(golden.cases[0].expected.sampleCount);
  });

  it.each(golden.cases.map((c) => [`${c.maxBuckets}/${c.minBucketMs}`, c] as const))(
    'matches the expected energies, waveform and trim suggestion for maxBuckets/minBucketMs %s',
    (_label, testCase) => {
      const result = energiesFromPcm(pcm, recipe.sampleRate, {
        maxBuckets: testCase.maxBuckets,
        minBucketMs: testCase.minBucketMs,
      });

      expect(result.durationMs).toBe(testCase.expected.durationMs);
      expect(result.bucketMs).toBe(testCase.expected.bucketMs);
      expect(result.energies).toHaveLength(testCase.expected.energies.length);
      result.energies.forEach((energy, i) => {
        expect(Math.abs(energy - testCase.expected.energies[i])).toBeLessThan(1e-6);
      });

      expect(waveformFromEnergies(result.energies)).toEqual(testCase.waveform64);
      expect(suggestTrim(result.energies, result.bucketMs)).toEqual(testCase.suggestTrim);
    },
  );
});
