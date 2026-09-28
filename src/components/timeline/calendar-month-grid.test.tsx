import { fireEvent, render } from '@testing-library/react-native';

import { CalendarMonthGrid } from '@/components/timeline/calendar-month-grid';
import { useCalendarMemoriesInRange } from '@/hooks/useCalendarMemories';
import { buildGridMonth } from '@/utils/calendar-grid';

const mockIsUserBlocked = jest.fn((userId: string | null) => userId === 'blocked-user');
const mockIsTargetReported = jest.fn((_type: string, id: string) => id === 'reported');

jest.mock('@/hooks/useCalendarMemories', () => ({ useCalendarMemoriesInRange: jest.fn() }));
jest.mock('@/hooks/useContentSafety', () => ({
  useContentSafety: () => ({ isUserBlocked: mockIsUserBlocked, isTargetReported: mockIsTargetReported }),
}));
jest.mock('@/hooks/useMediaUrls', () => ({ useMediaUrl: jest.fn(() => ({ url: null })) }));
jest.mock('@/hooks/useVideoThumbnail', () => ({ useVideoThumbnail: jest.fn(() => null) }));

const mockedUseCalendarMemoriesInRange = useCalendarMemoriesInRange as jest.MockedFunction<
  typeof useCalendarMemoriesInRange
>;

const TODAY = '2026-09-28';
const months = [buildGridMonth(2026, 8, TODAY), buildGridMonth(2026, 7, TODAY)];

function row(id: string, date: string, overrides: Record<string, unknown> = {}) {
  return {
    id, memory_date: date, user_id: 'u1', memory_type: 'text_only', emotion: 'joy',
    mediaAssets: [], taggedMembers: [], updated_at: 'x', ...overrides,
  };
}

function renderGrid(onDayPress = jest.fn(), onTopMonthChange = jest.fn()) {
  return render(
    <CalendarMonthGrid
      initialMonthKey="2026-09"
      months={months}
      onDayPress={onDayPress}
      onTopMonthChange={onTopMonthChange}
    />,
  );
}

describe('CalendarMonthGrid', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseCalendarMemoriesInRange.mockReturnValue({
      data: [
        row('newest', '2026-09-02'),
        row('older-same-day', '2026-09-02'),
        row('by-blocked', '2026-09-02', { user_id: 'blocked-user' }),
        row('only-blocked', '2026-09-05', { user_id: 'blocked-user' }),
        row('sound', '2026-09-10', { memory_type: 'audio', mediaAssets: [{ duration_ms: 3000, content_type: 'audio/mp4' }] }),
        row('reported', '2026-09-12'),
      ],
      refetch: jest.fn(),
    } as never);
  });

  it('fetches the visible month plus one either side', () => {
    renderGrid();
    expect(mockedUseCalendarMemoriesInRange).toHaveBeenCalledWith({ startDate: '2026-08-01', endDate: '2026-09-30' });
  });

  it('renders month titles and a Monday-start weekday header', () => {
    const { getByText, getByTestId } = renderGrid();
    expect(getByText('September 2026')).toBeTruthy();
    expect(getByTestId('calendar-grid-weekdays')).toBeTruthy();
  });

  it('stamps a day with its newest memory and badges the other visible ones (blocked excluded)', () => {
    const { getByTestId } = renderGrid();
    const tile = getByTestId('calendar-grid-day-2026-09-02');
    expect(tile.props.accessibilityLabel).toBe('September 2, 2 memories');
    expect(tile.props.accessibilityRole).toBe('button');
    expect(getByTestId('calendar-grid-day-2026-09-02-count')).toHaveTextContent('+1');
  });

  it('leaves days with no visible memory as plain, non-button cells', () => {
    const { getByTestId } = renderGrid();
    for (const iso of ['2026-09-03', '2026-09-05']) {
      const tile = getByTestId(`calendar-grid-day-${iso}`);
      expect(tile.props.accessibilityRole).toBeUndefined();
      expect(tile.props.accessibilityLabel).toMatch(/no memories$/);
    }
  });

  it('renders audio as a sound stamp and hides a reported memory\'s stamp', () => {
    const { getByTestId, queryByText } = renderGrid();
    expect(getByTestId('calendar-grid-memory-sound-sound')).toBeTruthy();
    expect(getByTestId('calendar-grid-day-2026-09-12-hidden')).toBeTruthy();
    expect(queryByText('“', { exact: false })).toBeTruthy();
  });

  it('opens a day with memories', () => {
    const onDayPress = jest.fn();
    const { getByTestId } = renderGrid(onDayPress);
    fireEvent.press(getByTestId('calendar-grid-day-2026-09-02'));
    expect(onDayPress).toHaveBeenCalledWith('2026-09-02');
  });

  it('never offers a create affordance (viewers included)', () => {
    const { queryByText } = renderGrid();
    expect(queryByText(/capture today/i)).toBeNull();
  });
});
