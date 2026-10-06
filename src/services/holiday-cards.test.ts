import { supabase } from '@/lib/supabase';
import { invokeEdgeFunction } from '@/services/ai';
import {
  createHolidayCard,
  fetchHolidayCardSummary,
  HOLIDAY_CARD_GREETING_TEXT,
  holidayCardWebUrl,
  mapCreateHolidayCardError,
} from '@/services/holiday-cards';

jest.mock('@/lib/supabase', () => ({ supabase: { rpc: jest.fn() } }));
jest.mock('@/services/ai', () => ({ invokeEdgeFunction: jest.fn() }));

const mockedRpc = supabase.rpc as unknown as jest.Mock;
const mockedInvoke = invokeEdgeFunction as jest.MockedFunction<typeof invokeEdgeFunction>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('holidayCardWebUrl', () => {
  it('points at the shop card page', () => {
    expect(holidayCardWebUrl('card-1')).toBe('https://shop.usemomora.com/c/card-1');
  });
});

describe('greeting strings', () => {
  it('mirror book-renderer/src/card/greetings.ts', () => {
    expect(HOLIDAY_CARD_GREETING_TEXT.es).toEqual({
      christmas: 'Feliz Navidad',
      holidays: 'Felices fiestas',
      'new-year': 'Feliz Año Nuevo',
    });
    expect(HOLIDAY_CARD_GREETING_TEXT.en).toEqual({
      christmas: 'Merry Christmas',
      holidays: 'Happy Holidays',
      'new-year': 'Happy New Year',
    });
  });
});

describe('fetchHolidayCardSummary', () => {
  it('calls the RPC and maps the single row', async () => {
    mockedRpc.mockResolvedValue({
      data: [
        { enabled: true, card_id: 'card-1', year: 2026, status: 'ready', last_failure_code: null, ordered: false, language: 'es' },
      ],
      error: null,
    });
    const result = await fetchHolidayCardSummary('family-1');
    expect(mockedRpc).toHaveBeenCalledWith('holiday_card_summary', { p_family_id: 'family-1' });
    expect(result).toEqual({
      data: {
        enabled: true,
        cardId: 'card-1',
        year: 2026,
        status: 'ready',
        lastFailureCode: null,
        ordered: false,
        language: 'es',
      },
      error: null,
    });
  });

  it('maps a switch-only row (no card) and defaults the language to English', async () => {
    mockedRpc.mockResolvedValue({
      data: [{ enabled: true, card_id: null, year: null, status: null, last_failure_code: null, ordered: false, language: 'fr' }],
      error: null,
    });
    const { data } = await fetchHolidayCardSummary('family-1');
    expect(data).toMatchObject({ enabled: true, cardId: null, status: null, language: 'en' });
  });

  it('returns null data for zero rows (not an owner/manager)', async () => {
    mockedRpc.mockResolvedValue({ data: [], error: null });
    expect(await fetchHolidayCardSummary('family-1')).toEqual({ data: null, error: null });
  });

  it('maps an RPC error', async () => {
    mockedRpc.mockResolvedValue({ data: null, error: { message: 'boom', code: '500' } });
    expect(await fetchHolidayCardSummary('family-1')).toEqual({ data: null, error: { message: 'boom', code: '500' } });
  });
});

describe('createHolidayCard', () => {
  it('invokes holiday-cards create with the greeting and the device timezone', async () => {
    mockedInvoke.mockResolvedValue({
      data: { success: true, created: true, card: { id: 'card-9' }, generation: 'dispatched', regionWarning: false },
      error: null,
    });
    const result = await createHolidayCard('family-1', 'holidays');
    expect(mockedInvoke).toHaveBeenCalledWith('holiday-cards', {
      op: 'create',
      familyId: 'family-1',
      greeting: 'holidays',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    expect(result).toEqual({ data: { cardId: 'card-9', created: true, regionWarning: false }, error: null });
  });

  it('surfaces regionWarning and created:false (200 for an existing card)', async () => {
    mockedInvoke.mockResolvedValue({
      data: { success: true, created: false, card: { id: 'card-9' }, regionWarning: true },
      error: null,
    });
    const { data } = await createHolidayCard('family-1', 'christmas');
    expect(data).toEqual({ cardId: 'card-9', created: false, regionWarning: true });
  });

  it('maps edge errors to typed codes', async () => {
    mockedInvoke.mockResolvedValue({ data: null, error: { message: 'x', code: 'HOLIDAY_CARDS_DISABLED' } });
    expect((await createHolidayCard('family-1', 'christmas')).error?.code).toBe('disabled');
    mockedInvoke.mockResolvedValue({ data: null, error: { message: 'x', code: 'holiday_card_slot_used' } });
    expect((await createHolidayCard('family-1', 'christmas')).error?.code).toBe('slot_used');
  });

  it('treats a malformed success body as unknown', async () => {
    mockedInvoke.mockResolvedValue({ data: { success: true } as never, error: null });
    expect((await createHolidayCard('family-1', 'christmas')).error?.code).toBe('unknown');
  });
});

describe('mapCreateHolidayCardError', () => {
  it.each([
    ['HOLIDAY_CARDS_DISABLED', 'disabled'],
    ['holiday_card_slot_used', 'slot_used'],
    ['SUBSCRIPTION_REQUIRED', 'subscription_required'],
    ['forbidden', 'forbidden'],
    ['500', 'unknown'],
    [undefined, 'network'],
  ])('%s -> %s', (code, expected) => {
    expect(mapCreateHolidayCardError({ message: 'm', code }).code).toBe(expected);
  });
});
