import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

export const REPORT_TARGET_TYPES = [
  'memory',
  'memory_illustration',
  'comment',
  'household_member',
  'family_member_profile',
  'family_member_portrait',
] as const;

export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

export const REPORT_REASONS = [
  'unsafe_or_sexual',
  'harassment_or_abuse',
  'privacy',
  'misleading_ai_depiction',
  'other',
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];
export type BlockedFamilyAccount = Database['public']['Tables']['blocked_family_accounts']['Row'];

export interface ContentReport {
  id: string;
  family_id: string;
  target_type: ReportTargetType;
  target_id: string;
  target_version_id: string | null;
  status: 'open' | 'reviewing';
  created_at: string;
}

export interface ServiceError {
  message: string;
  code?: string;
}

function mapError(error: { message: string; code?: string }): ServiceError {
  if (error.message.includes('already reported')) {
    return { message: 'You already reported this item.', code: 'already_reported' };
  }
  if (error.message.includes('Report limit reached')) {
    return { message: 'You’ve reached the report limit. Please try again later.', code: 'rate_limited' };
  }
  if (error.message.includes('unavailable')) {
    return { message: 'This item is no longer available.', code: 'target_unavailable' };
  }
  return { message: error.message, code: error.code };
}

export async function fetchMyContentReports(familyId: string): Promise<{
  data: ContentReport[] | null;
  error: ServiceError | null;
}> {
  const { data, error } = await supabase.rpc('get_my_open_content_reports', {
    p_family_id: familyId,
  });

  return error
    ? { data: null, error: mapError(error) }
    : { data: (data ?? []) as ContentReport[], error: null };
}

export async function createContentReport(input: {
  targetType: ReportTargetType;
  targetId: string;
  /** Selected generation; the RPC rejects it if it is no longer current. */
  targetVersionId?: string | null;
  reason: ReportReason;
  note?: string;
}): Promise<{ data: string | null; error: ServiceError | null }> {
  const { data, error } = await supabase.rpc('create_content_report', {
    p_target_type: input.targetType,
    p_target_id: input.targetId,
    p_reason: input.reason,
    p_note: input.note?.trim() || undefined,
    p_target_version_id: input.targetVersionId ?? undefined,
  });

  return error
    ? { data: null, error: mapError(error) }
    : { data, error: null };
}

export async function fetchMyBlockedFamilyAccounts(familyId: string): Promise<{
  data: BlockedFamilyAccount[] | null;
  error: ServiceError | null;
}> {
  const { data, error } = await supabase
    .from('blocked_family_accounts')
    .select('*')
    .eq('family_id', familyId)
    .order('created_at', { ascending: false });

  return error
    ? { data: null, error: mapError(error) }
    : { data: data ?? [], error: null };
}

export async function setFamilyAccountBlocked(input:
  | { shouldBlock: true; membershipId: string }
  | { shouldBlock: false; blockId: string }
): Promise<{ data: BlockedFamilyAccount | null; error: ServiceError | null }> {
  const { data, error } = await supabase.rpc('set_family_account_block', {
    p_should_block: input.shouldBlock,
    p_membership_id: input.shouldBlock ? input.membershipId : undefined,
    p_block_id: input.shouldBlock ? undefined : input.blockId,
  });

  return error
    ? { data: null, error: mapError(error) }
    : { data, error: null };
}
