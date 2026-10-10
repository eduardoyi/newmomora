import { act as rtlAct, fireEvent, render } from '@testing-library/react-native';
import { Keyboard } from 'react-native';
import { State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import {
  clampTrimRange,
  formatTrimTime,
  MIN_TRIM_SELECTION_MS,
  pickTrimHandle,
  TrimSheet,
  type TrimSheetProps,
} from './trim-sheet';

const mockPlayRange = jest.fn().mockResolvedValue(undefined);
const mockPause = jest.fn();
const mockToggle = jest.fn();
let mockPlaying = false;
let mockPosition = 0;

jest.mock('@/hooks/useAudioClipPlayback', () => ({
  useAudioClipPlayback: jest.fn(() => ({
    position: mockPosition,
    duration: 0,
    progress: 0,
    playing: mockPlaying,
    loading: false,
    error: null,
    toggle: mockToggle,
    seekTo: jest.fn(),
    playRange: mockPlayRange,
    pause: mockPause,
  })),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useAudioClipPlayback } = require('@/hooks/useAudioClipPlayback');

const DURATION_MS = 60_000;

function makeEnergies(count = 600): number[] {
  // A gentle swell so the bars are not all identical.
  return Array.from({ length: count }, (_, i) => 0.001 + 0.05 * Math.abs(Math.sin(i / 17)));
}

function renderSheet(overrides: Partial<TrimSheetProps> = {}) {
  const props: TrimSheetProps = {
    visible: true,
    sourceUri: 'file:///audio-recordings/original.m4a',
    durationMs: DURATION_MS,
    energies: makeEnergies(),
    bucketMs: 100,
    initialRange: { startMs: 0, endMs: DURATION_MS },
    suggested: false,
    maxSelectionMs: 120_000,
    mustTrim: false,
    hasUserNote: false,
    onCancel: jest.fn(),
    onDone: jest.fn(),
    ...overrides,
  };
  const utils = render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <TrimSheet {...props} />
    </SafeAreaProvider>,
  );
  // 390 wide screen minus 2 * 16 sheet padding.
  fireEvent(utils.getByTestId('trim-sheet-track'), 'layout', { nativeEvent: { layout: { width: 358 } } });
  return { ...utils, props };
}

function drag(events: Parameters<typeof fireGestureHandler>[1]) {
  rtlAct(() => {
    fireGestureHandler(getByGestureTestId('trim-sheet-pan'), events);
  });
}

function nudgeHandle(handle: 'start' | 'end', actionName: 'increment' | 'decrement', getByTestId: (id: string) => any) {
  fireEvent(getByTestId(`trim-sheet-${handle}-handle`), 'accessibilityAction', {
    nativeEvent: { actionName },
  });
}

beforeEach(() => {
  mockPlaying = false;
  mockPosition = 0;
  mockPlayRange.mockClear();
  mockPause.mockClear();
  useAudioClipPlayback.mockClear();
});

describe('clampTrimRange', () => {
  it('keeps the start at least 1 s before the end when the start handle is dragged right', () => {
    expect(clampTrimRange({ startMs: 59_000, endMs: 20_000 }, DURATION_MS, 'start')).toEqual({
      startMs: 19_000,
      endMs: 20_000,
    });
  });

  it('keeps the end at least 1 s after the start when the end handle is dragged left', () => {
    expect(clampTrimRange({ startMs: 10_000, endMs: 4_000 }, DURATION_MS, 'end')).toEqual({
      startMs: 10_000,
      endMs: 10_000 + MIN_TRIM_SELECTION_MS,
    });
  });

  it('never moves the handle that was not dragged', () => {
    const moved = clampTrimRange({ startMs: 50_000, endMs: 30_000 }, DURATION_MS, 'start');
    expect(moved.endMs).toBe(30_000);
    const movedEnd = clampTrimRange({ startMs: 30_000, endMs: 5_000 }, DURATION_MS, 'end');
    expect(movedEnd.startMs).toBe(30_000);
  });

  it('clamps to [0, durationMs]', () => {
    expect(clampTrimRange({ startMs: -500, endMs: 90_000 }, DURATION_MS, 'start')).toEqual({
      startMs: 0,
      endMs: DURATION_MS,
    });
    expect(clampTrimRange({ startMs: -500, endMs: 90_000 }, DURATION_MS, 'end')).toEqual({
      startMs: 0,
      endMs: DURATION_MS,
    });
  });

  it('keeps a range at the very end valid', () => {
    expect(clampTrimRange({ startMs: 60_000, endMs: 60_000 }, DURATION_MS, 'end')).toEqual({
      startMs: 59_000,
      endMs: 60_000,
    });
  });

  it('lets a sound shorter than the minimum be selected whole', () => {
    expect(clampTrimRange({ startMs: 100, endMs: 600 }, 700, 'start')).toEqual({ startMs: 0, endMs: 700 });
    expect(clampTrimRange({ startMs: 0, endMs: 700 }, 700, 'end')).toEqual({ startMs: 0, endMs: 700 });
  });

  it('survives non-finite input', () => {
    const range = clampTrimRange({ startMs: Number.NaN, endMs: Number.NaN }, DURATION_MS, 'end');
    expect(range).toEqual({ startMs: 0, endMs: DURATION_MS });
  });
});

describe('pickTrimHandle', () => {
  it('grabs the nearest handle within reach', () => {
    expect(pickTrimHandle(30, 24, 300)).toBe('start');
    expect(pickTrimHandle(290, 24, 300)).toBe('end');
  });

  it('ignores touches away from both handles', () => {
    expect(pickTrimHandle(160, 24, 300)).toBeNull();
  });

  it('resolves two close handles by the side the finger is on', () => {
    expect(pickTrimHandle(95, 100, 106)).toBe('start');
    expect(pickTrimHandle(112, 100, 106)).toBe('end');
  });
});

describe('formatTrimTime', () => {
  it('rounds to 0.1 s', () => {
    expect(formatTrimTime(0)).toBe('0:00.0');
    expect(formatTrimTime(3_449)).toBe('0:03.4');
    expect(formatTrimTime(3_450)).toBe('0:03.5');
    expect(formatTrimTime(65_960)).toBe('1:06.0');
  });
});

describe('TrimSheet', () => {
  it('shows the initial range, rounded to 0.1 s', () => {
    const { getByTestId } = renderSheet({ initialRange: { startMs: 3_450, endMs: 20_020 } });
    expect(getByTestId('trim-sheet-start-time').props.children).toBe('0:03.5');
    expect(getByTestId('trim-sheet-end-time').props.children).toBe('0:20.0');
    expect(getByTestId('trim-sheet-length').props.children).toBe('0:16.6');
  });

  it('shows the quiet-bits hint only when the range was suggested', () => {
    const suggested = renderSheet({ suggested: true, initialRange: { startMs: 2_000, endMs: 50_000 } });
    expect(suggested.getByText('We trimmed the quiet bits. Drag to adjust.')).toBeTruthy();
    suggested.unmount();

    const plain = renderSheet({ suggested: false });
    expect(plain.queryByText('We trimmed the quiet bits. Drag to adjust.')).toBeNull();
  });

  it('retires the hint once the parent adjusts the handles', () => {
    const { getByText, queryByText, getByTestId } = renderSheet({
      suggested: true,
      initialRange: { startMs: 2_000, endMs: 50_000 },
    });
    expect(getByText('We trimmed the quiet bits. Drag to adjust.')).toBeTruthy();
    nudgeHandle('start', 'increment', getByTestId);
    expect(queryByText('We trimmed the quiet bits. Drag to adjust.')).toBeNull();
  });

  it('Reset moves the handles to the whole sound and does nothing else', () => {
    const { getByTestId, props } = renderSheet({ initialRange: { startMs: 5_000, endMs: 30_000 } });

    fireEvent.press(getByTestId('trim-sheet-reset'));

    expect(getByTestId('trim-sheet-start-time').props.children).toBe('0:00.0');
    expect(getByTestId('trim-sheet-end-time').props.children).toBe('1:00.0');
    expect(props.onDone).not.toHaveBeenCalled();
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it('Done passes the current range', () => {
    const { getByTestId, props } = renderSheet({ initialRange: { startMs: 5_000, endMs: 30_000 } });

    fireEvent.press(getByTestId('trim-sheet-done'));

    expect(props.onDone).toHaveBeenCalledWith({ startMs: 5_000, endMs: 30_000 });
  });

  it('Done passes the nudged range', () => {
    const { getByTestId, props } = renderSheet({ initialRange: { startMs: 5_000, endMs: 30_000 } });

    nudgeHandle('start', 'increment', getByTestId);
    nudgeHandle('end', 'decrement', getByTestId);
    fireEvent.press(getByTestId('trim-sheet-done'));

    expect(props.onDone).toHaveBeenCalledWith({ startMs: 5_500, endMs: 29_500 });
  });

  it('disables Done and explains the cap when the selection is over the maximum', () => {
    const { getByTestId, getByText, props } = renderSheet({
      durationMs: 400_000,
      initialRange: { startMs: 0, endMs: 400_000 },
      maxSelectionMs: 300_000,
    });

    expect(getByText('Keep up to 5 minutes')).toBeTruthy();
    fireEvent.press(getByTestId('trim-sheet-done'));
    expect(props.onDone).not.toHaveBeenCalled();
    expect(getByTestId('trim-sheet-done').props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: true }),
    );
  });

  it('uses the 2 minute copy for recordings', () => {
    const { getByText } = renderSheet({
      durationMs: 150_000,
      initialRange: { startMs: 0, endMs: 150_000 },
      maxSelectionMs: 120_000,
    });
    expect(getByText('Keep up to 2 minutes')).toBeTruthy();
  });

  it('re-enables Done once the selection fits under the cap', () => {
    const { getByTestId, queryByText, props } = renderSheet({
      durationMs: 304_000,
      initialRange: { startMs: 0, endMs: 304_000 },
      maxSelectionMs: 300_000,
    });
    expect(queryByText('Keep up to 5 minutes')).toBeTruthy();

    // 8 nudges of 0.5 s off the start = 4 s, exactly 300 s selected.
    for (let i = 0; i < 8; i++) {
      nudgeHandle('start', 'increment', getByTestId);
    }
    expect(queryByText('Keep up to 5 minutes')).toBeNull();
    fireEvent.press(getByTestId('trim-sheet-done'));
    expect(props.onDone).toHaveBeenCalledWith({ startMs: 4_000, endMs: 304_000 });
  });

  it('never lets the nudge buttons shrink the selection under 1 s', () => {
    const { getByTestId } = renderSheet({ initialRange: { startMs: 10_000, endMs: 11_000 } });

    nudgeHandle('start', 'increment', getByTestId);
    expect(getByTestId('trim-sheet-start-time').props.children).toBe('0:10.0');
    nudgeHandle('end', 'decrement', getByTestId);
    expect(getByTestId('trim-sheet-end-time').props.children).toBe('0:11.0');
  });

  it('uses the must-trim title and Cancel abandons', () => {
    const { getByText, getByTestId, props } = renderSheet({
      durationMs: 400_000,
      initialRange: { startMs: 0, endMs: 300_000 },
      maxSelectionMs: 300_000,
      mustTrim: true,
    });

    expect(getByText('Choose up to 5 minutes to keep')).toBeTruthy();
    fireEvent.press(getByTestId('trim-sheet-cancel'));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it('uses the plain title otherwise', () => {
    const { getByText, queryByText } = renderSheet();
    expect(getByText('Trim this sound')).toBeTruthy();
    expect(queryByText(/Choose up to/)).toBeNull();
  });

  it('a must-trim sheet ignores backdrop taps (a stray tap must not abandon the import)', () => {
    const { getByTestId, props } = renderSheet({ mustTrim: true });
    fireEvent.press(getByTestId('trim-sheet-backdrop', { hidden: true }));
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it('a normal sheet cancels on a backdrop tap', () => {
    const { getByTestId, props } = renderSheet();
    fireEvent.press(getByTestId('trim-sheet-backdrop', { hidden: true }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows the note line only when the parent has typed a note', () => {
    const withNote = renderSheet({ hasUserNote: true });
    expect(withNote.getByText('Your note stays as you wrote it.')).toBeTruthy();
    withNote.unmount();

    const without = renderSheet({ hasUserNote: false });
    expect(without.queryByText('Your note stays as you wrote it.')).toBeNull();
  });

  it('plays only the selected range from the original source', () => {
    const { getByTestId } = renderSheet({ initialRange: { startMs: 5_500, endMs: 30_000 } });

    expect(useAudioClipPlayback).toHaveBeenCalledWith('file:///audio-recordings/original.m4a');
    fireEvent.press(getByTestId('trim-sheet-play'));

    expect(mockPlayRange).toHaveBeenCalledWith(5.5, 30);
  });

  it('pauses instead of restarting while the preview is playing', () => {
    mockPlaying = true;
    const { getByTestId } = renderSheet();

    fireEvent.press(getByTestId('trim-sheet-play'));

    expect(mockPause).toHaveBeenCalled();
    expect(mockPlayRange).not.toHaveBeenCalled();
  });

  it('pauses the preview on Done, Cancel and Reset', () => {
    const { getByTestId } = renderSheet();
    mockPause.mockClear();
    fireEvent.press(getByTestId('trim-sheet-reset'));
    fireEvent.press(getByTestId('trim-sheet-cancel'));
    fireEvent.press(getByTestId('trim-sheet-done'));
    expect(mockPause).toHaveBeenCalledTimes(3);
  });

  it('pauses the preview when the sheet closes', () => {
    const props: TrimSheetProps = {
      visible: true,
      sourceUri: 'file:///audio-recordings/original.m4a',
      durationMs: DURATION_MS,
      energies: makeEnergies(),
      bucketMs: 100,
      initialRange: { startMs: 0, endMs: DURATION_MS },
      suggested: false,
      maxSelectionMs: 120_000,
      mustTrim: false,
      hasUserNote: false,
      onCancel: jest.fn(),
      onDone: jest.fn(),
    };
    const { rerender } = render(
      <SafeAreaProvider initialMetrics={{ frame: { height: 844, width: 390, x: 0, y: 0 }, insets: { bottom: 0, left: 0, right: 0, top: 0 } }}>
        <TrimSheet {...props} />
      </SafeAreaProvider>,
    );
    mockPause.mockClear();

    rerender(
      <SafeAreaProvider initialMetrics={{ frame: { height: 844, width: 390, x: 0, y: 0 }, insets: { bottom: 0, left: 0, right: 0, top: 0 } }}>
        <TrimSheet {...props} visible={false} />
      </SafeAreaProvider>,
    );

    expect(mockPause).toHaveBeenCalled();
  });

  it('dismisses the keyboard when it opens', () => {
    const spy = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
    renderSheet();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('exposes both handles as adjustable elements with their time as the value', () => {
    const { getByTestId } = renderSheet({ initialRange: { startMs: 5_000, endMs: 30_000 } });

    const start = getByTestId('trim-sheet-start-handle');
    const end = getByTestId('trim-sheet-end-handle');
    expect(start.props.accessibilityRole).toBe('adjustable');
    expect(end.props.accessibilityRole).toBe('adjustable');
    expect(start.props.accessibilityValue).toEqual({ text: '0:05.0' });
    expect(end.props.accessibilityValue).toEqual({ text: '0:30.0' });
  });

  it('drags the nearest handle with the track pan and clamps against the other handle', () => {
    const { getByTestId, props } = renderSheet({ initialRange: { startMs: 0, endMs: DURATION_MS } });
    // inner width = 358 - 48 = 310 px for 60 s. The end handle sits at x = 334.
    drag([
      { state: State.BEGAN, x: 334, translationX: 0 },
      { state: State.ACTIVE, x: 334, translationX: 0 },
      { x: 334 - 155, translationX: -155 }, // half the track = 30 s
      { state: State.END, x: 334 - 155, translationX: -155 },
    ]);

    expect(getByTestId('trim-sheet-end-time').props.children).toBe('0:30.0');
    expect(getByTestId('trim-sheet-start-time').props.children).toBe('0:00.0');

    // Drag the end far past the start: it stops 1 s after it.
    drag([
      { state: State.BEGAN, x: 179, translationX: 0 },
      { state: State.ACTIVE, x: 179, translationX: 0 },
      { x: -500, translationX: -700 },
      { state: State.END, x: -500, translationX: -700 },
    ]);
    expect(getByTestId('trim-sheet-end-time').props.children).toBe('0:01.0');

    fireEvent.press(getByTestId('trim-sheet-done'));
    expect(props.onDone).toHaveBeenCalledWith({ startMs: 0, endMs: 1_000 });
  });

  it('ignores a pan that starts away from both handles', () => {
    const { getByTestId } = renderSheet({ initialRange: { startMs: 10_000, endMs: 50_000 } });

    drag([
      { state: State.BEGAN, x: 179, translationX: 0 },
      { state: State.ACTIVE, x: 179, translationX: 0 },
      { x: 220, translationX: 41 },
      { state: State.END, x: 220, translationX: 41 },
    ]);

    expect(getByTestId('trim-sheet-start-time').props.children).toBe('0:10.0');
    expect(getByTestId('trim-sheet-end-time').props.children).toBe('0:50.0');
  });

  it('starts from the composer range again each time it opens', () => {
    const props: TrimSheetProps = {
      visible: true,
      sourceUri: 'file:///audio-recordings/original.m4a',
      durationMs: DURATION_MS,
      energies: makeEnergies(),
      bucketMs: 100,
      initialRange: { startMs: 5_000, endMs: 30_000 },
      suggested: false,
      maxSelectionMs: 120_000,
      mustTrim: false,
      hasUserNote: false,
      onCancel: jest.fn(),
      onDone: jest.fn(),
    };
    const wrap = (visible: boolean) => (
      <SafeAreaProvider initialMetrics={{ frame: { height: 844, width: 390, x: 0, y: 0 }, insets: { bottom: 0, left: 0, right: 0, top: 0 } }}>
        <TrimSheet {...props} visible={visible} />
      </SafeAreaProvider>
    );
    const { getByTestId, rerender } = render(wrap(true));
    fireEvent(getByTestId('trim-sheet-track'), 'layout', { nativeEvent: { layout: { width: 358 } } });
    nudgeHandle('start', 'increment', getByTestId);
    expect(getByTestId('trim-sheet-start-time').props.children).toBe('0:05.5');

    rerender(wrap(false));
    rerender(wrap(true));

    expect(getByTestId('trim-sheet-start-time').props.children).toBe('0:05.0');
  });

  it('fires onDismissed from the Modal dismissal hand-off', () => {
    const onDismissed = jest.fn();
    const { UNSAFE_getByType } = renderSheet({ onDismissed });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Modal } = require('react-native');
    UNSAFE_getByType(Modal).props.onDismiss();
    expect(onDismissed).toHaveBeenCalledTimes(1);
  });

  it('on Android (no Modal.onDismiss) fires onDismissed once the sheet is told to close', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Platform } = require('react-native');
    const original = Platform.OS;
    Platform.OS = 'android';
    try {
      const onDismissed = jest.fn();
      const props: TrimSheetProps = {
        visible: true,
        sourceUri: 'file:///audio-recordings/original.m4a',
        durationMs: DURATION_MS,
        energies: makeEnergies(),
        bucketMs: 100,
        initialRange: { startMs: 0, endMs: DURATION_MS },
        suggested: false,
        maxSelectionMs: 120_000,
        mustTrim: false,
        hasUserNote: false,
        onCancel: jest.fn(),
        onDone: jest.fn(),
        onDismissed,
      };
      const wrap = (visible: boolean) => (
        <SafeAreaProvider initialMetrics={{ frame: { height: 844, width: 390, x: 0, y: 0 }, insets: { bottom: 0, left: 0, right: 0, top: 0 } }}>
          <TrimSheet {...props} visible={visible} />
        </SafeAreaProvider>
      );
      const { rerender } = render(wrap(true));
      expect(onDismissed).not.toHaveBeenCalled();
      rerender(wrap(false));
      expect(onDismissed).toHaveBeenCalledTimes(1);
    } finally {
      Platform.OS = original;
    }
  });
});
