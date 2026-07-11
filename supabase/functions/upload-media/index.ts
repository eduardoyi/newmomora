import { getAuthenticatedUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { getCallerFamilyRole, isManagerRole } from '../_shared/family-access.ts';
import { putObjectBytes } from '../_shared/r2.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';
import { assertUserOwnedKey, getAllowedContentTypes } from '../_shared/storage-keys.ts';

export interface UploadMediaResponse {
  objectKey: string;
  success: true;
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

function parseContentLength(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function maxBytesForContentType(contentType: string): number {
  return contentType.startsWith('image/') ? MAX_IMAGE_BYTES : MAX_UPLOAD_BYTES;
}

export async function handleUploadMedia(req: Request): Promise<Response> {
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

  const objectKey = req.headers.get('x-object-key');
  const contentType = req.headers.get('content-type')?.split(';')[0]?.trim();
  const familyId = req.headers.get('x-family-id');

  if (!objectKey) {
    return errorResponse('x-object-key is required', 400, 'validation_error');
  }

  if (!contentType) {
    return errorResponse('content-type is required', 400, 'validation_error');
  }

  if (!familyId) {
    return errorResponse('x-family-id is required', 400, 'validation_error');
  }

  // Uploads are always written under the caller's own uid -- the family
  // check below authorizes *which family* this upload belongs to, not the
  // key path itself.
  try {
    assertUserOwnedKey(objectKey, user.id);
  } catch {
    return errorResponse('Invalid object key', 400, 'validation_error');
  }

  const allowedContentTypes = getAllowedContentTypes(objectKey, user.id);
  if (!allowedContentTypes) {
    return errorResponse('Invalid object key', 400, 'validation_error');
  }

  if (!allowedContentTypes.has(contentType)) {
    return errorResponse('Unsupported content type', 400, 'validation_error');
  }

  const serviceClient = createServiceClient();
  const role = await getCallerFamilyRole(serviceClient, familyId, user.id);

  if (!isManagerRole(role)) {
    return errorResponse('Not authorized for this family', 403, 'forbidden');
  }

  const maxBytes = maxBytesForContentType(contentType);
  const contentLength = parseContentLength(req.headers.get('content-length'));
  if (contentLength != null && contentLength > maxBytes) {
    return errorResponse('File is too large', 413, 'file_too_large');
  }

  try {
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.byteLength === 0) {
      return errorResponse('File is empty', 400, 'validation_error');
    }

    if (bytes.byteLength > maxBytes) {
      return errorResponse('File is too large', 413, 'file_too_large');
    }

    await putObjectBytes(objectKey, bytes, contentType);

    const response: UploadMediaResponse = {
      objectKey,
      success: true,
    };

    return jsonResponse(response);
  } catch (error) {
    console.error('upload-media failed', error instanceof Error ? error.message : 'unknown');
    return errorResponse('Failed to upload media', 500, 'internal_error');
  }
}

if (import.meta.main) {
  Deno.serve(handleUploadMedia);
}
