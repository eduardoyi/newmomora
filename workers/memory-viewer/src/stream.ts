import { parseRangeHeader, formatContentRange } from './range';

/**
 * Streams one private R2 object with HTTP Range support (README "Why stream
 * through the Worker"). Shared by `/media/:token` and `/f/:token/video` so the
 * two stay identical. Returns `null` when the object is not in R2 (the DB row
 * pointed at bytes that never landed): each caller shows its own 404.
 *
 * `contentType` is always supplied by the caller from the database row, never
 * taken from R2's stored metadata. The response is `private, no-store`: the
 * route is a revocation-sensitive bearer URL.
 */
export async function streamR2Object(
  bucket: Env['MEDIA'],
  request: Request,
  objectKey: string,
  contentType: string,
): Promise<Response | null> {
  const range = parseRangeHeader(request.headers.get('Range'));
  const object = range ? await bucket.get(objectKey, { range }) : await bucket.get(objectKey);
  if (!object) return null;

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('content-type', contentType);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'private, no-store');

  if (object.range) {
    const { offset, length } = object.range;
    headers.set('content-range', formatContentRange({ servedOffset: offset, servedLength: length, totalSize: object.size }));
    headers.set('content-length', String(length));
    return new Response(object.body, { status: 206, headers });
  }

  headers.set('content-length', String(object.size));
  return new Response(object.body, { status: 200, headers });
}
