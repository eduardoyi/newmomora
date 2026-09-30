// Year Films client service layer (docs/plans/year-film-p2.md Steps 3-4,
// feature doc docs/features/year-film.md). Reads the client-granted
// `year_films` columns under RLS (member, video present, not blocked, not
// forced, surfaced -- owners/managers additionally see un-surfaced rows, so
// the list filters `surface_at <= now` again), the caller's own
// `year_film_views`, and signs playback / list-thumbnail URLs through the
// `get-year-film-url` Edge Function.
import { supabase } from '@/lib/supabase';
import { invokeEdgeFunction, type ServiceError } from '@/services/ai';
import type { Database } from '@/types/database';

export type YearFilmKind = 'birthday' | 'family_month' | 'family_year';

export const YEAR_FILM_KINDS: readonly YearFilmKind[] = ['birthday', 'family_month', 'family_year'];

type YearFilmRow = Database['public']['Tables']['year_films']['Row'];

/** The client-granted `year_films` columns (keys and scripts are never
 * granted). `placement_date` is the permanent Timeline date: the birthday,
 * the month's last day, or Dec 31. */
export type YearFilm = Pick<
  YearFilmRow,
  | 'id'
  | 'family_id'
  | 'family_member_id'
  | 'age_year'
  | 'scope_start_date'
  | 'scope_end_exclusive'
  | 'scope_label'
  | 'language'
  | 'duration_ms'
  | 'surface_at'
  | 'ready_at'
  | 'edits_version'
  | 'status'
  | 'blocked'
  | 'stale'
> & {
  kind: YearFilmKind;
  /** `YYYY-MM-DD`, non-null after narrowing (the generated column is nullable). */
  placement_date: string;
};

const YEAR_FILM_COLUMNS =
  'id, family_id, kind, family_member_id, age_year, scope_start_date, scope_end_exclusive, scope_label, language, placement_date, duration_ms, surface_at, ready_at, edits_version, status, blocked, stale';

/** One of the caller's own `year_film_views` rows. */
export interface YearFilmView {
  film_id: string;
  first_viewed_at: string;
  completed_at: string | null;
}

/** `get-year-film-url` single mode: presigned URLs, valid `expiresIn` seconds
 * (15 min). `scenesUrl` is null for a film without a scenes file. */
export interface YearFilmPlayback {
  videoUrl: string;
  posterUrl: string;
  scenesUrl: string | null;
  durationMs: number | null;
  expiresIn: number;
}

export interface GetYearFilmPlaybackResult {
  data: YearFilmPlayback | null;
  error: ServiceError | null;
  /** True when the film is gone, blocked, unsurfaced, or not visible to this
   * caller (edge 404 / 409 `film_unavailable`): the player shows "This film
   * isn't available right now." instead of a retry. `error.code` is then
   * normalised to `film_unavailable`. */
  unavailable: boolean;
}

/** get-year-film-url's per-request cap (MAX_BATCH_FILM_IDS in
 * supabase/functions/get-year-film-url/index.ts). */
export const YEAR_FILM_POSTER_BATCH_SIZE = 50;

const UNAVAILABLE_CODES = new Set(['film_unavailable', 'not_found', '404', '409']);

function mapSupabaseError(error: { message: string; code?: string }): ServiceError {
  return { message: error.message, code: error.code };
}

function isYearFilmKind(kind: string): kind is YearFilmKind {
  return (YEAR_FILM_KINDS as readonly string[]).includes(kind);
}

/**
 * The family's surfaced films, newest placement first. Belt on top of RLS:
 * rows with `surface_at` in the future (visible to owners/managers early) are
 * dropped, since a permanent surface must never show a not-yet-delivered film.
 */
export async function fetchFamilyYearFilms(
  familyId: string,
  now: Date = new Date(),
): Promise<{ data: YearFilm[] | null; error: ServiceError | null }> {
  const { data, error } = await supabase
    .from('year_films')
    .select(YEAR_FILM_COLUMNS)
    .eq('family_id', familyId)
    .order('placement_date', { ascending: false });

  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }

  const nowMs = now.getTime();
  const films = ((data ?? []) as unknown as YearFilmRow[]).filter(
    (row): row is YearFilmRow & { kind: YearFilmKind; placement_date: string } =>
      isYearFilmKind(row.kind) &&
      typeof row.placement_date === 'string' &&
      new Date(row.surface_at).getTime() <= nowMs,
  ) as YearFilm[];
  return { data: films, error: null };
}

