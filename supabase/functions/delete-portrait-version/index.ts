import { getAuthenticatedUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { getCallerFamilyRole, isManagerRole } from '../_shared/family-access.ts';
import { deleteObject, listObjectKeys } from '../_shared/r2.ts';
import { parseStorageKey } from '../_shared/storage-keys.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

interface DeletePortraitVersionRequest {
  portraitVersionId: string;
}

export interface DeletePortraitVersionDependencies {
  getAuthenticatedUser: typeof getAuthenticatedUser;
  createServiceClient: typeof createServiceClient;
  getCallerFamilyRole: typeof getCallerFamilyRole;
  listObjectKeys: typeof listObjectKeys;
  deleteObject: typeof deleteObject;
}

const DEFAULT_DEPENDENCIES: DeletePortraitVersionDependencies = {
  getAuthenticatedUser,
  createServiceClient,
  getCallerFamilyRole,
  listObjectKeys,
  deleteObject,
};

export async function handleDeletePortraitVersion(
  req: Request,
  dependencies: DeletePortraitVersionDependencies = DEFAULT_DEPENDENCIES,
): Promise<Response> {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405, 'method_not_allowed');
  }

  const user = await dependencies.getAuthenticatedUser(req);
  if (!user) return errorResponse('Unauthorized', 401, 'unauthorized');

  let body: DeletePortraitVersionRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }
  if (!body.portraitVersionId || typeof body.portraitVersionId !== 'string') {
    return errorResponse('portraitVersionId is required', 400, 'validation_error');
  }

  const supabase = dependencies.createServiceClient();
  const { data: version, error } = await supabase
    .from('family_member_portrait_versions')
    .select('*')
    .eq('id', body.portraitVersionId)
    .maybeSingle();
  if (error) {
    return errorResponse('Failed to load portrait version', 500, 'internal_error');
  }
  if (!version) return jsonResponse({ success: true });

  const role = await dependencies.getCallerFamilyRole(supabase, version.family_id, user.id);
  if (!isManagerRole(role)) {
    return errorResponse('Not authorized for this portrait version', 403, 'forbidden');
  }

  const parsed = parseStorageKey(version.profile_picture_key);
  if (
    !parsed ||
    parsed.kind !== 'portrait_version_photo' ||
    parsed.portraitVersionId !== version.id ||
    parsed.entityId !== version.family_member_id
  ) {
    return errorResponse('Invalid portrait source key', 400, 'validation_error');
  }

  let deletionToken = version.deletion_token as string | null;
  if (!deletionToken) {
    deletionToken = crypto.randomUUID();
    const { error: claimError } = await supabase.rpc('claim_family_member_portrait_deletion', {
      target_version_id: version.id,
      delete_token: deletionToken,
      actor_user_id: user.id,
    });
    if (claimError) {
      return errorResponse('Portrait version cannot be deleted', 409, 'DELETE_NOT_ALLOWED');
    }
  }

  const prefix = version.profile_picture_key.slice(0, -'photo.jpg'.length);
  try {
    const keys = await dependencies.listObjectKeys(prefix);
    for (const key of keys) await dependencies.deleteObject(key);
  } catch (storageError) {
    console.error(
      'delete-portrait-version storage cleanup failed',
      version.id,
      storageError instanceof Error ? storageError.message : 'unknown',
    );
    return errorResponse('Portrait deletion interrupted', 500, 'DELETION_INTERRUPTED');
  }

  const { data: deleted, error: finalizeError } = await supabase.rpc(
    'finish_family_member_portrait_deletion',
    { target_version_id: version.id, delete_token: deletionToken },
  );
  if (finalizeError || !deleted) {
    return errorResponse('Portrait deletion interrupted', 409, 'DELETION_INTERRUPTED');
  }
  return jsonResponse({ success: true });
}

if (import.meta.main) Deno.serve((request) => handleDeletePortraitVersion(request));
