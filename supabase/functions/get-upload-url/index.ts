import { getAuthenticatedUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { getCallerFamilyRole, isManagerRole } from '../_shared/family-access.ts';
import { createPresignedPutUrl, R2_URL_EXPIRY } from '../_shared/r2.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';
import { assertUserOwnedKey, getAllowedContentTypes, parseStorageKey } from '../_shared/storage-keys.ts';

export interface GetUploadUrlRequest {
  objectKey: string;
  contentType: string;
  /**
   * The memory-row lookup that would otherwise authorize this upload isn't
   * possible yet: the client uploads assets *before* inserting the
   * `memories` row. Instead, the caller declares which (non-deleted) family
   * they're uploading into and must be manager+ there. Cross-family binding
   * integrity is enforced later at insert/RPC time (memories RLS +
   * `replace_memory_media_assets` key validation).
   */
  familyId: string;
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

  const { objectKey, contentType, familyId } = body;

  if (!objectKey || typeof objectKey !== 'string') {
    return errorResponse('objectKey is required', 400, 'validation_error');
  }

  if (!contentType || typeof contentType !== 'string') {
    return errorResponse('contentType is required', 400, 'validation_error');
  }

  if (!familyId || typeof familyId !== 'string') {
    return errorResponse('familyId is required', 400, 'validation_error');
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

  const parsed = parseStorageKey(objectKey);
  if (parsed?.kind === 'portrait_version_photo') {
    const [{ data: member }, { data: existingVersion }] = await Promise.all([
      serviceClient
        .from('family_members')
        .select('id')
        .eq('id', parsed.entityId)
        .eq('family_id', familyId)
        .maybeSingle(),
      serviceClient
        .from('family_member_portrait_versions')
        .select('id')
        .eq('id', parsed.portraitVersionId as string)
        .maybeSingle(),
    ]);
    if (!member) {
      return errorResponse('Family member not found in this family', 400, 'validation_error');
    }
    if (existingVersion) {
      return errorResponse('Portrait version already exists', 409, 'version_exists');
    }
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
