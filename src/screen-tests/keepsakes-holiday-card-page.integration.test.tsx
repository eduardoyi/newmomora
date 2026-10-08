import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import HolidayCardProductScreen from '../../app/(app)/keepsakes/holiday-card';
import { MODAL_DISMISS_DELAY_MS } from '@/hooks/useLeaveKeepsakesPage';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useHolidayCard } from '@/hooks/useHolidayCard';
import { useKeepsakesOverview } from '@/hooks/useKeepsakesOverview';
import { holidayCardWebUrl, type HolidayCardSummary } from '@/services/holiday-cards';
import type { KeepsakesCardFront, KeepsakesOverview } from '@/services/keepsakes';
import { openShopUrl } from '@/services/web-handoff';

// Holiday card product page (docs/plans/keepsakes-redesign.md D3). "Today" is
// pinned to 2026-10-15. The hooks are mocked; the greeting sheet is real.

const mockRouter = { back: jest.fn(), canGoBack: jest.fn(() => true), replace: jest.fn(), navigate: jest.fn(), push: jest.fn() };

jest.mock('expo-router', () => ({
  get router() {
    return mockRouter;
  },
}));
jest.mock('@/lib/supabase', () => ({ supabase: { rpc: jest.fn() } }));
jest.mock('expo-symbols', () => ({ SymbolView: () => null }));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: () => null }));
jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/hooks/useFamilyMembers', () => ({ useFamilyMembers: jest.fn() }));
jest.mock('@/hooks/useHolidayCard', () => ({ useHolidayCard: jest.fn() }));
jest.mock('@/hooks/useKeepsakesOverview', () => ({ useKeepsakesOverview: jest.fn() }));
jest.mock('@/hooks/useMediaUrls', () => ({ useMediaUrl: jest.fn(() => ({ url: undefined, isLoading: false, isError: false })) }));
jest.mock('@/services/web-handoff', () => ({ openShopUrl: jest.fn(() => Promise.resolve()) }));
jest.mock('@/utils/portrait-versions', () => ({
  ...jest.requireActual('@/utils/portrait-versions'),
  getLocalTodayIso: () => '2026-10-15',
}));
jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context');
  return { ...actual, useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 34, left: 0 }) };
});

const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseFamilyMembers = useFamilyMembers as jest.MockedFunction<typeof useFamilyMembers>;
const mockedUseHolidayCard = useHolidayCard as jest.MockedFunction<typeof useHolidayCard>;
const mockedUseOverview = useKeepsakesOverview as jest.MockedFunction<typeof useKeepsakesOverview>;
const mockedOpenShopUrl = openShopUrl as jest.MockedFunction<typeof openShopUrl>;

const create = jest.fn();

function summary(overrides: Partial<HolidayCardSummary> = {}): HolidayCardSummary {
  return {
    enabled: true, cardId: null, year: null, status: null, readiness: null, lastFailureCode: null, ordered: false, language: 'en',
    ...overrides,
  };
}

function overview(overrides: Partial<KeepsakesOverview> = {}): KeepsakesOverview {
  return {
    recap: null, has_viewers: false, year_moments: 34, holiday_pool: 28, holiday_min_pool: 20, holiday_ship_by_note: null,
    preview_key: 'family/preview.jpg', book_preview_keys: {}, orders: [], card_front: null, ...overrides,
  };
}

const cardFront: KeepsakesCardFront = {
  card_id: 'card-1',
  year: 2026,
  image_key: 'family/front.jpg',
  width: 4000,
  height: 3000,
  layout: 'full-bleed',
  orientation: 'landscape',
  focal: { x: 0.4, y: 0.5 },
  greeting: 'christmas',
  language: 'en',
  greeting_text: 'Merry Christmas from the Parks',
  subline_text: 'Lila & Theo',
  greeting_position: 'top-left',
};

const lila = { id: 'child-1', family_id: 'family-1', name: 'Lila Park', date_of_birth: '2023-06-01', relationship: 'child' };
const theo = { id: 'child-2', family_id: 'family-1', name: 'Theo', date_of_birth: '2025-02-01', relationship: 'child' };
const grandma = { id: 'grandma', family_id: 'family-1', name: 'Mirian', date_of_birth: '1955-01-01', relationship: 'grandparent' };

