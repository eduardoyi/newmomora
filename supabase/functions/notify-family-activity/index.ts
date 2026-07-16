// Announces the caller's own new memory to the rest of their family
// (docs/plans/family-sharing.md §10). Fire-and-forget from the client after
// a successful memory create -- failures here must never surface to the
// memory-creation UX, so every step past authorization is best-effort.
//
// Flow: load the memory -> assert the CALLER is both its creator and
// manager+ of its family (this function only ever announces the caller's
// OWN memory, never someone else's) -> debounce on (family_id, actor_id)
// within the last 15 minutes -> log + prune -> push to every other member
// with notify_new_memories=true and a push token.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { getAuthenticatedUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { getCallerFamilyRole, isManagerRole } from '../_shared/family-access.ts';
import { sendExpoPushNotification } from '../_shared/expo-push.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

export interface NotifyFamilyActivityRequest {
  memoryId: string;
}

export interface NotifyFamilyActivityResponse {
  sent: boolean;
  reason?: 'debounced';
}

const DEBOUNCE_WINDOW_MS = 15 * 60 * 1000;
const PRUNE_AGE_MS = 24 * 60 * 60 * 1000;
const ACTIVITY_KIND = 'new_memory';

interface MemoryRow {
  id: string;
  user_id: string | null;
  family_id: string;
}

export async function processNotifyFamilyActivity(
  serviceClient: SupabaseClient,
  callerId: string,
  memoryId: string,
): Promise<Response> {
  const { data: memoryData, error: memoryError } = await serviceClient
    .from('memories')
    .select('id, user_id, family_id')
    .eq('id', memoryId)
    .maybeSingle();

  if (memoryError) {
    console.error('notify-family-activity memory lookup failed', memoryError.message);
    return errorResponse('Failed to process the notification', 500, 'internal_error');
  }

  const memory = memoryData as MemoryRow | null;

  if (!memory) {
    return errorResponse('Memory not found', 404, 'not_found');
  }

  // This function only ever announces the caller's OWN new memory -- never
  // someone else's, even if the caller is a manager who could otherwise
  // edit it.
  if (memory.user_id !== callerId) {
    return errorResponse('Not authorized', 403, 'forbidden');
  }

  const role = await getCallerFamilyRole(serviceClient, memory.family_id, callerId);
  if (!isManagerRole(role)) {
    return errorResponse('Not authorized', 403, 'forbidden');
  }

  const nowMs = Date.now();
  const debounceCutoffIso = new Date(nowMs - DEBOUNCE_WINDOW_MS).toISOString();

  const { data: recentActivity, error: recentActivityError } = await serviceClient
    .from('family_activity_log')
    .select('created_at')
    .eq('family_id', memory.family_id)
    .eq('actor_id', callerId)
    .eq('kind', ACTIVITY_KIND)
    .gte('created_at', debounceCutoffIso)
    .limit(1);

  if (recentActivityError) {
    console.error('notify-family-activity debounce lookup failed', recentActivityError.message);
    return errorResponse('Failed to process the notification', 500, 'internal_error');
  }

  if ((recentActivity ?? []).length > 0) {
    const response: NotifyFamilyActivityResponse = { sent: false, reason: 'debounced' };
    return jsonResponse(response);
  }

  // Log BEFORE sending -- fail closed, mirroring redeem-family-invite's
  // attempt-logging order, so a write failure can't silently defeat the
  // debounce and spam the family on retries.
  const { error: insertError } = await serviceClient.from('family_activity_log').insert({
    family_id: memory.family_id,
    actor_id: callerId,
    kind: ACTIVITY_KIND,
  });

  if (insertError) {
    console.error('notify-family-activity log insert failed', insertError.message);
    return errorResponse('Failed to process the notification', 500, 'internal_error');
  }

  // Opportunistically prune log rows older than 24h (best-effort).
  const pruneCutoffIso = new Date(nowMs - PRUNE_AGE_MS).toISOString();
  const { error: pruneError } = await serviceClient
    .from('family_activity_log')
    .delete()
    .lt('created_at', pruneCutoffIso);

  if (pruneError) {
    console.error('notify-family-activity log prune failed', pruneError.message);
  }

  await sendActivityPushes(serviceClient, memory, callerId);

  // Never expose recipient counts: in a two-person family that would reveal
  // whether the other account blocked the actor.
  const response: NotifyFamilyActivityResponse = { sent: true };
  return jsonResponse(response);
}

