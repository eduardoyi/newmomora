import { getAuthenticatedUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { createPresignedPutUrl, R2_URL_EXPIRY } from '../_shared/r2.ts';
import { getAllowedContentTypes } from '../_shared/storage-keys.ts';

export interface GetUploadUrlRequest {
  objectKey: string;
  contentType: string;
}

export interface GetUploadUrlResponse {
  uploadUrl: string;
  objectKey: string;
  expiresIn: number;
}

export async function handleGetUploadUrl(req: Request): Promise<Response> {
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

  let body: GetUploadUrlRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }

  const { objectKey, contentType } = body;

  if (!objectKey || typeof objectKey !== 'string') {
    return errorResponse('objectKey is required', 400, 'validation_error');
  }

  if (!contentType || typeof contentType !== 'string') {
    return errorResponse('contentType is required', 400, 'validation_error');
  }

  const allowedContentTypes = getAllowedContentTypes(objectKey, user.id);
  if (!allowedContentTypes) {
    return errorResponse('Invalid object key', 400, 'validation_error');
  }

  if (!allowedContentTypes.has(contentType)) {
    return errorResponse('Unsupported content type', 400, 'validation_error');
  }

  try {
    const uploadUrl = await createPresignedPutUrl(objectKey, contentType);

    const response: GetUploadUrlResponse = {
      uploadUrl,
      objectKey,
      expiresIn: R2_URL_EXPIRY.upload,
    };

    return jsonResponse(response);
  } catch (error) {
    console.error('get-upload-url failed', error instanceof Error ? error.message : 'unknown');
    return errorResponse('Failed to create upload URL', 500, 'internal_error');
  }
}

if (import.meta.main) {
  Deno.serve(handleGetUploadUrl);
}
