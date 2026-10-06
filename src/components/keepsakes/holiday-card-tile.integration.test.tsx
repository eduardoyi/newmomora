// The tile with the REAL useHolidayCard hook: a refused create refetches a
// summary that hides the tile (switch off, no card). The greeting sheet must
// stay mounted and show the refusal inline.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { HolidayCardTile } from '@/components/keepsakes/holiday-card-tile';
import { createHolidayCard, fetchHolidayCardSummary, type HolidayCardSummary } from '@/services/holiday-cards';
import { openShopUrl } from '@/services/web-handoff';

jest.mock('expo-symbols', () => ({ SymbolView: () => null }));
jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context');
  return { ...actual, useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) };
});
jest.mock('@/services/holiday-cards', () => ({
  ...jest.requireActual('@/services/holiday-cards'),
  fetchHolidayCardSummary: jest.fn(),
  createHolidayCard: jest.fn(),
}));
jest.mock('@/services/web-handoff', () => ({ openShopUrl: jest.fn(() => Promise.resolve()) }));

const mockedFetch = fetchHolidayCardSummary as jest.MockedFunction<typeof fetchHolidayCardSummary>;
const mockedCreate = createHolidayCard as jest.MockedFunction<typeof createHolidayCard>;
const mockedOpenShopUrl = openShopUrl as jest.MockedFunction<typeof openShopUrl>;

function summary(overrides: Partial<HolidayCardSummary> = {}): HolidayCardSummary {
  return { enabled: true, cardId: null, year: null, status: null, readiness: null, lastFailureCode: null, ordered: false, language: 'en', ...overrides };
}

function renderTile() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return render(
    <QueryClientProvider client={client}>
      <HolidayCardTile canEdit familyId="family-1" isFocused todayIso="2026-10-15" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('HolidayCardTile with the real hook', () => {
  it.each([
    ['disabled', "Holiday cards aren't available yet"],
    ['subscription_required', 'Making a holiday card needs an active subscription.'],
  ] as const)('keeps the sheet and shows the %s refusal when the refetch hides the tile', async (code, message) => {
    mockedFetch.mockResolvedValueOnce({ data: summary(), error: null });
    // After the refusal the server's switch reads off and there is no card.
    mockedFetch.mockResolvedValue({ data: summary({ enabled: false }), error: null });
    mockedCreate.mockResolvedValue({ data: null, error: { code, message: 'server text' } });

    const { findByTestId, getByTestId, getByText, queryByTestId } = renderTile();
    fireEvent.press(await findByTestId('holiday-card-tile-make'));
    fireEvent.press(getByTestId('holiday-greeting-christmas'));
    fireEvent.press(getByTestId('holiday-greeting-confirm'));

    await waitFor(() => expect(queryByTestId('holiday-card-tile')).toBeNull());
    expect(await findByTestId('holiday-greeting-error')).toBeTruthy();
    expect(getByText(message)).toBeTruthy();
    expect(getByTestId('holiday-greeting-sheet')).toBeTruthy();
    expect(mockedOpenShopUrl).not.toHaveBeenCalled();
  });

  it('creates, opens the shop for the new card and flips the tile to generating', async () => {
    mockedFetch.mockResolvedValueOnce({ data: summary(), error: null });
    mockedFetch.mockResolvedValue({
      data: summary({ cardId: 'card-5', year: 2026, status: 'generating' }),
      error: null,
    });
    mockedCreate.mockResolvedValue({ data: { cardId: 'card-5', created: true, regionWarning: false }, error: null });

    const { findByTestId, getByTestId } = renderTile();
    fireEvent.press(await findByTestId('holiday-card-tile-make'));
    fireEvent.press(getByTestId('holiday-greeting-new-year'));
    fireEvent.press(getByTestId('holiday-greeting-confirm'));
    fireEvent.press(await findByTestId('holiday-greeting-continue'));

    await waitFor(() => expect(mockedOpenShopUrl).toHaveBeenCalledWith('https://shop.usemomora.com/c/card-5'));
    expect(await findByTestId('holiday-card-tile-generating')).toBeTruthy();
  });
});
