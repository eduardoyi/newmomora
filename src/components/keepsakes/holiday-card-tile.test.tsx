import { fireEvent, render } from '@testing-library/react-native';

import { HolidayCardTile, holidayCardTileState } from '@/components/keepsakes/holiday-card-tile';
import { useHolidayCard } from '@/hooks/useHolidayCard';
import type { HolidayCardSummary } from '@/services/holiday-cards';
import { openShopUrl } from '@/services/web-handoff';

jest.mock('expo-symbols', () => ({ SymbolView: () => null }));
jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context');
  return { ...actual, useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) };
});
jest.mock('@/hooks/useHolidayCard', () => ({ useHolidayCard: jest.fn() }));
jest.mock('@/services/web-handoff', () => ({ openShopUrl: jest.fn(() => Promise.resolve()) }));

const mockedUseHolidayCard = useHolidayCard as jest.MockedFunction<typeof useHolidayCard>;
const mockedOpenShopUrl = openShopUrl as jest.MockedFunction<typeof openShopUrl>;
const refetch = jest.fn();
const create = jest.fn();

function summary(overrides: Partial<HolidayCardSummary> = {}): HolidayCardSummary {
  return {
    enabled: true,
    cardId: null,
    year: null,
    status: null,
    readiness: null,
    lastFailureCode: null,
    ordered: false,
    language: 'en',
    ...overrides,
  };
}

function mockSummary(value: HolidayCardSummary | null) {
  mockedUseHolidayCard.mockReturnValue({
    summary: value,
    isLoading: false,
    isError: false,
    refetch,
    create,
    isCreating: false,
  } as unknown as ReturnType<typeof useHolidayCard>);
}

function renderTile(props: Partial<React.ComponentProps<typeof HolidayCardTile>> = {}) {
  return render(<HolidayCardTile canEdit todayIso="2026-10-15" familyId="family-1" isFocused {...props} />);
}

const card = (overrides: Partial<HolidayCardSummary> = {}) =>
  summary({ cardId: 'card-1', year: 2026, status: 'ready', ...overrides });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('holidayCardTileState', () => {
  it('maps the summary to a tile state', () => {
    expect(holidayCardTileState(null, '2026-10-15')).toBeNull();
    expect(holidayCardTileState(summary({ enabled: false }), '2026-10-15')).toBeNull();
    expect(holidayCardTileState(summary(), '2026-10-15')).toBe('make');
    expect(holidayCardTileState(card({ status: 'generating' }), '2026-10-15')).toBe('generating');
    expect(holidayCardTileState(card(), '2026-10-15')).toBe('ready');
    expect(holidayCardTileState(card({ status: 'failed' }), '2026-10-15')).toBe('failed');
    expect(holidayCardTileState(card({ ordered: true }), '2026-10-15')).toBe('ordered');
  });

  it.each([
    ['generating', 'generating'],
    ['film', 'generating'],
    ['ready', 'ready'],
    ['failed', 'failed'],
  ] as const)('readiness %s wins over status and maps to %s', (readiness, expected) => {
    // `status` reads "ready" while the film is still rendering.
    expect(holidayCardTileState(card({ status: 'ready', readiness }), '2026-10-15')).toBe(expected);
  });

  it('falls back to status when readiness is absent (older backend)', () => {
    expect(holidayCardTileState(card({ status: 'generating', readiness: null }), '2026-10-15')).toBe('generating');
    expect(holidayCardTileState(card({ status: 'ready', readiness: null }), '2026-10-15')).toBe('ready');
  });

  it('ordered wins over readiness', () => {
    expect(holidayCardTileState(card({ ordered: true, readiness: 'film' }), '2026-10-15')).toBe('ordered');
  });

  it('shows a card even when the server switch is off', () => {
    expect(holidayCardTileState(card({ enabled: false }), '2026-10-15')).toBe('ready');
  });

  it('keeps last year\'s ORDERED card as "ordered" through Jan 31', () => {
    const lastYearOrdered = card({ year: 2025, ordered: true });
    expect(holidayCardTileState(lastYearOrdered, '2026-01-01')).toBe('ordered');
    expect(holidayCardTileState(lastYearOrdered, '2026-01-15')).toBe('ordered');
    expect(holidayCardTileState(lastYearOrdered, '2026-01-31')).toBe('ordered');
    expect(holidayCardTileState(card({ year: 2025, ordered: true, enabled: false }), '2026-01-15')).toBe('ordered');
  });

  it('drops last year\'s ordered card from Feb 1: make when enabled, hidden when not', () => {
    expect(holidayCardTileState(card({ year: 2025, ordered: true }), '2026-02-01')).toBe('make');
    expect(holidayCardTileState(card({ year: 2025, ordered: true, enabled: false }), '2026-02-01')).toBeNull();
    expect(holidayCardTileState(card({ year: 2025, ordered: true }), '2026-10-15')).toBe('make');
  });

  it('treats a previous-year card that was never ordered as no card', () => {
    expect(holidayCardTileState(card({ year: 2025 }), '2026-01-15')).toBe('make');
    expect(holidayCardTileState(card({ year: 2025, status: 'failed', enabled: false }), '2026-01-15')).toBeNull();
  });

  it('does not keep a card from two years back', () => {
    expect(holidayCardTileState(card({ year: 2024, ordered: true }), '2026-01-15')).toBe('make');
  });
});

