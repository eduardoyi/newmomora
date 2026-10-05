import * as Sentry from '@sentry/cloudflare';

import { sentryOptions } from './sentry';
import {
  parseShareToken,
  classifyShareToken,
  resolveOpenGraphPoster,
  resolveViewerMedia,
  type ResolvedMedia,
} from './resolve';
import { streamR2Object } from './stream';
import { fetchShareToken, fetchMemoryHeader, fetchPrimaryMediaAsset } from './supabase';
import { renderViewerPage, renderNotFoundPage, renderRevokedPage } from './page';
import { BRAND_POSTER_BYTES, BRAND_POSTER_CONTENT_TYPE } from './brand-poster';
import { parseFilmRoute } from './film';
import { filmNotFoundPage, handleFilmRoute } from './film-routes';

// Open Graph crawlers use these URLs outside the current browser request. Do
// not derive their origin from `request.url`: an alternate custom domain or a
// hostile Host header could otherwise poison a shared link's canonical/image
// metadata. This Worker is intentionally public only at this production
// custom domain (see wrangler.jsonc).
const PUBLIC_VIEWER_ORIGIN = 'https://m.usemomora.com';

function htmlResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Every response here is either PII (a memory's photo/video/caption)
      // or a generic/revoked-link page -- never cache any of them at a
      // shared/CDN layer.
      'cache-control': 'no-store',
    },
  });
}

function notFoundPage(): Response {
  return htmlResponse(renderNotFoundPage(), 404);
}

/** Round-19: distinct from `notFoundPage()` -- a REVOKED token was real at
 * some point (the owner deliberately turned it off), so it gets its own
 * copy and its own status. 410 Gone is the semantically correct code for
 * "this resource existed, is now permanently gone" (vs. 404's "not found" /
 * possibly never existed) -- and revealing that distinction over the wire
 * doesn't weaken the privacy model: the requester already holds the exact
 * unguessable token either way, so a 404-vs-410 split only ever tells them
 * something about a link THEY ALREADY HAVE, never lets them probe an
 * id/token they don't. */
function revokedPage(): Response {
  return htmlResponse(renderRevokedPage(), 410);
}

function posterHeaders(contentType: string, contentLength: number): Headers {
  return new Headers({
    'content-type': contentType,
    'content-length': String(contentLength),
    // Re-check the token on every fetch so a revoked printed-book link stops
    // resolving even after a chat app or browser has requested a preview.
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    // The static fallback is safe to open directly too: it is a bundled JPEG
    // with no scripts, network requests, or user-supplied data.
    'content-security-policy': "default-src 'none'; base-uri 'none'",
  });
}

function brandedPosterResponse(): Response {
  return new Response(BRAND_POSTER_BYTES, {
    headers: posterHeaders(BRAND_POSTER_CONTENT_TYPE, BRAND_POSTER_BYTES.byteLength),
  });
}

/**
 * A `/m/:token` or `/media/:token` request resolves to exactly one of three
 * outcomes: the token was never minted (`not_found`), it was minted and has
 * since been revoked (`revoked`), or it's active and resolves to real,
 * renderable media (`media`). Both Supabase lookups (share token, then
 * memory+asset once the token proves active) run in sequence -- the second
 * pair needs the `memory_id` the first one resolves -- unlike the old
 * memoryId-keyed version, which could run its two lookups concurrently.
 * Any resolution failure (network error, non-2xx from PostgREST) is logged
 * WITHOUT memory content (PII rule, see root CLAUDE.md) and mapped to
 * `not_found` -- this worker has no authenticated owner to show a 5xx to,
 * so fail-closed to the friendly page rather than leaking an error page.
 */
export type MediaResolution = { kind: 'not_found' } | { kind: 'revoked' } | { kind: 'media'; media: ResolvedMedia };

async function resolveMedia(env: Env, token: string): Promise<MediaResolution> {
  try {
    const tokenRow = await fetchShareToken(env, token);
    const classified = classifyShareToken(tokenRow);
    if (classified.status === 'not_found') return { kind: 'not_found' };
    if (classified.status === 'revoked') return { kind: 'revoked' };

    const [memory, asset] = await Promise.all([
      fetchMemoryHeader(env, classified.memoryId),
      fetchPrimaryMediaAsset(env, classified.memoryId),
    ]);
    const media = resolveViewerMedia(memory, asset);
    return media ? { kind: 'media', media } : { kind: 'not_found' };
  } catch (error) {
    console.error('memory-viewer: resolve failed', error instanceof Error ? error.message : 'unknown');
    return { kind: 'not_found' };
  }
}

