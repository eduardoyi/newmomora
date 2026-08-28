import { parseMemoryId, resolveViewerMedia, type ResolvedMedia } from './resolve';
import { parseRangeHeader, formatContentRange } from './range';
import { fetchMemoryHeader, fetchPrimaryMediaAsset } from './supabase';
import { renderViewerPage, renderNotFoundPage } from './page';

function htmlResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Every response here is either PII (a memory's photo/video/caption)
      // or the generic 404 -- never cache either at a shared/CDN layer.
      'cache-control': 'no-store',
    },
  });
}

function notFoundPage(): Response {
  return htmlResponse(renderNotFoundPage(), 404);
}

/**
 * Resolve `memoryId` to what should be rendered/streamed. Both Supabase
 * lookups run concurrently since they're independent reads keyed on the
 * same id. Any resolution failure (network error, non-2xx from
 * PostgREST) is logged WITHOUT memory content (PII rule, see root
 * CLAUDE.md) and mapped to the same 404 a genuinely-missing id gets --
 * this worker has no authenticated owner to show a 5xx to, so fail-closed
 * to the friendly page rather than leaking an error page.
 */
async function resolveMedia(env: Env, memoryId: string): Promise<ResolvedMedia | null> {
  try {
    const [memory, asset] = await Promise.all([
      fetchMemoryHeader(env, memoryId),
      fetchPrimaryMediaAsset(env, memoryId),
    ]);
    return resolveViewerMedia(memory, asset);
  } catch (error) {
    console.error('memory-viewer: resolve failed', error instanceof Error ? error.message : 'unknown');
    return null;
  }
}

async function handleViewerPage(env: Env, memoryId: string): Promise<Response> {
  const media = await resolveMedia(env, memoryId);
  if (!media) return notFoundPage();
  return htmlResponse(renderViewerPage(media, `/media/${memoryId}`), 200);
}

async function handleMediaBytes(env: Env, request: Request, memoryId: string): Promise<Response> {
  const media = await resolveMedia(env, memoryId);
  if (!media) return notFoundPage();

  const range = parseRangeHeader(request.headers.get('Range'));
  const object = range
    ? await env.MEDIA.get(media.objectKey, { range })
    : await env.MEDIA.get(media.objectKey);

  // The DB row pointed at an object that isn't in R2 (upload never
  // completed, or the two stores drifted). Same friendly 404 -- from the
  // scanning family member's point of view this is indistinguishable from
  // "link doesn't work".
  if (!object) return notFoundPage();

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  // Always set content-type from the DB row, not R2's stored
  // httpMetadata: memory_media rows are the source of truth for what an
  // asset IS (see resolve.ts's HEIC->preview substitution, which changes
  // the served content-type without changing what's in R2's own metadata).
  headers.set('content-type', media.contentType);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'private, max-age=3600');

  if (object.range) {
    const { offset, length } = object.range;
    headers.set('content-range', formatContentRange({ servedOffset: offset, servedLength: length, totalSize: object.size }));
    headers.set('content-length', String(length));
    return new Response(object.body, { status: 206, headers });
  }

  headers.set('content-length', String(object.size));
  return new Response(object.body, { status: 200, headers });
}

export default {
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

    const viewerId = parseMemoryId(url.pathname, '/m/');
    if (viewerId) return handleViewerPage(env, viewerId);

    const mediaId = parseMemoryId(url.pathname, '/media/');
    if (mediaId) return handleMediaBytes(env, request, mediaId);

    return notFoundPage();
  },
};
