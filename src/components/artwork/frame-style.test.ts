import {
  DETAIL_TILT_MAX,
  FRAME_COLORS,
  FRAME_KINDS,
  FRAME_TILT_MAX,
  pickDetailTilt,
  pickFrameStyle,
  seedLeanSign,
  walkLeanDirection,
} from '@/components/artwork/frame-style';
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

describe('pickDetailTilt', () => {
  it('is stable for the same key and direction', () => {
    for (const key of ['asset-1', 'a3f4c2b0-1d2e-4f5a-9b6c-7d8e9f0a1b2c']) {
      for (const direction of [undefined, 1, -1] as const) {
        expect(pickDetailTilt(key, direction)).toBe(pickDetailTilt(key, direction));
      }
    }
  });

  it('leans 1.5 to 4 degrees, in both directions, over many keys', () => {
    expect(DETAIL_TILT_MAX).toBe(4);
    let negative = 0;
    let positive = 0;
    for (let i = 0; i < 3000; i += 1) {
      const tilt = pickDetailTilt(`asset-${i}`);
      expect(Math.abs(tilt)).toBeGreaterThanOrEqual(1.5);
      expect(Math.abs(tilt)).toBeLessThanOrEqual(DETAIL_TILT_MAX);
      if (tilt < 0) negative += 1;
      else positive += 1;
    }
    expect(negative).toBeGreaterThan(0);
    expect(positive).toBeGreaterThan(0);
  });

  it('varies the magnitude (all eleven quarter-degree steps occur) and is bolder than the Timeline on average', () => {
    const magnitudes = new Set<number>();
    let detail = 0;
    let timeline = 0;
    for (let i = 0; i < 3000; i += 1) {
      magnitudes.add(Math.abs(pickDetailTilt(`asset-${i}`)));
      detail += Math.abs(pickDetailTilt(`asset-${i}`));
      timeline += Math.abs(pickFrameStyle(`asset-${i}`).tilt);
    }
    expect(magnitudes.size).toBe(11);
    expect(detail / 3000).toBeGreaterThan(timeline / 3000 + 0.5);
    expect(FRAME_TILT_MAX).toBe(2.5);
  });

  it('defaults to the seed sign (the Timeline tilt direction) and honors an explicit direction', () => {
    for (let i = 0; i < 200; i += 1) {
      const key = `asset-${i}`;
      expect(seedLeanSign(key)).toBe(Math.sign(pickFrameStyle(key).tilt));
      expect(Math.sign(pickDetailTilt(key))).toBe(seedLeanSign(key));
      expect(Math.sign(pickDetailTilt(key, 1))).toBe(1);
      expect(Math.sign(pickDetailTilt(key, -1))).toBe(-1);
      expect(Math.abs(pickDetailTilt(key, 1))).toBe(Math.abs(pickDetailTilt(key, -1)));
    }
  });
});

describe('walkLeanDirection', () => {
  it('starts from the first piece\'s seed sign and flips with the index parity', () => {
    for (let i = 0; i < 200; i += 1) {
      const key = `asset-${i}`;
      const start = seedLeanSign(key);
      expect(walkLeanDirection(key, 0)).toBe(start);
      expect(walkLeanDirection(key, 1)).toBe(-start);
      expect(walkLeanDirection(key, 2)).toBe(start);
      expect(walkLeanDirection(key, 3)).toBe(-start);
    }
  });

  it('leans every pair of neighbours in opposite directions, whatever their own seeds', () => {
    for (let walk = 0; walk < 100; walk += 1) {
      const keys = Array.from({ length: 8 }, (_, index) => `walk-${walk}-piece-${index}`);
      const tilts = keys.map((key, index) => pickDetailTilt(key, walkLeanDirection(keys[0], index)));
      for (let index = 0; index + 1 < tilts.length; index += 1) {
        expect(Math.sign(tilts[index])).toBe(-Math.sign(tilts[index + 1]));
        expect(Math.abs(tilts[index])).toBeGreaterThanOrEqual(1.5);
        expect(Math.abs(tilts[index])).toBeLessThanOrEqual(DETAIL_TILT_MAX);
      }
    }
  });
});
