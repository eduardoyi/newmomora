import { supabase } from '@/lib/supabase';
import { invokeEdgeFunction } from '@/services/ai';
import {
  fetchFamilyYearFilms,
  fetchYearFilmsEnabled,
  fetchYearFilmViews,
  getYearFilmPlayback,
  getYearFilmPosters,
  markYearFilmCompleted,
  markYearFilmViewed,
} from '@/services/year-films';

jest.mock('@/lib/supabase', () => ({
  supabase: { from: jest.fn(), rpc: jest.fn(), auth: { getUser: jest.fn() } },
}));

jest.mock('@/services/ai', () => ({
  invokeEdgeFunction: jest.fn(),
}));

const mockedSupabase = supabase as unknown as {
  from: jest.Mock;
  rpc: jest.Mock;
  auth: { getUser: jest.Mock };
};
const mockedInvoke = invokeEdgeFunction as jest.MockedFunction<typeof invokeEdgeFunction>;

const NOW = new Date('2026-10-20T12:00:00.000Z');

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'film-1',
    family_id: 'family-1',
    kind: 'family_month',
    family_member_id: null,
    age_year: null,
    scope_start_date: '2026-09-01',
    scope_end_exclusive: '2026-10-01',
    scope_label: null,
    language: 'en',
    placement_date: '2026-09-30',
    duration_ms: 60000,
    surface_at: '2026-10-01T19:00:00.000Z',
    ready_at: '2026-10-01T18:00:00.000Z',
    edits_version: 0,
    status: 'ready',
    blocked: false,
    stale: false,
    ...overrides,
  };
}

