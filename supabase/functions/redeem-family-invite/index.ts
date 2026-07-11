// Redeems a family invite code (docs/plans/family-sharing.md §9).
//
// Flow: normalize the code -> log the attempt (BEFORE any code check, so
// guesses always count against the limits) -> enforce per-user and per-IP
// rate limits -> resolve the invite + its family (service role) -> reject
// already-members -> claim the invite atomically -> best-effort push to the
// inviter. Invalid, expired, revoked, already-redeemed, and
// family-soft-deleted codes all return the SAME generic error so the
// endpoint can't be used as an oracle for which codes exist.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { getAuthenticatedUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { sendExpoPushNotification } from '../_shared/expo-push.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

export interface RedeemFamilyInviteRequest {
  code: string;
}

export interface RedeemFamilyInviteResponse {
  familyName: string;
  role: string;
}

export const USER_ATTEMPT_LIMIT_PER_HOUR = 10;
export const IP_ATTEMPT_LIMIT_PER_HOUR = 30;

const INVALID_CODE_MESSAGE = 'That invite code is invalid or has expired.';
const RATE_LIMIT_MESSAGE = 'Too many attempts. Please wait a while and try again.';

/** Must stay in sync with the client copy in src/utils/invites.ts. */
export function normalizeInviteCode(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The client IP for rate limiting is the LAST entry of x-forwarded-for --
 * the hop appended by Supabase's own proxy. Everything before it is
 * client-suppliable, so trusting any earlier entry would make the IP limit
 * spoofable per-request. Missing header -> null (the IP limit is skipped;
 * best-effort defense in depth per the plan).
 */
export function extractClientIp(req: Request): string | null {
  const header = req.headers.get('x-forwarded-for');

  if (!header) {
    return null;
  }

  const hops = header
    .split(',')
    .map((hop) => hop.trim())
    .filter(Boolean);

  return hops.length > 0 ? hops[hops.length - 1] : null;
}

interface InviteRow {
  id: string;
  family_id: string;
  role: string;
  status: string;
  invited_by: string;
  expires_at: string;
}

export async function processRedemption(
  serviceClient: SupabaseClient,
  userId: string,
  rawCode: string,
  ip: string | null,
): Promise<Response> {
  const code = normalizeInviteCode(rawCode);

  if (!code) {
    return errorResponse('code is required', 400, 'validation_error');
  }

  // 1. Log the attempt BEFORE checking the code. Fail closed: if the attempt
  //    can't be recorded, the rate limit can't be trusted, so don't proceed.
  const { error: attemptError } = await serviceClient
    .from('invite_redemption_attempts')
    .insert({ user_id: userId, ip });

  if (attemptError) {
    console.error('redeem-family-invite attempt log failed', attemptError.message);
    return errorResponse('Failed to process the invite code', 500, 'internal_error');
  }

  // 2. Opportunistically prune attempts older than 24h (best-effort).
  const pruneCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { error: pruneError } = await serviceClient
    .from('invite_redemption_attempts')
    .delete()
    .lt('attempted_at', pruneCutoff);

  if (pruneError) {
    console.error('redeem-family-invite attempt prune failed', pruneError.message);
  }

  // 3. Rate limits (the just-logged attempt is included in the counts, so
  //    "limit exceeded" means strictly more than the allowed attempts).
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const { count: userCount, error: userCountError } = await serviceClient
    .from('invite_redemption_attempts')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('attempted_at', hourAgo);

  if (userCountError) {
    console.error('redeem-family-invite user rate count failed', userCountError.message);
    return errorResponse('Failed to process the invite code', 500, 'internal_error');
  }

  if ((userCount ?? 0) > USER_ATTEMPT_LIMIT_PER_HOUR) {
    return errorResponse(RATE_LIMIT_MESSAGE, 429, 'rate_limited');
  }

  if (ip) {
    const { count: ipCount, error: ipCountError } = await serviceClient
      .from('invite_redemption_attempts')
      .select('*', { count: 'exact', head: true })
      .eq('ip', ip)
      .gte('attempted_at', hourAgo);

    if (ipCountError) {
      console.error('redeem-family-invite ip rate count failed', ipCountError.message);
      return errorResponse('Failed to process the invite code', 500, 'internal_error');
    }

    if ((ipCount ?? 0) > IP_ATTEMPT_LIMIT_PER_HOUR) {
      return errorResponse(RATE_LIMIT_MESSAGE, 429, 'rate_limited');
    }
  }

  // 4. Resolve the invite by code (service role; needed for the
  //    already-member check before the claim).
  const { data: inviteData, error: inviteError } = await serviceClient
    .from('family_invites')
    .select('id, family_id, role, status, invited_by, expires_at')
    .eq('code', code)
    .maybeSingle();

  if (inviteError) {
    console.error('redeem-family-invite invite lookup failed', inviteError.message);
    return errorResponse('Failed to process the invite code', 500, 'internal_error');
  }

  const invite = inviteData as InviteRow | null;

  if (!invite) {
    return errorResponse(INVALID_CODE_MESSAGE, 400, 'invalid_code');
  }

  // 5. Family must exist and not be soft-deleted -- otherwise the code would
  //    redeem into a dead family no one can approve, stranding the redeemer
  //    on the waiting screen (plan §9).
  const { data: family, error: familyError } = await serviceClient
    .from('families')
    .select('id, name, deleted_at')
    .eq('id', invite.family_id)
    .maybeSingle();

  if (familyError) {
    console.error('redeem-family-invite family lookup failed', familyError.message);
    return errorResponse('Failed to process the invite code', 500, 'internal_error');
  }

  if (!family || family.deleted_at) {
    return errorResponse(INVALID_CODE_MESSAGE, 400, 'invalid_code');
  }

  // 6. Reject callers who are already members of the invite's family.
  const { data: existingMembership, error: membershipError } = await serviceClient
    .from('family_memberships')
    .select('id')
    .eq('family_id', invite.family_id)
    .eq('user_id', userId)
    .maybeSingle();

  if (membershipError) {
    console.error('redeem-family-invite membership lookup failed', membershipError.message);
    return errorResponse('Failed to process the invite code', 500, 'internal_error');
  }

  if (existingMembership) {
    return errorResponse("You're already a member of this family.", 409, 'already_member');
  }

  // 7. Atomic claim: a single conditional UPDATE (status must still be
  //    'pending', expiry still in the future) with RETURNING. Two concurrent
  //    redemptions can't both match -- the loser gets zero rows and the same
  //    generic error as an invalid code. Expired/revoked/already-redeemed
  //    codes also fall out here even if they raced past the lookup above.
  const nowIso = new Date().toISOString();
  const { data: claimed, error: claimError } = await serviceClient
    .from('family_invites')
    .update({ status: 'redeemed', redeemed_by: userId, redeemed_at: nowIso })
    .eq('id', invite.id)
    .eq('status', 'pending')
    .gt('expires_at', nowIso)
    .select('id')
    .maybeSingle();

  if (claimError) {
    console.error('redeem-family-invite claim failed', claimError.message);
    return errorResponse('Failed to process the invite code', 500, 'internal_error');
  }

  if (!claimed) {
    return errorResponse(INVALID_CODE_MESSAGE, 400, 'invalid_code');
  }

  // 8. Push to the inviter (best-effort -- a push failure must never fail
  //    the redemption, which is already committed).
  try {
    const [{ data: redeemerProfile }, { data: inviterProfile }] = await Promise.all([
      serviceClient.from('user_profiles').select('name').eq('id', userId).maybeSingle(),
      serviceClient
        .from('user_profiles')
        .select('expo_push_token')
        .eq('id', invite.invited_by)
        .maybeSingle(),
    ]);

    const pushToken = inviterProfile?.expo_push_token as string | null | undefined;

    if (pushToken) {
      const redeemerName = (redeemerProfile?.name as string | undefined) ?? 'Someone';
      await sendExpoPushNotification(
        pushToken,
        'Momora',
        `${redeemerName} wants to join ${family.name} — open Momora to approve`,
      );
    }
  } catch (pushError) {
    console.error(
      'redeem-family-invite inviter push failed',
      pushError instanceof Error ? pushError.message : 'unknown',
    );
  }

  const response: RedeemFamilyInviteResponse = {
    familyName: family.name as string,
    role: invite.role,
  };

  return jsonResponse(response);
}

export async function handleRedeemFamilyInvite(req: Request): Promise<Response> {
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

  let body: RedeemFamilyInviteRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }

  if (typeof body.code !== 'string') {
    return errorResponse('code is required', 400, 'validation_error');
  }

  return processRedemption(createServiceClient(), user.id, body.code, extractClientIp(req));
}

if (import.meta.main) {
  Deno.serve(handleRedeemFamilyInvite);
}
