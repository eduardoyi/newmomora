import {
  buildCalendarWeekOffsets,
  buildCalendarWeeks,
  formatMonthBreakLabel,
  getCalendarFetchRange,
  getCalendarItemLayout,
  getCalendarMonthOptions,
  getCalendarWeekHeight,
  getCalendarWeekItemHeight,
  getMonthJumpWeekIndex,
  getVisibleMonthLabel,
  isMeasurableHostRef,
  JUMP_OFFSET_TOLERANCE_PX,
  MAX_JUMP_CORRECTION_PASSES,
  measureCalendarWeekOffset,
  resolveCalendarJumpCorrection,
  startCalendarJumpCorrection,
} from '@/utils/calendar';

describe('calendar utilities', () => {
  const referenceDate = new Date('2026-06-10T12:00:00');

  it('builds week rows back to the oldest memory week', () => {
    const weeks = buildCalendarWeeks({
      referenceDate,
      oldestMemoryDate: '2026-04-20',
      minimumWeeks: 4,
    });

    expect(weeks[0]?.label).toBe('this week');
    expect(weeks[0]?.days.map((day) => day.iso)).toEqual([
      '2026-06-10',
      '2026-06-09',
      '2026-06-08',
    ]);
    expect(weeks.at(-1)?.startIso).toBe('2026-04-20');
  });

  it('labels each week with its absolute date range', () => {
    const weeks = buildCalendarWeeks({
      referenceDate,
      oldestMemoryDate: '2026-04-20',
      minimumWeeks: 4,
    });

    expect(weeks[0]?.rangeLabel).toBe('Jun 8–10');
    expect(weeks[2]?.rangeLabel).toBe('May 25–31');
    expect(weeks[6]?.rangeLabel).toBe('Apr 27 – May 3');
  });

  it('marks a month break on the first week whose newest day enters an older month', () => {
    const weeks = buildCalendarWeeks({
      referenceDate,
      oldestMemoryDate: '2026-04-20',
      minimumWeeks: 4,
    });

    // Current-year breaks stay bare month names -- the year is only added
    // once a break crosses into a different year (see the test below).
    expect(weeks.map((week) => week.monthBreak)).toEqual([
      null,
      null,
      'May',
      null,
      null,
      null,
      null,
      'April',
    ]);
  });

  it('includes the year on month breaks that fall outside the reference year', () => {
    const weeks = buildCalendarWeeks({
      referenceDate: new Date('2026-01-15T12:00:00'),
      oldestMemoryDate: '2025-12-20',
      minimumWeeks: 4,
    });

    // Weeks run Jan 12-15, Jan 5-11, Dec 29-Jan 4 (newest day still
    // January), Dec 22-28 (first week fully in December -- the break), then
    // Dec 15-21.
    expect(weeks.map((week) => week.monthBreak)).toEqual([
      null,
      null,
      null,
      'December 2025',
      null,
    ]);
  });

  it('keeps a short fallback range when there are no memories yet', () => {
    const weeks = buildCalendarWeeks({
      referenceDate,
      oldestMemoryDate: null,
      minimumWeeks: 4,
    });

    expect(weeks).toHaveLength(4);
    expect(weeks.at(-1)?.startIso).toBe('2026-05-18');
  });

  it('returns a bounded fetch range around visible week rows', () => {
    const weeks = buildCalendarWeeks({
      referenceDate,
      oldestMemoryDate: '2026-04-20',
      minimumWeeks: 4,
    });

    expect(getCalendarFetchRange(weeks, { startIndex: 2, endIndex: 3 }, 1)).toEqual({
      startDate: '2026-05-11',
      endDate: '2026-06-07',
    });
  });
});

