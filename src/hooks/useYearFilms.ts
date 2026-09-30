// Year Films data hooks (docs/plans/year-film-p2.md Steps 3-4). The pure
// placement / title helpers live in src/utils/year-films.ts.
import { useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useAuth } from '@/hooks/use-auth';
import {
  yearFilmEditOptionsQueryKey,
  yearFilmPosterQueryKey,
  yearFilmsEnabledQueryKey,
  yearFilmsQueryKey,
  yearFilmsQueryKeyBase,
  yearFilmViewsQueryKey,
} from '@/hooks/queryKeys';
import {
  fetchFamilyYearFilms,
  fetchYearFilmsEnabled,
  fetchYearFilmViews,
  getYearFilmEditOptions,
  getYearFilmPosters,
  markYearFilmCompleted,
  markYearFilmViewed,
  saveYearFilmEdits,
  type SaveYearFilmEditsResult,
  type YearFilm,
  type YearFilmEditOptions,
  type YearFilmEdits,
  type YearFilmView,
} from '@/services/year-films';

/** Posters are signed for 60 min (POSTER_URL_TTL_SECONDS in get-year-film-url);
 * refresh well inside that so an on-screen tile never holds a dead URL. */
const POSTER_STALE_TIME = 45 * 60 * 1000;
const POSTER_GC_TIME = 55 * 60 * 1000;
/** A film omitted by the server (not servable yet) is retried sooner. */
const POSTER_MISSING_STALE_TIME = 60 * 1000;
const FILMS_STALE_TIME = 60 * 1000;

function toError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return new Error(String((error as { message: unknown }).message));
  }
  return new Error(fallback);
}

function familyYearFilmsQueryOptions(familyId: string | null | undefined) {
  return {
    queryKey: yearFilmsQueryKey(familyId),
    queryFn: async (): Promise<YearFilm[]> => {
      const { data, error } = await fetchFamilyYearFilms(familyId!);
      if (error) throw toError(error, 'Could not load films');
      return data ?? [];
    },
    staleTime: FILMS_STALE_TIME,
  };
}

/** Warm the films query (Timeline prefetches it at mount so anchored
 * rendering does not race a late film insert). */
export function prefetchFamilyYearFilms(queryClient: QueryClient, familyId: string | null | undefined) {
  if (!familyId) return Promise.resolve();
  return queryClient.prefetchQuery(familyYearFilmsQueryOptions(familyId));
}

/**
 * Invalidate the films list -- for a `film_ready` push, a drawer open, or
 * after the player learns a film is gone. Without `familyId`, every family's
 * cache is invalidated.
 */
export function invalidateYearFilms(queryClient: QueryClient, familyId?: string | null) {
  return queryClient.invalidateQueries({
    queryKey: familyId ? yearFilmsQueryKey(familyId) : [yearFilmsQueryKeyBase],
  });
}

/**
 * The family's surfaced films, newest placement first. Refetches on app
 * foreground (`refetchOnWindowFocus`, wired to AppState in app-providers) and
 * on mount when stale; tab screens never unmount, so screen-focus callers
 * should also call `refetch()` in their own focus effect. A film that
 * disappears server-side (blocked, deleted) drops out on the next refetch.
 */
