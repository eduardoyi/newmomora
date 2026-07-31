// WP-SEC carve-out: J2's dependency (docs/plans/onboarding-implementation.md).
// Lets a pre-auth caller (anonymous Auth session, per src/lib/anonymous-session.ts)
// preview an invite code before signing up: only the family name and the
// inviter's display name, so the join screen can ask "Join the Rivera
// Family?" before the user has an account. A permanent (non-anonymous)
// caller may also use it -- this is the one normal-facing endpoint that
// deliberately accepts BOTH, unlike every other Edge Function (see
// _shared/auth.ts).
//
// Never leaks: membership lists, emails, the invite's role, or family ids.
// Same generic invalid-code error for not-found/expired/revoked/redeemed/
// family-soft-deleted, so the endpoint can't be used as an oracle -- same
// convention as redeem-family-invite. Rate-limited BY CODE (not by caller):
// once anonymous sign-ins are enabled, an attacker can mint unlimited
// anonymous sessions for near-zero cost, so a per-user/per-account limit
// alone would not bound hammering one guessed code the way it does for
// redeem-family-invite (a real account signup).
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { getAuthenticatedUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

export interface PreviewFamilyInviteRequest {
  code: string;
}

export interface PreviewFamilyInviteResponse {
  familyName: string;
  inviterName: string;
}

export const CODE_PREVIEW_LIMIT_PER_HOUR = 20;

const INVALID_CODE_MESSAGE = 'That invite code is invalid or has expired.';
const RATE_LIMIT_MESSAGE = 'Too many attempts. Please wait a while and try again.';
const FALLBACK_INVITER_NAME = 'A family member';

/**
 * Must stay in sync with the client copy in src/utils/invites.ts (and the
 * server copy in redeem-family-invite/index.ts) -- same code shape, not a
 * second format.
 */
export function normalizeInviteCode(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Same "trust only the platform-appended last hop" rule as
 * redeem-family-invite/index.ts#extractClientIp -- kept only as an inline
 * best-effort log field here (the required limit is by code, not by IP).
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
  family_id: string;
  status: string;
  expires_at: string;
  invited_by: string;
}

export async function processPreview(
  serviceClient: SupabaseClient,
  rawCode: string,
  ip: string | null,
): Promise<Response> {
  const code = normalizeInviteCode(rawCode);

  if (!code) {
    return errorResponse('code is required', 400, 'validation_error');
  }

  // 1. Log the attempt BEFORE checking the code -- fail closed: if the
  //    attempt can't be recorded, the per-code limit can't be trusted, so
  //    don't proceed. Same convention as redeem-family-invite.
  const { error: attemptError } = await serviceClient
    .from('invite_preview_attempts')
    .insert({ code, ip });

  if (attemptError) {
    console.error('preview-family-invite attempt log failed', attemptError.message);
    return errorResponse('Failed to process the invite code', 500, 'internal_error');
  }

  // 2. Opportunistically prune attempts older than 24h (best-effort).
  const pruneCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { error: pruneError } = await serviceClient
    .from('invite_preview_attempts')
    .delete()
    .lt('attempted_at', pruneCutoff);

  if (pruneError) {
    console.error('preview-family-invite attempt prune failed', pruneError.message);
  }

  // 3. Rate limit BY CODE (the just-logged attempt is included in the
  //    count, so "limit exceeded" means strictly more than allowed).
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const { count: codeCount, error: codeCountError } = await serviceClient
    .from('invite_preview_attempts')
    .select('*', { count: 'exact', head: true })
    .eq('code', code)
    .gte('attempted_at', hourAgo);

  if (codeCountError) {
    console.error('preview-family-invite rate count failed', codeCountError.message);
    return errorResponse('Failed to process the invite code', 500, 'internal_error');
  }

  if ((codeCount ?? 0) > CODE_PREVIEW_LIMIT_PER_HOUR) {
    return errorResponse(RATE_LIMIT_MESSAGE, 429, 'rate_limited');
  }

  // 4. Resolve the invite by code. Same validity window as redemption
  //    (status pending, not expired, family exists and not soft-deleted) --
  //    a preview that promises a family the redeem step would then refuse
  //    is worse than a generic "invalid" here.
  const { data: inviteData, error: inviteError } = await serviceClient
    .from('family_invites')
    .select('family_id, status, expires_at, invited_by')
    .eq('code', code)
    .maybeSingle();

  if (inviteError) {
    console.error('preview-family-invite invite lookup failed', inviteError.message);
    return errorResponse('Failed to process the invite code', 500, 'internal_error');
  }

  const invite = inviteData as InviteRow | null;

  if (!invite || invite.status !== 'pending' || invite.expires_at <= new Date().toISOString()) {
    return errorResponse(INVALID_CODE_MESSAGE, 400, 'invalid_code');
  }

  const { data: family, error: familyError } = await serviceClient
    .from('families')
    .select('name, deleted_at')
    .eq('id', invite.family_id)
    .maybeSingle();

  if (familyError) {
    console.error('preview-family-invite family lookup failed', familyError.message);
    return errorResponse('Failed to process the invite code', 500, 'internal_error');
  }

  if (!family || family.deleted_at) {
    return errorResponse(INVALID_CODE_MESSAGE, 400, 'invalid_code');
  }

  // 5. Inviter display name -- best-effort; a hard-deleted inviter account
  //    (FK `on delete set null`) falls back to a generic label rather than
  //    failing the whole preview.
  let inviterName = FALLBACK_INVITER_NAME;
  if (invite.invited_by) {
    const { data: inviterProfile } = await serviceClient
      .from('user_profiles')
      .select('name')
      .eq('id', invite.invited_by)
      .maybeSingle();
    inviterName = (inviterProfile?.name as string | undefined) || FALLBACK_INVITER_NAME;
  }

  const response: PreviewFamilyInviteResponse = {
    familyName: family.name as string,
    inviterName,
  };

  return jsonResponse(response);
}

export async function handlePreviewFamilyInvite(req: Request): Promise<Response> {
  const corsResponse = handleCors(req);
  if (corsResponse) {
    return corsResponse;
  }

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405, 'method_not_allowed');
  }

  // WP-SEC carve-out: accepts BOTH an anonymous Auth session and a permanent
  // one -- calls getAuthenticatedUser directly, never getAuthenticatedNonAnonymousUser.
  const user = await getAuthenticatedUser(req);
  if (!user) {
    return errorResponse('Unauthorized', 401, 'unauthorized');
  }

  let body: PreviewFamilyInviteRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }

  if (typeof body.code !== 'string') {
    return errorResponse('code is required', 400, 'validation_error');
  }

  return processPreview(createServiceClient(), body.code, extractClientIp(req));
}

if (import.meta.main) {
  Deno.serve(handlePreviewFamilyInvite);
}
