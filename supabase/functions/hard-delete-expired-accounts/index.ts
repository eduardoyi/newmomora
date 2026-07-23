import { validateCronSecret } from '../_shared/cron.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { deleteObject, listObjectKeys } from '../_shared/r2.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

export interface HardDeleteResponse {
  success: true;
  deletedCount: number;
}

type ServiceClient = ReturnType<typeof createServiceClient>;

export interface HardDeleteDependencies {
  createServiceClient: typeof createServiceClient;
  listObjectKeys: typeof listObjectKeys;
  deleteObject: typeof deleteObject;
}

const DEFAULT_DEPENDENCIES: HardDeleteDependencies = {
  createServiceClient,
  listObjectKeys,
  deleteObject,
};

/**
 * Collects every R2 key that belongs to a family, across ALL creators (not
 * just the owner) -- child photos/portraits and memory media/illustrations
 * can live under other members' `{uid}/` prefixes (see plan §7's "child
 * photo replacement by non-creators" note), so the owner's own prefix alone
 * would miss them.
 */
export async function collectFamilyStorageKeys(
  supabase: ServiceClient,
  familyId: string,
): Promise<string[]> {
  const keys: string[] = [];

  const { data: memories, error: memoriesError } = await supabase
    .from('memories')
    .select('id, media_key, illustration_key')
    .eq('family_id', familyId);
  if (memoriesError) throw new Error(`Memory storage lookup failed: ${memoriesError.message}`);

  const memoryIds: string[] = [];
  for (const memory of memories ?? []) {
    memoryIds.push(memory.id);
    if (memory.media_key) keys.push(memory.media_key);
    if (memory.illustration_key) keys.push(memory.illustration_key);
  }

  if (memoryIds.length > 0) {
    const { data: mediaAssets, error: mediaAssetsError } = await supabase
      .from('memory_media')
      .select('object_key, preview_object_key')
      .in('memory_id', memoryIds);
    if (mediaAssetsError) {
      throw new Error(`Memory media storage lookup failed: ${mediaAssetsError.message}`);
    }

    for (const asset of mediaAssets ?? []) {
      if (asset.object_key) keys.push(asset.object_key);
      if (asset.preview_object_key) keys.push(asset.preview_object_key);
    }
  }

  const { data: members, error: membersError } = await supabase
    .from('family_members')
    .select('profile_picture_key, illustrated_profile_key')
    .eq('family_id', familyId);
  if (membersError) throw new Error(`Family member storage lookup failed: ${membersError.message}`);

  for (const member of members ?? []) {
    if (member.profile_picture_key) keys.push(member.profile_picture_key);
    if (member.illustrated_profile_key) keys.push(member.illustrated_profile_key);
  }

  const { data: portraitVersions, error: portraitVersionsError } = await supabase
    .from('family_member_portrait_versions')
    .select('profile_picture_key, illustrated_profile_key, generation_output_key')
    .eq('family_id', familyId);
  if (portraitVersionsError) {
    throw new Error(`Portrait version storage lookup failed: ${portraitVersionsError.message}`);
  }

  for (const version of portraitVersions ?? []) {
    if (version.profile_picture_key) keys.push(version.profile_picture_key);
    if (version.illustrated_profile_key) keys.push(version.illustrated_profile_key);
    if (version.generation_output_key) keys.push(version.generation_output_key);
  }

  // A durable job can own bytes that are not yet pointed to by its memory or
  // portrait version. Include those deterministic keys before the family
  // cascade removes the jobs table and would otherwise strand an R2 object.
  const { data: memoryJobs, error: memoryJobsError } = await supabase
    .from('memory_illustration_jobs')
    .select('output_key')
    .eq('family_id', familyId);
  if (memoryJobsError) {
    throw new Error(`Memory generation job lookup failed: ${memoryJobsError.message}`);
  }
  for (const job of memoryJobs ?? []) {
    if (job.output_key) keys.push(job.output_key);
  }

  const { data: portraitJobs, error: portraitJobsError } = await supabase
    .from('portrait_generation_jobs')
    .select('output_key')
    .eq('family_id', familyId);
  if (portraitJobsError) {
    throw new Error(`Portrait generation job lookup failed: ${portraitJobsError.message}`);
  }
  for (const job of portraitJobs ?? []) {
    if (job.output_key) keys.push(job.output_key);
  }

  return [...new Set(keys)];
}

/**
 * Deletes every family `ownerId` owns: collects R2 keys across the whole
 * family (all creators) BEFORE deleting any rows, deletes those R2
 * objects, then deletes the `families` row -- FK cascades remove its
 * `memories` / `family_members` / `family_memberships` / `family_invites`
 * rows for free.
 */