describe('year-films service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  });

  describe('fetchFamilyYearFilms', () => {
    function mockList(result: { data: unknown; error: unknown }) {
      const order = jest.fn().mockResolvedValue(result);
      const eq = jest.fn().mockReturnValue({ order });
      const select = jest.fn().mockReturnValue({ eq });
      mockedSupabase.from.mockReturnValue({ select } as never);
      return { select, eq, order };
    }

    it('selects the granted columns for the family, newest placement first', async () => {
      const { select, eq, order } = mockList({ data: [row()], error: null });

      const result = await fetchFamilyYearFilms('family-1', NOW);

      expect(mockedSupabase.from).toHaveBeenCalledWith('year_films');
      expect(select.mock.calls[0][0]).toContain('placement_date');
      expect(select.mock.calls[0][0]).not.toMatch(/video_key|poster_key|film_script/);
      expect(eq).toHaveBeenCalledWith('family_id', 'family-1');
      expect(order).toHaveBeenCalledWith('placement_date', { ascending: false });
      expect(result.error).toBeNull();
      expect(result.data).toEqual([row()]);
    });

    it('drops films that have not surfaced yet (owners/managers see them under RLS)', async () => {
      mockList({
        data: [
          row({ id: 'future', surface_at: '2026-10-21T09:00:00.000Z' }),
          row({ id: 'past' }),
        ],
        error: null,
      });

      const result = await fetchFamilyYearFilms('family-1', NOW);

      expect(result.data?.map((f) => f.id)).toEqual(['past']);
    });

    it('drops rows without a placement date or with an unknown kind', async () => {
      mockList({
        data: [row({ id: 'no-date', placement_date: null }), row({ id: 'odd', kind: 'mystery' }), row({ id: 'ok' })],
        error: null,
      });

      const result = await fetchFamilyYearFilms('family-1', NOW);

      expect(result.data?.map((f) => f.id)).toEqual(['ok']);
    });

    it('maps a Supabase error', async () => {
      mockList({ data: null, error: { message: 'boom', code: '500' } });

      const result = await fetchFamilyYearFilms('family-1', NOW);

      expect(result.data).toBeNull();
      expect(result.error).toEqual({ message: 'boom', code: '500' });
    });
  });

  describe('fetchYearFilmViews', () => {
    it('reads the own view rows', async () => {
      const select = jest.fn().mockResolvedValue({
        data: [{ film_id: 'film-1', first_viewed_at: '2026-10-02T00:00:00Z', completed_at: null }],
        error: null,
      });
      mockedSupabase.from.mockReturnValue({ select } as never);

      const result = await fetchYearFilmViews();

      expect(mockedSupabase.from).toHaveBeenCalledWith('year_film_views');
      expect(select).toHaveBeenCalledWith('film_id, first_viewed_at, completed_at');
      expect(result.data).toHaveLength(1);
      expect(result.error).toBeNull();
    });

    it('maps an error', async () => {
      const select = jest.fn().mockResolvedValue({ data: null, error: { message: 'nope', code: '42501' } });
      mockedSupabase.from.mockReturnValue({ select } as never);

      const result = await fetchYearFilmViews();

      expect(result).toEqual({ data: null, error: { message: 'nope', code: '42501' } });
    });
  });

  describe('markYearFilmViewed', () => {
    it('inserts with ON CONFLICT DO NOTHING (ignoreDuplicates) for the current user', async () => {
      const upsert = jest.fn().mockResolvedValue({ error: null });
      mockedSupabase.from.mockReturnValue({ upsert } as never);

      const result = await markYearFilmViewed('film-1');

      expect(mockedSupabase.from).toHaveBeenCalledWith('year_film_views');
      expect(upsert).toHaveBeenCalledWith(
        { film_id: 'film-1', user_id: 'user-1' },
        { onConflict: 'film_id,user_id', ignoreDuplicates: true },
      );
      expect(result.error).toBeNull();
    });

    it('fails without writing when signed out', async () => {
      mockedSupabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: null });

      const result = await markYearFilmViewed('film-1');

      expect(result.error?.code).toBe('unauthorized');
      expect(mockedSupabase.from).not.toHaveBeenCalled();
    });

    it('maps a write error', async () => {
      const upsert = jest.fn().mockResolvedValue({ error: { message: 'denied', code: '42501' } });
      mockedSupabase.from.mockReturnValue({ upsert } as never);

      expect((await markYearFilmViewed('film-1')).error).toEqual({ message: 'denied', code: '42501' });
    });
  });

  describe('markYearFilmCompleted', () => {
    it('stamps completed_at on the own row only', async () => {
      const eqUser = jest.fn().mockResolvedValue({ error: null });
      const eqFilm = jest.fn().mockReturnValue({ eq: eqUser });
      const update = jest.fn().mockReturnValue({ eq: eqFilm });
      mockedSupabase.from.mockReturnValue({ update } as never);

      const result = await markYearFilmCompleted('film-1', NOW);

      expect(update).toHaveBeenCalledWith({ completed_at: NOW.toISOString() });
      expect(eqFilm).toHaveBeenCalledWith('film_id', 'film-1');
      expect(eqUser).toHaveBeenCalledWith('user_id', 'user-1');
      expect(result.error).toBeNull();
    });
  });

  describe('getYearFilmPlayback', () => {
    const playback = {
      videoUrl: 'https://r2/video.mp4',
      posterUrl: 'https://r2/poster.jpg',
      scenesUrl: 'https://r2/scenes.json',
      durationMs: 60000,
      expiresIn: 900,
    };

    it('invokes single mode and returns the URLs', async () => {
      mockedInvoke.mockResolvedValue({ data: playback, error: null });

      const result = await getYearFilmPlayback('film-1');

      expect(mockedInvoke).toHaveBeenCalledWith('get-year-film-url', { filmId: 'film-1' });
      expect(result).toEqual({ data: playback, error: null, unavailable: false });
    });

    it.each([
      ['film_unavailable'],
      ['not_found'],
      ['404'],
      ['409'],
    ])('maps %s to an unavailable result', async (code) => {
      mockedInvoke.mockResolvedValue({ data: null, error: { message: 'Film not available', code } });

      const result = await getYearFilmPlayback('film-1');

      expect(result.unavailable).toBe(true);
      expect(result.data).toBeNull();
      expect(result.error?.code).toBe('film_unavailable');
    });

    it('keeps other errors as retryable failures', async () => {
      mockedInvoke.mockResolvedValue({ data: null, error: { message: 'Something went wrong', code: '500' } });

      const result = await getYearFilmPlayback('film-1');

      expect(result.unavailable).toBe(false);
      expect(result.error).toEqual({ message: 'Something went wrong', code: '500' });
    });

    it('treats a response without a video URL as unavailable', async () => {
      mockedInvoke.mockResolvedValue({ data: null, error: null });

      const result = await getYearFilmPlayback('film-1');

      expect(result.unavailable).toBe(true);
    });
  });

  describe('getYearFilmPosters', () => {
    it('sends one batch request and returns the poster map', async () => {
      mockedInvoke.mockResolvedValue({ data: { posters: { a: 'https://r2/a.jpg' } }, error: null });

      const result = await getYearFilmPosters(['a', 'b']);

      expect(mockedInvoke).toHaveBeenCalledTimes(1);
      expect(mockedInvoke).toHaveBeenCalledWith('get-year-film-url', { filmIds: ['a', 'b'] });
      expect(result).toEqual({ data: { a: 'https://r2/a.jpg' }, error: null });
    });

    it('chunks at 50 ids, dedupes, and merges the responses', async () => {
      const ids = Array.from({ length: 120 }, (_, i) => `film-${i}`);
      mockedInvoke.mockImplementation(async (_fn, body) => ({
        data: { posters: Object.fromEntries((body.filmIds as string[]).map((id) => [id, `url-${id}`])) },
        error: null,
      }));

      const result = await getYearFilmPosters([...ids, 'film-0']);

      expect(mockedInvoke).toHaveBeenCalledTimes(3);
      expect((mockedInvoke.mock.calls[0][1].filmIds as string[]).length).toBe(50);
      expect((mockedInvoke.mock.calls[2][1].filmIds as string[]).length).toBe(20);
      expect(Object.keys(result.data!)).toHaveLength(120);
    });

    it('does not call the function for an empty list', async () => {
      const result = await getYearFilmPosters([]);

      expect(mockedInvoke).not.toHaveBeenCalled();
      expect(result).toEqual({ data: {}, error: null });
    });

    it('fails when a chunk fails', async () => {
      mockedInvoke.mockResolvedValue({ data: null, error: { message: 'bad', code: '500' } });

      const result = await getYearFilmPosters(['a']);

      expect(result).toEqual({ data: null, error: { message: 'bad', code: '500' } });
    });
  });

  describe('fetchYearFilmsEnabled', () => {
    it('calls the RPC and returns the boolean', async () => {
      mockedSupabase.rpc.mockResolvedValue({ data: true, error: null });

      const result = await fetchYearFilmsEnabled('family-1');

      expect(mockedSupabase.rpc).toHaveBeenCalledWith('year_films_enabled', { p_family_id: 'family-1' });
      expect(result).toEqual({ data: true, error: null });
    });

    it('maps an error', async () => {
      mockedSupabase.rpc.mockResolvedValue({ data: null, error: { message: 'x', code: 'P0001' } });

      expect(await fetchYearFilmsEnabled('family-1')).toEqual({ data: null, error: { message: 'x', code: 'P0001' } });
    });
  });
});
