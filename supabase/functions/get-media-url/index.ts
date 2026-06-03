import { getAuthenticatedUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { createPresignedGetUrls, R2_URL_EXPIRY } from '../_shared/r2.ts';
import { assertUserOwnedKey } from '../_shared/storage-keys.ts';

const MAX_KEYS = 50;

export interface GetMediaUrlRequest {
  keys: string[];
}

export interface GetMediaUrlResponse {
  urls: Record<string, string>;
  expiresIn: number;
}

export async function handleGetMediaUrl(req: Request): Promise<Response> {
  const corsResponse = handleCors(req);
  if (corsResponse) {
    return corsResponse;
  }

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405, 'method_not_allowed');
  }

  const user = await getAuthenticatedUser(req);
  if (!user) {
    return errorResponse('Unauthorized', 401, 'unauthorized');
  }

  let body: GetMediaUrlRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }

  const { keys } = body;

  if (!Array.isArray(keys) || keys.length === 0) {
    return errorResponse('keys must be a non-empty array', 400, 'validation_error');
  }

  if (keys.length > MAX_KEYS) {
    return errorResponse(`Maximum ${MAX_KEYS} keys allowed`, 400, 'validation_error');
  }

  for (const key of keys) {
    if (typeof key !== 'string' || !key.trim()) {
      return errorResponse('Each key must be a non-empty string', 400, 'validation_error');
    }

    try {
      assertUserOwnedKey(key, user.id);
    } catch {
      return errorResponse('Invalid object key', 400, 'validation_error');
    }
  }

  try {
    const urls = await createPresignedGetUrls(keys);

    const response: GetMediaUrlResponse = {
      urls,
      expiresIn: R2_URL_EXPIRY.download,
    };

    return jsonResponse(response);
  } catch (error) {
    console.error('get-media-url failed', error instanceof Error ? error.message : 'unknown');
    return errorResponse('Failed to create media URLs', 500, 'internal_error');
  }
}

if (import.meta.main) {
  Deno.serve(handleGetMediaUrl);
}
