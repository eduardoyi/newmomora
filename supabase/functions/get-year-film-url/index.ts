/**
 * Short-lived URLs for Year Films (docs/plans/year-film-p1.md Step 7,
 * docs/plans/year-film-p2.md Step 3).
 *
 * Single mode `{ filmId }`: presigned video/poster/scenes URLs for ONE film.
 * Any family member may fetch it once it has surfaced; owners/managers may
 * preview it earlier (canary).
 *
 * Batch mode `{ filmIds }` (1-50): presigned URLs for the list THUMBNAILS
 * (`poster_thumb.jpg`, derived from poster_key), as `{ posters: { [id]: url } }`.
 * Surfaced for EVERYONE (no owner/manager early preview: the app never shows
 * an unsurfaced film). Films that are missing, foreign, unsurfaced, blocked,
 * forced or without a video are omitted, never errors.
 *
 * Neither mode serves a blocked film (content the family removed or
 * reported), a forced (operator canary) film, or one without a published video.
 * The one exception to the forced rule is a HOLIDAY CARD film
 * (docs/plans/holiday-cards-p1.md Step 7): a forced `family_holiday` film that
 * a non-deleted `holiday_cards` row of the same family points at is served to
 * that family's owners and managers only (never to viewers, never in the
 * batch for anyone else). Every other rejection is unchanged.
 */
import { getAuthenticatedNonAnonymousUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { getCallerFamilyRole, getCallerFamilyRoles } from '../_shared/family-access.ts';
import { createPresignedGetUrls } from '../_shared/r2.ts';
import { serveWithSentry } from '../_shared/sentry.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Long enough to download a ~60s MP4 on a slow connection. */
export const FILM_URL_TTL_SECONDS = 15 * 60;
/** List thumbnails live longer than the video URL (a list keeps them on
 * screen), but short enough that a block stops serving quickly: the old
 * objects stay in R2 until the re-render publishes. */
export const POSTER_URL_TTL_SECONDS = 60 * 60;
export const MAX_BATCH_FILM_IDS = 50;
const POSTER_THUMB_NAME = 'poster_thumb.jpg';

export interface FilmUrlRow {
  id?: string;
  family_id: string;
  video_key: string | null;
  poster_key: string | null;
  scenes_key: string | null;
  blocked: boolean;
  /** Operator canary films are never served to the app. */
  forced: boolean;
  surface_at: string;
  duration_ms: number | null;
}

export interface GetYearFilmUrlDeps {
  getAuthenticatedUser: (req: Request) => Promise<{ id: string } | null>;
  loadFilm: (filmId: string) => Promise<FilmUrlRow | null>;
  /** One query for a whole batch; rows carry their `id`. */
  loadFilms: (filmIds: string[]) => Promise<(FilmUrlRow & { id: string })[]>;
  getRole: (familyId: string, userId: string) => Promise<string | null>;
  /** The caller's role per family (films in a batch may span families). */
  getRoles: (familyIds: string[], userId: string) => Promise<Map<string, string | null>>;
  presign: (keys: string[], ttl: number) => Promise<Record<string, string>>;
  /** Non-deleted holiday cards that reference any of `filmIds` (their film id and family). */
  liveCardFilms: (filmIds: string[]) => Promise<{ film_id: string; family_id: string }[]>;
  now: () => Date;
}

/** The list-thumbnail key: `poster_thumb.jpg` in the same directory as the
 * poster (the render job writes both; no DB column). */
export function posterThumbKey(posterKey: string): string | null {
  const slash = posterKey.lastIndexOf('/');
  return slash < 0 ? null : `${posterKey.slice(0, slash + 1)}${POSTER_THUMB_NAME}`;
}

export async function handleGetYearFilmUrl(req: Request, deps: GetYearFilmUrlDeps): Promise<Response> {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'method_not_allowed');
  const user = await deps.getAuthenticatedUser(req);
  if (!user) return errorResponse('Unauthorized', 401, 'unauthorized');

  let body: { filmId?: unknown; filmIds?: unknown } | null;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }

  if (body?.filmIds !== undefined) return handleBatch(body.filmIds, user.id, deps);

  const filmId = body?.filmId;
  if (typeof filmId !== 'string' || !UUID.test(filmId)) return errorResponse('filmId is invalid', 400, 'validation_error');

  const film = await deps.loadFilm(filmId);
  // Same answer for "missing" and "not yours" (no existence oracle).
  if (!film) return errorResponse('Film not found', 404, 'not_found');
  const role = await deps.getRole(film.family_id, user.id);
  if (!role) return errorResponse('Film not found', 404, 'not_found');
  // Operator canary films are invisible to the app, like a missing film --
  // except a card's own film, for the family's owners/managers.
  if (film.forced && !(await isManagerOfCardFilm(deps, filmId, film.family_id, role))) {
    return errorResponse('Film not found', 404, 'not_found');
  }
  if (film.blocked || !film.video_key || !film.poster_key) return errorResponse('Film not available', 409, 'film_unavailable');
  if (!isSurfaced(film, deps) && role !== 'owner' && role !== 'manager') return errorResponse('Film not found', 404, 'not_found');

  const keys = [film.video_key, film.poster_key, ...(film.scenes_key ? [film.scenes_key] : [])];
  const urls = await deps.presign(keys, FILM_URL_TTL_SECONDS);
  return jsonResponse({
    videoUrl: urls[film.video_key],
    posterUrl: urls[film.poster_key],
    scenesUrl: film.scenes_key ? urls[film.scenes_key] : null,
    durationMs: film.duration_ms,
    expiresIn: FILM_URL_TTL_SECONDS,
  });
}

