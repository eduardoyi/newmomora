import { act, configure, fireEvent, render } from '@testing-library/react-native';
import { AccessibilityInfo, AppState, StyleSheet } from 'react-native';
import * as Reanimated from 'react-native-reanimated';

import {
  LIVING_PORTRAIT_COVER_TIMEOUT_MS,
  LIVING_PORTRAIT_FRAME_MS,
  LIVING_PORTRAIT_HOLD_MS,
  LivingPortraitOverlay,
  livingPortraitCycleMs,
  livingPortraitFrameAt,
} from '@/components/living-portrait-overlay';
import { useMediaUrl } from '@/hooks/useMediaUrls';

jest.mock('expo-image', () => ({
  Image: ({ onError, onLoad, source, testID }: { onError?: () => void; onLoad?: () => void; source?: unknown; testID?: string }) => {
    const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
    return <Text onError={onError} onPress={onLoad} testID={testID}>{JSON.stringify(source)}</Text>;
  },
}));

jest.mock('@/hooks/useMediaUrls', () => ({
  useMediaUrl: jest.fn(() => ({ url: 'https://signed.example/motion', isLoading: false, isError: false })),
}));

// The overlay is accessibility-hidden by design; the queries must still see it.
configure({ defaultIncludeHiddenElements: true });

const mockedUseMediaUrl = useMediaUrl as jest.MockedFunction<typeof useMediaUrl>;
const motion = { key: 'u/family/m/portraits/v1/motion/t.webp', columns: 3, rows: 3 };

// The sheet only mounts once its box has been measured.
function layOut(getByTestId: (id: string) => unknown, width = 120, height = 120) {
  act(() => {
    fireEvent(getByTestId('living-portrait-overlay') as never, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width, height } } });
  });
}

describe('livingPortraitFrameAt', () => {
  it('holds frame 0 for 800ms, then steps one frame per 150ms', () => {
    expect(LIVING_PORTRAIT_HOLD_MS).toBe(800);
    expect(LIVING_PORTRAIT_FRAME_MS).toBe(150);
    expect(livingPortraitFrameAt(0, 9)).toBe(0);
    expect(livingPortraitFrameAt(799, 9)).toBe(0);
    expect(livingPortraitFrameAt(800, 9)).toBe(1);
    expect(livingPortraitFrameAt(949, 9)).toBe(1);
    expect(livingPortraitFrameAt(950, 9)).toBe(2);
    expect(livingPortraitFrameAt(800 + 7 * 150, 9)).toBe(8);
    expect(livingPortraitFrameAt(800 + 8 * 150 - 1, 9)).toBe(8);
  });

  it('loops: a full cycle is the hold plus the remaining frames, then frame 0 again', () => {
    const cycle = livingPortraitCycleMs(9);
    expect(cycle).toBe(2000);
    expect(livingPortraitFrameAt(cycle, 9)).toBe(0);
    expect(livingPortraitFrameAt(cycle + 800, 9)).toBe(1);
    expect(livingPortraitFrameAt(cycle * 5 + 1999, 9)).toBe(8);
  });

  it('only ever returns whole frames inside the sheet', () => {
    for (let ms = 0; ms < 4000; ms += 7) {
      const frame = livingPortraitFrameAt(ms, 9);
      expect(Number.isInteger(frame)).toBe(true);
      expect(frame).toBeGreaterThanOrEqual(0);
      expect(frame).toBeLessThanOrEqual(8);
    }
  });

  it('handles a single frame and non-square grids', () => {
    expect(livingPortraitCycleMs(1)).toBe(800);
    expect(livingPortraitFrameAt(12345, 1)).toBe(0);
    expect(livingPortraitCycleMs(4)).toBe(1250);
    expect(livingPortraitFrameAt(800 + 150 * 2, 4)).toBe(3);
    expect(livingPortraitFrameAt(1250, 4)).toBe(0);
  });
});