function mockHooks({
  role = 'owner',
  card = summary() as HolidayCardSummary | null,
  isLoading = false,
  ov = overview() as KeepsakesOverview | null,
}: { role?: string; card?: HolidayCardSummary | null; isLoading?: boolean; ov?: KeepsakesOverview | null } = {}) {
  mockedUseFamily.mockReturnValue({ familyId: 'family-1', role, isLoading: false } as unknown as ReturnType<typeof useFamily>);
  mockedUseFamilyMembers.mockReturnValue({ members: [lila, theo, grandma], isLoading: false } as unknown as ReturnType<typeof useFamilyMembers>);
  mockedUseHolidayCard.mockReturnValue({
    summary: card, isLoading, isError: false, refetch: jest.fn(), create, isCreating: false,
  } as unknown as ReturnType<typeof useHolidayCard>);
  mockedUseOverview.mockReturnValue({ overview: ov, isLoading: false, refetch: jest.fn() } as unknown as ReturnType<typeof useKeepsakesOverview>);
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockRouter.canGoBack.mockReturnValue(true);
});
afterEach(() => jest.useRealTimers());

async function advanceModalDismiss() {
  await act(async () => {
    jest.advanceTimersByTime(MODAL_DISMISS_DELAY_MS + 50);
  });
}

async function pickGreetingAndConfirm(api: ReturnType<typeof render>) {
  fireEvent.press(api.getByTestId('holiday-card-product-cta'));
  fireEvent.press(api.getByTestId('holiday-greeting-christmas'));
  await act(async () => {
    fireEvent.press(api.getByTestId('holiday-greeting-confirm'));
  });
}