describe('calendar month-jump utilities', () => {
  const referenceDate = new Date('2026-06-10T12:00:00');

  describe('getCalendarMonthOptions', () => {
    it('lists months from the current month back to the oldest memory month, newest first', () => {
      const options = getCalendarMonthOptions(referenceDate, '2026-04-20');

      expect(options).toEqual([
        { year: 2026, month: 5, label: 'June', iso: '2026-06-01', isCurrent: true },
        { year: 2026, month: 4, label: 'May', iso: '2026-05-01', isCurrent: false },
        { year: 2026, month: 3, label: 'April', iso: '2026-04-01', isCurrent: false },
      ]);
    });

    it('spans a year boundary when the oldest memory is in a prior year', () => {
      const options = getCalendarMonthOptions(referenceDate, '2025-11-05');

      expect(options.map((option) => `${option.year}-${option.month}`)).toEqual([
        '2026-5',
        '2026-4',
        '2026-3',
        '2026-2',
        '2026-1',
        '2026-0',
        '2025-11', // December 2025
        '2025-10', // November 2025 -- the oldest memory's month (boundary, inclusive)
      ]);
    });

    it('returns only the current month when there are no memories yet', () => {
      expect(getCalendarMonthOptions(referenceDate, null)).toEqual([
        { year: 2026, month: 5, label: 'June', iso: '2026-06-01', isCurrent: true },
      ]);
      expect(getCalendarMonthOptions(referenceDate, undefined)).toHaveLength(1);
    });
  });

  describe('getMonthJumpWeekIndex', () => {
    it('resolves the current month to index 0', () => {
      expect(getMonthJumpWeekIndex(referenceDate, 2026, 5)).toBe(0);
      expect(getMonthJumpWeekIndex(new Date('2026-06-02T12:00:00'), 2026, 5)).toBe(0);
      // Month-end edge: on Jun 30 the current week's Sunday falls in July,
      // but week 0's newest day is today (June), so June still resolves to
      // the top row.
      expect(getMonthJumpWeekIndex(new Date('2026-06-30T12:00:00'), 2026, 5)).toBe(0);
    });

    it("resolves a past month to its NEWEST week -- the row where the month's divider renders", () => {
      const weeks = buildCalendarWeeks({ referenceDate, oldestMemoryDate: '2026-04-20', minimumWeeks: 4 });

      // Matches the month-break fixture above: the 'May' divider renders at
      // index 2 (week May 25-31) and the 'April' divider at index 7 (week
      // Apr 20-26). Landing on the divider row puts the entire selected
      // month BELOW the viewport top -- the week containing the 1st would
      // be the month's oldest week instead, stranding the user at its tail.
      expect(getMonthJumpWeekIndex(referenceDate, 2026, 4)).toBe(2);
      expect(weeks[2]?.monthBreak).toBe('May');

      expect(getMonthJumpWeekIndex(referenceDate, 2026, 3)).toBe(7);
      expect(weeks[7]?.monthBreak).toBe('April');
    });

    it('skips weeks that straddle into the following month', () => {
      // Week index 6 (Apr 27 - May 3) contains April days but belongs to
      // May by the newest-day rule -- April's newest week is index 7.
      const weeks = buildCalendarWeeks({ referenceDate, oldestMemoryDate: '2026-04-20', minimumWeeks: 4 });

      expect(weeks[6]?.startIso).toBe('2026-04-27');
      expect(weeks[6]?.endIso).toBe('2026-05-03');
      expect(getMonthJumpWeekIndex(referenceDate, 2026, 3)).toBe(7);
    });

    it('always lands inside the built weeks for every month the picker offers', () => {
      // A month's newest week is never older than the week of any date in
      // that month, so months bounded by the oldest memory date always have
      // a built row -- even when the oldest memory falls mid-month.
      for (const oldestIso of ['2026-04-20', '2026-04-01', '2025-11-05']) {
        const weeks = buildCalendarWeeks({ referenceDate, oldestMemoryDate: oldestIso, minimumWeeks: 4 });

        for (const option of getCalendarMonthOptions(referenceDate, oldestIso)) {
          const index = getMonthJumpWeekIndex(referenceDate, option.year, option.month);

          expect(index).toBeGreaterThanOrEqual(0);
          expect(index).toBeLessThanOrEqual(weeks.length - 1);

          // Semantic check: the landed week belongs to the chosen month.
          const end = new Date(`${weeks[index]!.endIso}T00:00:00`);
          expect(end.getFullYear()).toBe(option.year);
          expect(end.getMonth()).toBe(option.month);
        }
      }
    });
  });

  describe('week item layout helpers', () => {
    const weeks = buildCalendarWeeks({ referenceDate, oldestMemoryDate: '2026-04-20', minimumWeeks: 4 });

    it('gives month-break weeks extra height over a same-size week without one', () => {
      const weekWithBreak = weeks[2]!; // 'May 2026' break, per the suite above
      const weekWithoutBreak = weeks[3]!;

      expect(weekWithBreak.monthBreak).not.toBeNull();
      expect(weekWithoutBreak.monthBreak).toBeNull();
      expect(weekWithBreak.days).toHaveLength(weekWithoutBreak.days.length);
      expect(getCalendarWeekItemHeight(weekWithBreak)).toBeGreaterThan(
        getCalendarWeekItemHeight(weekWithoutBreak),
      );
    });

    it('gives "this week" a shorter height than a full 7-day week when fewer days have occurred', () => {
      expect(weeks[0]!.days.length).toBeLessThan(7);
      expect(getCalendarWeekItemHeight(weeks[0]!)).toBeLessThan(getCalendarWeekItemHeight(weeks[1]!));
    });

    it('builds strictly increasing cumulative offsets matching each week height', () => {
      const offsets = buildCalendarWeekOffsets(weeks);

      expect(offsets).toHaveLength(weeks.length);
      expect(offsets[0]).toBe(0);

      for (let i = 1; i < weeks.length; i += 1) {
        expect(offsets[i]).toBe(offsets[i - 1]! + getCalendarWeekItemHeight(weeks[i - 1]!));
      }
    });

    it('produces a getItemLayout-shaped result for a given index', () => {
      const offsets = buildCalendarWeekOffsets(weeks);
      const layout = getCalendarItemLayout(weeks, offsets, 3);

      expect(layout).toEqual({
        index: 3,
        offset: offsets[3],
        length: getCalendarWeekItemHeight(weeks[3]!),
      });
    });

    it('is defensive about out-of-range indices', () => {
      const offsets = buildCalendarWeekOffsets(weeks);

      expect(getCalendarItemLayout(weeks, offsets, weeks.length + 5)).toEqual({
        index: weeks.length + 5,
        offset: 0,
        length: 0,
      });
    });

    it('starts offsets at the list-header height so they live in content coordinates', () => {
      // getItemLayout offsets span the ListHeaderComponent -- omitting it
      // shifts every scrollToIndex landing by the header height.
      const plain = buildCalendarWeekOffsets(weeks);
      const withHeader = buildCalendarWeekOffsets(weeks, 105);

      expect(plain[0]).toBe(0);
      expect(withHeader[0]).toBe(105);
      expect(withHeader.map((offset, i) => offset - plain[i]!)).toEqual(weeks.map(() => 105));
    });

    it('prefers a measured real height over the static estimate', () => {
      const measured = new Map([[weeks[1]!.startIso, 999]]);

      expect(getCalendarWeekHeight(weeks[1]!, measured)).toBe(999);
      expect(getCalendarWeekHeight(weeks[2]!, measured)).toBe(getCalendarWeekItemHeight(weeks[2]!));

      // Offsets after the measured week shift by the estimate/measured delta.
      const plain = buildCalendarWeekOffsets(weeks);
      const corrected = buildCalendarWeekOffsets(weeks, 0, measured);
      const delta = 999 - getCalendarWeekItemHeight(weeks[1]!);

      expect(corrected[1]).toBe(plain[1]);
      expect(corrected[2]).toBe(plain[2]! + delta);

      // getItemLayout length follows the same override.
      expect(getCalendarItemLayout(weeks, corrected, 1, measured).length).toBe(999);
    });
  });

  describe('post-jump settle-and-correct', () => {
    it('starts with the bounded number of passes and records the commanded (estimated) offset', () => {
      expect(startCalendarJumpCorrection(12, 4200)).toEqual({
        targetIndex: 12,
        attemptsLeft: MAX_JUMP_CORRECTION_PASSES,
        lastCommandedOffset: 4200,
      });
      expect(startCalendarJumpCorrection(12).lastCommandedOffset).toBeNull();
      expect(MAX_JUMP_CORRECTION_PASSES).toBe(2);
    });

    it('does nothing with no pending correction', () => {
      expect(resolveCalendarJumpCorrection(null, 4200)).toEqual({
        scrollToOffset: null,
        retryIndex: null,
        next: null,
      });
    });

    it('corrects to the MEASURED pixel offset when it differs from what was commanded', () => {
      // The jump commanded the model's estimate (4200); the target row
      // actually sits at 4337 -- a constant sub-row error an index-level
      // check could never see. The correction scrolls to the measured
      // position, not back to the estimate.
      const pending = startCalendarJumpCorrection(12, 4200);

      expect(resolveCalendarJumpCorrection(pending, 4337)).toEqual({
        scrollToOffset: 4337,
        retryIndex: null,
        next: { targetIndex: 12, attemptsLeft: 1, lastCommandedOffset: 4337 },
      });
    });

    it('confirms the landing when the measurement matches the commanded offset within tolerance', () => {
      const pending = { targetIndex: 12, attemptsLeft: 1, lastCommandedOffset: 4337 };

      expect(resolveCalendarJumpCorrection(pending, 4337)).toEqual({
        scrollToOffset: null,
        retryIndex: null,
        next: null,
      });
      expect(
        resolveCalendarJumpCorrection(pending, 4337 + JUMP_OFFSET_TOLERANCE_PX).scrollToOffset,
      ).toBeNull();
      // Beyond tolerance: still corrects.
      expect(
        resolveCalendarJumpCorrection(pending, 4337 + JUMP_OFFSET_TOLERANCE_PX + 1).scrollToOffset,
      ).toBe(4337 + JUMP_OFFSET_TOLERANCE_PX + 1);
    });

    it('never confirms against a missing commanded offset', () => {
      // No baseline to compare against -> treat as unconfirmed and snap to
      // the measured position.
      expect(resolveCalendarJumpCorrection(startCalendarJumpCorrection(12), 4337).scrollToOffset).toBe(4337);
    });

    it('retries by index when the target row is not rendered/measurable', () => {
      const pending = startCalendarJumpCorrection(12, 4200);

      expect(resolveCalendarJumpCorrection(pending, null)).toEqual({
        scrollToOffset: null,
        retryIndex: 12,
        next: { targetIndex: 12, attemptsLeft: 1, lastCommandedOffset: 4200 },
      });
    });

    it('is bounded: stops for good once the passes are exhausted', () => {
      const exhausted = { targetIndex: 12, attemptsLeft: 0, lastCommandedOffset: 4337 };

      expect(resolveCalendarJumpCorrection(exhausted, 9999)).toEqual({
        scrollToOffset: null,
        retryIndex: null,
        next: null,
      });
      expect(resolveCalendarJumpCorrection(exhausted, null)).toEqual({
        scrollToOffset: null,
        retryIndex: null,
        next: null,
      });
    });
  });

  describe('measureCalendarWeekOffset', () => {
    // A host-component instance, as returned by getInnerViewRef() -- what
    // Fabric's measureLayout requires as the relativeTo argument.
    const innerViewRef = { __fakeHostInstance: true };

    it('reports the measured y position in content coordinates', () => {
      const onResult = jest.fn();
      const weekView = {
        measureLayout: jest.fn(
          (_ref: object, onSuccess: (x: number, y: number) => void) => onSuccess(0, 4337),
        ),
      };

      measureCalendarWeekOffset(weekView, innerViewRef, onResult);

      expect(weekView.measureLayout).toHaveBeenCalledWith(
        innerViewRef,
        expect.any(Function),
        expect.any(Function),
      );
      expect(onResult).toHaveBeenCalledWith(4337);
    });

    it('never calls measureLayout with a node HANDLE instead of a host ref (Fabric regression)', () => {
      // getInnerViewNode()/findNodeHandle() return numeric handles, which
      // Fabric rejects at runtime ("ref.measureLayout must be called with a
      // ref to a native component") -- a handle must degrade to null, not
      // reach measureLayout.
      const onResult = jest.fn();
      const measureLayout = jest.fn();

      measureCalendarWeekOffset({ measureLayout }, 7, onResult);
      measureCalendarWeekOffset({ measureLayout }, 'node-7', onResult);

      expect(measureLayout).not.toHaveBeenCalled();
      expect(onResult).toHaveBeenCalledTimes(2);
      expect(onResult.mock.calls.every(([value]) => value === null)).toBe(true);

      expect(isMeasurableHostRef(7)).toBe(false);
      expect(isMeasurableHostRef(null)).toBe(false);
      expect(isMeasurableHostRef(innerViewRef)).toBe(true);
    });

    it('reports null when the row, ref, or measurement API is unavailable', () => {
      const onResult = jest.fn();

      measureCalendarWeekOffset(null, innerViewRef, onResult);
      measureCalendarWeekOffset({}, innerViewRef, onResult);
      measureCalendarWeekOffset({ measureLayout: jest.fn() }, null, onResult);

      expect(onResult).toHaveBeenCalledTimes(3);
      expect(onResult.mock.calls.every(([value]) => value === null)).toBe(true);
    });

    it('reports null when native measurement fails', () => {
      const onResult = jest.fn();
      const weekView = {
        measureLayout: jest.fn(
          (_ref: object, _onSuccess: (x: number, y: number) => void, onFail?: () => void) => onFail?.(),
        ),
      };

      measureCalendarWeekOffset(weekView, innerViewRef, onResult);

      expect(onResult).toHaveBeenCalledWith(null);
    });
  });

  describe('formatMonthBreakLabel', () => {
    it('keeps current-year dividers as bare month names', () => {
      expect(formatMonthBreakLabel(new Date('2026-05-31T12:00:00'), referenceDate)).toBe('May');
      expect(formatMonthBreakLabel(new Date('2026-01-04T12:00:00'), referenceDate)).toBe('January');
    });

    it('appends the year once the divider month falls outside the reference year', () => {
      expect(formatMonthBreakLabel(new Date('2025-12-28T12:00:00'), referenceDate)).toBe('December 2025');
      expect(formatMonthBreakLabel(new Date('2024-07-31T12:00:00'), referenceDate)).toBe('July 2024');
    });
  });

  describe('getVisibleMonthLabel', () => {
    // Reuses the fixture from the "marks a month break" test above: weeks[0]
    // and weeks[1] are June, weeks[2]-weeks[6] are May (break at index 2),
    // weeks[7] is April (break at index 7).
    const weeks = buildCalendarWeeks({ referenceDate, oldestMemoryDate: '2026-04-20', minimumWeeks: 4 });

    it('labels the current month when the topmost visible week is "this week"', () => {
      expect(getVisibleMonthLabel(weeks, { startIndex: 0, endIndex: 0 })).toBe('June 2026');
    });

    it('always includes the year, even for current-year months (unlike month-break dividers)', () => {
      // The header is the persistent "where am I" anchor, so it never drops
      // the year -- contrast with formatMonthBreakLabel, which keeps
      // current-year dividers bare.
      expect(getVisibleMonthLabel(weeks, { startIndex: 2, endIndex: 2 })).toBe('May 2026');
      expect(formatMonthBreakLabel(new Date('2026-05-31T12:00:00'), referenceDate)).toBe('May');
    });

    it('labels a past month once the topmost visible week has scrolled into it', () => {
      expect(getVisibleMonthLabel(weeks, { startIndex: 2, endIndex: 2 })).toBe('May 2026');
      expect(getVisibleMonthLabel(weeks, { startIndex: 7, endIndex: 7 })).toBe('April 2026');
    });

    it('derives the label from only the topmost index, ignoring how far the range extends below it', () => {
      // Topmost visible row is still week 0 (June) even though the visible
      // range extends down into the May rows -- this is what keeps the
      // label stable/non-flickering as more rows enter view below the top.
      expect(getVisibleMonthLabel(weeks, { startIndex: 0, endIndex: 5 })).toBe('June 2026');
      expect(getVisibleMonthLabel(weeks, { startIndex: 2, endIndex: 6 })).toBe('May 2026');
    });

    it('is defensive about a reversed or out-of-range visible range', () => {
      // Order-agnostic: the smaller index always wins, regardless of which
      // field it's passed in.
      expect(getVisibleMonthLabel(weeks, { startIndex: 5, endIndex: 2 })).toBe(
        getVisibleMonthLabel(weeks, { startIndex: 2, endIndex: 5 }),
      );
      // An index past the end of the array has no corresponding week, so
      // this falls back to the first (current) week rather than throwing.
      expect(getVisibleMonthLabel(weeks, { startIndex: weeks.length + 10, endIndex: weeks.length + 10 }))
        .toBe(getVisibleMonthLabel(weeks, { startIndex: 0, endIndex: 0 }));
    });

    it('returns an empty label when there are no weeks to describe', () => {
      expect(getVisibleMonthLabel([], { startIndex: 0, endIndex: 0 })).toBe('');
    });
  });
});
