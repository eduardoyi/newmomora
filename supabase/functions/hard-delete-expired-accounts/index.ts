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

  const { data: memories } = await supabase
    .from('memories')
    .select('id, media_key, illustration_key')
    .eq('family_id', familyId);

  const memoryIds: string[] = [];
  for (const memory of memories ?? []) {
    memoryIds.push(memory.id);
    if (memory.media_key) keys.push(memory.media_key);
    if (memory.illustration_key) keys.push(memory.illustration_key);
  }

  if (memoryIds.length > 0) {
    const { data: mediaAssets } = await supabase
      .from('memory_media')
      .select('object_key')
      .in('memory_id', memoryIds);

    for (const asset of mediaAssets ?? []) {
      if (asset.object_key) keys.push(asset.object_key);
    }
  }

  const { data: members } = await supabase
    .from('family_members')
    .select('profile_picture_key, illustrated_profile_key')
    .eq('family_id', familyId);

  for (const member of members ?? []) {
    if (member.profile_picture_key) keys.push(member.profile_picture_key);
    if (member.illustrated_profile_key) keys.push(member.illustrated_profile_key);
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
async function deleteOwnedFamilies(supabase: ServiceClient, ownerId: string): Promise<void> {
  const { data: ownedFamilies, error } = await supabase
    .from('families')
    .select('id')
    .eq('owner_id', ownerId);

  if (error) {
    console.error('hard-delete-expired-accounts owned-families lookup failed', ownerId, error.message);
    return;
  }

  for (const family of ownedFamilies ?? []) {
    try {
      const keys = await collectFamilyStorageKeys(supabase, family.id);
      await Promise.all(keys.map((key) => deleteObject(key)));
    } catch (storageError) {
      console.error(
        'hard-delete-expired-accounts owned-family storage cleanup failed',
        family.id,
        storageError instanceof Error ? storageError.message : 'unknown',
      );
    }

    const { error: deleteFamilyError } = await supabase.from('families').delete().eq('id', family.id);

    if (deleteFamilyError) {
      console.error(
        'hard-delete-expired-accounts family row delete failed',
        family.id,
        deleteFamilyError.message,
      );
    }
  }
}

/**
 * Given a set of candidate keys (typically everything under a `{userId}/`
 * prefix), returns the subset still referenced by a surviving row --
 * `memory_media.object_key`, `memories.media_key`/`illustration_key`, or
 * `family_members.profile_picture_key`/`illustrated_profile_key`. Five
 * simple `.in()` queries rather than a single `.or()` string, so key
 * values (which can contain `.`/`-`) never need PostgREST filter-syntax
 * escaping.
 */
export async function resolveReferencedKeys(
  supabase: ServiceClient,
  keys: string[],
): Promise<Set<string>> {
  const referenced = new Set<string>();

  if (keys.length === 0) {
    return referenced;
  }

  const [mediaAssetRows, memoryMediaKeyRows, memoryIllustrationKeyRows, memberPhotoRows, memberPortraitRows] =
    await Promise.all([
      supabase.from('memory_media').select('object_key').in('object_key', keys),
      supabase.from('memories').select('media_key').in('media_key', keys),
      supabase.from('memories').select('illustration_key').in('illustration_key', keys),
      supabase.from('family_members').select('profile_picture_key').in('profile_picture_key', keys),
      supabase
        .from('family_members')
        .select('illustrated_profile_key')
        .in('illustrated_profile_key', keys),
    ]);

  for (const row of mediaAssetRows.data ?? []) {
    if (row.object_key) referenced.add(row.object_key);
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
async function deleteUnreferencedUserObjects(
  supabase: ServiceClient,
  userId: string,
): Promise<void> {
  let keys: string[];

  try {
    keys = await listObjectKeys(`${userId}/`);
  } catch (listError) {
    console.error(
      'hard-delete-expired-accounts prefix listing failed',
      userId,
      listError instanceof Error ? listError.message : 'unknown',
    );
    return;
  }

  if (keys.length === 0) {
    return;
  }

  const referenced = await resolveReferencedKeys(supabase, keys);
  const unreferencedKeys = keys.filter((key) => !referenced.has(key));

  try {
    await Promise.all(unreferencedKeys.map((key) => deleteObject(key)));
  } catch (deleteError) {
    console.error(
      'hard-delete-expired-accounts unreferenced object cleanup failed',
      userId,
      deleteError instanceof Error ? deleteError.message : 'unknown',
    );
  }
}

export async function handleHardDeleteExpiredAccounts(req: Request): Promise<Response> {
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

  const supabase = createServiceClient();
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

    try {
      await deleteOwnedFamilies(supabase, userId);
      await deleteUnreferencedUserObjects(supabase, userId);
    } catch (cleanupError) {
      console.error(
        'hard-delete-expired-accounts cleanup failed',
        userId,
        cleanupError instanceof Error ? cleanupError.message : 'unknown',
      );
    }

    // No explicit deletes of `memories` / `family_members` by user_id here:
    // rows in owned families are already gone via the families cascade
    // above, and rows in families this user doesn't own must SURVIVE
    // (user_id -> null automatically via `on delete set null` once
    // auth.admin.deleteUser removes the auth.users row below).
    await supabase.from('user_profiles').delete().eq('id', userId);

    const { error: authDeleteError } = await supabase.auth.admin.deleteUser(userId);

    if (authDeleteError) {
      console.error('hard-delete-expired-accounts auth delete failed', userId, authDeleteError.message);
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
  Deno.serve(handleHardDeleteExpiredAccounts);
}
