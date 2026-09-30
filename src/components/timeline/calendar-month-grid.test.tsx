import { fireEvent, render } from '@testing-library/react-native';

import { CalendarGridMonth } from '@/components/timeline/calendar-month-grid';
import type { MemoryWithTags } from '@/services/memories';
import { buildGridMonth, getGridMonthHeight, summarizeGridDays } from '@/utils/calendar-grid';

jest.mock('@/hooks/useMediaUrls', () => ({ useMediaUrl: jest.fn(() => ({ url: null })) }));
jest.mock('@/hooks/useVideoThumbnail', () => ({ useVideoThumbnail: jest.fn(() => null) }));

const TODAY = '2026-09-28';
const september = buildGridMonth(2026, 8, TODAY);

function row(id: string, date: string, overrides: Record<string, unknown> = {}) {
  return {
    id, memory_date: date, user_id: 'u1', memory_type: 'text_only', emotion: 'joy',
    mediaAssets: [], taggedMembers: [], updated_at: 'x', ...overrides,
  } as unknown as MemoryWithTags;
}

const summaries = summarizeGridDays(
  [
    row('newest', '2026-09-02'),
    row('older-same-day', '2026-09-02'),
    row('by-blocked', '2026-09-02', { user_id: 'blocked-user' }),
    row('only-blocked', '2026-09-05', { user_id: 'blocked-user' }),
    row('sound', '2026-09-10', { memory_type: 'audio', mediaAssets: [{ duration_ms: 3000, content_type: 'audio/mp4' }] }),
    row('reported', '2026-09-12'),
  ],
  (userId) => userId === 'blocked-user',
);

function renderMonth(onDayPress = jest.fn(), filmDates?: ReadonlySet<string>) {
  return render(
    <CalendarGridMonth
      filmDates={filmDates}
      isTargetReported={(_type, id) => id === 'reported'}
      month={september}
      onDayPress={onDayPress}
      summaries={summaries}
      tileSize={40}
    />,
  );
}

// One month of the Timeline's Calendar view (docs/plans/timeline-calendar-keepsakes.md B2).
describe('CalendarGridMonth', () => {
  it('renders the title at the exact height getItemLayout assumes', () => {
    const { getByText, getByTestId } = renderMonth();
    expect(getByText('September 2026')).toBeTruthy();
    const style = [getByTestId('calendar-grid-month-2026-09').props.style].flat();
    expect(style).toEqual(expect.arrayContaining([{ height: getGridMonthHeight(september, 40) }]));
  });

  it('stamps a day with its newest memory and badges the other visible ones (blocked excluded)', () => {
    const { getByTestId } = renderMonth();
    const tile = getByTestId('calendar-grid-day-2026-09-02');
    expect(tile.props.accessibilityLabel).toBe('September 2, 2 memories');
    expect(tile.props.accessibilityRole).toBe('button');
    expect(getByTestId('calendar-grid-day-2026-09-02-count')).toHaveTextContent('+1');
  });

  it('leaves days with no visible memory as plain, non-button cells', () => {
    const { getByTestId } = renderMonth();
    for (const iso of ['2026-09-03', '2026-09-05']) {
      const tile = getByTestId(`calendar-grid-day-${iso}`);
      expect(tile.props.accessibilityRole).toBeUndefined();
      expect(tile.props.accessibilityLabel).toMatch(/no memories$/);
    }
  });

  it('renders audio as a sound stamp and hides a reported memory\'s stamp', () => {
    const { getByTestId } = renderMonth();
    expect(getByTestId('calendar-grid-memory-sound-sound')).toBeTruthy();
    expect(getByTestId('calendar-grid-day-2026-09-12-hidden')).toBeTruthy();
  });

  it('opens a day with memories', () => {
    const onDayPress = jest.fn();
    const { getByTestId } = renderMonth(onDayPress);
    fireEvent.press(getByTestId('calendar-grid-day-2026-09-02'));
    expect(onDayPress).toHaveBeenCalledWith('2026-09-02');
  });

  // Year Films (docs/plans/year-film-p2.md Step 5.4): a film dot, and a
  // film-only day (a recap on a memory-less month-end) is a button too.
  it('dots a day that has a film, with or without memories', () => {
    const { getByTestId, queryByTestId } = renderMonth(jest.fn(), new Set(['2026-09-02', '2026-09-30']));
    expect(getByTestId('calendar-grid-day-2026-09-02-film')).toBeTruthy();
    expect(getByTestId('calendar-grid-day-2026-09-30-film')).toBeTruthy();
    expect(getByTestId('calendar-grid-day-2026-09-02').props.accessibilityLabel).toBe('September 2, 2 memories, film');
    expect(queryByTestId('calendar-grid-day-2026-09-10-film')).toBeNull();
  });

  it('makes a film-only day pressable and opens it like any other day', () => {
    const onDayPress = jest.fn();
    const { getByTestId } = renderMonth(onDayPress, new Set(['2026-09-30']));
    const tile = getByTestId('calendar-grid-day-2026-09-30');
    expect(tile.props.accessibilityRole).toBe('button');
    expect(tile.props.accessibilityLabel).toBe('September 30, film');
    fireEvent.press(tile);
    expect(onDayPress).toHaveBeenCalledWith('2026-09-30');
  });

  it('leaves memory-less days without a film inert', () => {
    const { getByTestId } = renderMonth(jest.fn(), new Set(['2026-09-30']));
    expect(getByTestId('calendar-grid-day-2026-09-03').props.accessibilityRole).toBeUndefined();
  });

  it('never offers a create affordance (viewers included)', () => {
    const { queryByText } = renderMonth();
    expect(queryByText(/capture today/i)).toBeNull();
  });
});
