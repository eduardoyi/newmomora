// Family relationships service (docs/features/family-relationships.md):
// AI suggestions (read + resolve), the per-account "this is me" link, and the
// fire-and-forget suggestion request. Writes to family_members for a person's
// role/side still go through updateFamilyMember (src/services/family-members.ts).
import { supabase } from '@/lib/supabase';
import { invokeEdgeFunction } from '@/services/ai';
import type { Database } from '@/types/database';
import { isLinkableMember } from '@/utils/family-relationships';

export type FamilyMemberSuggestion = Database['public']['Tables']['family_member_suggestions']['Row'];

export interface MembershipLink {
  userId: string;
  familyMemberId: string | null;
  notInList: boolean;
}

export interface RelationshipServiceError {
  message: string;
  code?: string;
}

function mapError(error: { message: string; code?: string }): RelationshipServiceError {
  return { message: error.message, code: error.code };
}

export async function fetchPendingSuggestions(familyId: string): Promise<{
  data: FamilyMemberSuggestion[] | null;
  error: RelationshipServiceError | null;
}> {
  const { data, error } = await supabase
    .from('family_member_suggestions')
    .select('*')
    .eq('family_id', familyId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) return { data: null, error: mapError(error) };
  return { data: data ?? [], error: null };
}

/** Every account's link in the family (RLS: any member can read the roster). */
export async function fetchMembershipLinks(familyId: string): Promise<{
  data: MembershipLink[] | null;
  error: RelationshipServiceError | null;
}> {
  const { data, error } = await supabase
    .from('family_memberships')
    .select('user_id, family_member_id, not_in_list')
    .eq('family_id', familyId);
  if (error) return { data: null, error: mapError(error) };
  return {
    data: (data ?? []).map((row) => ({
      userId: row.user_id,
      familyMemberId: row.family_member_id,
      notInList: row.not_in_list,
    })),
    error: null,
  };
}

export async function resolveSuggestions(
  familyId: string,
  accept: string[],
  dismiss: string[],
): Promise<{ error: RelationshipServiceError | null }> {
  if (accept.length === 0 && dismiss.length === 0) return { error: null };
  const { error } = await supabase.rpc('resolve_family_member_suggestions', {
    p_family_id: familyId,
    p_accept: accept,
    p_dismiss: dismiss,
  });
  return { error: error ? mapError(error) : null };
}

/** Link (memberId), unlink (null) or "I'm not in the list" (notInList). */
export async function setMyFamilyMember(
  familyId: string,
  memberId: string | null,
  notInList = false,
): Promise<{ error: RelationshipServiceError | null }> {
  const { error } = await supabase.rpc('set_my_family_member', {
    p_family_id: familyId,
    // The RPC accepts null (unlink / not in list); generated types say string.
    p_member_id: memberId as string,
    p_not_in_list: notInList,
  });
  return { error: error ? mapError(error) : null };
}

export async function unlinkFamilyMemberAccount(
  familyId: string,
  memberId: string,
): Promise<{ error: RelationshipServiceError | null }> {
  const { error } = await supabase.rpc('unlink_family_member_account', {
    p_family_id: familyId,
    p_member_id: memberId,
  });
  return { error: error ? mapError(error) : null };
}

export function isAlreadyLinkedError(error: RelationshipServiceError | null): boolean {
  return Boolean(error && (error.code === '23505' || error.message.includes('member_already_linked')));
}

export type SuggestRelationshipsResult =
  | { skipped: true; reason: string }
  | { skipped: false; suggested: number };

/** Best-effort: the server throttles; failures are ignored by callers. */
export async function requestRelationshipSuggestions(familyId: string): Promise<SuggestRelationshipsResult | null> {
  const { data, error } = await invokeEdgeFunction<SuggestRelationshipsResult>('suggest-family-relationships', {
    familyId,
  });
  return error ? null : data;
}

/**
 * Whether a just-joined account has anyone to pick in "Are you in the
 * family?". Fetched explicitly for the approved family id -- the join flow
 * can't rely on useFamilyMembers, which follows the active family and may
 * still point at the previous one. Errors read as "no" (skip the prompt).
 */
export async function familyHasLinkableMember(familyId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('family_members')
    .select('id, name, relationship, date_of_birth')
    .eq('family_id', familyId);
  if (error || !data) return false;
  return data.some((member) => isLinkableMember(member));
}

/**
 * Whether a just-approved account should be sent to "Are you in the family?".
 * False when the invite already linked them to a person (invite-for-person,
 * docs/plans/invite-for-person.md); otherwise the usual linkable check. A
 * failed links read falls through to that check -- today's behaviour.
 */
export async function shouldOfferWhosWhoAfterJoin(familyId: string, userId: string | null | undefined): Promise<boolean> {
  if (userId) {
    const { data } = await fetchMembershipLinks(familyId);
    if (data?.some((link) => link.userId === userId && link.familyMemberId !== null)) {
      return false;
    }
  }
  return familyHasLinkableMember(familyId);
}