interface FamilyDeletionFence {
  familyId: string;
  token: string;
}

async function releaseFamilyDeletionFences(
  supabase: ServiceClient,
  fences: FamilyDeletionFence[],
): Promise<void> {
  await Promise.allSettled(fences.map(async (fence) => {
    const { error } = await supabase.rpc('release_family_deletion_fence', {
      p_family_id: fence.familyId,
      p_delete_token: fence.token,
    });
    if (error) {
      console.error('hard-delete-expired-accounts family fence release failed', fence.familyId);
    }
  }));
}

/**
 * Returns false when a family must be retried by a later cron run. No auth or
 * profile deletion may follow that result: a live generation or failed R2
 * cleanup must keep the account intact rather than cascade its durable jobs.
 */
export async function deleteOwnedFamilies(
  supabase: ServiceClient,
  ownerId: string,
  dependencies: Pick<HardDeleteDependencies, 'listObjectKeys' | 'deleteObject'> = DEFAULT_DEPENDENCIES,
  preflightedUserKeys: string[] = [],
): Promise<boolean> {
  const { data: ownedFamilies, error } = await supabase
    .from('families')
    .select('id')
    .eq('owner_id', ownerId);

  if (error) {
    console.error('hard-delete-expired-accounts owned-families lookup failed', ownerId, error.message);
    return false;
  }

  const fences: FamilyDeletionFence[] = [];
  for (const family of ownedFamilies ?? []) {
    const token = crypto.randomUUID();
    const { data: claimed, error: claimError } = await supabase.rpc('claim_family_deletion_fence', {
      p_family_id: family.id,
      p_delete_token: token,
    });
    if (claimError || !claimed) {
      if (claimError?.message === 'Fresh portrait generation is still active' ||
        claimError?.message === 'Fresh illustration generation is still active') {
        console.info('hard-delete-expired-accounts family purge deferred for generation', family.id);
      } else {
        console.error('hard-delete-expired-accounts family fence claim failed', family.id);
      }
      await releaseFamilyDeletionFences(supabase, fences);
      return false;
    }
    fences.push({ familyId: family.id, token });
  }

  const storageByFamily: Array<{ familyId: string; keys: string[] }> = [];
  for (const family of ownedFamilies ?? []) {
    try {
      const keys = await collectFamilyStorageKeys(supabase, family.id);
      const versionPrefixes = keys
        .filter((key) => key.endsWith('/photo.jpg') && key.includes('/portraits/'))
        .map((key) => key.slice(0, -'photo.jpg'.length));
      const prefixKeys = (
        await Promise.all(versionPrefixes.map((prefix) => dependencies.listObjectKeys(prefix)))
      ).flat();
      storageByFamily.push({ familyId: family.id, keys: [...new Set([...keys, ...prefixKeys])] });
    } catch (storageError) {
      console.error(
        'hard-delete-expired-accounts owned-family storage cleanup failed',
        family.id,
        storageError instanceof Error ? storageError.message : 'unknown',
      );
      await releaseFamilyDeletionFences(supabase, fences);
      return false;
    }
  }

  try {
    // `preflightedUserKeys` are objects under the deleted owner's prefix
    // which were proven unreferenced while the owned-family rows still
    // existed. Delete them in the same all-storage phase, before any family
    // fence is finalized. This prevents a later account-prefix lookup failure
    // from leaving the profile alive after its owned families were cascaded.
    const allKeys = new Set([
      ...storageByFamily.flatMap(({ keys }) => keys),
      ...preflightedUserKeys,
    ]);
    await Promise.all([...allKeys].map((key) => dependencies.deleteObject(key)));
  } catch (storageError) {
    console.error(
      'hard-delete-expired-accounts owned-family storage cleanup failed',
      ownerId,
      storageError instanceof Error ? storageError.message : 'unknown',
    );
    await releaseFamilyDeletionFences(supabase, fences);
    return false;
  }

  const { data: finalized, error: finalizeError } = await supabase.rpc(
    'finish_owned_family_deletion_fences',
    {
      p_owner_id: ownerId,
      p_fences: fences.map((fence) => ({ family_id: fence.familyId, delete_token: fence.token })),
    },
  );
  if (finalizeError || !finalized) {
    console.error('hard-delete-expired-accounts family fence finalization failed', ownerId);
    await releaseFamilyDeletionFences(supabase, fences);
    return false;
  }
  return true;
}