export function useFamilyYearFilms(
  familyId: string | null | undefined,
  options: { enabled?: boolean } = {},
) {
  const query = useQuery({
    ...familyYearFilmsQueryOptions(familyId),
    enabled: Boolean(familyId) && (options.enabled ?? true),
    refetchOnWindowFocus: true,
  });

  return {
    films: query.data ?? EMPTY_FILMS,
    isLoading: query.isLoading,
    /** True once a fetch has settled (success or error) -- Timeline waits on this before anchoring. */
    isFetched: query.isFetched,
    isRefetching: query.isRefetching,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}

const EMPTY_FILMS: YearFilm[] = [];
const EMPTY_VIEWS: YearFilmView[] = [];

/** The caller's own view rows; `viewedIds` feeds `isNewFilm`. Don't show
 * "New" while `isLoading`. */
export function useYearFilmViews() {
  const { user } = useAuth();
  const userId = user?.id;

  const query = useQuery({
    queryKey: yearFilmViewsQueryKey(userId),
    queryFn: async (): Promise<YearFilmView[]> => {
      const { data, error } = await fetchYearFilmViews();
      if (error) throw toError(error, 'Could not load film views');
      return data ?? [];
    },
    enabled: Boolean(userId),
    staleTime: FILMS_STALE_TIME,
    refetchOnWindowFocus: true,
  });

  const views = query.data ?? EMPTY_VIEWS;
  const viewedIds = useMemo(() => new Set(views.map((view) => view.film_id)), [views]);

  return {
    views,
    viewedIds,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}

/** `mutate(filmId)`: records the first view (insert-ignore) and refreshes the views query. */
export function useMarkYearFilmViewed() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (filmId: string) => {
      const { error } = await markYearFilmViewed(filmId);
      if (error) throw toError(error, 'Could not record the view');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: yearFilmViewsQueryKey(user?.id) }),
  });
}

/** `mutate(filmId)`: stamps `completed_at` on the own view row and refreshes the views query. */
export function useMarkYearFilmCompleted() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (filmId: string) => {
      const { error } = await markYearFilmCompleted(filmId);
      if (error) throw toError(error, 'Could not record completion');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: yearFilmViewsQueryKey(user?.id) }),
  });
}

/** Whether to show the upcoming next-month recap card (server-decided). */
export function useYearFilmsEnabled(familyId: string | null | undefined) {
  const query = useQuery({
    queryKey: yearFilmsEnabledQueryKey(familyId),
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await fetchYearFilmsEnabled(familyId!);
      if (error) throw toError(error, 'Could not load film settings');
      return data === true;
    },
    enabled: Boolean(familyId),
    staleTime: 10 * 60 * 1000,
  });

  return { enabled: query.data === true, isLoading: query.isLoading, isError: query.isError };
}

// --- posters -------------------------------------------------------------

/** What `useYearFilmPosters` needs per film: the id, and `ready_at` for the
 * stable image cacheKey. A bare id string is accepted too (drawer rows, which
 * only carry the film id; the cacheKey then has an empty ready_at part). */
export type YearFilmPosterTarget = string | { id: string; ready_at?: string | null };

export interface YearFilmPoster {
  url: string;
  /** `film-thumb:{id}:{ready_at}` -- pass to expo-image as `cacheKey`: the
   * presigned URL changes on every fetch, a re-render changes `ready_at`. */
  cacheKey: string;
}

export function yearFilmPosterCacheKey(filmId: string, readyAt?: string | null): string {
  return `film-thumb:${filmId}:${readyAt ?? ''}`;
}

// Micro-batcher: every per-film query that fires in the same tick joins one
// get-year-film-url request (chunked at 50 inside getYearFilmPosters), while
// each film keeps its own cache entry.
interface PosterWaiter {
  resolve: (url: string | null) => void;
  reject: (e: Error) => void;
}
const pendingPosterRequests = new Map<string, PosterWaiter[]>();
let posterFlushScheduled = false;

function flushPosterRequests() {
  posterFlushScheduled = false;
  const batch = new Map(pendingPosterRequests);
  pendingPosterRequests.clear();
  const ids = [...batch.keys()];
  if (ids.length === 0) return;

  void getYearFilmPosters(ids).then(({ data, error }) => {
    for (const [id, waiters] of batch) {
      for (const waiter of waiters) {
        if (error || !data) waiter.reject(toError(error, 'Could not load film posters'));
        else waiter.resolve(data[id] ?? null);
      }
    }
  });
}

function requestPoster(filmId: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const waiters = pendingPosterRequests.get(filmId);
    if (waiters) waiters.push({ resolve, reject });
    else pendingPosterRequests.set(filmId, [{ resolve, reject }]);
    if (!posterFlushScheduled) {
      posterFlushScheduled = true;
      setTimeout(flushPosterRequests, 0);
    }
  });
}

