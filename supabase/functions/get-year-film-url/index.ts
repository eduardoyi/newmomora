/**
 * Short-lived URLs for a Year Film (docs/plans/year-film-p1.md Step 7).
 * Any family member may fetch a film once it has surfaced; owners/managers
 * may preview it earlier (canary). Never serves a blocked film (content the
 * family removed or reported) or a film without a published video.
 */
import { getAuthenticatedNonAnonymousUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { getCallerFamilyRole } from '../_shared/family-access.ts';
import { createPresignedGetUrls } from '../_shared/r2.ts';
import { serveWithSentry } from '../_shared/sentry.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Long enough to download a ~60s MP4 on a slow connection. */
export const FILM_URL_TTL_SECONDS = 15 * 60;

export interface FilmUrlRow {
  family_id: string;
  video_key: string | null;
  poster_key: string | null;
  scenes_key: string | null;
  blocked: boolean;
  surface_at: string;
  duration_ms: number | null;
}

export interface GetYearFilmUrlDeps {
  getAuthenticatedUser: (req: Request) => Promise<{ id: string } | null>;
  loadFilm: (filmId: string) => Promise<FilmUrlRow | null>;
  getRole: (familyId: string, userId: string) => Promise<string | null>;
  presign: (keys: string[], ttl: number) => Promise<Record<string, string>>;
  now: () => Date;
}

export async function handleGetYearFilmUrl(req: Request, deps: GetYearFilmUrlDeps): Promise<Response> {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'method_not_allowed');
  const user = await deps.getAuthenticatedUser(req);
  if (!user) return errorResponse('Unauthorized', 401, 'unauthorized');

  let filmId: unknown;
  try {
    filmId = (await req.json())?.filmId;
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }
  if (typeof filmId !== 'string' || !UUID.test(filmId)) return errorResponse('filmId is invalid', 400, 'validation_error');

  const film = await deps.loadFilm(filmId);
  // Same answer for "missing" and "not yours" (no existence oracle).
  if (!film) return errorResponse('Film not found', 404, 'not_found');
  const role = await deps.getRole(film.family_id, user.id);
  if (!role) return errorResponse('Film not found', 404, 'not_found');
  if (film.blocked || !film.video_key || !film.poster_key) return errorResponse('Film not available', 409, 'film_unavailable');
  const surfaced = new Date(film.surface_at).getTime() <= deps.now().getTime();
  if (!surfaced && role !== 'owner' && role !== 'manager') return errorResponse('Film not found', 404, 'not_found');

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

if (import.meta.main) {
  serveWithSentry('get-year-film-url', (req) => {
    const supabase = createServiceClient();
    return handleGetYearFilmUrl(req, {
      getAuthenticatedUser: getAuthenticatedNonAnonymousUser,
      loadFilm: async (filmId) => {
        const { data, error } = await supabase
          .from('year_films')
          .select('family_id, video_key, poster_key, scenes_key, blocked, surface_at, duration_ms')
          .eq('id', filmId)
          .maybeSingle();
        if (error) throw error;
        return data as FilmUrlRow | null;
      },
      getRole: (familyId, userId) => getCallerFamilyRole(supabase, familyId, userId),
      presign: createPresignedGetUrls,
      now: () => new Date(),
    });
  });
}