/**
 * Given a set of candidate keys (typically everything under a `{userId}/`
 * prefix), returns the subset still referenced by a surviving row --
 * `memory_media.object_key`/`preview_object_key`,
 * `memories.media_key`/`illustration_key`, or
 * `family_members.profile_picture_key`/`illustrated_profile_key`. Simple
 * `.in()` queries rather than a single `.or()` string, so key values (which
 * can contain `.`/`-`) never need PostgREST filter-syntax escaping.
 * `preview_object_key` is checked as its own reference column (not folded
 * into the `object_key` query) -- a preview key never equals its asset's
 * `object_key`, so without this a live preview would look unreferenced and
 * be deleted as orphan garbage.
 */
export async function resolveReferencedKeys(
  supabase: ServiceClient,
  keys: string[],
): Promise<Set<string>> {
  const referenced = new Set<string>();

  if (keys.length === 0) {
    return referenced;
  }

  const [
    mediaAssetRows,
    mediaAssetPreviewRows,
    memoryMediaKeyRows,
    memoryIllustrationKeyRows,
    memberPhotoRows,
    memberPortraitRows,
    versionPhotoRows,
    versionPortraitRows,
    versionAttemptRows,
    memoryJobOutputRows,
    portraitJobOutputRows,
  ] = await Promise.all([
    supabase.from('memory_media').select('object_key').in('object_key', keys),
    supabase.from('memory_media').select('preview_object_key').in('preview_object_key', keys),
    supabase.from('memories').select('media_key').in('media_key', keys),
    supabase.from('memories').select('illustration_key').in('illustration_key', keys),
    supabase.from('family_members').select('profile_picture_key').in('profile_picture_key', keys),
    supabase
      .from('family_members')
      .select('illustrated_profile_key')
      .in('illustrated_profile_key', keys),
    supabase
      .from('family_member_portrait_versions')
      .select('profile_picture_key')
      .in('profile_picture_key', keys),
    supabase
      .from('family_member_portrait_versions')
      .select('illustrated_profile_key')
      .in('illustrated_profile_key', keys),
    supabase
      .from('family_member_portrait_versions')
      .select('generation_output_key')
      .in('generation_output_key', keys),
    supabase
      .from('memory_illustration_jobs')
      .select('output_key')
      .in('output_key', keys),
    supabase
      .from('portrait_generation_jobs')
      .select('output_key')
      .in('output_key', keys),
  ]);

  const lookupError = [
    mediaAssetRows,
    mediaAssetPreviewRows,
    memoryMediaKeyRows,
    memoryIllustrationKeyRows,
    memberPhotoRows,
    memberPortraitRows,
    versionPhotoRows,
    versionPortraitRows,
    versionAttemptRows,
    memoryJobOutputRows,
    portraitJobOutputRows,
  ].find((result) => result.error)?.error;
  if (lookupError) {
    throw new Error(`Referenced storage lookup failed: ${lookupError.message}`);
  }

  for (const row of mediaAssetRows.data ?? []) {
    if (row.object_key) referenced.add(row.object_key);
  }
  for (const row of mediaAssetPreviewRows.data ?? []) {
    if (row.preview_object_key) referenced.add(row.preview_object_key);
  }
  for (const row of memoryMediaKeyRows.data ?? []) {
    if (row.media_key) referenced.add(row.media_key);
  }
  for (const row of memoryIllustrationKeyRows.data ?? []) {
    if (row.illustration_key) referenced.add(row.illustration_key);
  }
  for (const row of memberPhotoRows.data ?? []) {
    if (row.profile_picture_key) referenced.add(row.profile_picture_key);
  }
  for (const row of memberPortraitRows.data ?? []) {
    if (row.illustrated_profile_key) referenced.add(row.illustrated_profile_key);
  }
  for (const row of versionPhotoRows.data ?? []) {
    if (row.profile_picture_key) referenced.add(row.profile_picture_key);
  }
  for (const row of versionPortraitRows.data ?? []) {
    if (row.illustrated_profile_key) referenced.add(row.illustrated_profile_key);
  }
  for (const row of versionAttemptRows.data ?? []) {
    if (row.generation_output_key) referenced.add(row.generation_output_key);
  }
  for (const row of memoryJobOutputRows.data ?? []) {
    if (row.output_key) referenced.add(row.output_key);
  }
  for (const row of portraitJobOutputRows.data ?? []) {
    if (row.output_key) referenced.add(row.output_key);
  }

  return referenced;
}

/**
 * Non-owner cleanup: this user's created content (memories, family_members
 * in families they don't own) survives -- `user_id` goes to null via the FK
 * `on delete set null` when `auth.admin.deleteUser` removes their
 * `auth.users` row below. So a blanket delete of everything under
 * `{userId}/` would orphan media still referenced by those surviving rows.
 * Instead: enumerate objects under the prefix and delete only the ones no
 * surviving row references.
 */
