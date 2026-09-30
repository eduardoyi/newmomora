import { act, renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { yearFilmViewsQueryKey, yearFilmsQueryKey } from '@/hooks/queryKeys';
import {
  invalidateYearFilms,
  useFamilyYearFilms,
  useMarkYearFilmCompleted,
  useSaveYearFilmEdits,
  useYearFilmEditOptions,
  useMarkYearFilmViewed,
  useYearFilmPosters,
  useYearFilmsEnabled,
  useYearFilmViews,
} from '@/hooks/useYearFilms';
import {
  fetchFamilyYearFilms,
  fetchYearFilmsEnabled,
  fetchYearFilmViews,
  getYearFilmEditOptions,
  getYearFilmPosters,
  markYearFilmCompleted,
  markYearFilmViewed,
  saveYearFilmEdits,
  type YearFilm,
} from '@/services/year-films';

jest.mock('@/hooks/use-auth', () => ({ useAuth: jest.fn() }));

jest.mock('@/services/year-films', () => ({
  fetchFamilyYearFilms: jest.fn(),
  fetchYearFilmViews: jest.fn(),
  fetchYearFilmsEnabled: jest.fn(),
  getYearFilmPosters: jest.fn(),
  markYearFilmViewed: jest.fn(),
  markYearFilmCompleted: jest.fn(),
  getYearFilmEditOptions: jest.fn(),
  saveYearFilmEdits: jest.fn(),
}));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedFetchFilms = fetchFamilyYearFilms as jest.MockedFunction<typeof fetchFamilyYearFilms>;
const mockedFetchViews = fetchYearFilmViews as jest.MockedFunction<typeof fetchYearFilmViews>;
const mockedEnabled = fetchYearFilmsEnabled as jest.MockedFunction<typeof fetchYearFilmsEnabled>;
const mockedPosters = getYearFilmPosters as jest.MockedFunction<typeof getYearFilmPosters>;
const mockedMarkViewed = markYearFilmViewed as jest.MockedFunction<typeof markYearFilmViewed>;
const mockedMarkCompleted = markYearFilmCompleted as jest.MockedFunction<typeof markYearFilmCompleted>;
const mockedEditOptions = getYearFilmEditOptions as jest.MockedFunction<typeof getYearFilmEditOptions>;
const mockedSaveEdits = saveYearFilmEdits as jest.MockedFunction<typeof saveYearFilmEdits>;

const clients: QueryClient[] = [];

function makeClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, retry: false },
      mutations: { gcTime: Infinity, retry: false },
    },
  });
  clients.push(client);
  return client;
}

