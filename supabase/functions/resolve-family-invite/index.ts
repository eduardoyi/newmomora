// Approves or rejects a redeemed family invite (docs/plans/family-sharing.md
// §9). Caller must be owner/manager of the invite's family. Approve inserts
// the membership (the DB's 50-cap trigger enforces the member limit), ALWAYS
// points the redeemer's active_family_id at this family, marks the invite
// approved, and pushes to the redeemer. Reject just marks the invite.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { getAuthenticatedUser } from '../_shared/auth.ts';
import { sendTransactionalEmail } from '../_shared/bento.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { getCallerFamilyRole, isManagerRole } from '../_shared/family-access.ts';
import { sendExpoPushNotification } from '../_shared/expo-push.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

export interface ResolveFamilyInviteRequest {
  inviteId: string;
  action: 'approve' | 'reject';
}

export interface ResolveFamilyInviteResponse {
  success: true;
  status: 'approved' | 'rejected';
}

interface InviteRow {
  id: string;
  family_id: string;
  role: string;
  status: string;
  redeemed_by: string | null;
}

function buildApprovalEmailHtml(familyName: string): string {
  return `
    <p>You're in!</p>
    <p>Welcome to <strong>${familyName}</strong> on Momora. Open the app to see the timeline and start adding your own memories.</p>
    <p>-- The Momora team</p>
  `.trim();
}