/** The caller's own view rows (RLS scopes to `auth.uid()`). Feeds the "New"
 * marker via `isNewFilm`. */
export async function fetchYearFilmViews(): Promise<{
  data: YearFilmView[] | null;
  error: ServiceError | null;
}> {
  const { data, error } = await supabase
    .from('year_film_views')
    .select('film_id, first_viewed_at, completed_at');

  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }
  return { data: (data ?? []) as YearFilmView[], error: null };
}

async function getCurrentUserId(): Promise<{ userId: string | null; error: ServiceError | null }> {
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return {
      userId: null,
      error: { message: error?.message ?? 'You must be signed in to watch a film', code: 'unauthorized' },
    };
  }
  return { userId: user.id, error: null };
}

/**
 * Records the caller's first view: `insert ... on conflict do nothing` (the
 * table grants INSERT + own-row SELECT + UPDATE(completed_at) only, so a
 * merging upsert -- which needs UPDATE on `film_id`/`user_id` -- is not
 * allowed). Re-watching never rewrites `first_viewed_at`.
 */
export async function markYearFilmViewed(filmId: string): Promise<{ error: ServiceError | null }> {
  const { userId, error: authError } = await getCurrentUserId();
  if (!userId) return { error: authError };

  const { error } = await supabase
    .from('year_film_views')
    .upsert({ film_id: filmId, user_id: userId }, { onConflict: 'film_id,user_id', ignoreDuplicates: true });

  return { error: error ? mapSupabaseError(error) : null };
}

/** Stamps `completed_at` on the caller's own view row. Call after
 * `markYearFilmViewed`. */
export async function markYearFilmCompleted(
  filmId: string,
  now: Date = new Date(),
): Promise<{ error: ServiceError | null }> {
  const { userId, error: authError } = await getCurrentUserId();
  if (!userId) return { error: authError };

  const { error } = await supabase
    .from('year_film_views')
    .update({ completed_at: now.toISOString() })
    .eq('film_id', filmId)
    .eq('user_id', userId);

  return { error: error ? mapSupabaseError(error) : null };
}

/** Presigned video / poster / scenes URLs for ONE film (15 min). 404/409 map
 * to `unavailable: true`. */
export async function getYearFilmPlayback(filmId: string): Promise<GetYearFilmPlaybackResult> {
  const { data, error } = await invokeEdgeFunction<YearFilmPlayback>('get-year-film-url', { filmId });

  if (error) {
    const unavailable = Boolean(error.code && UNAVAILABLE_CODES.has(error.code));
    return {
      data: null,
      error: unavailable ? { ...error, code: 'film_unavailable' } : error,
      unavailable,
    };
  }
  if (!data?.videoUrl) {
    return {
      data: null,
      error: { message: 'Film not available', code: 'film_unavailable' },
      unavailable: true,
    };
  }
  return { data, error: null, unavailable: false };
}

/**
 * Signed list-thumbnail URLs (60 min) for many films, `{ [filmId]: url }`.
 * Chunked at 50 ids per call. Ids the server omits (unsurfaced, blocked,
 * forced, foreign) are simply absent from the result. The first failing
 * chunk fails the whole call.
 */
export async function getYearFilmPosters(
  filmIds: readonly string[],
): Promise<{ data: Record<string, string> | null; error: ServiceError | null }> {
  const unique = Array.from(new Set(filmIds.filter(Boolean)));
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += YEAR_FILM_POSTER_BATCH_SIZE) {
    chunks.push(unique.slice(i, i + YEAR_FILM_POSTER_BATCH_SIZE));
  }

  const results = await Promise.all(
    chunks.map((chunk) =>
      invokeEdgeFunction<{ posters?: Record<string, string> }>('get-year-film-url', { filmIds: chunk }),
    ),
  );

  const posters: Record<string, string> = {};
  for (const { data, error } of results) {
    if (error) return { data: null, error };
    Object.assign(posters, data?.posters ?? {});
  }
  return { data: posters, error: null };
}

/** Whether the family should see the "upcoming recap" card (server-side
 * rollout, billing, own-child and memory-count gates). */
export async function fetchYearFilmsEnabled(
  familyId: string,
): Promise<{ data: boolean | null; error: ServiceError | null }> {
  const { data, error } = await supabase.rpc('year_films_enabled', { p_family_id: familyId });

  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }
  return { data: data === true, error: null };
}
