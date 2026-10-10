import { FRAME_COLORS, FRAME_KINDS, pickFrameStyle } from '@/components/artwork/frame-style';
import { colors } from '@/constants/theme';

describe('pickFrameStyle', () => {
  it('is stable for the same key', () => {
    for (const key of ['asset-1', 'a3f4c2b0-1d2e-4f5a-9b6c-7d8e9f0a1b2c', 'memory-xyz']) {
      expect(pickFrameStyle(key)).toEqual(pickFrameStyle(key));
    }
  });

  it('covers all 36 style/color combinations over many keys', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 4000; i += 1) {
      const { kind, color } = pickFrameStyle(`asset-${i}`);
      seen.add(`${kind}|${color}`);
    }
    expect(seen.size).toBe(FRAME_KINDS.length * FRAME_COLORS.length);
    expect(seen.size).toBe(36);
  });

  it('keeps the tilt within +-1 to +-2.5 degrees and uses both directions', () => {
    let negative = 0;
    let positive = 0;
    for (let i = 0; i < 2000; i += 1) {
      const { tilt } = pickFrameStyle(`k${i}`);
      expect(Math.abs(tilt)).toBeGreaterThanOrEqual(1);
      expect(Math.abs(tilt)).toBeLessThanOrEqual(2.5);
      if (tilt < 0) negative += 1;
      else positive += 1;
    }
    expect(negative).toBeGreaterThan(0);
    expect(positive).toBeGreaterThan(0);
  });

  it('exposes the six owner-approved kinds and colors', () => {
    expect([...FRAME_KINDS]).toEqual(['scallop', 'gingham', 'ricrac', 'wavy', 'bobble', 'chunky']);
    expect([...FRAME_COLORS]).toEqual([
      colors.frameBlush,
      colors.frameSky,
      colors.frameMint,
      colors.frameLilac,
      colors.frameButter,
      colors.frameTomato,
    ]);
    expect(FRAME_COLORS).toEqual(['#F2A7B8', '#4A8FD6', '#8FD1AA', '#C4ADE6', '#F2C84B', '#E2553F']);
  });
});
