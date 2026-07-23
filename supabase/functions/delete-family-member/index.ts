import { getAuthenticatedUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { getCallerFamilyRole, isManagerRole } from '../_shared/family-access.ts';
import { deleteObject, listObjectKeys } from '../_shared/r2.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

export interface DeleteFamilyMemberDependencies {
  getAuthenticatedUser: typeof getAuthenticatedUser;
  createServiceClient: typeof createServiceClient;
  getCallerFamilyRole: typeof getCallerFamilyRole;
  listObjectKeys: typeof listObjectKeys;
  deleteObject: typeof deleteObject;
}

const DEFAULT_DEPENDENCIES: DeleteFamilyMemberDependencies = {
  getAuthenticatedUser,
  createServiceClient,
  getCallerFamilyRole,
  listObjectKeys,
  deleteObject,
};

export async function handleDeleteFamilyMember(
  req: Request,
  dependencies: DeleteFamilyMemberDependencies = DEFAULT_DEPENDENCIES,
): Promise<Response> {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405, 'method_not_allowed');
  }
  const user = await dependencies.getAuthenticatedUser(req);
  if (!user) return errorResponse('Unauthorized', 401, 'unauthorized');

  let familyMemberId: string;
  try {
    ({ familyMemberId } = await req.json());
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }
  if (!familyMemberId || typeof familyMemberId !== 'string') {
    return errorResponse('familyMemberId is required', 400, 'validation_error');
  }

  const supabase = dependencies.createServiceClient();
  const { data: member, error } = await supabase
    .from('family_members')
    .select('id, family_id, profile_picture_key, illustrated_profile_key')
    .eq('id', familyMemberId)
    .maybeSingle();
  if (error) {
    return errorResponse('Failed to load family member', 500, 'internal_error');
  }
  if (!member) return jsonResponse({ success: true });

  const role = await dependencies.getCallerFamilyRole(supabase, member.family_id, user.id);
  if (!isManagerRole(role)) {
    return errorResponse('Not authorized', 403, 'forbidden');
  }

  const memberId = member.id;
  const deletionToken = crypto.randomUUID();
  const { data: claimed, error: claimError } = await supabase.rpc(
    'claim_family_member_deletion_fence',
    {
      p_family_member_id: memberId,
      p_delete_token: deletionToken,
    },
  );
  if (claimError || !claimed) {
    if (claimError?.message === 'Fresh portrait generation is still active') {
      return errorResponse(
        'Portrait generation is still in progress',
        409,
        'PORTRAIT_GENERATION_IN_PROGRESS',
      );
    }
    return errorResponse('Family member deletion already in progress', 409, 'DELETION_IN_PROGRESS');
  }

  let fenceHeld = true;
  async function releaseFence(): Promise<void> {
    if (!fenceHeld) return;
    const { error: releaseError } = await supabase.rpc('release_family_member_deletion_fence', {
      p_family_member_id: memberId,
      p_delete_token: deletionToken,
    });
    if (releaseError) {
      console.error('delete-family-member deletion fence release failed', memberId);
      return;
    }
    fenceHeld = false;
  }

  const { data: versions, error: versionsError } = await supabase
    .from('family_member_portrait_versions')
    .select('profile_picture_key, illustrated_profile_key, generation_output_key')
    .eq('family_member_id', member.id);
  if (versionsError) {
    console.error('delete-family-member portrait lookup failed', member.id, versionsError.message);
    await releaseFence();
    return errorResponse('Failed to load portrait versions', 500, 'internal_error');
  }
  const keys = [member.profile_picture_key, member.illustrated_profile_key].filter(
    (key): key is string => Boolean(key),
  );
  try {
    for (const version of versions ?? []) {
      if (version.illustrated_profile_key) keys.push(version.illustrated_profile_key);
      if (version.generation_output_key) keys.push(version.generation_output_key);
      const prefix = version.profile_picture_key.slice(0, -'photo.jpg'.length);
      keys.push(...(await dependencies.listObjectKeys(prefix)));
    }
    for (const key of [...new Set(keys)]) await dependencies.deleteObject(key);
  } catch (storageError) {
    console.error(
      'delete-family-member storage cleanup failed',
      member.id,
      storageError instanceof Error ? storageError.message : 'unknown',
    );
    await releaseFence();
    return errorResponse('Family member deletion interrupted', 500, 'DELETION_INTERRUPTED');
  }

  const { error: deleteError } = await supabase.from('family_members').delete().eq('id', member.id);
  if (deleteError) {
    await releaseFence();
    return errorResponse('Failed to delete family member', 500, 'internal_error');
  }
  fenceHeld = false; // the cascade removes the fence-bearing row atomically
  return jsonResponse({ success: true });
}

if (import.meta.main) Deno.serve((request) => handleDeleteFamilyMember(request));
