import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { errorResponse } from './errors.ts';

interface BillingAiCheckRow {
  allowed: boolean;
  scope: 'daily' | 'monthly' | null;
  retry_after_iso: string | null;
  error_code: string | null;
}

interface BillingRpcClient {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: unknown }>;
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}

function firstRow(value: unknown): BillingAiCheckRow | null {
  const row = Array.isArray(value) ? value[0] : value;
  return row && typeof row === 'object' ? (row as BillingAiCheckRow) : null;
}

export async function checkBillingAiGeneration(
  serviceClient: SupabaseClient,
  input: {
    familyId: string;
    actorUserId: string;
    targetKind: 'memory' | 'portrait_version';
    targetId: string;
    requestIntent: string;
  },
): Promise<Response | null> {
  const { data, error } = await serviceClient.rpc('billing_ai_generation_check', {
    p_family_id: input.familyId,
    p_actor_user_id: input.actorUserId,
    p_target_kind: input.targetKind,
    p_target_id: input.targetId,
    p_request_intent: input.requestIntent,
  });

  if (error) {
    console.error('billing AI check failed', error.code ?? 'unknown');
    return errorResponse('Could not verify subscription access', 500, 'billing_check_failed');
  }

  const result = firstRow(data);
  if (!result || result.allowed) return null;

  if (result.error_code === 'SUBSCRIPTION_REQUIRED') {
    return errorResponse('An active Momora subscription is required for AI generation', 403, 'SUBSCRIPTION_REQUIRED');
  }

  const retryAfter = result.retry_after_iso ? Date.parse(result.retry_after_iso) : Number.NaN;
  const retrySeconds = Number.isFinite(retryAfter)
    ? Math.max(1, Math.ceil((retryAfter - Date.now()) / 1000))
    : 1;
  return new Response(JSON.stringify({
    error: 'AI generation limit reached',
    code: 'OWNER_AI_LIMIT_REACHED',
    scope: result.scope,
    retryAfterIso: result.retry_after_iso,
  }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(retrySeconds),
    },
  });
}

export async function checkBillingFamilyWrite(
  serviceClient: BillingRpcClient,
  familyId: string,
  actorUserId: string,
  operation: string,
): Promise<Response | null> {
  const { error } = await serviceClient.rpc('assert_billing_write_access', {
    p_family_id: familyId,
    p_actor_user_id: actorUserId,
    p_operation: operation,
  });
  if (!error) return null;
  if (errorCode(error) === 'P0001') {
    return errorResponse('An active Momora subscription is required for this action', 403, 'SUBSCRIPTION_REQUIRED');
  }
  console.error('billing family write check failed', errorCode(error) ?? 'unknown');
  return errorResponse('Could not verify subscription access', 500, 'billing_check_failed');
}

export async function checkBillingMediaUpload(
  serviceClient: SupabaseClient,
  input: { familyId: string; actorUserId: string; memoryId: string },
): Promise<Response | null> {
  const { data: memory, error: memoryError } = await serviceClient
    .from('memories')
    .select('user_id, family_id, onboarding_media_pending, onboarding_media_pending_until')
    .eq('id', input.memoryId)
    .eq('family_id', input.familyId)
    .maybeSingle();

  if (memoryError) {
    console.error('billing media row check failed', memoryError.code ?? 'unknown');
    return errorResponse('Could not verify subscription access', 500, 'billing_check_failed');
  }

  if (
    memory?.onboarding_media_pending &&
    memory.user_id === input.actorUserId &&
    (!memory.onboarding_media_pending_until || Date.parse(memory.onboarding_media_pending_until) > Date.now())
  ) return null;
  return checkBillingFamilyWrite(serviceClient, input.familyId, input.actorUserId, 'media_upload');
}