function createWrapper(queryClient = makeClient()) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function film(overrides: Partial<YearFilm> = {}): YearFilm {
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

// Poster queries carry a 55-minute gcTime of their own. Clear every client
// only AFTER RNTL's auto-cleanup has unmounted the hooks (this top-level
// afterEach is registered after RNTL's, so it runs after it), on a later tick:
// an observer that unsubscribes, or a fetch that settles, after client.clear()
// re-arms that timer on the removed query and `jest --detectOpenHandles`
// never exits.
afterEach(async () => {
  await Promise.all(clients.map((client) => waitFor(() => expect(client.isFetching()).toBe(0))));
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  clients.splice(0).forEach((client) => client.clear());
});

describe('useYearFilms hooks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseAuth.mockReturnValue({ user: { id: 'user-1' } } as ReturnType<typeof useAuth>);
    mockedFetchFilms.mockResolvedValue({ data: [], error: null });
    mockedFetchViews.mockResolvedValue({ data: [], error: null });
    mockedEnabled.mockResolvedValue({ data: false, error: null });
    mockedMarkViewed.mockResolvedValue({ error: null });
    mockedMarkCompleted.mockResolvedValue({ error: null });
  });

  describe('useFamilyYearFilms', () => {
    it('loads the family films', async () => {
      mockedFetchFilms.mockResolvedValue({ data: [film()], error: null });

      const { result } = renderHook(() => useFamilyYearFilms('family-1'), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.isFetched).toBe(true));
      expect(mockedFetchFilms).toHaveBeenCalledWith('family-1');
      expect(result.current.films.map((f) => f.id)).toEqual(['film-1']);
    });

    it('does not fetch without a family', () => {
      const { result } = renderHook(() => useFamilyYearFilms(null), { wrapper: createWrapper() });

      expect(mockedFetchFilms).not.toHaveBeenCalled();
      expect(result.current.films).toEqual([]);
    });

    it('surfaces a service error', async () => {
      mockedFetchFilms.mockResolvedValue({ data: null, error: { message: 'boom' } });

      const { result } = renderHook(() => useFamilyYearFilms('family-1'), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.films).toEqual([]);
    });

    it('drops a film that disappears server-side after invalidation', async () => {
      const queryClient = makeClient();
      mockedFetchFilms.mockResolvedValue({ data: [film({ id: 'a' }), film({ id: 'b' })], error: null });
      const { result } = renderHook(() => useFamilyYearFilms('family-1'), { wrapper: createWrapper(queryClient) });
      await waitFor(() => expect(result.current.films).toHaveLength(2));

      mockedFetchFilms.mockResolvedValue({ data: [film({ id: 'a' })], error: null });
      await act(async () => {
        await invalidateYearFilms(queryClient, 'family-1');
      });

      await waitFor(() => expect(result.current.films.map((f) => f.id)).toEqual(['a']));
    });
  });

  describe('invalidateYearFilms', () => {
    it('invalidates one family, or all when no family is given', async () => {
      const queryClient = makeClient();
      queryClient.setQueryData(yearFilmsQueryKey('family-1'), [film()]);
      queryClient.setQueryData(yearFilmsQueryKey('family-2'), [film()]);

      await invalidateYearFilms(queryClient, 'family-1');
      expect(queryClient.getQueryState(yearFilmsQueryKey('family-1'))?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(yearFilmsQueryKey('family-2'))?.isInvalidated).toBe(false);

      await invalidateYearFilms(queryClient);
      expect(queryClient.getQueryState(yearFilmsQueryKey('family-2'))?.isInvalidated).toBe(true);
    });
  });

  describe('views', () => {
    it('exposes the viewed ids', async () => {
      mockedFetchViews.mockResolvedValue({
        data: [{ film_id: 'film-1', first_viewed_at: '2026-10-02T00:00:00Z', completed_at: null }],
        error: null,
      });

      const { result } = renderHook(() => useYearFilmViews(), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.viewedIds.has('film-1')).toBe(true);
      expect(result.current.viewedIds.has('film-2')).toBe(false);
    });

    it('markViewed writes then invalidates the views query', async () => {
      const queryClient = makeClient();
      queryClient.setQueryData(yearFilmViewsQueryKey('user-1'), []);

      const { result } = renderHook(() => useMarkYearFilmViewed(), { wrapper: createWrapper(queryClient) });
      await act(async () => {
        await result.current.mutateAsync('film-1');
      });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockedMarkViewed).toHaveBeenCalledWith('film-1');
      expect(queryClient.getQueryState(yearFilmViewsQueryKey('user-1'))?.isInvalidated).toBe(true);
    });

    it('markCompleted writes then invalidates the views query', async () => {
      const queryClient = makeClient();
      queryClient.setQueryData(yearFilmViewsQueryKey('user-1'), []);

      const { result } = renderHook(() => useMarkYearFilmCompleted(), { wrapper: createWrapper(queryClient) });
      await act(async () => {
        await result.current.mutateAsync('film-1');
      });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockedMarkCompleted).toHaveBeenCalledWith('film-1');
      expect(queryClient.getQueryState(yearFilmViewsQueryKey('user-1'))?.isInvalidated).toBe(true);
    });

    it('rejects when the write fails', async () => {
      mockedMarkViewed.mockResolvedValue({ error: { message: 'denied' } });

      const { result } = renderHook(() => useMarkYearFilmViewed(), { wrapper: createWrapper() });
      await act(async () => {
        await expect(result.current.mutateAsync('film-1')).rejects.toThrow('denied');
      });
      await waitFor(() => expect(result.current.isError).toBe(true));
    });
  });

  describe('useYearFilmsEnabled', () => {
    it('returns the server boolean', async () => {
      mockedEnabled.mockResolvedValue({ data: true, error: null });

      const { result } = renderHook(() => useYearFilmsEnabled('family-1'), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.enabled).toBe(true));
      expect(mockedEnabled).toHaveBeenCalledWith('family-1');
    });

    it('is false while loading and on error', async () => {
      mockedEnabled.mockResolvedValue({ data: null, error: { message: 'x' } });

      const { result } = renderHook(() => useYearFilmsEnabled('family-1'), { wrapper: createWrapper() });

      expect(result.current.enabled).toBe(false);
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.enabled).toBe(false);
    });
  });

  describe('useYearFilmPosters', () => {
    it('batches same-tick films into one request and returns url + cacheKey', async () => {
      mockedPosters.mockResolvedValue({ data: { a: 'https://r2/a', b: 'https://r2/b' }, error: null });

      const { result } = renderHook(
        () =>
          useYearFilmPosters([
            { id: 'a', ready_at: '2026-10-01T18:00:00.000Z' },
            { id: 'b', ready_at: null },
            'c',
          ]),
        { wrapper: createWrapper() },
      );

      await waitFor(() => expect(Object.keys(result.current).sort()).toEqual(['a', 'b']));
      expect(mockedPosters).toHaveBeenCalledTimes(1);
      expect([...mockedPosters.mock.calls[0][0]].sort()).toEqual(['a', 'b', 'c']);
      expect(result.current.a).toEqual({
        url: 'https://r2/a',
        cacheKey: 'film-thumb:a:2026-10-01T18:00:00.000Z',
      });
      expect(result.current.b.cacheKey).toBe('film-thumb:b:');
      expect(result.current.c).toBeUndefined();
    });

    it('only signs the new ids when the list grows', async () => {
      mockedPosters.mockImplementation(async (ids) => ({
        data: Object.fromEntries(ids.map((id) => [id, `https://r2/${id}`])),
        error: null,
      }));

      const { result, rerender } = renderHook(
        ({ ids }: { ids: string[] }) => useYearFilmPosters(ids),
        { wrapper: createWrapper(), initialProps: { ids: ['a'] } },
      );
      await waitFor(() => expect(result.current.a).toBeDefined());

      rerender({ ids: ['a', 'b'] });
      await waitFor(() => expect(result.current.b).toBeDefined());

      expect(mockedPosters).toHaveBeenCalledTimes(2);
      expect(mockedPosters.mock.calls[1][0]).toEqual(['b']);
    });

    it('returns no posters when the request fails', async () => {
      mockedPosters.mockResolvedValue({ data: null, error: { message: 'bad' } });

      const { result } = renderHook(() => useYearFilmPosters(['a']), { wrapper: createWrapper() });

      await waitFor(() => expect(mockedPosters).toHaveBeenCalled());
      expect(result.current).toEqual({});
    });
  });
  describe('edit sheet hooks', () => {
    const editableOptions = {
      editable: true as const,
      kind: 'birthday' as const,
      editsVersion: 0,
      musicBedId: 'bright-pop',
      removedMemoryIds: [],
      chosenQuote: null,
      frames: [],
      quoteCandidates: [],
    };

    it('useYearFilmEditOptions loads the options for the film', async () => {
      mockedEditOptions.mockResolvedValue({ data: editableOptions, error: null });

      const { result } = renderHook(() => useYearFilmEditOptions('film-1'), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.options).toEqual(editableOptions));
      expect(mockedEditOptions).toHaveBeenCalledWith('film-1');
    });

    it('useYearFilmEditOptions does not fetch when disabled or without a film', () => {
      renderHook(() => useYearFilmEditOptions('film-1', { enabled: false }), { wrapper: createWrapper() });
      renderHook(() => useYearFilmEditOptions(null), { wrapper: createWrapper() });

      expect(mockedEditOptions).not.toHaveBeenCalled();
    });

    it('useYearFilmEditOptions surfaces a failure', async () => {
      mockedEditOptions.mockResolvedValue({ data: null, error: { message: 'Not authorized', code: '42501' } });

      const { result } = renderHook(() => useYearFilmEditOptions('film-1'), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.options).toBeNull();
    });

    it('useSaveYearFilmEdits saves, then invalidates the films and the options', async () => {
      mockedSaveEdits.mockResolvedValue({ data: { ok: true, editsVersion: 1 }, error: null });
      const queryClient = makeClient();
      const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useSaveYearFilmEdits(), { wrapper: createWrapper(queryClient) });
      let outcome: unknown;
      await act(async () => {
        outcome = await result.current.mutateAsync({ filmId: 'film-1', edits: { removedMemoryIds: ['m-1'] } });
      });

      expect(outcome).toEqual({ ok: true, editsVersion: 1 });
      expect(mockedSaveEdits).toHaveBeenCalledWith('film-1', { removedMemoryIds: ['m-1'] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['year-films'] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['year-films', 'edit-options', 'film-1'] });
    });

    it('useSaveYearFilmEdits resolves an expected failure without invalidating', async () => {
      mockedSaveEdits.mockResolvedValue({ data: { ok: false, reason: 'rate_limited' }, error: null });
      const queryClient = makeClient();
      const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useSaveYearFilmEdits(), { wrapper: createWrapper(queryClient) });
      let outcome: unknown;
      await act(async () => {
        outcome = await result.current.mutateAsync({ filmId: 'film-1', edits: { removedMemoryIds: [] } });
      });

      expect(outcome).toEqual({ ok: false, reason: 'rate_limited' });
      expect(invalidate).not.toHaveBeenCalled();
    });

    it('useSaveYearFilmEdits rejects on an unexpected error', async () => {
      mockedSaveEdits.mockResolvedValue({ data: null, error: { message: 'timeout' } });

      const { result } = renderHook(() => useSaveYearFilmEdits(), { wrapper: createWrapper() });

      await act(async () => {
        await expect(
          result.current.mutateAsync({ filmId: 'film-1', edits: { removedMemoryIds: [] } }),
        ).rejects.toThrow('timeout');
      });
    });
  });
});