/**
 * Preflights the owner-prefix objects that survive neither an owned-family
 * cascade nor a shared-family reference. It intentionally performs no R2
 * deletion: callers must finish every listing/reference lookup before they
 * remove a single owned-family row.
 */
export async function collectUnreferencedUserObjectKeys(
  supabase: ServiceClient,
  userId: string,
  dependencies: Pick<HardDeleteDependencies, 'listObjectKeys'> = DEFAULT_DEPENDENCIES,
): Promise<string[] | null> {
  let keys: string[];

  try {
    keys = await dependencies.listObjectKeys(`${userId}/`);
  } catch (listError) {
    console.error(
      'hard-delete-expired-accounts prefix listing failed',
      userId,
      listError instanceof Error ? listError.message : 'unknown',
    );
    return null;
  }

  if (keys.length === 0) {
    return [];
  }

  let referenced: Set<string>;
  try {
    referenced = await resolveReferencedKeys(supabase, keys);
  } catch (lookupError) {
    console.error(
      'hard-delete-expired-accounts referenced object lookup failed',
      userId,
      lookupError instanceof Error ? lookupError.message : 'unknown',
    );
    return null;
  }
  return keys.filter((key) => !referenced.has(key));
}

export async function handleHardDeleteExpiredAccounts(
  req: Request,
  dependencyOverrides: Partial<HardDeleteDependencies> = {},
): Promise<Response> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const corsResponse = handleCors(req);
  if (corsResponse) {
    return corsResponse;
  }

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405, 'method_not_allowed');
  }

  if (!validateCronSecret(req)) {
    return errorResponse('Unauthorized', 401, 'unauthorized');
  }

  const supabase = dependencies.createServiceClient();
  const now = new Date().toISOString();

  const { data: profiles, error } = await supabase
    .from('user_profiles')
    .select('id')
    .not('scheduled_hard_delete_at', 'is', null)
    .lte('scheduled_hard_delete_at', now);

  if (error) {
    console.error('hard-delete-expired-accounts lookup failed', error.message);
    return errorResponse('Failed to load expired accounts', 500, 'internal_error');
  }

  let deletedCount = 0;

  for (const profile of profiles ?? []) {
    const userId = profile.id;
    const hardDeleteToken = crypto.randomUUID();

    const { data: claimed, error: claimError } = await supabase.rpc(
      'claim_account_hard_deletion',
      {
        p_owner_id: userId,
        p_hard_delete_token: hardDeleteToken,
      },
    );
    if (claimError || !claimed) {
      if (claimError) {
        console.error('hard-delete-expired-accounts account fence claim failed', userId);
      }
      continue;
    }

    try {
      const unreferencedUserKeys = await collectUnreferencedUserObjectKeys(supabase, userId, dependencies);
      if (unreferencedUserKeys === null) {
        continue;
      }

      const deletedOwnedFamilies = await deleteOwnedFamilies(
        supabase,
        userId,
        dependencies,
        unreferencedUserKeys,
      );
      if (!deletedOwnedFamilies) {
        continue;
      }
    } catch (cleanupError) {
      console.error(
        'hard-delete-expired-accounts cleanup failed',
        userId,
        cleanupError instanceof Error ? cleanupError.message : 'unknown',
      );
      continue;
    }

    // Re-verify the exact ownership token *after* every external storage
    // action. A PostgREST delete with zero matching rows still reports no
    // error, so finalization must be an explicit locked RPC rather than an
    // id-only/profile-row delete. The migration changes user_profiles ->
    // auth.users to ON DELETE CASCADE: only a successful GoTrue deletion can
    // remove the profile, leaving it retryable if GoTrue fails.
    const { data: refreshed, error: refreshError } = await supabase.rpc(
      'refresh_account_hard_deletion_claim',
      {
        p_owner_id: userId,
        p_hard_delete_token: hardDeleteToken,
      },
    );
    if (refreshError || !refreshed) {
      if (refreshError) {
        console.error('hard-delete-expired-accounts account fence refresh failed', userId);
      }
      continue;
    }

    const { error: authDeleteError } = await supabase.auth.admin.deleteUser(userId);

    if (authDeleteError) {
      console.error('hard-delete-expired-accounts auth delete failed', userId, authDeleteError.message);
      const { error: releaseError } = await supabase.rpc('release_account_hard_deletion_claim', {
        p_owner_id: userId,
        p_hard_delete_token: hardDeleteToken,
      });
      if (releaseError) {
        console.error('hard-delete-expired-accounts account fence release failed', userId);
      }
      continue;
    }

    deletedCount += 1;
  }

  const response: HardDeleteResponse = {
    success: true,
    deletedCount,
  };

  return jsonResponse(response);
}

if (import.meta.main) {
  Deno.serve((request) => handleHardDeleteExpiredAccounts(request));
}
