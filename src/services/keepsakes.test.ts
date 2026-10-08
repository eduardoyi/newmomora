import { supabase } from '@/lib/supabase';
import { fetchKeepsakesOverview, parseKeepsakesOverview } from '@/services/keepsakes';

jest.mock('@/lib/supabase', () => ({ supabase: { rpc: jest.fn() } }));

const mockedRpc = supabase.rpc as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

const cardFront = {
  card_id: 'card-1',
  year: 2026,
  image_key: 'family/front.jpg',
  width: 4000,
  height: 3000,
  layout: 'full-bleed',
  orientation: 'landscape',
  focal: { x: 0.3, y: 0.6 },
  greeting: 'christmas',
  language: 'es',
  greeting_text: 'Felices fiestas a todos',
  subline_text: '',
  greeting_position: 'top-center',
};

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
  card_front: cardFront,
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
        card_front: null,
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
      card_front: null,
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
      card_front: null,
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

describe('parseKeepsakesOverview card_front', () => {
  const parse = (raw: unknown) => parseKeepsakesOverview({ card_front: raw }).card_front;

  it('passes a well-formed card front through (an empty subline stays empty = hidden)', () => {
    expect(parse(cardFront)).toEqual(cardFront);
    expect(parse({ ...cardFront, subline_text: null, greeting_text: null })).toMatchObject({
      subline_text: null,
      greeting_text: null,
    });
  });

  it('is null without a card id or a year, or for a non-object', () => {
    expect(parse(null)).toBeNull();
    expect(parse('card')).toBeNull();
    expect(parse([])).toBeNull();
    expect(parse({ ...cardFront, card_id: '' })).toBeNull();
    expect(parse({ ...cardFront, year: '2026' })).toBeNull();
  });

  it('defaults unknown enums and a missing key', () => {
    expect(
      parse({ ...cardFront, layout: 'illustrated', greeting: 'easter', language: 'fr', greeting_position: 'middle', image_key: '' }),
    ).toMatchObject({
      layout: 'bordered',
      greeting: 'holidays',
      language: 'en',
      greeting_position: 'bottom-left',
      image_key: null,
    });
  });

  it('keeps the picture size only when both sides are valid, and derives the orientation from it', () => {
    expect(parse({ ...cardFront, width: 4000, height: null })).toMatchObject({ width: null, height: null });
    expect(parse({ ...cardFront, width: 0, height: 3000 })).toMatchObject({ width: null, height: null });
    expect(parse({ ...cardFront, orientation: undefined, width: 3000, height: 4000 })).toMatchObject({ orientation: 'portrait' });
    expect(parse({ ...cardFront, orientation: 'sideways', width: 4000, height: 3000 })).toMatchObject({ orientation: 'landscape' });
    expect(parse({ ...cardFront, orientation: undefined, width: null, height: null })).toMatchObject({ orientation: 'landscape' });
  });

  it('clamps the focal point and drops a malformed one', () => {
    expect(parse({ ...cardFront, focal: { x: -1, y: 4 } })).toMatchObject({ focal: { x: 0, y: 1 } });
    expect(parse({ ...cardFront, focal: { x: 0.5 } })).toMatchObject({ focal: null });
    expect(parse({ ...cardFront, focal: 'center' })).toMatchObject({ focal: null });
  });

  it('ignores wrongly typed text fields', () => {
    expect(parse({ ...cardFront, greeting_text: 5, subline_text: false })).toMatchObject({
      greeting_text: null,
      subline_text: null,
    });
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