/** Maps a non-`media` resolution to its response. Returns `null` for
 * `kind: 'media'` -- callers only reach for this after already handling
 * that case themselves (they need the resolved `media` payload, which this
 * function deliberately doesn't have). */
function nonMediaResponse(resolution: MediaResolution): Response | null {
  if (resolution.kind === 'not_found') return notFoundPage();
  if (resolution.kind === 'revoked') return revokedPage();
  return null;
}

async function handleViewerPage(env: Env, token: string): Promise<Response> {
  const resolution = await resolveMedia(env, token);
  if (resolution.kind !== 'media') return nonMediaResponse(resolution)!;
  const poster = resolveOpenGraphPoster(resolution.media);
  const canonicalUrl = new URL(`/m/${token}`, PUBLIC_VIEWER_ORIGIN).toString();
  const posterUrl = poster ? new URL(`/poster/${token}`, PUBLIC_VIEWER_ORIGIN).toString() : undefined;
  // The rendered page's <img>/<video>/<audio> src points at THIS SAME
  // token's /media/ route -- not the underlying memory id, which never
  // reaches the client.
  return htmlResponse(
    renderViewerPage(resolution.media, `/media/${token}`, {
      canonicalUrl,
      posterContentType: poster?.contentType,
      posterUrl,
    }),
    200,
  );
}

async function handleMediaBytes(env: Env, request: Request, token: string): Promise<Response> {
  const resolution = await resolveMedia(env, token);
  if (resolution.kind !== 'media') return nonMediaResponse(resolution)!;
  const media = resolution.media;

  const response = await streamR2Object(env.MEDIA, request, media.objectKey, media.contentType);

  // The DB row pointed at an object that isn't in R2 (upload never
  // completed, or the two stores drifted). Same friendly 404 -- from the
  // scanning family member's point of view this is indistinguishable from
  // "link doesn't work". Content-type always comes from the DB row, not R2's
  // stored httpMetadata: memory_media rows are the source of truth for what
  // an asset IS (see resolve.ts's HEIC->preview substitution).
  return response ?? notFoundPage();
}

/**
 * Stream a share-token-authorized Open Graph poster. This must resolve the
 * share token independently of `/m/:token`: social crawlers fetch metadata
 * and images separately, and a token can be revoked between those requests.
 */
async function handlePosterBytes(env: Env, token: string): Promise<Response> {
  const resolution = await resolveMedia(env, token);
  if (resolution.kind !== 'media') return nonMediaResponse(resolution)!;

  const poster = resolveOpenGraphPoster(resolution.media);
  if (!poster) return notFoundPage();
  if (poster.kind === 'brand') return brandedPosterResponse();

  try {
    const object = await env.MEDIA.get(poster.objectKey);

    // A DB preview key can be stale after a failed/deleted upload. Keep the
    // active link shareable with the neutral JPEG rather than advertising a
    // broken Open Graph image, and never expose an R2 detail or object key.
    if (!object || !object.body) return brandedPosterResponse();

    return new Response(object.body, {
      headers: posterHeaders(poster.contentType, object.size),
    });
  } catch {
    // Do not include the key, memory id, or an R2 error message in logs or a
    // response. All of those may identify a family's private asset.
    console.error('memory-viewer: poster read failed');
    return notFoundPage();
  }
}

export default Sentry.withSentry(sentryOptions, {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== 'GET') {
      return notFoundPage();
    }

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    // Public film page (holiday card QR). Checked first so a malformed /f/
    // path gets the film-flavored 404 rather than the memory one.
    if (url.pathname.startsWith('/f/')) {
      const filmRoute = parseFilmRoute(url.pathname);
      return filmRoute ? handleFilmRoute(env, request, filmRoute) : filmNotFoundPage();
    }

    const viewerToken = parseShareToken(url.pathname, '/m/');
    if (viewerToken) return handleViewerPage(env, viewerToken);

    const mediaToken = parseShareToken(url.pathname, '/media/');
    if (mediaToken) return handleMediaBytes(env, request, mediaToken);

    const posterToken = parseShareToken(url.pathname, '/poster/');
    if (posterToken) return handlePosterBytes(env, posterToken);

    return notFoundPage();
  },
});
