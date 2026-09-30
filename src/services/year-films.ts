// Year Films client service layer (docs/plans/year-film-p2.md Steps 3-4,
// feature doc docs/features/year-film.md). Reads the client-granted
// `year_films` columns under RLS (member, ever ready, not forced, surfaced --
// blocked rows are visible too: a film being remade shows as a placeholder,
// see `filmDisplayState`; owners/managers additionally see un-surfaced rows, so
// the list filters `surface_at <= now` again), the caller's own
// `year_film_views`, and signs playback / list-thumbnail URLs through the
// `get-year-film-url` Edge Function.
import { supabase } from '@/lib/supabase';
import { invokeEdgeFunction, type ServiceError } from '@/services/ai';
import type { Database, Json } from '@/types/database';

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
 * Blocked rows (a film being remade) are returned on purpose; `hidden` ones
 * (blocked + failed/skipped) are dropped by `useFamilyYearFilms`, not here.
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

// --- edit sheet (docs/plans/year-film-p2.md Step 11) ------------------------

/** One moment the film shows (or a removed one, so it can be restored). */
export interface YearFilmEditFrame {
  memoryId: string;
  date: string | null;
  /** `illustration | photo | video | audio` (as the script names it). */
  kind: string;
}

export interface YearFilmQuoteCandidate {
  memoryId: string;
  textHash: string;
  text: string;
  speakerName: string | null;
  /** The line the current film shows (or the family's chosen one). */
  isCurrent: boolean;
}

export type YearFilmNotEditableReason = 'not_ready' | 'blocked' | 'subscription_required';

/** `get_year_film_edit_options`: what the owner/manager edit sheet shows. */
export type YearFilmEditOptions =
  | { editable: false; reason: YearFilmNotEditableReason }
  | {
      editable: true;
      kind: YearFilmKind;
      editsVersion: number;
      musicBedId: string | null;
      removedMemoryIds: string[];
      chosenQuote: { memoryId: string; textHash: string } | null;
      frames: YearFilmEditFrame[];
      quoteCandidates: YearFilmQuoteCandidate[];
    };

/** What `save_year_film_edits` accepts. `removedMemoryIds` is the FULL set
 * (an id left out is restored); `quote` / `musicBedId` are sent only when
 * changed. */
export interface YearFilmEdits {
  removedMemoryIds: string[];
  quote?: { memoryId: string; textHash: string } | null;
  musicBedId?: string;
}

export type SaveYearFilmEditsFailure =
  | 'rate_limited'
  | 'film_not_editable'
  | 'subscription_required'
  | 'unauthorized'
  | 'invalid_edits';

export type SaveYearFilmEditsResult =
  | { ok: true; editsVersion: number }
  | { ok: false; reason: SaveYearFilmEditsFailure };

const NOT_EDITABLE_REASONS: readonly YearFilmNotEditableReason[] = ['not_ready', 'blocked', 'subscription_required'];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Normalises the RPC's jsonb; a malformed payload reads as not editable. */
export function parseYearFilmEditOptions(raw: unknown): YearFilmEditOptions {
  const row = asRecord(raw);
  if (!row || row.editable !== true) {
    const reason = row?.reason;
    return {
      editable: false,
      reason: NOT_EDITABLE_REASONS.find((candidate) => candidate === reason) ?? 'not_ready',
    };
  }
  const kind = asString(row.kind);
  if (!kind || !isYearFilmKind(kind)) return { editable: false, reason: 'not_ready' };

  const frames: YearFilmEditFrame[] = [];
  for (const item of Array.isArray(row.frames) ? row.frames : []) {
    const frame = asRecord(item);
    const memoryId = asString(frame?.memoryId);
    if (!frame || !memoryId) continue;
    frames.push({ memoryId, date: asString(frame.date), kind: asString(frame.kind) ?? 'photo' });
  }

  const quoteCandidates: YearFilmQuoteCandidate[] = [];
  for (const item of Array.isArray(row.quoteCandidates) ? row.quoteCandidates : []) {
    const candidate = asRecord(item);
    const memoryId = asString(candidate?.memoryId);
    const textHash = asString(candidate?.textHash);
    const text = asString(candidate?.text);
    if (!candidate || !memoryId || !textHash || !text) continue;
    quoteCandidates.push({
      memoryId,
      textHash,
      text,
      speakerName: asString(candidate.speakerName),
      isCurrent: candidate.isCurrent === true,
    });
  }

  const chosen = asRecord(row.chosenQuote);
  const chosenMemoryId = asString(chosen?.memoryId);
  const chosenHash = asString(chosen?.textHash);

  return {
    editable: true,
    kind,
    editsVersion: typeof row.editsVersion === 'number' ? row.editsVersion : 0,
    musicBedId: asString(row.musicBedId),
    removedMemoryIds: (Array.isArray(row.removedMemoryIds) ? row.removedMemoryIds : []).filter(
      (id): id is string => typeof id === 'string',
    ),
    chosenQuote: chosenMemoryId && chosenHash ? { memoryId: chosenMemoryId, textHash: chosenHash } : null,
    frames,
    quoteCandidates,
  };
}

/** Owner/manager only (the RPC raises for anyone else). A blocked or
 * not-yet-ready film resolves to `{ editable: false, reason }`. */
export async function getYearFilmEditOptions(
  filmId: string,
): Promise<{ data: YearFilmEditOptions | null; error: ServiceError | null }> {
  const { data, error } = await supabase.rpc('get_year_film_edit_options', { p_film_id: filmId });
  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }
  return { data: parseYearFilmEditOptions(data), error: null };
}

function saveFailureFromError(error: { message: string; code?: string; hint?: string | null }): SaveYearFilmEditsFailure | null {
  if (error.hint === 'film_not_editable' || error.code === '55000') return 'film_not_editable';
  if (error.hint === 'invalid_edits' || error.code === '22023') return 'invalid_edits';
  if (error.code === '42501') {
    return /subscription/i.test(error.message) ? 'subscription_required' : 'unauthorized';
  }
  return null;
}

/**
 * Saves the edits and queues the re-render. Expected outcomes come back as
 * `{ ok: false, reason }` (fair-use `rate_limited`, a film that is no longer
 * editable, ...); `error` is only for unexpected failures. Removing moments
 * blocks the current video until the new one publishes.
 */
export async function saveYearFilmEdits(
  filmId: string,
  edits: YearFilmEdits,
): Promise<{ data: SaveYearFilmEditsResult | null; error: ServiceError | null }> {
  const { data, error } = await supabase.rpc('save_year_film_edits', {
    p_film_id: filmId,
    p_edits: edits as unknown as Json,
  });

  if (error) {
    const reason = saveFailureFromError(error);
    if (reason) return { data: { ok: false, reason }, error: null };
    return { data: null, error: mapSupabaseError(error) };
  }

  const row = asRecord(data);
  if (row?.ok === true) {
    return { data: { ok: true, editsVersion: typeof row.edits_version === 'number' ? row.edits_version : 0 }, error: null };
  }
  if (row?.reason === 'rate_limited') {
    return { data: { ok: false, reason: 'rate_limited' }, error: null };
  }
  return { data: null, error: { message: 'Could not save the film edits', code: 'unexpected_response' } };
}
