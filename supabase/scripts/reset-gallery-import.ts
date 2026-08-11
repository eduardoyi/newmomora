/**
 * Resets a test/dev account's SERVER-SIDE gallery-import state so the whole
 * import flow (scan -> stage -> review -> approve) can be re-tested from
 * scratch on that account.
 *
 * Device-side reset is NOT this script's job: the local run/chunk
 * checkpoint (opaque-token -> OS asset id map, upload/approval progress,
 * deck cursor) lives only in the app's AsyncStorage on the originating
 * device (see docs/features/gallery-import.md). Clearing the app's storage,
 * or reinstalling the app, resets that side. Running only this script
 * leaves a stale local checkpoint pointing at server rows that no longer
 * exist; the app's own reconciliation treats a vanished run as gone, but a
 * real device-side reset gives a cleaner slate for a from-scratch retest.
 *
 * FOR TEST/DEV ACCOUNTS ONLY. This is a destructive, irreversible admin
 * script -- never point it at a real user's account.
 *
 * Deletes, scoped to the resolved user as gallery-import actor_id:
 *   - gallery_import_runs -- cascades (ON DELETE CASCADE, see
 *     supabase/migrations/20260809130000_gallery_import_foundation.sql) to
 *     gallery_import_chunks, gallery_import_assets, gallery_import_candidates,
 *     gallery_import_provider_attempts (via chunk_id), and
 *     gallery_import_approval_leases (via run_id/candidate_id);
 *     gallery_import_cluster_results cascades from chunks.
 *   - gallery_import_cluster_receipts -- NOT cascaded from runs. Keyed on
 *     (family_id, actor_id, algorithm_version, cluster_signature) and
 *     deliberately outlives run/candidate expiry so a previously
 *     skipped/approved cluster stays suppressed. A real reset must clear
 *     these explicitly, or re-scanning the same photos silently comes back
 *     as "suppressed" with zero staged candidates.
 *   - Transient R2 preview objects under the `{userId}/gallery-import/`
 *     prefix (the actor-scoped preview key space; see
 *     `record_gallery_import_preview_upload`'s
 *     `{actorId}/gallery-import/{runId}/previews/{assetToken}.jpg` grammar
 *     in the same migration), via the shared `_shared/r2.ts` client other
 *     scripts in this directory use (`listObjectKeys` + `deleteObject`).
 *
 * Never deletes approved memories or media. `gallery_import_candidates
 * .memory_id` references `memories(id) ON DELETE SET NULL` -- that governs
 * what happens to the CANDIDATE row if the memory is deleted, not the
 * reverse, so deleting candidate rows (including already-approved ones)
 * never touches `memories`/`memory_media`. Approved original assets also
 * live under a different R2 prefix (`{userId}/memories/...`), outside the
 * `{userId}/gallery-import/` prefix this script clears.
 *
 * Dry run (reports what would be deleted, touches nothing):
 * deno run --allow-all --env-file=supabase/.env.local --env-file=.env.local \
 *   supabase/scripts/reset-gallery-import.ts --user test@example.com
 * # or: npm run reset:gallery-import -- --user test@example.com
 *
 * Apply (actually deletes -- irreversible):
 * ... --user test@example.com --confirm
 *
 * --user accepts either an email address or a raw auth user id (uuid).
 *
 * Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, R2_ACCESS_KEY_ID,
 * R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET (same names as every other
 * script in this directory -- no new secrets).
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { deleteObject, listObjectKeys } from '../functions/_shared/r2.ts';

// ---------------------------------------------------------------------------
// Pure helpers (exported + covered by reset-gallery-import.test.ts).
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * The actor-scoped R2 prefix under which every transient gallery-import
 * preview lives, regardless of run. Mirrors
 * `record_gallery_import_preview_upload`'s
 * `{actorId}/gallery-import/{runId}/previews/{assetToken}.jpg` key grammar
 * (supabase/migrations/20260809130000_gallery_import_foundation.sql) --
 * listing/deleting this whole prefix covers every run's previews for this
 * user without needing to know their individual run ids.
 */
export function galleryImportPreviewPrefix(userId: string): string {
  return `${userId}/gallery-import/`;
}