async function sendActivityPushes(
  serviceClient: SupabaseClient,
  memory: MemoryRow,
  actorId: string,
): Promise<number> {
  try {
    const [
      { data: family },
      { data: actorProfile },
      { data: memberships },
      { data: blockedRecipients, error: blockedRecipientsError },
    ] = await Promise.all([
      serviceClient.from('families').select('name').eq('id', memory.family_id).maybeSingle(),
      serviceClient.from('user_profiles').select('name').eq('id', actorId).maybeSingle(),
      serviceClient
        .from('family_memberships')
        .select('user_id')
        .eq('family_id', memory.family_id)
        .neq('user_id', actorId),
      serviceClient
        .from('blocked_family_accounts')
        .select('blocker_user_id')
        .eq('family_id', memory.family_id)
        .eq('blocked_user_id', actorId),
    ]);

    // Fail closed: a block lookup failure must never deliver an alert the
    // recipient asked not to receive. The caller receives no delivery count
    // or other block-dependent signal.
    if (blockedRecipientsError) {
      console.error('notify-family-activity block lookup failed', blockedRecipientsError.message);
      return 0;
    }

    const blockedRecipientIds = new Set(
      ((blockedRecipients ?? []) as Array<{ blocker_user_id: string }>).map((row) => row.blocker_user_id),
    );

    const recipientIds = ((memberships ?? []) as Array<{ user_id: string }>)
      .map((m) => m.user_id)
      .filter((userId) => !blockedRecipientIds.has(userId));

    if (recipientIds.length === 0) {
      return 0;
    }

    const { data: profiles, error: profilesError } = await serviceClient
      .from('user_profiles')
      .select('id, expo_push_token, notify_new_memories')
      .in('id', recipientIds);

    if (profilesError) {
      console.error('notify-family-activity recipient lookup failed', profilesError.message);
      return 0;
    }

    const eligible = ((profiles ?? []) as Array<{
      id: string;
      expo_push_token: string | null;
      notify_new_memories: boolean;
    }>).filter((profile) => profile.notify_new_memories && Boolean(profile.expo_push_token));

    if (eligible.length === 0) {
      return 0;
    }

    const familyName = (family?.name as string | undefined) ?? 'Momora';
    const actorName = (actorProfile?.name as string | undefined) ?? 'Someone';
    const body = `${actorName} added a new memory`;

    const results = await Promise.allSettled(
      eligible.map((profile) =>
        sendExpoPushNotification(profile.expo_push_token as string, familyName, body, {
          route: 'memory',
          familyId: memory.family_id,
          memoryId: memory.id,
        }),
      ),
    );

    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        console.error(
          'notify-family-activity push failed',
          eligible[index].id,
          result.reason instanceof Error ? result.reason.message : 'unknown',
        );
      }
    }

    return eligible.length;
  } catch (error) {
    // Push failures are logged, never fatal -- the memory is already
    // created and the activity already logged by this point.
    console.error(
      'notify-family-activity push pipeline failed',
      error instanceof Error ? error.message : 'unknown',
    );
    return 0;
  }
}

export async function handleNotifyFamilyActivity(req: Request): Promise<Response> {
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

  let body: NotifyFamilyActivityRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }

  if (typeof body.memoryId !== 'string' || !body.memoryId.trim()) {
    return errorResponse('memoryId is required', 400, 'validation_error');
  }

  return processNotifyFamilyActivity(createServiceClient(), user.id, body.memoryId);
}

if (import.meta.main) {
  Deno.serve(handleNotifyFamilyActivity);
}