function posterQueryOptions(filmId: string) {
  return {
    queryKey: yearFilmPosterQueryKey(filmId),
    queryFn: () => requestPoster(filmId),
    // gcTime > staleTime, both under the 60 min signature window (same idea
    // as useMediaUrls). A null (server omitted the id) is retried after 1 min.
    staleTime: (query: { state: { data: string | null | undefined } }) =>
      query.state.data ? POSTER_STALE_TIME : POSTER_MISSING_STALE_TIME,
    gcTime: POSTER_GC_TIME,
  };
}

/** Drop a film's cached poster URL so the next render re-signs it (call from
 * an image `onError`, like `useMediaUrls` consumers). */
export function invalidateYearFilmPoster(queryClient: QueryClient, filmId: string) {
  return queryClient.invalidateQueries({ queryKey: yearFilmPosterQueryKey(filmId) });
}

/**
 * Signed list-thumbnail URLs, one query PER FILM ID (a growing list only
 * signs the new ids), fetched through a same-tick batcher. Films the server
 * won't serve are absent from the result.
 */
export function useYearFilmPosters(targets: readonly YearFilmPosterTarget[]): Record<string, YearFilmPoster> {
  const targetsSignature = targets
    .map((t) => (typeof t === 'string' ? t : `${t.id}:${t.ready_at ?? ''}`))
    .join('|');
  const normalized = useMemo(() => {
    const seen = new Map<string, string | null>();
    for (const target of targets) {
      const id = typeof target === 'string' ? target : target.id;
      if (!id || seen.has(id)) continue;
      seen.set(id, typeof target === 'string' ? null : (target.ready_at ?? null));
    }
    return [...seen.entries()].map(([id, readyAt]) => ({ id, readyAt }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `targets` identity changes every render; its content is `targetsSignature`
  }, [targetsSignature]);

  const results = useQueries({
    queries: normalized.map(({ id }) => posterQueryOptions(id)),
  });

  const dataSignature = results.map((r) => r.data ?? '').join('|');
  return useMemo(() => {
    const posters: Record<string, YearFilmPoster> = {};
    normalized.forEach(({ id, readyAt }, index) => {
      const url = results[index]?.data;
      if (url) posters[id] = { url, cacheKey: yearFilmPosterCacheKey(id, readyAt) };
    });
    return posters;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `results` identity changes every render; its content is `dataSignature`
  }, [normalized, dataSignature]);
}

// --- edit sheet (docs/plans/year-film-p2.md Step 11) ------------------------

/** The owner/manager edit sheet's options. Always refetched on open (the film
 * may have been remade or blocked since it was last looked at). */
export function useYearFilmEditOptions(filmId: string | null | undefined, options: { enabled?: boolean } = {}) {
  const query = useQuery({
    queryKey: yearFilmEditOptionsQueryKey(filmId),
    queryFn: async (): Promise<YearFilmEditOptions> => {
      const { data, error } = await getYearFilmEditOptions(filmId!);
      if (error || !data) throw toError(error, 'Could not load the film edit options');
      return data;
    },
    enabled: Boolean(filmId) && (options.enabled ?? true),
    staleTime: 0,
    gcTime: 60 * 1000,
    refetchOnMount: 'always',
  });

  return {
    options: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}

/**
 * `mutateAsync({ filmId, edits })` resolves with `{ ok, ... }` for expected
 * outcomes (including `rate_limited`) and throws only for unexpected errors.
 * On success the films (list + by-id) and the options are invalidated: the
 * film is remade, and removals take the old video down at once.
 */
export function useSaveYearFilmEdits() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ filmId, edits }: { filmId: string; edits: YearFilmEdits }): Promise<SaveYearFilmEditsResult> => {
      const { data, error } = await saveYearFilmEdits(filmId, edits);
      if (error || !data) throw toError(error, 'Could not save the film edits');
      return data;
    },
    onSuccess: (result, { filmId }) => {
      if (!result.ok) return;
      void invalidateYearFilms(queryClient);
      void queryClient.invalidateQueries({ queryKey: yearFilmEditOptionsQueryKey(filmId) });
    },
  });
}
