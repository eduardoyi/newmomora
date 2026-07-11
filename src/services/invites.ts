// Family-invite data access (docs/plans/family-sharing.md §9). Reads and the
// revoke update ride RLS (`family_invites` policies are manager+ of the
// family); creation goes through the `create_family_invite` definer RPC; the
// redemption/approval state transitions go through Edge Functions so their
// side effects (rate limiting, pushes, membership insert) run server-side.
import { invokeEdgeFunction, type ServiceError } from '@/services/ai';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

export type FamilyInvite = Database['public']['Tables']['family_invites']['Row'];
export type InviteRedeemer = Database['public']['Functions']['get_invite_redeemer']['Returns'][number];
export type RedeemedInviteStatus =
  Database['public']['Functions']['get_my_redeemed_invite_status']['Returns'][number];

export interface RedeemFamilyInviteResponse {
  familyName: string;
  role: string;
}

export interface ResolveFamilyInviteResponse {
  success: true;
  status: 'approved' | 'rejected';
}

function mapSupabaseError(error: { message: string; code?: string }): ServiceError {
  return {
    message: error.message,
    code: error.code,
  };
}

export async function createFamilyInvite(
  familyId: string,
  role: 'manager' | 'viewer',
): Promise<{ data: FamilyInvite | null; error: ServiceError | null }> {
  const { data, error } = await supabase.rpc('create_family_invite', {
    fam: familyId,
    invite_role: role,
  });

  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }

  return { data: data as FamilyInvite, error: null };
}

/**
 * Every invite for the family, newest first. RLS already scopes reads to
 * manager+ members of `familyId`; callers filter by status.
 */
export async function fetchFamilyInvites(
  familyId: string,
): Promise<{ data: FamilyInvite[] | null; error: ServiceError | null }> {
  const { data, error } = await supabase
    .from('family_invites')
    .select('*')
    .eq('family_id', familyId)
    .order('created_at', { ascending: false });

  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }

  return { data: data ?? [], error: null };
}

/**
 * Revoke is a plain RLS update (manager+), constrained to pending invites so
 * it can never yank a redemption already awaiting approval out from under
 * the approvals screen.
 */
export async function revokeFamilyInvite(
  inviteId: string,
): Promise<{ error: ServiceError | null }> {
  const { error } = await supabase
    .from('family_invites')
    .update({ status: 'revoked' })
    .eq('id', inviteId)
    .eq('status', 'pending');

  if (error) {
    return { error: mapSupabaseError(error) };
  }

  return { error: null };
}

/** Redeemer name + email for the approvals screen (definer RPC, manager+ of the invite's family). */
export async function fetchInviteRedeemer(
  inviteId: string,
): Promise<{ data: InviteRedeemer | null; error: ServiceError | null }> {
  const { data, error } = await supabase.rpc('get_invite_redeemer', { invite_id: inviteId });

  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }

  return { data: data?.[0] ?? null, error: null };
}

/** The caller's own most recent redeemed invite, for the waiting screen poll. */
export async function fetchMyRedeemedInviteStatus(): Promise<{
  data: RedeemedInviteStatus | null;
  error: ServiceError | null;
}> {
  const { data, error } = await supabase.rpc('get_my_redeemed_invite_status');

  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }

  return { data: data?.[0] ?? null, error: null };
}

export async function redeemFamilyInvite(code: string): Promise<{
  data: RedeemFamilyInviteResponse | null;
  error: ServiceError | null;
}> {
  return invokeEdgeFunction<RedeemFamilyInviteResponse>('redeem-family-invite', { code });
}

export async function resolveFamilyInvite(
  inviteId: string,
  action: 'approve' | 'reject',
): Promise<{ data: ResolveFamilyInviteResponse | null; error: ServiceError | null }> {
  return invokeEdgeFunction<ResolveFamilyInviteResponse>('resolve-family-invite', {
    inviteId,
    action,
  });
}