describe('LivingPortraitOverlay', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    mockedUseMediaUrl.mockReturnValue({ url: 'https://signed.example/motion', isLoading: false, isError: false });
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
    jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: jest.fn() } as never);
  });

  it('signs the sheet key and pins the image cache to it', async () => {
    const { getByTestId } = render(<LivingPortraitOverlay motion={motion} />);
    await act(async () => {});
    layOut(getByTestId);

    expect(mockedUseMediaUrl).toHaveBeenLastCalledWith(motion.key, motion.key);
    expect(getByTestId('living-portrait-sheet').props.children).toBe(
      JSON.stringify({ uri: 'https://signed.example/motion', cacheKey: motion.key }),
    );
  });

  it('is invisible until the sheet loads, then shows', async () => {
    const { getByTestId } = render(<LivingPortraitOverlay motion={motion} />);
    await act(async () => {});

    expect(StyleSheet.flatten(getByTestId('living-portrait-overlay').props.style).opacity).toBe(0);

    layOut(getByTestId);
    // Measured but not decoded yet: still hidden.
    expect(StyleSheet.flatten(getByTestId('living-portrait-overlay').props.style).opacity).toBe(0);

    act(() => getByTestId('living-portrait-sheet').props.onPress());

    expect(StyleSheet.flatten(getByTestId('living-portrait-overlay').props.style).opacity).toBe(1);
  });

  it('does not mount the sheet before its box is measured', async () => {
    const { queryByTestId } = render(<LivingPortraitOverlay motion={motion} />);
    await act(async () => {});

    expect(queryByTestId('living-portrait-strip')).toBeNull();
    expect(queryByTestId('living-portrait-sheet')).toBeNull();
  });

  it('is not interactive and hidden from accessibility', async () => {
    const { getByTestId } = render(<LivingPortraitOverlay motion={motion} />);
    await act(async () => {});

    const overlay = getByTestId('living-portrait-overlay');
    expect(overlay.props.pointerEvents).toBe('none');
    expect(overlay.props.accessibilityElementsHidden).toBe(true);
    expect(overlay.props.importantForAccessibility).toBe('no-hide-descendants');
  });

  it('sizes the sheet to columns x rows measured boxes in pixels and starts on the first frame', async () => {
    const { getByTestId } = render(<LivingPortraitOverlay motion={{ ...motion, columns: 2, rows: 4 }} />);
    await act(async () => {});
    layOut(getByTestId, 90, 110);

    const strip = StyleSheet.flatten(getByTestId('living-portrait-strip').props.style);
    expect(strip.width).toBe(180);
    expect(strip.height).toBe(440);
    expect(strip.transform).toEqual([{ translateX: -0 }, { translateY: -0 }]);
  });

  it('plays a looping, non-interpolated timing once loaded', async () => {
    const withTiming = jest.spyOn(Reanimated, 'withTiming');
    withTiming.mockClear();
    const { getByTestId } = render(<LivingPortraitOverlay motion={motion} />);
    await act(async () => {});
    layOut(getByTestId);
    act(() => getByTestId('living-portrait-sheet').props.onPress());

    expect(withTiming).toHaveBeenCalledWith(2000, expect.objectContaining({ duration: 2000 }));
  });

  it('renders nothing under Reduce Motion', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    const { queryByTestId } = render(<LivingPortraitOverlay motion={motion} />);
    await act(async () => {});

    expect(queryByTestId('living-portrait-overlay')).toBeNull();
    expect(queryByTestId('living-portrait-sheet')).toBeNull();
    expect(queryByTestId('living-portrait-cover')).toBeNull();
    expect(mockedUseMediaUrl).toHaveBeenLastCalledWith(null, motion.key);
  });

  it('covers the still while the sheet URL is being signed', async () => {
    mockedUseMediaUrl.mockReturnValue({ url: undefined, isLoading: true, isError: false });
    const { getByTestId, queryByTestId } = render(<LivingPortraitOverlay coverColor="#123456" motion={motion} />);
    await act(async () => {});

    expect(queryByTestId('living-portrait-overlay')).toBeNull();
    expect(StyleSheet.flatten(getByTestId('living-portrait-cover').props.style).backgroundColor).toBe('#123456');
  });

  it('lifts the cover once the loop has decoded, so its first frame is the resting image', async () => {
    const { getByTestId, queryByTestId } = render(<LivingPortraitOverlay motion={motion} />);
    await act(async () => {});
    expect(getByTestId('living-portrait-cover')).toBeTruthy();

    layOut(getByTestId);
    act(() => getByTestId('living-portrait-sheet').props.onPress());

    expect(queryByTestId('living-portrait-cover')).toBeNull();
    expect(StyleSheet.flatten(getByTestId('living-portrait-overlay').props.style).opacity).toBe(1);
  });

  it('shows the still (and no late loop) when the sheet takes too long', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId, queryByTestId } = render(<LivingPortraitOverlay motion={motion} />);
      await act(async () => {});
      layOut(getByTestId);

      act(() => jest.advanceTimersByTime(LIVING_PORTRAIT_COVER_TIMEOUT_MS));

      expect(queryByTestId('living-portrait-cover')).toBeNull();
      expect(queryByTestId('living-portrait-overlay')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows the still when the sheet fails to load or sign', async () => {
    const { getByTestId, queryByTestId, rerender } = render(<LivingPortraitOverlay motion={motion} />);
    await act(async () => {});
    layOut(getByTestId);
    act(() => getByTestId('living-portrait-sheet').props.onError());
    expect(queryByTestId('living-portrait-cover')).toBeNull();
    expect(queryByTestId('living-portrait-overlay')).toBeNull();

    mockedUseMediaUrl.mockReturnValue({ url: undefined, isLoading: false, isError: true });
    rerender(<LivingPortraitOverlay motion={{ ...motion, key: 'other/motion.webp' }} />);
    await act(async () => {});
    expect(queryByTestId('living-portrait-cover')).toBeNull();
  });

  it('rests the loop while the app is backgrounded', async () => {
    let listener: ((state: string) => void) | undefined;
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_event: string, callback: (state: string) => void) => {
      listener = callback;
      return { remove: jest.fn() };
    }) as never);
    const withTiming = jest.spyOn(Reanimated, 'withTiming');
    withTiming.mockClear();

    const { getByTestId } = render(<LivingPortraitOverlay motion={motion} />);
    await act(async () => {});
    layOut(getByTestId);
    act(() => getByTestId('living-portrait-sheet').props.onPress());
    expect(withTiming).toHaveBeenCalledTimes(1);

    act(() => listener?.('background'));
    expect(withTiming).toHaveBeenCalledTimes(1);

    act(() => listener?.('active'));
    expect(withTiming).toHaveBeenCalledTimes(2);
  });
});
