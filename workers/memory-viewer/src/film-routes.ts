import { classifyFilmToken, resolveFilm, type FilmResolution, type FilmRoute } from './film';
import {
  FILM_COMMON_HEADERS,
  FILM_HTML_CONTENT_SECURITY_POLICY,
  renderFilmNotFoundPage,
  renderFilmPage,
  renderFilmRevokedPage,
  renderFilmUpdatingPage,
} from './film-page';
import { BRAND_POSTER_BYTES, BRAND_POSTER_CONTENT_TYPE } from './brand-poster';
import { fetchFilm, fetchFilmShareToken } from './supabase';
import { streamR2Object } from './stream';

/**
 * Public film page routes (`/f/:token`, `/f/:token/video`, `/f/:token/poster`),
 * the QR target printed on Momora holiday cards (docs/plans/holiday-cards.md C5).
 * Every route re-resolves the token on every request, so revoking it (or a
 * blocked / deleted film) stops fresh reads immediately.
 */

// Same rule as index.ts: OG crawlers use these URLs outside the browser
// request, so never derive the origin from `request.url` / the Host header.
const PUBLIC_FILM_ORIGIN = 'https://m.usemomora.com';

function withCommonHeaders(headers: Headers): Headers {
  for (const [name, value] of Object.entries(FILM_COMMON_HEADERS)) headers.set(name, value);
  return headers;
}

function htmlResponse(body: string, status: number, extra: Record<string, string> = {}): Response {
  const headers = withCommonHeaders(new Headers({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': FILM_HTML_CONTENT_SECURITY_POLICY,
    ...extra,
  }));
  return new Response(body, { status, headers });
}

function notFound(): Response {
  return htmlResponse(renderFilmNotFoundPage(), 404);
}

/** The 404 for a malformed `/f/` path (no Supabase call was made). */
export function filmNotFoundPage(): Response {
  return notFound();
}

function revoked(): Response {
  return htmlResponse(renderFilmRevokedPage(), 410);
}

function updating(language: 'es' | 'en'): Response {
  // 503 + Retry-After: temporary, and not something to cache or index.
  return htmlResponse(renderFilmUpdatingPage(language), 503, { 'retry-after': '3600' });
}

function posterResponse(body: BodyInit, contentLength: number): Response {
  return new Response(body, {
    headers: withCommonHeaders(new Headers({
      'content-type': BRAND_POSTER_CONTENT_TYPE,
      'content-length': String(contentLength),
      'cache-control': 'private, no-store',
      'content-security-policy': "default-src 'none'; base-uri 'none'",
    })),
  });
}

/**
 * token -> film_share_tokens -> year_films. Any lookup failure is logged WITHOUT
 * the token, ids or content and maps to `not_found`: this worker has no
 * authenticated owner to show a 5xx to, so it fails closed to the friendly page.
 */
async function resolveFilmToken(env: Env, token: string): Promise<FilmResolution> {
  try {
    const classified = classifyFilmToken(await fetchFilmShareToken(env, token));
    if (classified.status === 'not_found') return { kind: 'not_found' };
    if (classified.status === 'revoked') return { kind: 'revoked' };
    return resolveFilm(await fetchFilm(env, classified.filmId));
  } catch (error) {
    console.error('memory-viewer: film resolve failed', error instanceof Error ? error.message : 'unknown');
    return { kind: 'not_found' };
  }
}

function nonFilmResponse(resolution: FilmResolution): Response | null {
  if (resolution.kind === 'not_found') return notFound();
  if (resolution.kind === 'revoked') return revoked();
  if (resolution.kind === 'updating') return updating(resolution.language);
  return null;
}

export async function handleFilmRoute(env: Env, request: Request, route: FilmRoute): Promise<Response> {
  const resolution = await resolveFilmToken(env, route.token);
  if (resolution.kind !== 'film') return nonFilmResponse(resolution)!;
  const film = resolution.film;

  if (route.kind === 'page') {
    return htmlResponse(
      renderFilmPage(film, {
        canonicalUrl: new URL(`/f/${route.token}`, PUBLIC_FILM_ORIGIN).toString(),
        posterUrl: new URL(`/f/${route.token}/poster`, PUBLIC_FILM_ORIGIN).toString(),
        videoUrl: `/f/${route.token}/video`,
        posterPath: `/f/${route.token}/poster`,
      }),
      200,
    );
  }

  if (route.kind === 'video') {
    const response = await streamR2Object(env.MEDIA, request, film.videoKey, 'video/mp4');
    if (!response) return notFound();
    withCommonHeaders(response.headers);
    return response;
  }

  // poster
  try {
    const object = await env.MEDIA.get(film.posterKey);
    // A stale poster key must not break a link people share: fall back to the
    // neutral Momora card (no names, dates or family data), never an R2 detail.
    if (!object || !object.body) return posterResponse(BRAND_POSTER_BYTES, BRAND_POSTER_BYTES.byteLength);
    return posterResponse(object.body, object.size);
  } catch {
    console.error('memory-viewer: film poster read failed');
    return notFound();
  }
}
