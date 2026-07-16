import { act, fireEvent, render, within } from '@testing-library/react-native';
import { FlatList } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import CalendarScreen from '../../app/(app)/(tabs)/calendar';
import { useFamily } from '@/hooks/use-family';
import { useCalendarMemoriesInRange, useOldestMemoryDate } from '@/hooks/useCalendarMemories';
import * as calendarUtils from '@/utils/calendar';
import {
  buildCalendarWeekOffsets,
  buildCalendarWeeks,
  getCalendarFetchRange,
  getCalendarMonthOptions,
  getMonthJumpWeekIndex,
  getVisibleMonthLabel,
} from '@/utils/calendar';
import { toIsoDate } from '@/utils/dates';

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
}));

jest.mock('@/components/pending-memory-uploads-banner', () => ({
  PendingMemoryUploadsBanner: () => null,
}));

jest.mock('@/hooks/use-family', () => ({
  useFamily: jest.fn(),
}));

jest.mock('@/hooks/useCalendarMemories', () => ({
  useCalendarMemoriesInRange: jest.fn(),
  useOldestMemoryDate: jest.fn(),
}));

jest.mock('@/hooks/useMediaUrls', () => ({
  useMediaUrl: jest.fn(() => ({ url: null })),
}));

jest.mock('@/hooks/useVideoThumbnail', () => ({
  useVideoThumbnail: jest.fn(() => null),
}));

// The native Reanimated module cannot run in Jest -- same test double used
// by floating-tab-bar.test.tsx for the Today button's fade-in.
jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');

  return {
    __esModule: true,
    default: { View },
    FadeIn: { duration: () => ({}) },
  };
});

const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseCalendarMemoriesInRange = useCalendarMemoriesInRange as jest.MockedFunction<
  typeof useCalendarMemoriesInRange
>;
const mockedUseOldestMemoryDate = useOldestMemoryDate as jest.MockedFunction<typeof useOldestMemoryDate>;

function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <CalendarScreen />
    </SafeAreaProvider>,
  );
}

