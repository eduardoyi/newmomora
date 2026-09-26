import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';

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
  // Path order: [0] un-played pencil line, [1] played glow, [2] played ink.
  it('renders the neutral graphite ink when emotion is null', () => {
    const { toJSON } = render(<SoundTrace emotion={null} progress={0.5} seed={7} />);
    const paths = findByType(toJSON(), 'RNSVGPath');
    expect(paths).toHaveLength(3);
    expect(strokePayload(paths[0])).toBe(argbIntFromHex(colors.ink2));
  });

  it('renders the emotion ink tone once emotion is analyzed, with a glow in its main color', () => {
    const { toJSON } = render(<SoundTrace emotion="joy" progress={0.5} seed={7} />);
    const paths = findByType(toJSON(), 'RNSVGPath');
    expect(strokePayload(paths[0])).toBe(argbIntFromHex(emotionColors.joy.ink));
    expect(strokePayload(paths[1])).toBe(argbIntFromHex(emotionColors.joy.c));
  });

  it('keeps un-played ink faint and played ink bolder', () => {
    const { toJSON } = render(<SoundTrace emotion="joy" progress={0.5} seed={7} stroke={2} />);
    const [idle, , played] = findByType(toJSON(), 'RNSVGPath');
    expect(idle.props.strokeOpacity).toBeLessThan(0.3);
    expect(Number(played.props.strokeWidth)).toBeGreaterThan(Number(idle.props.strokeWidth));
  });

  it('falls back to neutral for an unrecognized emotion label', () => {
    const { toJSON } = render(<SoundTrace emotion="not-a-real-emotion" progress={0} seed={7} />);
    const paths = findByType(toJSON(), 'RNSVGPath');
    expect(strokePayload(paths[0])).toBe(argbIntFromHex(colors.ink2));
  });

  it('draws the pen-nib playhead only strictly between 0 and 1 progress', () => {
    const nibOpacity = (progress: number) => {
      const { getByTestId } = render(<SoundTrace emotion="joy" progress={progress} seed={7} testID="trace" />);
      return StyleSheet.flatten(getByTestId('trace-nib').props.style).opacity;
    };
    expect(nibOpacity(0)).toBe(0);
    expect(nibOpacity(0.4)).toBe(1);
    expect(nibOpacity(1)).toBe(0);
  });

  it('omits the nib on static thumbnails', () => {
    const { queryByTestId } = render(<SoundTrace emotion="joy" progress={0.4} seed={7} showNib={false} testID="trace" />);
    expect(queryByTestId('trace-nib')).toBeNull();
  });

  it('seeks to the tapped position when seeking is enabled', () => {
    const onSeek = jest.fn();
    const { getByTestId } = render(<SoundTrace emotion="joy" onSeek={onSeek} seed={7} testID="trace" />);
    fireEvent(getByTestId('trace'), 'layout', { nativeEvent: { layout: { width: 200 } } });

    fireGestureHandler(getByGestureTestId('trace-tap'), [
      { state: State.BEGAN, x: 150 },
      { state: State.ACTIVE, x: 150 },
      { state: State.END, x: 150 },
    ]);

    expect(onSeek).toHaveBeenCalledWith(0.75);
  });

  it('scrubs with a horizontal drag, reporting the live position and seeking on release', () => {
    const onSeek = jest.fn();
    const onScrubChange = jest.fn();
    const { getByTestId } = render(
      <SoundTrace durationSeconds={20} emotion="joy" onScrubChange={onScrubChange} onSeek={onSeek} seed={7} testID="trace" />,
    );
    fireEvent(getByTestId('trace'), 'layout', { nativeEvent: { layout: { width: 200 } } });

    fireGestureHandler(getByGestureTestId('trace-pan'), [
      { state: State.BEGAN, x: 20 },
      { state: State.ACTIVE, x: 20 },
      { x: 100 },
      { x: 160 },
      { state: State.END, x: 160 },
    ]);

    expect(onScrubChange).toHaveBeenCalledWith(0.5);
    expect(onScrubChange).toHaveBeenCalledWith(0.8);
    expect(onScrubChange).toHaveBeenLastCalledWith(null);
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledWith(0.8);
  });

  it('never hands the player a non-finite position', () => {
    const onSeek = jest.fn();
    const { getByTestId } = render(<SoundTrace emotion="joy" onSeek={onSeek} progress={Number.NaN} seed={7} testID="trace" />);
    fireEvent(getByTestId('trace'), 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
    expect(onSeek).not.toHaveBeenCalled();
  });

  it('is an adjustable control for screen readers, stepping 10%', () => {
    const onSeek = jest.fn();
    const { getByTestId } = render(<SoundTrace emotion="joy" onSeek={onSeek} progress={0.5} seed={7} testID="trace" />);
    const trace = getByTestId('trace');
    expect(trace.props.accessibilityRole).toBe('adjustable');
    fireEvent(trace, 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
    expect(onSeek).toHaveBeenLastCalledWith(0.6);
    fireEvent(trace, 'accessibilityAction', { nativeEvent: { actionName: 'decrement' } });
    expect(onSeek).toHaveBeenLastCalledWith(0.4);
  });

  it('produces the same path geometry across renders for the same seed (deterministic port)', () => {
    const first = render(<SoundTrace emotion={null} progress={0} seed={22} />);
    const firstPaths = findByType(first.toJSON(), 'RNSVGPath');
    const second = render(<SoundTrace emotion={null} progress={0} seed={22} />);
    const secondPaths = findByType(second.toJSON(), 'RNSVGPath');

    expect(firstPaths[0].props.d).toBe(secondPaths[0].props.d);
  });
});