describe('holiday card product page', () => {
  it('shows the card the family created: the real front, landscape full-bleed, with its texts', () => {
    mockHooks({
      card: summary({ cardId: 'card-1', year: 2026, status: 'ready', readiness: 'ready' }),
      ov: overview({ card_front: cardFront }),
    });
    const { getByTestId, getByText, queryByText } = render(<HolidayCardProductScreen />);
    expect(getByTestId('holiday-card-product-object-front')).toBeTruthy();
    expect(getByText('Merry Christmas from the Parks')).toBeTruthy();
    expect(getByText('Lila & Theo')).toBeTruthy();
    expect(queryByText('Happy Holidays')).toBeNull();
    expect(getByText('Open your card')).toBeTruthy();
    // Landscape 5R inside the ~300-high stage: 280 wide at most, envelope included.
    const { width, height } = StyleSheet.flatten(getByTestId('holiday-card-product-object').props.style);
    expect(width).toBeLessThanOrEqual(280);
    expect(height).toBeLessThan(width);
  });

  it('a portrait bordered card keeps the portrait shape and hides an empty small line', () => {
    mockHooks({
      card: summary({ cardId: 'card-1', year: 2026, status: 'ready', readiness: 'ready' }),
      ov: overview({ card_front: { ...cardFront, orientation: 'portrait', layout: 'bordered', subline_text: '', greeting_text: null, language: 'es' } }),
    });
    const { getByTestId, getByText, queryByTestId } = render(<HolidayCardProductScreen />);
    expect(getByText('Feliz Navidad')).toBeTruthy();
    expect(queryByTestId('holiday-card-product-object-front-subline')).toBeNull();
    const { width, height } = StyleSheet.flatten(getByTestId('holiday-card-product-object').props.style);
    expect(height).toBeGreaterThan(width);
  });

  it('falls back to the generic preview when the overview has no front or a different card’s', () => {
    mockHooks({ card: summary({ cardId: 'card-1', year: 2026, status: 'ready', readiness: 'ready' }), ov: overview() });
    const noFront = render(<HolidayCardProductScreen />);
    expect(noFront.queryByTestId('holiday-card-product-object-front')).toBeNull();
    expect(noFront.getByText('Happy Holidays')).toBeTruthy();
    noFront.unmount();

    mockHooks({
      card: summary({ cardId: 'card-1', year: 2026, status: 'ready', readiness: 'ready' }),
      ov: overview({ card_front: { ...cardFront, card_id: 'other-card' } }),
    });
    const other = render(<HolidayCardProductScreen />);
    expect(other.queryByTestId('holiday-card-product-object-front')).toBeNull();
  });

  it('a previous-year card (offer "make") keeps the generic preview, in the family language', () => {
    mockHooks({
      card: summary({ cardId: 'card-0', year: 2025, status: 'ready', readiness: 'ready', language: 'es' }),
      ov: overview({ card_front: { ...cardFront, card_id: 'card-0', year: 2025 } }),
    });
    const { queryByTestId, getByText } = render(<HolidayCardProductScreen />);
    expect(queryByTestId('holiday-card-product-object-front')).toBeNull();
    expect(getByText('Felices fiestas')).toBeTruthy();
    expect(getByText('Make our 2026 card')).toBeTruthy();
  });

  it('renders the layout for a family that can make a card, with no prices', () => {
    mockHooks({ ov: overview({ holiday_ship_by_note: 'Order by Dec 10 for Christmas delivery in the US.', has_viewers: true }) });
    const { getByTestId, getByText, queryByText, toJSON } = render(<HolidayCardProductScreen />);

    expect(getByTestId('keepsakes-product-holiday-card')).toBeTruthy();
    expect(getByText('HOLIDAY CARDS · 2026')).toBeTruthy();
    expect(getByText('Your family, on this year’s card.')).toBeTruthy();
    expect(getByText('Free to make')).toBeTruthy();
    expect(getByText('Your 2026 has 34 moments, plenty for the letter.')).toBeTruthy();
    expect(getByText('Viewers in your family won’t see this card. Your surprise is safe.')).toBeTruthy();
    expect(getByText('Order by Dec 10 for Christmas delivery in the US.')).toBeTruthy();
    expect(getByText('Pick a greeting, then make it your own in the app.')).toBeTruthy();
    // No card yet: the generic preview, with the real default greeting and just the year.
    expect(getByText('Happy Holidays')).toBeTruthy();
    expect(within(getByTestId('holiday-card-product-object')).getByText('2026')).toBeTruthy();
    expect(queryByText(/Mirian/)).toBeNull();
    expect(getByText('Make our 2026 card')).toBeTruthy();
    expect(JSON.stringify(toJSON())).not.toMatch(/\$\d/);
  });

  it('omits the privacy note and ship-by pill when there are no viewers / no note', () => {
    mockHooks();
    const { queryByTestId } = render(<HolidayCardProductScreen />);
    expect(queryByTestId('keepsakes-product-privacy')).toBeNull();
    expect(queryByTestId('holiday-card-ship-by')).toBeNull();
  });

  it('below the holiday floor it does not promise the QR film', () => {
    mockHooks({ ov: overview({ holiday_pool: 12, year_moments: 14 }) });
    const { getByText, queryByText } = render(<HolidayCardProductScreen />);
    expect(getByText('Your 2026 has 14 moments so far.')).toBeTruthy();
    expect(getByText(/Add a few more moments/)).toBeTruthy();
    expect(queryByText(/Scan the back/)).toBeNull();
  });

  it('at or above the floor it promises the QR film', () => {
    mockHooks();
    const { getByText } = render(<HolidayCardProductScreen />);
    expect(getByText(/Scan the back/)).toBeTruthy();
  });

  it('with no overview it shows no eligibility line and no QR fact', () => {
    mockHooks({ ov: null });
    const { queryByTestId, queryByText, getByTestId } = render(<HolidayCardProductScreen />);
    expect(queryByTestId('holiday-card-eligibility')).toBeNull();
    expect(queryByText(/Scan the back/)).toBeNull();
    expect(queryByText(/Add a few more moments/)).toBeNull();
    expect(getByTestId('holiday-card-product-cta')).toBeTruthy();
  });

  it.each([
    ['generating', summary({ cardId: 'card-1', year: 2026, status: 'generating', readiness: 'generating' })],
    ['ready', summary({ cardId: 'card-1', year: 2026, status: 'ready', readiness: 'ready' })],
    ['failed', summary({ cardId: 'card-1', year: 2026, status: 'failed', readiness: 'failed' })],
    ['ordered', summary({ cardId: 'card-1', year: 2026, status: 'ready', ordered: true })],
  ])('opens the shop in the %s state', (_name, card) => {
    mockHooks({ card });
    const { getByText, getByTestId, queryByTestId } = render(<HolidayCardProductScreen />);
    expect(getByText('Open your card')).toBeTruthy();
    fireEvent.press(getByTestId('holiday-card-product-cta'));
    expect(mockedOpenShopUrl).toHaveBeenCalledWith(holidayCardWebUrl('card-1'));
    expect(queryByTestId('holiday-greeting-sheet')).toBeNull();
  });

  it('uses the state, not the card id: a never-ordered previous-year card still offers "make"', () => {
    mockHooks({ card: summary({ cardId: 'old', year: 2025, status: 'ready', ordered: false }) });
    const { getByText } = render(<HolidayCardProductScreen />);
    expect(getByText('Make our 2026 card')).toBeTruthy();
    expect(getByText('HOLIDAY CARDS · 2026')).toBeTruthy();
  });

  describe('out of season, viewers and deep links', () => {
    it('leaves when the first settled state is null (out of season)', () => {
      mockHooks({ card: summary({ enabled: false }) });
      render(<HolidayCardProductScreen />);
      expect(mockRouter.back).toHaveBeenCalledTimes(1);
    });

    it('falls back to the Keepsakes tab when there is nothing to go back to', () => {
      mockRouter.canGoBack.mockReturnValue(false);
      mockHooks({ card: summary({ enabled: false }) });
      render(<HolidayCardProductScreen />);
      expect(mockRouter.replace).toHaveBeenCalledWith('/(app)/(tabs)/keepsakes');
    });

    it('waits for the summary before deciding', () => {
      mockHooks({ card: null, isLoading: true });
      const { rerender, queryByTestId } = render(<HolidayCardProductScreen />);
      expect(mockRouter.back).not.toHaveBeenCalled();
      expect(queryByTestId('keepsakes-product-loading')).toBeTruthy();
      mockHooks({ card: summary() });
      rerender(<HolidayCardProductScreen />);
      expect(mockRouter.back).not.toHaveBeenCalled();
    });

    it('a viewer is sent back', () => {
      mockHooks({ role: 'viewer', card: null });
      render(<HolidayCardProductScreen />);
      expect(mockRouter.back).toHaveBeenCalledTimes(1);
    });

    it('never auto-leaves when the state turns null after the first settle', () => {
      mockHooks();
      const { rerender, getByText } = render(<HolidayCardProductScreen />);
      mockHooks({ card: summary({ enabled: false }) });
      rerender(<HolidayCardProductScreen />);
      expect(mockRouter.back).not.toHaveBeenCalled();
      // The page keeps showing the last real state.
      expect(getByText('Make our 2026 card')).toBeTruthy();
    });
  });

  describe('making the card', () => {
    it('a new card leaves the page after the sheet has dismissed', async () => {
      mockHooks();
      create.mockResolvedValue({ ok: true, result: { cardId: 'card-9', created: true, regionWarning: false } });
      const api = render(<HolidayCardProductScreen />);
      await pickGreetingAndConfirm(api);
      expect(create).toHaveBeenCalledWith('christmas');

      fireEvent.press(await api.findByTestId('holiday-greeting-continue'));
      // Not in the same tick as the dismissal.
      expect(mockRouter.back).not.toHaveBeenCalled();
      await advanceModalDismiss();
      expect(mockRouter.back).toHaveBeenCalledTimes(1);
      expect(mockedOpenShopUrl).not.toHaveBeenCalled();
    });

    it('a refused create keeps the page open', async () => {
      mockHooks();
      create.mockResolvedValue({ ok: false, error: { code: 'subscription_required', message: 'server' } });
      const api = render(<HolidayCardProductScreen />);
      await pickGreetingAndConfirm(api);

      expect(await api.findByTestId('holiday-greeting-error')).toBeTruthy();
      fireEvent.press(api.getByTestId('holiday-greeting-cancel'));
      await advanceModalDismiss();
      expect(mockRouter.back).not.toHaveBeenCalled();
      expect(api.getByTestId('holiday-card-product-cta')).toBeTruthy();
    });

    it('closing the sheet without creating does not leave (createdRef gate)', async () => {
      mockHooks();
      const api = render(<HolidayCardProductScreen />);
      fireEvent.press(api.getByTestId('holiday-card-product-cta'));
      fireEvent.press(api.getByTestId('holiday-greeting-backdrop', { includeHiddenElements: true }));
      await advanceModalDismiss();
      expect(mockRouter.back).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    });

    it('an existing card opens the shop and stays on the page', async () => {
      mockHooks();
      create.mockResolvedValue({ ok: true, result: { cardId: 'card-3', created: false, regionWarning: false } });
      const api = render(<HolidayCardProductScreen />);
      await pickGreetingAndConfirm(api);
      fireEvent.press(await api.findByTestId('holiday-greeting-continue'));
      await advanceModalDismiss();
      expect(mockedOpenShopUrl).toHaveBeenCalledWith(holidayCardWebUrl('card-3'));
      expect(mockRouter.back).not.toHaveBeenCalled();
    });

    it('a created card whose refetch hides the card still leaves exactly once', async () => {
      mockHooks();
      create.mockResolvedValue({ ok: true, result: { cardId: 'card-9', created: true, regionWarning: false } });
      const api = render(<HolidayCardProductScreen />);
      await pickGreetingAndConfirm(api);
      mockHooks({ card: summary({ cardId: 'card-9', year: 2026, status: 'generating' }) });
      api.rerender(<HolidayCardProductScreen />);
      fireEvent.press(await api.findByTestId('holiday-greeting-continue'));
      await advanceModalDismiss();
      await waitFor(() => expect(mockRouter.back).toHaveBeenCalledTimes(1));
    });
  });
});
