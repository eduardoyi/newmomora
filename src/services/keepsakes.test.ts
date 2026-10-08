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

const { card_id: _cardId, year: _year, ...pastFront } = { ...cardFront, card_id: 'card-0', year: 2025, greeting: 'holidays', language: 'en' };

const upcomingBirthday = {
  kind: 'birthday',
  member_id: 'child-1',
  age_year: 4,
  film_date: '2026-11-20',
  scope_start: '2025-11-20',
  scope_end_excl: '2026-11-20',
  moments: 12,
  visuals: 7,
  min_moments: 15,
  min_visuals: 8,
  quarters: null,
  min_quarters: null,
  picture_key: 'family/b.jpg',
};

const upcomingYear = {
  kind: 'family_year',
  member_id: null,
  age_year: null,
  film_date: '2027-01-01',
  scope_start: '2026-01-01',
  scope_end_excl: '2027-01-01',
  moments: 40,
  visuals: 20,
  min_moments: 30,
  min_visuals: 15,
  quarters: 3,
  min_quarters: 3,
  picture_key: null,
};

const rawCards = [
  { card_id: 'card-1', year: 2026, status: 'ready', ordered: false, front: pastFront },
  { card_id: 'card-0', year: 2025, status: 'ready', ordered: true, front: pastFront },
];

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
  cards: rawCards,
  upcoming_films: [upcomingBirthday, upcomingYear],
};

// What the parser makes of `full`: each card's front gets the entry's own id and year.
const parsedFull = {
  ...full,
  cards: rawCards.map((entry) => ({ ...entry, front: { ...entry.front, card_id: entry.card_id, year: entry.year } })),
};

describe('parseKeepsakesOverview', () => {
  it('passes a well-formed payload through', () => {
    expect(parseKeepsakesOverview(full)).toEqual(parsedFull);
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
        cards: [],
        upcoming_films: [upcomingYear],
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
      cards: [],
      upcoming_films: [upcomingYear],
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
      cards: [],
      upcoming_films: [],
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

describe('parseKeepsakesOverview cards', () => {
  const parse = (raw: unknown) => parseKeepsakesOverview({ cards: raw }).cards;

  it('is [] when the server has no cards key (old server) or it is not an array', () => {
    expect(parseKeepsakesOverview({}).cards).toEqual([]);
    expect(parse(null)).toEqual([]);
    expect(parse({})).toEqual([]);
  });

  it('keeps the server order and fills each front with the entry id and year', () => {
    const cards = parse(rawCards);
    expect(cards.map((c) => [c.card_id, c.year, c.status, c.ordered])).toEqual([
      ['card-1', 2026, 'ready', false],
      ['card-0', 2025, 'ready', true],
    ]);
    expect(cards[1].front).toMatchObject({ card_id: 'card-0', year: 2025, layout: 'full-bleed', image_key: 'family/front.jpg' });
  });

  it('skips entries without an id, a year or a known status, and repeated ids', () => {
    const base = rawCards[0];
    expect(
      parse([
        'junk',
        { ...base, card_id: '' },
        { ...base, year: '2026' },
        { ...base, status: 'queued' },
        { ...base, card_id: 'ok' },
        { ...base, card_id: 'ok', year: 2024 },
      ]).map((c) => [c.card_id, c.year]),
    ).toEqual([['ok', 2026]]);
  });

  it('keeps a card without a usable front (front null) and reads ordered strictly', () => {
    const [card] = parse([{ card_id: 'c', year: 2025, status: 'generating', ordered: 'yes', front: 'nope' }]);
    expect(card).toEqual({ card_id: 'c', year: 2025, status: 'generating', ordered: false, front: null });
  });
});

describe('parseKeepsakesOverview upcoming_films', () => {
  const parse = (raw: unknown) => parseKeepsakesOverview({ upcoming_films: raw }).upcoming_films;

  it('is [] without the key (old server) or for a non-array', () => {
    expect(parseKeepsakesOverview({}).upcoming_films).toEqual([]);
    expect(parse('x')).toEqual([]);
    expect(parse(null)).toEqual([]);
  });

  it('passes well-formed birthday and year-end entries through', () => {
    expect(parse([upcomingBirthday, upcomingYear])).toEqual([upcomingBirthday, upcomingYear]);
  });

  it('skips unknown kinds, bad dates, missing floors and a birthday without its child', () => {
    expect(
      parse([
        { ...upcomingBirthday, kind: 'family_month' },
        { ...upcomingBirthday, film_date: 'soon' },
        { ...upcomingBirthday, scope_start: null },
        { ...upcomingBirthday, scope_end_excl: '2026-13' },
        { ...upcomingBirthday, min_moments: undefined },
        { ...upcomingBirthday, min_visuals: '8' },
        { ...upcomingBirthday, member_id: null },
        'junk',
        upcomingYear,
      ]),
    ).toEqual([upcomingYear]);
  });

  it('keeps quarters only when both numbers are there, and clamps negative counts', () => {
    expect(parse([{ ...upcomingYear, quarters: 2, min_quarters: null }])[0]).toMatchObject({ quarters: null, min_quarters: null });
    expect(parse([{ ...upcomingYear, quarters: 1, min_quarters: 3 }])[0]).toMatchObject({ quarters: 1, min_quarters: 3 });
    expect(parse([{ ...upcomingYear, moments: -4, visuals: 'x' }])[0]).toMatchObject({ moments: 0, visuals: 0 });
  });

  it('drops a year-end entry member id and a non-positive age', () => {
    expect(parse([{ ...upcomingYear, member_id: 'child-1', age_year: 0 }])[0]).toMatchObject({ member_id: null, age_year: null });
  });
});

describe('fetchKeepsakesOverview', () => {
  it('calls the RPC with the family id and parses the result', async () => {
    mockedRpc.mockResolvedValue({ data: full, error: null });
    await expect(fetchKeepsakesOverview('family-1')).resolves.toEqual(parsedFull);
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