describe('Calendar month-jump', () => {
  let rafSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();

    mockedUseFamily.mockReturnValue({ role: 'manager' } as never);
    mockedUseCalendarMemoriesInRange.mockReturnValue({
      data: [],
      isRefetching: false,
      refetch: jest.fn(),
    } as never);

    // The jump handler schedules its scrollToIndex call inside
    // requestAnimationFrame; running the callback synchronously keeps
    // assertions in the same tick as the fireEvent that triggered it.
    rafSpy = jest
      .spyOn(global, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 0;
      });
  });

  afterEach(() => {
    rafSpy.mockRestore();
  });

  it('disables the month trigger and keeps the picker closed when there are no memories yet', () => {
    mockedUseOldestMemoryDate.mockReturnValue({
      data: null,
      isRefetching: false,
      refetch: jest.fn(),
    } as never);

    const { getByTestId, queryByTestId } = renderScreen();

    const trigger = getByTestId('calendar-month-trigger');
    expect(trigger.props.accessibilityState.disabled).toBe(true);

    fireEvent.press(trigger);

    expect(queryByTestId('month-picker-sheet')).toBeNull();
  });

  it('opens the picker with months bounded by the current month and the oldest memory month', () => {
    const now = new Date();
    const oldest = new Date(now.getFullYear(), now.getMonth() - 2, 15);
    const oldestIso = toIsoDate(oldest);

    mockedUseOldestMemoryDate.mockReturnValue({
      data: oldestIso,
      isRefetching: false,
      refetch: jest.fn(),
    } as never);

    const { getByTestId, queryByTestId } = renderScreen();

    const trigger = getByTestId('calendar-month-trigger');
    expect(trigger.props.accessibilityState.disabled).toBe(false);

    fireEvent.press(trigger);
    expect(queryByTestId('month-picker-sheet')).toBeTruthy();

    const expectedOptions = getCalendarMonthOptions(now, oldestIso);
    expect(expectedOptions.length).toBeGreaterThan(1);

    for (const option of expectedOptions) {
      expect(getByTestId(`month-picker-option-${option.iso}`)).toBeTruthy();
    }
  });

  it("jumps to the chosen month's NEWEST week (the divider row) and widens the fetch window to cover it", () => {
    const now = new Date();
    const oldest = new Date(now.getFullYear(), now.getMonth() - 3, 1);
    const oldestIso = toIsoDate(oldest);

    mockedUseOldestMemoryDate.mockReturnValue({
      data: oldestIso,
      isRefetching: false,
      refetch: jest.fn(),
    } as never);

    const scrollToIndexSpy = jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});

    const { getByTestId, queryByTestId } = renderScreen();

    fireEvent.press(getByTestId('calendar-month-trigger'));

    const targetOption = getCalendarMonthOptions(now, oldestIso).at(-1)!; // oldest selectable month
    fireEvent.press(getByTestId(`month-picker-option-${targetOption.iso}`));

    const weeks = buildCalendarWeeks({ referenceDate: now, oldestMemoryDate: oldestIso, minimumWeeks: 4 });
    // The semantic target: the first week in list order (newest) whose
    // month -- by the "month of its newest day" rule -- is the chosen one.
    // In this reverse-chronological ribbon that's where the month's divider
    // renders; the week containing the 1st is the month's OLDEST week and
    // would land the user at its tail end.
    const expectedIndex = weeks.findIndex((week) => {
      const end = new Date(`${week.endIso}T00:00:00`);
      return end.getFullYear() === targetOption.year && end.getMonth() === targetOption.month;
    });
    expect(expectedIndex).toBeGreaterThanOrEqual(0);
    expect(getMonthJumpWeekIndex(now, targetOption.year, targetOption.month)).toBe(expectedIndex);

    expect(scrollToIndexSpy).toHaveBeenCalledWith(
      expect.objectContaining({ index: expectedIndex, viewPosition: 0 }),
    );

    // The sheet closes once a month is picked.
    expect(queryByTestId('month-picker-sheet')).toBeNull();

    const expectedRange = getCalendarFetchRange(
      weeks,
      { startIndex: expectedIndex, endIndex: Math.min(expectedIndex + 3, weeks.length - 1) },
      4,
    );
    const lastCall = mockedUseCalendarMemoriesInRange.mock.calls.at(-1);
    expect(lastCall?.[0]).toEqual(expectedRange);

    scrollToIndexSpy.mockRestore();
  });

  it('stays inside the built weeks even when the oldest memory falls mid-month', () => {
    const now = new Date();
    // Oldest memory on the 15th: the week containing the 1st of that month
    // was never built, but the month's NEWEST week always is -- the jump
    // lands in-bounds without relying on the defensive clamp.
    const oldest = new Date(now.getFullYear(), now.getMonth() - 3, 15);
    const oldestIso = toIsoDate(oldest);

    mockedUseOldestMemoryDate.mockReturnValue({
      data: oldestIso,
      isRefetching: false,
      refetch: jest.fn(),
    } as never);

    const scrollToIndexSpy = jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});

    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('calendar-month-trigger'));

    const targetOption = getCalendarMonthOptions(now, oldestIso).at(-1)!;
    fireEvent.press(getByTestId(`month-picker-option-${targetOption.iso}`));

    const weeks = buildCalendarWeeks({ referenceDate: now, oldestMemoryDate: oldestIso, minimumWeeks: 4 });
    const rawIndex = getMonthJumpWeekIndex(now, targetOption.year, targetOption.month);
    expect(rawIndex).toBeLessThanOrEqual(weeks.length - 1);

    expect(scrollToIndexSpy).toHaveBeenCalledWith(
      expect.objectContaining({ index: rawIndex, viewPosition: 0 }),
    );

    scrollToIndexSpy.mockRestore();
  });

  describe('post-jump settle-and-correct', () => {
    const now = new Date();
    const oldest = new Date(now.getFullYear(), now.getMonth() - 3, 1);
    const oldestIso = toIsoDate(oldest);
    const weeks = buildCalendarWeeks({ referenceDate: now, oldestMemoryDate: oldestIso, minimumWeeks: 4 });

    function jumpToOldestOption(getByTestId: ReturnType<typeof renderScreen>['getByTestId']) {
      fireEvent.press(getByTestId('calendar-month-trigger'));
      const targetOption = getCalendarMonthOptions(now, oldestIso).at(-1)!;
      fireEvent.press(getByTestId(`month-picker-option-${targetOption.iso}`));
      return getMonthJumpWeekIndex(now, targetOption.year, targetOption.month);
    }

    // The settle signal: onMomentumScrollEnd reaches both our correction
    // handler and VirtualizedList's own scroll bookkeeping, so it goes
    // through act().
    function fireMomentumScrollEnd(getByTestId: ReturnType<typeof renderScreen>['getByTestId']) {
      act(() => {
        getByTestId('calendar-week-list').props.onMomentumScrollEnd();
      });
    }

    beforeEach(() => {
      mockedUseOldestMemoryDate.mockReturnValue({
        data: oldestIso,
        isRefetching: false,
        refetch: jest.fn(),
      } as never);
    });

    it("snaps to the target row's MEASURED offset when the landing differs from the estimate", () => {
      const scrollToIndexSpy = jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});
      const scrollToOffsetSpy = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {});
      const measureSpy = jest.spyOn(calendarUtils, 'measureCalendarWeekOffset');

      const { getByTestId } = renderScreen();

      const targetIndex = jumpToOldestOption(getByTestId);
      expect(scrollToIndexSpy).toHaveBeenCalledTimes(1);
      expect(scrollToIndexSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ animated: true, index: targetIndex }),
      );

      // The jump commanded the model's ESTIMATED offset; measured geometry
      // says the target row really sits 137px further down -- the constant
      // sub-row error an index-level comparison could never see.
      // (105 = the screen's list-header estimate; no onLayout fires in test.)
      const estimatedOffset = buildCalendarWeekOffsets(weeks, 105)[targetIndex]!;
      const measuredOffset = estimatedOffset + 137;
      measureSpy.mockImplementation((_view, _node, onResult) => onResult(measuredOffset));

      fireMomentumScrollEnd(getByTestId);

      // Final positioning uses measured geometry: scrollToOffset to the
      // measured pixel position -- NOT another scrollToIndex through the
      // same estimated getItemLayout model.
      expect(scrollToOffsetSpy).toHaveBeenCalledTimes(1);
      expect(scrollToOffsetSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ animated: false, offset: measuredOffset }),
      );
      expect(scrollToIndexSpy).toHaveBeenCalledTimes(1);

      // Next settle: measurement matches the corrected position -- landed.
      // Further settle signals are no-ops.
      fireMomentumScrollEnd(getByTestId);
      fireMomentumScrollEnd(getByTestId);

      expect(scrollToOffsetSpy).toHaveBeenCalledTimes(1);
      expect(scrollToIndexSpy).toHaveBeenCalledTimes(1);

      measureSpy.mockRestore();
      scrollToIndexSpy.mockRestore();
      scrollToOffsetSpy.mockRestore();
    });

    it('retries by index when the target row is not rendered, then snaps to the measured offset', () => {
      const scrollToIndexSpy = jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});
      const scrollToOffsetSpy = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {});
      const measureSpy = jest.spyOn(calendarUtils, 'measureCalendarWeekOffset');

      const { getByTestId } = renderScreen();

      const targetIndex = jumpToOldestOption(getByTestId);

      // First settle: the landing was far enough off that the target row
      // never rendered -- nothing to measure, so re-scroll by index to
      // bring it into the render window.
      measureSpy.mockImplementation((_view, _node, onResult) => onResult(null));
      fireMomentumScrollEnd(getByTestId);

      expect(scrollToIndexSpy).toHaveBeenCalledTimes(2);
      expect(scrollToIndexSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ animated: false, index: targetIndex, viewPosition: 0 }),
      );

      // Second settle: the row is rendered now -- snap to its measured
      // position.
      measureSpy.mockImplementation((_view, _node, onResult) => onResult(5120));
      fireMomentumScrollEnd(getByTestId);

      expect(scrollToOffsetSpy).toHaveBeenCalledTimes(1);
      expect(scrollToOffsetSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ animated: false, offset: 5120 }),
      );

      measureSpy.mockRestore();
      scrollToIndexSpy.mockRestore();
      scrollToOffsetSpy.mockRestore();
    });

    it('is bounded: at most two corrective scrolls even if measurements keep disagreeing', () => {
      const scrollToIndexSpy = jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});
      const scrollToOffsetSpy = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {});
      const measureSpy = jest.spyOn(calendarUtils, 'measureCalendarWeekOffset');

      const { getByTestId } = renderScreen();

      jumpToOldestOption(getByTestId);

      // Pathological: every measurement reports a different position.
      let measurement = 9000;
      measureSpy.mockImplementation((_view, _node, onResult) => onResult((measurement += 100)));

      fireMomentumScrollEnd(getByTestId); // pass 1: corrects
      fireMomentumScrollEnd(getByTestId); // pass 2: still moving, corrects
      fireMomentumScrollEnd(getByTestId); // exhausted: no-op
      fireMomentumScrollEnd(getByTestId); // still a no-op

      expect(scrollToOffsetSpy).toHaveBeenCalledTimes(2);
      expect(scrollToIndexSpy).toHaveBeenCalledTimes(1); // only the initial animated jump

      measureSpy.mockRestore();
      scrollToIndexSpy.mockRestore();
      scrollToOffsetSpy.mockRestore();
    });

    it('a manual drag cancels any pending correction -- the user always wins', () => {
      const scrollToIndexSpy = jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});
      const scrollToOffsetSpy = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {});
      const measureSpy = jest
        .spyOn(calendarUtils, 'measureCalendarWeekOffset')
        .mockImplementation((_view, _node, onResult) => onResult(9999));

      const { getByTestId } = renderScreen();

      jumpToOldestOption(getByTestId);

      act(() => {
        getByTestId('calendar-week-list').props.onScrollBeginDrag();
      });
      fireMomentumScrollEnd(getByTestId);

      // Only the initial animated jump -- no corrective scroll after a drag.
      expect(scrollToIndexSpy).toHaveBeenCalledTimes(1);
      expect(scrollToOffsetSpy).not.toHaveBeenCalled();

      measureSpy.mockRestore();
      scrollToIndexSpy.mockRestore();
      scrollToOffsetSpy.mockRestore();
    });
  });
});