describe('HolidayCardTile', () => {
  it('renders nothing for viewers, and does not enable the query', () => {
    mockSummary(card());
    const { queryByTestId } = renderTile({ canEdit: false });
    expect(queryByTestId('holiday-card-tile')).toBeNull();
    expect(mockedUseHolidayCard).toHaveBeenCalledWith('family-1', expect.objectContaining({ enabled: false }));
    expect(refetch).not.toHaveBeenCalled();
  });

  it('renders nothing when the switch is off and there is no card', () => {
    mockSummary(summary({ enabled: false }));
    expect(renderTile().queryByTestId('holiday-card-tile')).toBeNull();
  });

  it('renders nothing while the summary is missing (loading, error, not owner/manager)', () => {
    mockSummary(null);
    expect(renderTile().queryByTestId('holiday-card-tile')).toBeNull();
  });

  it('make: offers the card and opens the greeting sheet, not the shop', () => {
    mockSummary(summary());
    const { getByTestId, getByText, queryByTestId } = renderTile();
    expect(getByText('Make your holiday card')).toBeTruthy();
    expect(getByText(/QR to your year’s film/)).toBeTruthy();
    expect(getByText(/US & Canada/)).toBeTruthy();
    expect(queryByTestId('holiday-greeting-sheet')).toBeNull();

    fireEvent.press(getByTestId('holiday-card-tile-make'));
    expect(getByTestId('holiday-greeting-sheet')).toBeTruthy();
    expect(mockedOpenShopUrl).not.toHaveBeenCalled();
  });

  it('passes the card language to the greeting sheet', () => {
    mockSummary(summary({ language: 'es' }));
    const { getByTestId, getByText } = renderTile();
    fireEvent.press(getByTestId('holiday-card-tile-make'));
    expect(getByText('Feliz Navidad')).toBeTruthy();
  });

  it('generating: "Preparing your card…" opens the shop card page', () => {
    mockSummary(card({ status: 'generating' }));
    const { getByTestId, getByText } = renderTile();
    expect(getByText('Preparing your card…')).toBeTruthy();
    fireEvent.press(getByTestId('holiday-card-tile-generating'));
    expect(mockedOpenShopUrl).toHaveBeenCalledWith('https://shop.usemomora.com/c/card-1');
  });

  it.each(['generating', 'film'] as const)(
    'readiness %s: "Preparing your card…" with the ~20 minute notification subtitle, tap opens the shop',
    (readiness) => {
      mockSummary(card({ status: 'ready', readiness }));
      const { getByTestId, getByText, queryByText } = renderTile();
      expect(getByText('Preparing your card…')).toBeTruthy();
      expect(getByText('This takes about 20 minutes. We’ll send you a notification when it’s ready.')).toBeTruthy();
      expect(queryByText('Edit & order your card')).toBeNull();
      fireEvent.press(getByTestId('holiday-card-tile-generating'));
      expect(mockedOpenShopUrl).toHaveBeenCalledWith('https://shop.usemomora.com/c/card-1');
    },
  );

  it('readiness ready: "Edit & order your card"', () => {
    mockSummary(card({ status: 'ready', readiness: 'ready' }));
    expect(renderTile().getByText('Edit & order your card')).toBeTruthy();
  });

  it('ready: "Edit & order your card" opens the shop card page', () => {
    mockSummary(card());
    const { getByTestId, getByText } = renderTile();
    expect(getByText('Edit & order your card')).toBeTruthy();
    fireEvent.press(getByTestId('holiday-card-tile-ready'));
    expect(mockedOpenShopUrl).toHaveBeenCalledWith('https://shop.usemomora.com/c/card-1');
  });

  it('failed: says so with the support address, and tap opens the shop', () => {
    mockSummary(card({ status: 'failed', lastFailureCode: 'generation_failed' }));
    const { getByTestId, getByText } = renderTile();
    expect(getByText('We couldn’t make your card')).toBeTruthy();
    expect(getByText(/hello@usemomora\.com/)).toBeTruthy();
    fireEvent.press(getByTestId('holiday-card-tile-failed'));
    expect(mockedOpenShopUrl).toHaveBeenCalledWith('https://shop.usemomora.com/c/card-1');
  });

  it('ordered: "Your cards are ordered" (wins over status) opens the shop', () => {
    mockSummary(card({ ordered: true }));
    const { getByTestId, getByText } = renderTile();
    expect(getByText('Your cards are ordered')).toBeTruthy();
    fireEvent.press(getByTestId('holiday-card-tile-ordered'));
    expect(mockedOpenShopUrl).toHaveBeenCalledWith('https://shop.usemomora.com/c/card-1');
  });

  it('refetches the summary when the tab gains focus', () => {
    mockSummary(card());
    const { rerender } = renderTile({ isFocused: false });
    expect(refetch).not.toHaveBeenCalled();
    rerender(<HolidayCardTile canEdit todayIso="2026-10-15" familyId="family-1" isFocused />);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the greeting sheet mounted when a successful create flips the tile to generating', async () => {
    mockSummary(summary());
    create.mockImplementation(async () => {
      // The hook invalidates the summary: the tile now sees the new card.
      mockSummary(card({ status: 'generating' }));
      return { ok: true, result: { cardId: 'card-1', created: true, regionWarning: true } };
    });
    const { getByTestId, findByTestId } = renderTile();
    fireEvent.press(getByTestId('holiday-card-tile-make'));
    fireEvent.press(getByTestId('holiday-greeting-christmas'));
    fireEvent.press(getByTestId('holiday-greeting-confirm'));
    expect(await findByTestId('holiday-greeting-region')).toBeTruthy();
    expect(mockedOpenShopUrl).not.toHaveBeenCalled();
  });
});
