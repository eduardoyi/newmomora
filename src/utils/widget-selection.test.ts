import {
  WIDGET_LEASE_MS,
  WIDGET_DAYTIME_TIMELINE_ENTRY_LIMIT,
  WIDGET_TIMELINE_SLOT_COUNT,
  buildWidgetTimeline,
  classifyWidgetAgeBand,
  selectWidgetMemorySlots,
  widgetLocalDateAt,
  widgetNextLocalDaytimeBoundary,
  widgetNextLocalMidnight,
  widgetTimelineIsExpired,
} from '@/utils/widget-selection';

function candidate(
  id: string,
  memoryDate: string,
  ageBand?: 'recent' | 'medium' | 'old' | 'deep',
) {
  return { id, memoryDate, ageBand };
}

describe('widget age bands', () => {
  it('puts future and recent dates in the recent band', () => {
    expect(classifyWidgetAgeBand('2026-09-15', '2026-09-15')).toBe('recent');
    expect(classifyWidgetAgeBand('2026-09-20', '2026-09-15')).toBe('recent');
    expect(classifyWidgetAgeBand('2026-06-18', '2026-09-15')).toBe('recent');
  });

  it('uses strict calendar cutoffs for 90 days, 18 months, and 36 months', () => {
    expect(classifyWidgetAgeBand('2026-06-17', '2026-09-15')).toBe('medium');
    expect(classifyWidgetAgeBand('2025-03-15', '2026-09-15')).toBe('old');
    expect(classifyWidgetAgeBand('2023-09-15', '2026-09-15')).toBe('deep');
    expect(classifyWidgetAgeBand('not-a-date', '2026-09-15')).toBeNull();
  });
});

