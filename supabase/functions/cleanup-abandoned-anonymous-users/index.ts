// WP-SEC item 5 (docs/plans/onboarding-implementation.md): scheduled cleanup
// for abandoned anonymous Auth users. Same shape as
// hard-delete-expired-accounts/index.ts (validateCronSecret +
// createServiceClient + injectable DEFAULT_DEPENDENCIES), but the cleanup
// itself is much simpler: an anonymous Auth user never legitimately owns a
// family, a memory, or a user_profiles row (see
// 20260729130000_onboarding_anonymous_lockdown.sql §1), so there is no
// storage to walk and no family to cascade -- deleting the auth.users row
// is the whole job.
//
// "Abandoned" = anonymous (`is_anonymous = true`) AND older than
// ABANDONED_ANONYMOUS_USER_TTL_DAYS. The candidate query
// (`get_abandoned_anonymous_auth_user_ids`,
// 20260729150000_abandoned_anonymous_cleanup.sql) additionally excludes
// anyone who somehow holds a real family_memberships row or owns a family --
// that should be structurally impossible after the WP-SEC lockdown, but a
// maintenance cron must never quietly trust an invariant it didn't just
// check: `families.owner_id references auth.users on delete cascade`, so
// deleting an anonymous user who *did* somehow own a family would silently
// destroy it. This function re-verifies that same safety net a second time,
// immediately before each individual delete (`isSafeToDelete`), and skips
// (loud log, not a thrown error) rather than deleting if it ever finds one.
//
// Deleting the auth.users row is exactly the cascade docs/features/usage-limits.md
// already documents and supabase/tests/usage_limits_onboarding.sql already
// tests: `ai_onboarding_voice_requests.actor_user_id` and
// `ai_usage_events.actor_user_id` null out via their own `on delete set
// null` FKs, while the deidentified `ai_system_usage_monthly_rollups`
// company COGS rollup is untouched (no user FK at all). This function does
// not touch the ledger itself in any way -- it only ever calls
// `auth.admin.deleteUser`, and lets that existing cascade run.
import { validateCronSecret } from '../_shared/cron.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

export interface CleanupAbandonedAnonymousUsersResponse {
  success: true;
  deletedCount: number;
}

/**
 * Conservative TTL, not a hard technical minimum: 7 days matches the
 * existing invite-code-expiry precedent elsewhere in this codebase (see
 * docs/features/family-sharing.md) for "how long a temporary pre-account
 * state stays valid before it's considered abandoned" -- generous enough
 * that a parent who puts the app down for a week mid-onboarding and comes
 * back still has their two-attempt voice reservation counter intact, while
 * bounding how long an abandoned pre-auth session's auth.users row survives
 * with nothing else ever sweeping it.
 */
export const ABANDONED_ANONYMOUS_USER_TTL_DAYS = 7;

type ServiceClient = ReturnType<typeof createServiceClient>;

export interface CleanupDependencies {
  createServiceClient: typeof createServiceClient;
  now: () => Date;
}

const DEFAULT_DEPENDENCIES: CleanupDependencies = {
  createServiceClient,
  now: () => new Date(),
};

export interface AbandonedAnonymousUserCandidate {
  id: string;
  created_at: string;
}

/**
 * The dangerous failure mode this function exists to prevent: deleting a
 * permanent user, or an anonymous user who (somehow) already owns real
 * content. Re-fetches the user fresh (not trusting the candidate row's age)
 * and re-checks family_memberships/families ownership fresh, immediately
 * before the delete. Returns false (never throws) for anything that isn't
 * unambiguously safe -- a lookup error, a since-deleted user, a
 * since-converted-to-permanent user, or unexpected real content all skip
 * this candidate rather than delete it.
 */
export async function isSafeToDelete(
  supabase: ServiceClient,
  candidateId: string,
): Promise<boolean> {
  const { data: userData, error: userError } = await supabase.auth.admin.getUserById(candidateId);

  if (userError || !userData?.user) {
    return false;
  }

  if (userData.user.is_anonymous !== true) {
    console.error(
      'cleanup-abandoned-anonymous-users: candidate is not anonymous -- refusing to delete',
      candidateId,
    );
    return false;
  }

  const [membershipResult, ownedFamilyResult] = await Promise.all([
    supabase.from('family_memberships').select('*', { count: 'exact', head: true }).eq(
      'user_id',
      candidateId,
    ),
    supabase.from('families').select('*', { count: 'exact', head: true }).eq(
      'owner_id',
      candidateId,
    ),
  ]);

  if (membershipResult.error || ownedFamilyResult.error) {
    console.error('cleanup-abandoned-anonymous-users: safety re-check failed', candidateId);
    return false;
  }

  if ((membershipResult.count ?? 0) > 0 || (ownedFamilyResult.count ?? 0) > 0) {
    // This should be structurally impossible after the WP-SEC lockdown
    // (20260729130000_onboarding_anonymous_lockdown.sql) -- if it ever
    // happens, it means that lockdown has regressed, which needs
    // investigation, not a silent delete that would cascade-destroy a real
    // family.
    console.error(
      'cleanup-abandoned-anonymous-users: candidate unexpectedly owns real content -- skipping (this indicates an anonymous-lockdown regression)',
      candidateId,
    );
    return false;
  }

  return true;
}

export async function handleCleanupAbandonedAnonymousUsers(
  req: Request,
  dependencyOverrides: Partial<CleanupDependencies> = {},
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
  const cutoff = new Date(
    dependencies.now().getTime() - ABANDONED_ANONYMOUS_USER_TTL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data: candidates, error: candidatesError } = await supabase.rpc(
    'get_abandoned_anonymous_auth_user_ids',
    { p_older_than: cutoff },
  );

  if (candidatesError) {
    console.error('cleanup-abandoned-anonymous-users candidate lookup failed', candidatesError.message);
    return errorResponse('Failed to load abandoned anonymous users', 500, 'internal_error');
  }

  const rows = (candidates ?? []) as AbandonedAnonymousUserCandidate[];
  let deletedCount = 0;

  for (const candidate of rows) {
    const safeToDelete = await isSafeToDelete(supabase, candidate.id);
    if (!safeToDelete) {
      continue;
    }

    const { error: deleteError } = await supabase.auth.admin.deleteUser(candidate.id);
    if (deleteError) {
      console.error(
        'cleanup-abandoned-anonymous-users auth delete failed',
        candidate.id,
        deleteError.message,
      );
      continue;
    }

    deletedCount += 1;
  }

  const response: CleanupAbandonedAnonymousUsersResponse = {
    success: true,
    deletedCount,
  };

  return jsonResponse(response);
}

if (import.meta.main) {
  Deno.serve((request) => handleCleanupAbandonedAnonymousUsers(request));
}