describe('Calendar header -- visible month label and Today button', () => {
  let rafSpy: jest.SpyInstance;
  const now = new Date();
  const oldest = new Date(now.getFullYear(), now.getMonth() - 3, 1);
  const oldestIso = toIsoDate(oldest);
  const weeks = buildCalendarWeeks({ referenceDate: now, oldestMemoryDate: oldestIso, minimumWeeks: 4 });
  const scrolledIndex = weeks.length - 1; // oldest built week -- a different month than "this week"

  beforeEach(() => {
    jest.clearAllMocks();

    mockedUseFamily.mockReturnValue({ role: 'manager' } as never);
    mockedUseOldestMemoryDate.mockReturnValue({
      data: oldestIso,
      isRefetching: false,
      refetch: jest.fn(),
    } as never);
    mockedUseCalendarMemoriesInRange.mockReturnValue({
      data: [],
      isRefetching: false,
      refetch: jest.fn(),
    } as never);

    rafSpy = jest
      .spyOn(global, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 0;
      });
  });

  afterEach(() => {
    rafSpy.mockRestore();
  });

  function simulateTopVisibleIndex(getByTestId: ReturnType<typeof renderScreen>['getByTestId'], index: number) {
    const list = getByTestId('calendar-week-list');

    act(() => {
      list.props.onViewableItemsChanged({
        viewableItems: [{ index, isViewable: true, item: weeks[index], key: `${index}` }],
        changed: [],
      });
    });
  }

  it('renders the month label and Today button in a fixed bar outside the scrolling list', () => {
    const { getByTestId } = renderScreen();

    // The trigger lives in the pinned header bar, not inside the FlatList's
    // scrolled content -- so it cannot scroll away with the weeks.
    const fixedHeader = getByTestId('calendar-fixed-header');
    expect(within(fixedHeader).getByTestId('calendar-month-trigger')).toBeTruthy();
    expect(within(getByTestId('calendar-week-list')).queryByTestId('calendar-month-trigger')).toBeNull();

    simulateTopVisibleIndex(getByTestId, scrolledIndex);

    expect(within(getByTestId('calendar-fixed-header')).getByTestId('calendar-today-button')).toBeTruthy();
    expect(within(getByTestId('calendar-week-list')).queryByTestId('calendar-today-button')).toBeNull();
  });

  it('shows the current month and hides the Today button while "this week" is at the top', () => {
    const { getByText, queryByTestId } = renderScreen();

    expect(getByText(getVisibleMonthLabel(weeks, { startIndex: 0, endIndex: 0 }))).toBeTruthy();
    expect(queryByTestId('calendar-today-button')).toBeNull();
  });

  it("tracks the header label to the topmost visible week's month as the list scrolls", () => {
    const { getByTestId, getByText, queryByText } = renderScreen();

    const currentLabel = getVisibleMonthLabel(weeks, { startIndex: 0, endIndex: 0 });
    const scrolledLabel = getVisibleMonthLabel(weeks, { startIndex: scrolledIndex, endIndex: scrolledIndex });
    expect(scrolledLabel).not.toBe(currentLabel);

    simulateTopVisibleIndex(getByTestId, scrolledIndex);

    expect(getByText(scrolledLabel)).toBeTruthy();
    expect(queryByText(currentLabel)).toBeNull();
  });

  it('does not change the label when only the bottom of the visible range shifts (no flicker at boundaries)', () => {
    const { getByTestId, getByText } = renderScreen();
    const list = getByTestId('calendar-week-list');

    act(() => {
      list.props.onViewableItemsChanged({
        viewableItems: [
          { index: 0, isViewable: true, item: weeks[0], key: '0' },
          { index: 1, isViewable: true, item: weeks[1], key: '1' },
        ],
        changed: [],
      });
    });

    expect(getByText(getVisibleMonthLabel(weeks, { startIndex: 0, endIndex: 0 }))).toBeTruthy();
  });

  it('shows the Today button once scrolled away from the top, and tapping it scrolls to the exact top and resets the fetch window', () => {
    const scrollToOffsetSpy = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {});
    const scrollToIndexSpy = jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});

    const { getByTestId, queryByTestId } = renderScreen();

    simulateTopVisibleIndex(getByTestId, scrolledIndex);

    const todayButton = getByTestId('calendar-today-button');
    expect(todayButton).toBeTruthy();
    expect(todayButton.props.accessibilityLabel).toBe('Back to today');

    fireEvent.press(todayButton);

    // scrollToOffset(0) is the exact content top by definition -- unlike
    // month jumps it involves no height model, so it can't drift and needs
    // no settle-and-correct pass.
    expect(scrollToOffsetSpy).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 0 }),
    );
    act(() => {
      getByTestId('calendar-week-list').props.onMomentumScrollEnd();
    });
    expect(scrollToIndexSpy).not.toHaveBeenCalled();

    // Mirrors handleSelectMonth: the visible-week window resets to the top
    // immediately (not waiting on onViewableItemsChanged), so the range
    // fetch for "this week" kicks off right away.
    const expectedRange = getCalendarFetchRange(weeks, { startIndex: 0, endIndex: Math.min(3, weeks.length - 1) }, 4);
    const lastCall = mockedUseCalendarMemoriesInRange.mock.calls.at(-1);
    expect(lastCall?.[0]).toEqual(expectedRange);

    // The button disappears again once back at the top.
    expect(queryByTestId('calendar-today-button')).toBeNull();

    scrollToOffsetSpy.mockRestore();
    scrollToIndexSpy.mockRestore();
  });

  it('leaves the month-jump picker trigger working after the header gains the Today button', () => {
    const { getByTestId, queryByTestId } = renderScreen();

    simulateTopVisibleIndex(getByTestId, scrolledIndex);
    expect(getByTestId('calendar-today-button')).toBeTruthy();

    fireEvent.press(getByTestId('calendar-month-trigger'));

    expect(queryByTestId('month-picker-sheet')).toBeTruthy();
  });
});