describe('selectWidgetMemorySlots', () => {
  const baseOptions = {
    familyId: 'family-1',
    familyDate: '2026-09-15',
  };

  it('returns no slots for an empty or invalid candidate list', () => {
    expect(selectWidgetMemorySlots({ ...baseOptions, candidates: [] })).toEqual([]);
    expect(
      selectWidgetMemorySlots({
        ...baseOptions,
        candidates: [candidate('bad', '2026-99-99')],
      }),
    ).toEqual([]);
  });

  it('keeps one saved memory useful by repeating it across seven slots', () => {
    const slots = selectWidgetMemorySlots({
      ...baseOptions,
      candidates: [candidate('memory-1', '2026-09-15')],
    });

    expect(slots).toHaveLength(WIDGET_TIMELINE_SLOT_COUNT);
    expect(new Set(slots.map((slot) => slot.memoryId))).toEqual(new Set(['memory-1']));
    expect(slots.map((slot) => slot.slotIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('bounds the candidate and slot inputs to the widget contract', () => {
    const candidates = Array.from({ length: 45 }, (_, index) =>
      candidate(`memory-${index}`, '2026-09-15', 'recent'),
    );
    const slots = selectWidgetMemorySlots({
      ...baseOptions,
      candidates,
      slotCount: 99,
    });
    expect(slots).toHaveLength(7);
    expect(new Set(slots.map((slot) => slot.memoryId)).size).toBe(7);

    const timeline = buildWidgetTimeline({
      verifiedAt: '2026-09-15T12:00:00.000Z',
      timezoneName: 'UTC',
      slots: Array.from({ length: 10 }, (_, slotIndex) => ({
        slotIndex,
        memoryId: `memory-${slotIndex}`,
      })),
    });
    expect(timeline?.entries).toHaveLength(7);
  });

  it('alternates non-empty age bands and avoids duplicate IDs until exhausted', () => {
    const slots = selectWidgetMemorySlots({
      ...baseOptions,
      candidates: [
        candidate('recent-1', '2026-09-15', 'recent'),
        candidate('recent-2', '2026-09-14', 'recent'),
        candidate('medium-1', '2025-10-01', 'medium'),
        candidate('old-1', '2024-01-01', 'old'),
        candidate('deep-1', '2020-01-01', 'deep'),
      ],
    });

    expect(new Set(slots.slice(0, 5).map((slot) => slot.memoryId)).size).toBe(5);
    expect(slots).toHaveLength(7);
    expect(slots[5].memoryId).toBe(slots[0].memoryId);
    expect(slots[6].memoryId).toBe(slots[1].memoryId);
  });

  it('is deterministic for the same family/date and varies with the date', () => {
    const candidates = [
      candidate('a', '2026-09-15', 'recent'),
      candidate('b', '2025-01-01', 'medium'),
      candidate('c', '2023-01-01', 'old'),
      candidate('d', '2020-01-01', 'deep'),
    ];
    const first = selectWidgetMemorySlots({ ...baseOptions, candidates });
    const second = selectWidgetMemorySlots({ ...baseOptions, candidates });
    const nextDay = selectWidgetMemorySlots({
      ...baseOptions,
      familyDate: '2026-09-16',
      candidates,
    });

    expect(second).toEqual(first);
    expect(nextDay.map((slot) => slot.memoryId)).not.toEqual(first.map((slot) => slot.memoryId));
  });

  it('defers recent scheduled IDs when fresh candidates exist, then relaxes the preference', () => {
    const slots = selectWidgetMemorySlots({
      ...baseOptions,
      recentScheduledIds: ['recent-1', 'medium-1'],
      candidates: [
        candidate('recent-1', '2026-09-15', 'recent'),
        candidate('recent-2', '2026-09-14', 'recent'),
        candidate('medium-1', '2025-10-01', 'medium'),
        candidate('medium-2', '2025-09-30', 'medium'),
      ],
    });

    const ids = slots.map((slot) => slot.memoryId);
    expect(ids.slice(0, 2)).toEqual(expect.arrayContaining(['recent-2', 'medium-2']));
    expect(new Set(ids.slice(0, 4)).size).toBe(4);
    expect(ids.slice(4)).toEqual(ids.slice(0, 3));
  });

  it('deduplicates IDs before applying the repeat rule', () => {
    const slots = selectWidgetMemorySlots({
      ...baseOptions,
      candidates: [
        candidate('same', '2026-09-15', 'recent'),
        candidate('same', '2026-09-14', 'recent'),
        candidate('other', '2025-01-01', 'medium'),
      ],
    });
    expect(new Set(slots.slice(0, 2).map((slot) => slot.memoryId)).size).toBe(2);
  });
});

describe('widget timezone timeline', () => {
  it('uses the validated timezone for local date and next-midnight boundaries', () => {
    const instant = '2026-09-15T23:30:00.000Z';
    expect(widgetLocalDateAt(instant, 'America/New_York')).toBe('2026-09-15');
    expect(widgetLocalDateAt(instant, 'not/a-timezone')).toBe('2026-09-15');
    expect(widgetNextLocalMidnight(instant, 'America/New_York')?.toISOString()).toBe(
      '2026-09-16T04:00:00.000Z',
    );
    expect(widgetNextLocalMidnight('2026-09-05T16:00:00.000Z', 'America/Santiago')?.toISOString()).toBe(
      '2026-09-06T04:00:00.000Z',
    );
    expect(widgetNextLocalMidnight('2026-09-05T16:00:00.000Z', 'America/Sao_Paulo')?.toISOString()).toBe(
      '2026-09-06T03:00:00.000Z',
    );
    expect(widgetNextLocalMidnight('2026-03-28T12:00:00.000Z', 'Europe/Lisbon')?.toISOString()).toBe(
      '2026-03-29T00:00:00.000Z',
    );
  });

  it('handles leap-day local dates without losing the next calendar day', () => {
    const next = widgetNextLocalMidnight('2024-02-29T12:00:00.000Z', 'UTC');
    expect(next?.toISOString()).toBe('2024-03-01T00:00:00.000Z');
  });

  it('keeps the lease exactly 168 elapsed hours over spring DST', () => {
    const timeline = buildWidgetTimeline({
      verifiedAt: '2026-03-07T17:00:00.000Z',
      timezoneName: 'America/New_York',
      slots: Array.from({ length: 7 }, (_, slotIndex) => ({
        slotIndex,
        memoryId: `memory-${slotIndex}`,
      })),
    });

    expect(timeline).not.toBeNull();
    expect(new Date(timeline!.expiresAt).getTime() - new Date(timeline!.verifiedAt).getTime()).toBe(
      WIDGET_LEASE_MS,
    );
    expect(timeline!.entries.map((entry) => entry.localDate)).toEqual([
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
      '2026-03-10',
      '2026-03-11',
      '2026-03-12',
      '2026-03-13',
    ]);
  });

  it('keeps the lease exactly 168 elapsed hours over fall DST and holds slot seven to expiry', () => {
    const timeline = buildWidgetTimeline({
      verifiedAt: '2026-10-31T16:00:00.000Z',
      timezoneName: 'America/New_York',
      slots: Array.from({ length: 7 }, (_, slotIndex) => ({
        slotIndex,
        memoryId: `memory-${slotIndex}`,
      })),
    });

    expect(timeline).not.toBeNull();
    const expiry = new Date(timeline!.expiresAt).getTime();
    expect(expiry - new Date(timeline!.verifiedAt).getTime()).toBe(WIDGET_LEASE_MS);
    expect(timeline!.entries).toHaveLength(7);
    expect(timeline!.entries[6].endsAt).toBe(timeline!.expiresAt);
    expect(widgetTimelineIsExpired(timeline!, new Date(expiry - 1))).toBe(false);
    expect(widgetTimelineIsExpired(timeline!, new Date(expiry))).toBe(true);
  });

  it('starts slot one immediately and later slots at successive local midnights', () => {
    const timeline = buildWidgetTimeline({
      verifiedAt: '2026-09-15T12:00:00.000Z',
      timezoneName: 'UTC',
      slots: [
        { slotIndex: 0, memoryId: 'a' },
        { slotIndex: 1, memoryId: 'b' },
        { slotIndex: 2, memoryId: 'c' },
      ],
    });

    expect(timeline?.entries.map((entry) => entry.startsAt)).toEqual([
      '2026-09-15T12:00:00.000Z',
      '2026-09-16T00:00:00.000Z',
      '2026-09-17T00:00:00.000Z',
    ]);
    expect(timeline?.entries[2].endsAt).toBe('2026-09-22T12:00:00.000Z');
  });

  it('uses every strict daytime boundary and reaches the full spring-DST lease', () => {
    const verifiedAt = '2026-03-02T12:30:00.000Z';
    const timeline = buildWidgetTimeline({
      verifiedAt,
      timezoneName: 'America/New_York',
      maxTimelineEntries: WIDGET_DAYTIME_TIMELINE_ENTRY_LIMIT,
      slots: Array.from({ length: 7 }, (_, slotIndex) => ({
        slotIndex,
        memoryId: `memory-${slotIndex}`,
      })),
    });

    expect(timeline).not.toBeNull();
    expect(timeline!.entries).toHaveLength(23);
    expect(new Date(timeline!.expiresAt).getTime() - Date.parse(verifiedAt)).toBe(WIDGET_LEASE_MS);
    expect(timeline!.entries[0].startsAt).toBe(verifiedAt);
    expect(timeline!.entries[1].startsAt).toBe('2026-03-02T13:00:00.000Z');
    expect(timeline!.entries.some((entry) => entry.startsAt === '2026-03-08T12:00:00.000Z')).toBe(true);
    expect(timeline!.entries.every((entry) => Date.parse(entry.startsAt) < Date.parse(timeline!.expiresAt))).toBe(true);
    expect(timeline!.entries.at(-1)?.endsAt).toBe(timeline!.expiresAt);
  });

  it('keeps the fall-DST lease covered without scheduling past expiry', () => {
    const verifiedAt = '2026-10-26T11:30:00.000Z';
    const timeline = buildWidgetTimeline({
      verifiedAt,
      timezoneName: 'America/New_York',
      maxTimelineEntries: WIDGET_DAYTIME_TIMELINE_ENTRY_LIMIT,
      slots: Array.from({ length: 7 }, (_, slotIndex) => ({
        slotIndex,
        memoryId: `memory-${slotIndex}`,
      })),
    });

    expect(timeline).not.toBeNull();
    expect(timeline!.entries).toHaveLength(22);
    expect(timeline!.entries.every((entry) => Date.parse(entry.startsAt) < Date.parse(timeline!.expiresAt))).toBe(true);
    expect(timeline!.entries.at(-1)?.endsAt).toBe(timeline!.expiresAt);
    expect(widgetTimelineIsExpired(timeline!, new Date(Date.parse(timeline!.expiresAt) - 1))).toBe(false);
    expect(widgetTimelineIsExpired(timeline!, timeline!.expiresAt)).toBe(true);
  });

  it('starts before-eight, after-six, and exact-eight validations at strict boundaries', () => {
    const slots = [{ slotIndex: 0, memoryId: 'a' }, { slotIndex: 1, memoryId: 'b' }];
    const beforeEight = buildWidgetTimeline({
      verifiedAt: '2026-09-15T06:30:00.000Z',
      timezoneName: 'UTC',
      maxTimelineEntries: WIDGET_DAYTIME_TIMELINE_ENTRY_LIMIT,
      slots,
    });
    const afterSix = buildWidgetTimeline({
      verifiedAt: '2026-09-15T19:30:00.000Z',
      timezoneName: 'UTC',
      maxTimelineEntries: WIDGET_DAYTIME_TIMELINE_ENTRY_LIMIT,
      slots,
    });
    const exactEight = buildWidgetTimeline({
      verifiedAt: '2026-09-15T08:00:00.000Z',
      timezoneName: 'UTC',
      maxTimelineEntries: WIDGET_DAYTIME_TIMELINE_ENTRY_LIMIT,
      slots,
    });

    expect(beforeEight?.entries[1].startsAt).toBe('2026-09-15T08:00:00.000Z');
    expect(afterSix?.entries[1].startsAt).toBe('2026-09-16T08:00:00.000Z');
    expect(exactEight?.entries[0].startsAt).toBe('2026-09-15T08:00:00.000Z');
    expect(exactEight?.entries[1].startsAt).toBe('2026-09-15T13:00:00.000Z');
    expect(exactEight?.entries[0].startsAt).not.toBe(exactEight?.entries[1].startsAt);
  });

  it('handles quarter-hour zones and excludes an exact boundary from the future list', () => {
    const exactEight = widgetNextLocalDaytimeBoundary(
      '2026-09-15T02:15:00.000Z',
      'Asia/Kathmandu',
    );
    expect(exactEight?.toISOString()).toBe('2026-09-15T07:15:00.000Z');

    const timeline = buildWidgetTimeline({
      verifiedAt: '2026-09-15T02:15:00.000Z',
      timezoneName: 'Asia/Kathmandu',
      maxTimelineEntries: WIDGET_DAYTIME_TIMELINE_ENTRY_LIMIT,
      slots: [{ slotIndex: 0, memoryId: 'a' }, { slotIndex: 1, memoryId: 'b' }],
    });
    expect(timeline?.entries[0].startsAt).toBe('2026-09-15T02:15:00.000Z');
    expect(timeline?.entries[1].startsAt).toBe('2026-09-15T07:15:00.000Z');
  });

  it('cycles unique daytime IDs so the wrap does not repeat a card', () => {
    const timeline = buildWidgetTimeline({
      verifiedAt: '2026-09-15T12:00:00.000Z',
      timezoneName: 'UTC',
      maxTimelineEntries: WIDGET_DAYTIME_TIMELINE_ENTRY_LIMIT,
      slots: [
        { slotIndex: 0, memoryId: 'a' },
        { slotIndex: 1, memoryId: 'b' },
        { slotIndex: 2, memoryId: 'a' },
        { slotIndex: 3, memoryId: 'b' },
      ],
    });

    expect(timeline).not.toBeNull();
    expect(timeline!.entries.length).toBeGreaterThan(7);
    expect(timeline!.entries.every((entry, index, entries) => index === 0 || entry.memoryId !== entries[index - 1].memoryId)).toBe(true);
  });
});