function isManagerRole(role: string | null): boolean {
  return role === 'owner' || role === 'manager';
}

/** True when `filmId` is the film of a live holiday card of `familyId` and the caller manages that family. */
async function isManagerOfCardFilm(
  deps: GetYearFilmUrlDeps,
  filmId: string,
  familyId: string,
  role: string | null,
): Promise<boolean> {
  if (!isManagerRole(role)) return false;
  const cards = await deps.liveCardFilms([filmId]);
  return cards.some((card) => card.film_id === filmId && card.family_id === familyId);
}

function isSurfaced(film: FilmUrlRow, deps: GetYearFilmUrlDeps): boolean {
  return new Date(film.surface_at).getTime() <= deps.now().getTime();
}

async function handleBatch(rawIds: unknown, userId: string, deps: GetYearFilmUrlDeps): Promise<Response> {
  if (!Array.isArray(rawIds) || rawIds.length < 1 || rawIds.length > MAX_BATCH_FILM_IDS) {
    return errorResponse(`filmIds must have 1-${MAX_BATCH_FILM_IDS} ids`, 400, 'validation_error');
  }
  if (!rawIds.every((id) => typeof id === 'string' && UUID.test(id))) {
    return errorResponse('filmIds is invalid', 400, 'validation_error');
  }
  const ids = [...new Set((rawIds as string[]).map((id) => id.toLowerCase()))];

  const films = await deps.loadFilms(ids);
  const roles = await deps.getRoles([...new Set(films.map((f) => f.family_id))], userId);

  // Card films are forced; only look them up when the batch has a forced film
  // the caller manages (the common batch never pays this query).
  const forcedManaged = films.filter((f) => f.forced && isManagerRole(roles.get(f.family_id) ?? null));
  const cardFilms = forcedManaged.length > 0 ? await deps.liveCardFilms(forcedManaged.map((f) => f.id)) : [];
  const isLiveCardFilm = (film: FilmUrlRow & { id: string }) =>
    cardFilms.some((card) => card.film_id === film.id && card.family_id === film.family_id);

  const signable: { id: string; thumbKey: string }[] = [];
  for (const film of films) {
    // Unknown/forbidden/not-servable ids are simply omitted (no oracle).
    if (!roles.get(film.family_id)) continue;
    if (film.forced && !(isManagerRole(roles.get(film.family_id) ?? null) && isLiveCardFilm(film))) continue;
    if (film.blocked || !film.video_key || !film.poster_key) continue;
    if (!isSurfaced(film, deps)) continue;
    const thumbKey = posterThumbKey(film.poster_key);
    if (thumbKey) signable.push({ id: film.id, thumbKey });
  }

  const posters: Record<string, string> = {};
  if (signable.length > 0) {
    const urls = await deps.presign(signable.map((f) => f.thumbKey), POSTER_URL_TTL_SECONDS);
    for (const { id, thumbKey } of signable) {
      if (urls[thumbKey]) posters[id] = urls[thumbKey];
    }
  }
  return jsonResponse({ posters, expiresIn: POSTER_URL_TTL_SECONDS });
}

const FILM_COLUMNS = 'id, family_id, video_key, poster_key, scenes_key, blocked, forced, surface_at, duration_ms';

if (import.meta.main) {
  serveWithSentry('get-year-film-url', (req) => {
    const supabase = createServiceClient();
    return handleGetYearFilmUrl(req, {
      getAuthenticatedUser: getAuthenticatedNonAnonymousUser,
      loadFilm: async (filmId) => {
        const { data, error } = await supabase
          .from('year_films')
          .select(FILM_COLUMNS)
          .eq('id', filmId)
          .maybeSingle();
        if (error) throw error;
        return data as FilmUrlRow | null;
      },
      loadFilms: async (filmIds) => {
        const { data, error } = await supabase.from('year_films').select(FILM_COLUMNS).in('id', filmIds);
        if (error) throw error;
        return (data ?? []) as (FilmUrlRow & { id: string })[];
      },
      getRole: (familyId, userId) => getCallerFamilyRole(supabase, familyId, userId),
      getRoles: (familyIds, userId) => getCallerFamilyRoles(supabase, familyIds, userId),
      presign: createPresignedGetUrls,
      liveCardFilms: async (filmIds) => {
        const { data, error } = await supabase
          .from('holiday_cards')
          .select('film_id, family_id')
          .in('film_id', filmIds)
          .is('deleted_at', null);
        if (error) throw error;
        return (data ?? []) as { film_id: string; family_id: string }[];
      },
      now: () => new Date(),
    });
  });
}
