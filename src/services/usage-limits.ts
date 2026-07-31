import { supabase } from '@/lib/supabase';

export interface UsageLimitNotice {
  id: string;
  family_id: string;
  target_kind: 'memory' | 'portrait_version';
  target_id: string;
  scope: 'memory' | 'daily' | 'monthly';
  retry_after: string;
  quota_policy_epoch: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseUsageLimitNotice(value: unknown): UsageLimitNotice | null {
  const quotaPolicyEpoch = isRecord(value) ? value.quota_policy_epoch : null;
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.family_id !== 'string' ||
    (value.target_kind !== 'memory' && value.target_kind !== 'portrait_version') || typeof value.target_id !== 'string' ||
    (value.scope !== 'memory' && value.scope !== 'daily' && value.scope !== 'monthly') ||
    typeof value.retry_after !== 'string' || !Number.isInteger(quotaPolicyEpoch)) return null;
  return {
    id: value.id,
    family_id: value.family_id,
    target_kind: value.target_kind,
    target_id: value.target_id,
    scope: value.scope,
    retry_after: value.retry_after,
    quota_policy_epoch: quotaPolicyEpoch as number,
  };
}

export async function getMyAiUsageLimitNotices(familyId: string): Promise<UsageLimitNotice[]> {
  const { data, error } = await (supabase as any).rpc('get_my_ai_usage_limit_notices');
  if (error) throw error;
  return (Array.isArray(data) ? data : []).map(parseUsageLimitNotice)
    .filter((notice): notice is UsageLimitNotice => notice !== null && notice.family_id === familyId);
}

export function usageLimitMessage(targetKind: UsageLimitNotice['target_kind'], retryAfterIso: string): string {
  const retryAt = new Date(retryAfterIso);
  const retryLabel = Number.isNaN(retryAt.getTime())
    ? 'a little later'
    : retryAt.toLocaleString();
  return targetKind === 'memory'
    ? `Your memory is safely saved. We’ll be ready to make another illustration after ${retryLabel}.`
    : `Your portrait update is safely saved. We’ll be ready to make another illustration after ${retryLabel}.`;
}