export async function processResolution(
  serviceClient: SupabaseClient,
  callerId: string,
  inviteId: string,
  action: 'approve' | 'reject',
): Promise<Response> {
  const { data: inviteData, error: inviteError } = await serviceClient
    .from('family_invites')
    .select('id, family_id, role, status, redeemed_by')
    .eq('id', inviteId)
    .maybeSingle();

  if (inviteError) {
    console.error('resolve-family-invite invite lookup failed', inviteError.message);
    return errorResponse('Failed to resolve the invite', 500, 'internal_error');
  }

  const invite = inviteData as InviteRow | null;

  if (!invite) {
    return errorResponse('Invite not found', 404, 'not_found');
  }

  // Role check is bound to THIS invite's family (mirrors get_invite_redeemer:
  // "manager anywhere" would let a Family A manager resolve Family B invites).
  const callerRole = await getCallerFamilyRole(serviceClient, invite.family_id, callerId);

  if (!isManagerRole(callerRole)) {
    return errorResponse('Not authorized', 403, 'forbidden');
  }

  if (invite.status !== 'redeemed') {
    return errorResponse('This invite is not awaiting approval', 409, 'invalid_status');
  }

  const nowIso = new Date().toISOString();

  if (action === 'reject') {
    const { error: rejectError } = await serviceClient
      .from('family_invites')
      .update({ status: 'rejected', resolved_by: callerId, resolved_at: nowIso })
      .eq('id', inviteId)
      .eq('status', 'redeemed');

    if (rejectError) {
      console.error('resolve-family-invite reject failed', rejectError.message);
      return errorResponse('Failed to resolve the invite', 500, 'internal_error');
    }

    const response: ResolveFamilyInviteResponse = { success: true, status: 'rejected' };
    return jsonResponse(response);
  }

  // approve
  if (!invite.redeemed_by) {
    // Redeemer's account was hard-deleted (FK on delete set null) -- nothing
    // to approve into the family.
    return errorResponse('This invite can no longer be approved', 409, 'invalid_status');
  }

  const { error: membershipError } = await serviceClient.from('family_memberships').insert({
    family_id: invite.family_id,
    user_id: invite.redeemed_by,
    role: invite.role,
  });

  if (membershipError) {
    // 23505 (unique violation): the redeemer is already a member -- e.g. an
    // earlier approval attempt failed after this insert, or they joined via
    // another invite. Idempotently continue so the invite still resolves.
    if (membershipError.code === 'P0001') {
      // The DB's 50-member cap trigger.
      return errorResponse('This family already has the maximum of 50 members.', 409, 'family_full');
    }

    if (membershipError.code !== '23505') {
      console.error('resolve-family-invite membership insert failed', membershipError.message);
      return errorResponse('Failed to resolve the invite', 500, 'internal_error');
    }
  }

  // ALWAYS set the redeemer's active family to this one -- redeeming an
  // invite is the strongest possible signal of intent (plan §9); an "only if
  // null" update would leave an existing multi-family user staring at their
  // old family's timeline after approval. Failing here fails the request:
  // the invite is still 'redeemed', so the approver can retry (the
  // membership insert above is idempotent via the 23505 branch).
  const { error: profileError } = await serviceClient
    .from('user_profiles')
    .update({ active_family_id: invite.family_id })
    .eq('id', invite.redeemed_by);

  if (profileError) {
    console.error('resolve-family-invite active-family update failed', profileError.message);
    return errorResponse('Failed to resolve the invite', 500, 'internal_error');
  }

  const { error: approveError } = await serviceClient
    .from('family_invites')
    .update({ status: 'approved', resolved_by: callerId, resolved_at: nowIso })
    .eq('id', inviteId)
    .eq('status', 'redeemed');

  if (approveError) {
    console.error('resolve-family-invite approve failed', approveError.message);
    return errorResponse('Failed to resolve the invite', 500, 'internal_error');
  }

  // Push + email to the redeemer are both best-effort -- neither may throw
  // past this point, the invite is already committed as approved.
  let familyName = 'the family';
  try {
    const { data: family } = await serviceClient
      .from('families')
      .select('name')
      .eq('id', invite.family_id)
      .maybeSingle();
    familyName = (family?.name as string | undefined) ?? familyName;
  } catch (familyLookupError) {
    console.error(
      'resolve-family-invite family-name lookup failed',
      familyLookupError instanceof Error ? familyLookupError.message : 'unknown',
    );
  }

  try {
    const { data: redeemerProfile } = await serviceClient
      .from('user_profiles')
      .select('expo_push_token')
      .eq('id', invite.redeemed_by)
      .maybeSingle();

    const pushToken = redeemerProfile?.expo_push_token as string | null | undefined;

    if (pushToken) {
      await sendExpoPushNotification(
        pushToken,
        'Momora',
        `You're in! Welcome to ${familyName} — open Momora to start exploring.`,
        { route: 'timeline', familyId: invite.family_id },
      );
    }
  } catch (pushError) {
    console.error(
      'resolve-family-invite redeemer push failed',
      pushError instanceof Error ? pushError.message : 'unknown',
    );
  }

  // "You're in!" welcome email via Bento (best-effort, same failure
  // convention as the push above). The redeemer's email lives on
  // auth.users, not user_profiles, so it's fetched via the service-role
  // admin API.
  try {
    const { data: redeemerAuth } = await serviceClient.auth.admin.getUserById(invite.redeemed_by);
    const redeemerEmail = redeemerAuth?.user?.email;

    if (redeemerEmail) {
      await sendTransactionalEmail({
        to: redeemerEmail,
        subject: `You're in! Welcome to ${familyName}`,
        htmlBody: buildApprovalEmailHtml(familyName),
      });
    }
  } catch (emailError) {
    console.error(
      'resolve-family-invite redeemer email failed',
      emailError instanceof Error ? emailError.message : 'unknown',
    );
  }

  const response: ResolveFamilyInviteResponse = { success: true, status: 'approved' };
  return jsonResponse(response);
}

export async function handleResolveFamilyInvite(req: Request): Promise<Response> {
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

  let body: ResolveFamilyInviteRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }

  if (typeof body.inviteId !== 'string' || !body.inviteId.trim()) {
    return errorResponse('inviteId is required', 400, 'validation_error');
  }

  if (body.action !== 'approve' && body.action !== 'reject') {
    return errorResponse("action must be 'approve' or 'reject'", 400, 'validation_error');
  }

  return processResolution(createServiceClient(), user.id, body.inviteId, body.action);
}

if (import.meta.main) {
  Deno.serve(handleResolveFamilyInvite);
}