// ---------------------------------------------------------------------------
// Script entry point -- everything below has side effects (network/env) and
// is intentionally not exported/tested directly; the pure helpers above are.
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function getFlagValue(name: string): string | undefined {
  const index = Deno.args.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  const value = Deno.args[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

// Mirrors seed-demo-account.ts's findUserByEmail: the admin listUsers API
// has no reliable server-side email filter, so page through and match
// case-insensitively client-side.
async function findUserByEmail(admin: SupabaseClient, email: string) {
  const target = email.toLowerCase();
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) {
      throw new Error(`Could not list auth users: ${error.message}`);
    }
    const user = data.users.find((candidate) => candidate.email?.toLowerCase() === target);
    if (user) {
      return user;
    }
    if (data.users.length < 1000) {
      break;
    }
  }
  return null;
}

async function resolveUser(
  admin: SupabaseClient,
  userFlag: string,
): Promise<{ id: string; email: string | null }> {
  if (isUuid(userFlag)) {
    const { data, error } = await admin.auth.admin.getUserById(userFlag);
    if (error || !data.user) {
      throw new Error(`No auth user found for id ${userFlag}`);
    }
    return { id: data.user.id, email: data.user.email ?? null };
  }

  const user = await findUserByEmail(admin, userFlag);
  if (!user) {
    throw new Error(`No auth user found for email ${userFlag}`);
  }
  return { id: user.id, email: user.email ?? null };
}

async function main(): Promise<void> {
  const userFlag = getFlagValue('--user');
  if (!userFlag) {
    console.error('Usage: reset-gallery-import.ts --user <email-or-id> [--confirm]');
    Deno.exit(1);
    return;
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? requireEnv('EXPO_PUBLIC_SUPABASE_URL');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { id: userId, email } = await resolveUser(admin, userFlag);
  const shouldApply = Deno.args.includes('--confirm');

  console.log(`Target user: ${userId}${email ? ` (${email})` : ''}`);
  console.log(shouldApply ? 'Applying gallery-import reset' : 'Dry-running gallery-import reset (pass --confirm to apply)');

  const { data: runs, error: runsError } = await admin
    .from('gallery_import_runs')
    .select('id, status')
    .eq('actor_id', userId);
  if (runsError) {
    throw new Error(`Could not load gallery import runs: ${runsError.message}`);
  }
  const runIds = (runs ?? []).map((run) => run.id as string);

  const { data: receipts, error: receiptsError } = await admin
    .from('gallery_import_cluster_receipts')
    .select('id')
    .eq('actor_id', userId);
  if (receiptsError) {
    throw new Error(`Could not load cluster receipts: ${receiptsError.message}`);
  }
  const receiptCount = receipts?.length ?? 0;

  const previewPrefix = galleryImportPreviewPrefix(userId);
  const previewKeys = await listObjectKeys(previewPrefix);

  console.log(
    `Found ${runIds.length} run(s), ${receiptCount} cluster receipt(s), ` +
      `${previewKeys.length} R2 preview object(s) under ${previewPrefix}`,
  );

  if (!shouldApply) {
    console.log('Dry run only -- nothing deleted. Pass --confirm to apply.');
    return;
  }

  if (runIds.length > 0) {
    const { error: deleteRunsError } = await admin.from('gallery_import_runs').delete().in('id', runIds);
    if (deleteRunsError) {
      throw new Error(`Could not delete gallery import runs: ${deleteRunsError.message}`);
    }
  }

  if (receiptCount > 0) {
    const { error: deleteReceiptsError } = await admin
      .from('gallery_import_cluster_receipts')
      .delete()
      .eq('actor_id', userId);
    if (deleteReceiptsError) {
      throw new Error(`Could not delete cluster receipts: ${deleteReceiptsError.message}`);
    }
  }

  let deletedObjectCount = 0;
  let failedObjectCount = 0;
  const failedKeys: string[] = [];
  for (const key of previewKeys) {
    try {
      await deleteObject(key);
      deletedObjectCount += 1;
    } catch (error) {
      failedObjectCount += 1;
      failedKeys.push(key);
      console.error(`Failed to delete R2 object ${key}:`, error instanceof Error ? error.message : error);
    }
  }

  console.log(
    `Deleted ${runIds.length} run(s) (cascading chunks/assets/candidates/provider attempts/approval ` +
      `leases/cluster results), ${receiptCount} cluster receipt(s), ${deletedObjectCount} R2 preview ` +
      `object(s)${failedObjectCount > 0 ? ` (${failedObjectCount} failed: ${failedKeys.join(', ')})` : ''}.`,
  );
  console.log(
    'Server state reset. Remember the device-side reset too: clear the app storage, or reinstall, on the ' +
      'device that ran the import, to drop its local AsyncStorage checkpoint before retesting.',
  );

  if (failedObjectCount > 0) {
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
