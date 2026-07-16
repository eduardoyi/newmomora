import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { getAuthenticatedUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { getCallerFamilyRole } from '../_shared/family-access.ts';
import { sendExpoPushNotification } from '../_shared/expo-push.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

export type EngagementKind = 'like' | 'comment';

export interface NotifyMemoryEngagementRequest {
  memoryId: string;
  kind: EngagementKind;
  engagementId?: string;
}

export interface NotifyMemoryEngagementResponse {
  sent: boolean;
  reason?: 'self' | 'disabled' | 'debounced' | 'no_recipient';
}

export function validateNotifyMemoryEngagementRequest(body: unknown): string | null {
  if (!body || typeof body !== 'object') return 'Invalid request body';
  const input = body as Partial<NotifyMemoryEngagementRequest>;
  if (typeof input.memoryId !== 'string' || !input.memoryId.trim()) {
    return 'memoryId is required';
  }
  if (input.kind !== 'like' && input.kind !== 'comment') {
    return 'kind must be like or comment';
  }
  if (input.kind === 'comment' && (typeof input.engagementId !== 'string' || !input.engagementId)) {
    return 'engagementId is required for comments';
  }
  return null;
}

const LIKE_DEBOUNCE_MS = 24 * 60 * 60 * 1000;
const LOG_PRUNE_MS = 24 * 60 * 60 * 1000;

interface MemoryRow {
  id: string;
  user_id: string | null;
  family_id: string;
}

export async function processNotifyMemoryEngagement(
  serviceClient: SupabaseClient,
  callerId: string,
  input: NotifyMemoryEngagementRequest,
): Promise<Response> {
  const { data: memoryData, error: memoryError } = await serviceClient
    .from('memories')
    .select('id, user_id, family_id')
    .eq('id', input.memoryId)
    .maybeSingle();

  if (memoryError) {
    console.error('notify-memory-engagement memory lookup failed', memoryError.message);
    return errorResponse('Failed to process the notification', 500, 'internal_error');
  }

  const memory = memoryData as MemoryRow | null;
  if (!memory) return errorResponse('Memory not found', 404, 'not_found');

  const callerRole = await getCallerFamilyRole(serviceClient, memory.family_id, callerId);
  if (!callerRole) return errorResponse('Not authorized', 403, 'forbidden');

  const engagementKey = await verifyEngagement(serviceClient, callerId, input);
  if (!engagementKey) return errorResponse('Engagement not found', 404, 'not_found');

  if (!memory.user_id) {
    return jsonResponse({ sent: false, reason: 'no_recipient' } satisfies NotifyMemoryEngagementResponse);
  }
  if (memory.user_id === callerId) {
    return jsonResponse({ sent: false, reason: 'self' } satisfies NotifyMemoryEngagementResponse);
  }

  const [
    { data: recipientMembership },
    { data: recipientProfile },
    { data: actorProfile },
    { data: family },
    { data: recipientBlock, error: recipientBlockError },
  ] =
    await Promise.all([
      serviceClient
        .from('family_memberships')
        .select('user_id')
        .eq('family_id', memory.family_id)
        .eq('user_id', memory.user_id)
        .maybeSingle(),
      serviceClient
        .from('user_profiles')
        .select('expo_push_token, notify_engagement')
        .eq('id', memory.user_id)
        .maybeSingle(),
      serviceClient.from('user_profiles').select('name').eq('id', callerId).maybeSingle(),
      serviceClient.from('families').select('name').eq('id', memory.family_id).maybeSingle(),
      serviceClient
        .from('blocked_family_accounts')
        .select('id')
        .eq('family_id', memory.family_id)
        .eq('blocker_user_id', memory.user_id)
        .eq('blocked_user_id', callerId)
        .maybeSingle(),
    ]);

  if (!recipientMembership) {
    return jsonResponse({ sent: false, reason: 'no_recipient' } satisfies NotifyMemoryEngagementResponse);
  }

  // Reuse the existing generic disabled result so the actor cannot infer
  // whether the recipient blocked them, disabled notifications, or has no
  // deliverable token. Fail closed on lookup errors.
  if (recipientBlockError || recipientBlock) {
    if (recipientBlockError) {
      console.error('notify-memory-engagement block lookup failed', recipientBlockError.message);
    }
    return jsonResponse({ sent: false, reason: 'disabled' } satisfies NotifyMemoryEngagementResponse);
  }

  const recipient = recipientProfile as {
    expo_push_token: string | null;
    notify_engagement: boolean;
  } | null;
  if (!recipient?.notify_engagement || !recipient.expo_push_token) {
    return jsonResponse({ sent: false, reason: 'disabled' } satisfies NotifyMemoryEngagementResponse);
  }

  const nowMs = Date.now();
  const cutoffIso = new Date(nowMs - LIKE_DEBOUNCE_MS).toISOString();
  const logKind = `engagement_${engagementKey}`;
  const { data: recent, error: recentError } = await serviceClient
    .from('family_activity_log')
    .select('created_at')
    .eq('family_id', memory.family_id)
    .eq('actor_id', callerId)
    .eq('kind', logKind)
    .gte('created_at', cutoffIso)
    .limit(1);

  if (recentError) {
    console.error('notify-memory-engagement debounce lookup failed', recentError.message);
    return errorResponse('Failed to process the notification', 500, 'internal_error');
  }
  if ((recent ?? []).length > 0) {
    return jsonResponse({ sent: false, reason: 'debounced' } satisfies NotifyMemoryEngagementResponse);
  }

  const { error: insertError } = await serviceClient.from('family_activity_log').insert({
    family_id: memory.family_id,
    actor_id: callerId,
    kind: logKind,
  });
  if (insertError) {
    console.error('notify-memory-engagement log insert failed', insertError.message);
    return errorResponse('Failed to process the notification', 500, 'internal_error');
  }

  const pruneCutoffIso = new Date(nowMs - LOG_PRUNE_MS).toISOString();
  const { error: pruneError } = await serviceClient
    .from('family_activity_log')
    .delete()
    .lt('created_at', pruneCutoffIso);
  if (pruneError) {
    console.error('notify-memory-engagement log prune failed', pruneError.message);
  }

  const actorName = (actorProfile?.name as string | undefined) ?? 'Someone';
  const familyName = (family?.name as string | undefined) ?? 'Momora';
  const body = input.kind === 'like'
    ? `${actorName} liked a memory`
    : `${actorName} commented on a memory`;

  try {
    await sendExpoPushNotification(recipient.expo_push_token, familyName, body, {
      route: 'memory',
      familyId: memory.family_id,
      memoryId: memory.id,
    });
  } catch (error) {
    console.error(
      'notify-memory-engagement push failed',
      memory.id,
      error instanceof Error ? error.message : 'unknown',
    );
  }

  return jsonResponse({ sent: true } satisfies NotifyMemoryEngagementResponse);
}

async function verifyEngagement(
  serviceClient: SupabaseClient,
  callerId: string,
  input: NotifyMemoryEngagementRequest,
): Promise<string | null> {
  if (input.kind === 'like') {
    const { data } = await serviceClient
      .from('memory_likes')
      .select('memory_id')
      .eq('memory_id', input.memoryId)
      .eq('user_id', callerId)
      .maybeSingle();
    return data ? `like:${input.memoryId}` : null;
  }

  if (!input.engagementId) return null;
  const { data } = await serviceClient
    .from('memory_comments')
    .select('id')
    .eq('id', input.engagementId)
    .eq('memory_id', input.memoryId)
    .eq('user_id', callerId)
    .maybeSingle();
  return data ? `comment:${input.engagementId}` : null;
}

export async function handleNotifyMemoryEngagement(req: Request): Promise<Response> {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405, 'method_not_allowed');
  }

  const user = await getAuthenticatedUser(req);
  if (!user) return errorResponse('Unauthorized', 401, 'unauthorized');

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }

  const validationError = validateNotifyMemoryEngagementRequest(body);
  if (validationError) return errorResponse(validationError, 400, 'validation_error');

  return processNotifyMemoryEngagement(
    createServiceClient(),
    user.id,
    body as NotifyMemoryEngagementRequest,
  );
}

if (import.meta.main) {
  Deno.serve(handleNotifyMemoryEngagement);
}
