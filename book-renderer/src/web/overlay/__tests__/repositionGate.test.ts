import { describe, expect, it } from 'vitest';
import { croppingDelta, needsReposition, REPOSITION_ASPECT_DELTA_THRESHOLD } from '../repositionGate';

describe('croppingDelta', () => {
  it('is zero for identical aspect ratios', () => {
    expect(croppingDelta(1.5, 1.5)).toBe(0);
  });

  it('grows with how far the photo aspect is from the slot aspect', () => {
    const small = croppingDelta(1.05, 1);
    const large = croppingDelta(2, 1);
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small);
  });

  it('registers a mismatch symmetrically whether the photo is wider or narrower than its slot, for a shared ratio', () => {
    // photo twice as wide as its slot, vs. slot twice as wide as its photo —
    // both are "off by a factor of two", so both should read as clearly
    // over any reasonable "small" threshold, not just one direction.
    const wider = croppingDelta(2, 1);
    const narrower = croppingDelta(1, 2);
    expect(wider).toBeGreaterThan(REPOSITION_ASPECT_DELTA_THRESHOLD);
    expect(narrower).toBeGreaterThan(REPOSITION_ASPECT_DELTA_THRESHOLD);
  });

  it('returns 0 (never NaN/Infinity) for non-positive input', () => {
    expect(croppingDelta(0, 1)).toBe(0);
    expect(croppingDelta(1, 0)).toBe(0);
    expect(croppingDelta(-1, 1)).toBe(0);
  });
});

describe('needsReposition', () => {
  it('is false when the photo is effectively uncropped (delta below threshold)', () => {
    expect(needsReposition(1, 1)).toBe(false);
    expect(needsReposition(1.5, 1.51)).toBe(false);
  });

  it('is true once the crop delta exceeds the threshold', () => {
    expect(needsReposition(1.5, 1)).toBe(true);
    expect(needsReposition(1, 1.5)).toBe(true);
  });

  it('sits right on either side of the threshold correctly (strictly greater-than, not >=)', () => {
    const slotAspect = 1;
    const justBelow = 1 + REPOSITION_ASPECT_DELTA_THRESHOLD * 0.5;
    const justAbove = 1 + REPOSITION_ASPECT_DELTA_THRESHOLD * 1.5;
    expect(needsReposition(justBelow, slotAspect)).toBe(false);
    expect(needsReposition(justAbove, slotAspect)).toBe(true);
  });

  it('respects a custom threshold', () => {
    expect(needsReposition(1.1, 1, 0.2)).toBe(false);
    expect(needsReposition(1.1, 1, 0.05)).toBe(true);
  });

  it('fails open (still offers Reposition) for null/undefined/non-positive aspect data', () => {
    expect(needsReposition(null, 1)).toBe(true);
    expect(needsReposition(1, null)).toBe(true);
    expect(needsReposition(undefined, undefined)).toBe(true);
    expect(needsReposition(0, 1)).toBe(true);
    expect(needsReposition(1, -1)).toBe(true);
  });
});
