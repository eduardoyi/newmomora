import { render } from '@testing-library/react-native';

import { colors, emotionColors } from '@/constants/theme';

import { moEnv, SoundTrace } from './sound-trace';

// react-native-svg's native components render as RNSVG* host nodes in the
// test renderer, and color props arrive as an already-parsed
// `{ type, payload }` ARGB int -- not the original hex string -- so
// assertions below compare against the same encoding rather than the
// literal `#RRGGBB`.
function findByType(node: any, typeName: string): any[] {
  if (!node) {
    return [];
  }
  const matches: any[] = [];
  if (node.type === typeName) {
    matches.push(node);
  }
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    matches.push(...findByType(child, typeName));
  }
  return matches;
}

function argbIntFromHex(hex: string): number {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return ((0xff << 24) | (r << 16) | (g << 8) | b) >>> 0;
}

function strokePayload(pathNode: any): number {
  return pathNode.props.stroke.payload;
}

describe('moEnv', () => {
  it('is deterministic for a fixed seed', () => {
    const first = moEnv(7, 20);
    const second = moEnv(7, 20);
    expect(second).toEqual(first);
  });

  it('produces different traces for different seeds', () => {
    const a = moEnv(7, 20);
    const b = moEnv(31, 20);
    expect(a).not.toEqual(b);
  });

  it('keeps every sample within the expected 0-1-ish envelope range', () => {
    const env = moEnv(58, 40);
    for (const value of env) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe('SoundTrace', () => {
  it('renders the neutral graphite ink when emotion is null', () => {
    const { toJSON } = render(<SoundTrace emotion={null} progress={0.5} seed={7} />);
    const paths = findByType(toJSON(), 'RNSVGPath');
    expect(paths.length).toBeGreaterThanOrEqual(2);
    for (const path of paths) {
      expect(strokePayload(path)).toBe(argbIntFromHex(colors.ink2));
    }
  });

  it('renders the emotion ink tone once emotion is analyzed', () => {
    const { toJSON } = render(<SoundTrace emotion="joy" progress={0.5} seed={7} />);
    const paths = findByType(toJSON(), 'RNSVGPath');
    expect(paths.length).toBeGreaterThanOrEqual(2);
    for (const path of paths) {
      expect(strokePayload(path)).toBe(argbIntFromHex(emotionColors.joy.ink));
    }
  });

  it('falls back to neutral for an unrecognized emotion label', () => {
    const { toJSON } = render(<SoundTrace emotion="not-a-real-emotion" progress={0} seed={7} />);
    const paths = findByType(toJSON(), 'RNSVGPath');
    expect(strokePayload(paths[0])).toBe(argbIntFromHex(colors.ink2));
  });

  it('draws the mid-play tip line only strictly between 0 and 1 progress', () => {
    const atStart = findByType(render(<SoundTrace emotion="joy" progress={0} seed={7} />).toJSON(), 'RNSVGLine');
    const midPlay = findByType(render(<SoundTrace emotion="joy" progress={0.4} seed={7} />).toJSON(), 'RNSVGLine');
    const finished = findByType(render(<SoundTrace emotion="joy" progress={1} seed={7} />).toJSON(), 'RNSVGLine');

    expect(atStart.length).toBe(0);
    expect(midPlay.length).toBe(1);
    expect(finished.length).toBe(0);
  });

  it('produces the same path geometry across renders for the same seed (deterministic port)', () => {
    const first = render(<SoundTrace emotion={null} progress={0} seed={22} />);
    const firstPaths = findByType(first.toJSON(), 'RNSVGPath');
    const second = render(<SoundTrace emotion={null} progress={0} seed={22} />);
    const secondPaths = findByType(second.toJSON(), 'RNSVGPath');

    expect(firstPaths[0].props.d).toBe(secondPaths[0].props.d);
  });
});
