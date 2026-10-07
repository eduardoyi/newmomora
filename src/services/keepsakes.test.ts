import { supabase } from '@/lib/supabase';
import { fetchKeepsakesOverview, parseKeepsakesOverview } from '@/services/keepsakes';

jest.mock('@/lib/supabase', () => ({ supabase: { rpc: jest.fn() } }));

const mockedRpc = supabase.rpc as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

const full = {
  recap: {
    month_start: '2026-10-01',
    delivers_on: '2026-11-01',
    moments: 7,
    visuals: 3,
    min_moments: 10,
    min_visuals: 6,
    picture_key: 'family/pic.jpg',
  },
  has_viewers: true,
  year_moments: 42,
  holiday_pool: 30,
  holiday_min_pool: 20,
  holiday_ship_by_note: 'Order by Dec 10 for Christmas delivery in the US.',
  preview_key: 'family/preview.jpg',
  book_preview_keys: { 'child-1': 'family/child-1.jpg' },
  orders: [
    { product: 'book', item_id: 'book-1', status: 'shipped', shipped_at: null },
    { product: 'card', item_id: 'card-1', status: 'shipped', shipped_at: '2026-12-12T10:00:00+00:00' },
  ],
};

describe('parseKeepsakesOverview', () => {
  it('passes a well-formed payload through', () => {
    expect(parseKeepsakesOverview(full)).toEqual(full);
  });

  it('turns a viewer payload (nulls and empties) into nulls and empties', () => {
    expect(
      parseKeepsakesOverview({
        recap: full.recap,
        has_viewers: null,
        year_moments: null,
        holiday_pool: null,
        holiday_min_pool: null,
        holiday_ship_by_note: null,
        preview_key: null,
        book_preview_keys: null,
        orders: [],
      }),
    ).toEqual({
      recap: full.recap,
      has_viewers: null,
      year_moments: null,
      holiday_pool: null,
      holiday_min_pool: null,
      holiday_ship_by_note: null,
      preview_key: null,
      book_preview_keys: {},
      orders: [],
    });
  });

  it.each([null, undefined, 'nope', 42, [], {}])('never throws on a non-conforming payload (%p)', (raw) => {
    expect(parseKeepsakesOverview(raw)).toEqual({
      recap: null,
      has_viewers: null,
      year_moments: null,
      holiday_pool: null,
      holiday_min_pool: null,
      holiday_ship_by_note: null,
      preview_key: null,
      book_preview_keys: {},
      orders: [],
    });
  });

  it('drops a recap without valid owner-local dates', () => {
    expect(parseKeepsakesOverview({ recap: { ...full.recap, month_start: 'October' } }).recap).toBeNull();
    expect(parseKeepsakesOverview({ recap: { ...full.recap, delivers_on: null } }).recap).toBeNull();
    expect(parseKeepsakesOverview({ recap: 'x' }).recap).toBeNull();
  });

  it('defaults missing recap numbers (floors fall back to 10 / 6)', () => {
    const recap = parseKeepsakesOverview({ recap: { month_start: '2026-10-01', delivers_on: '2026-11-01' } }).recap!;
    expect(recap).toMatchObject({ moments: 0, visuals: 0, min_moments: 10, min_visuals: 6, picture_key: null });
  });

  it('skips malformed orders and preview keys', () => {
    const parsed = parseKeepsakesOverview({
      book_preview_keys: { a: 'k1', b: 3, c: '' },
      orders: [
        { product: 'poster', item_id: 'x', status: 'paid' },
        { product: 'book', item_id: '', status: 'paid' },
        { product: 'book', item_id: 'b', status: 5 },
        'junk',
        { product: 'book', item_id: 'ok', status: 'paid' },
      ],
    });
    expect(parsed.book_preview_keys).toEqual({ a: 'k1' });
    expect(parsed.orders).toEqual([{ product: 'book', item_id: 'ok', status: 'paid', shipped_at: null }]);
  });

  it('ignores wrongly typed scalars', () => {
    const parsed = parseKeepsakesOverview({ has_viewers: 'yes', year_moments: '40', holiday_ship_by_note: '', preview_key: 3 });
    expect(parsed).toMatchObject({ has_viewers: null, year_moments: null, holiday_ship_by_note: null, preview_key: null });
  });
});

describe('fetchKeepsakesOverview', () => {
  it('calls the RPC with the family id and parses the result', async () => {
    mockedRpc.mockResolvedValue({ data: full, error: null });
    await expect(fetchKeepsakesOverview('family-1')).resolves.toEqual(full);
    expect(mockedRpc).toHaveBeenCalledWith('keepsakes_overview', { p_family_id: 'family-1' });
  });

  it('parses a malformed payload instead of throwing', async () => {
    mockedRpc.mockResolvedValue({ data: 'garbage', error: null });
    await expect(fetchKeepsakesOverview('family-1')).resolves.toMatchObject({ recap: null, orders: [] });
  });

  it('throws only on an RPC error', async () => {
    mockedRpc.mockResolvedValue({ data: null, error: { message: 'function not found', code: '42883' } });
    await expect(fetchKeepsakesOverview('family-1')).rejects.toThrow('function not found');
  });
});
