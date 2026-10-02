// Family relationships service (docs/features/family-relationships.md):
// AI suggestions (read + resolve), the per-account "this is me" link, and the
// fire-and-forget suggestion request. Writes to family_members for a person's
// role/side still go through updateFamilyMember (src/services/family-members.ts).
import { supabase } from '@/lib/supabase';
import { invokeEdgeFunction } from '@/services/ai';
import { createFamilyMember } from '@/services/family-members';
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

/**
 * Owner/manager links an already-joined account to a person ("this is me",
 * set for them). Replaces the account's previous link; never steals a person
 * held by another account (`member_already_linked`). Not billing-gated.
 */
export async function linkFamilyMemberAccount(
  familyId: string,
  userId: string,
  memberId: string,
): Promise<{ error: RelationshipServiceError | null }> {
  const { error } = await supabase.rpc('link_family_member_account', {
    p_family_id: familyId,
    p_user_id: userId,
    p_member_id: memberId,
  });
  return { error: error ? mapError(error) : null };
}

/**
 * Gives a new owner their own person in the family -- a "parent" named from
 * their account (S12A's "Your name") -- and links it as "this is me", so
 * voice memories know who "I" is and the Family tab shows them under Parents
 * with a "You" badge (2026-10-02). Onboarding only ever created the kids.
 * Runs after access (S16): family_members inserts are billing-gated. A no-op
 * when the account is already linked or chose "I'm not in the list", or
 * there's no name to use; every failure is swallowed into `skipped` -- this
 * must never block onboarding. Reads the signed-in account and its profile
 * name itself, so the caller only passes the family.
 */
export async function ensureOwnerFamilyPerson(
  familyId: string,
): Promise<{ memberId: string | null; skipped: string | null }> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || user.is_anonymous) return { memberId: null, skipped: 'no_user' };
  const userId = user.id;

  const { data: profile } = await supabase.from('user_profiles').select('name').eq('id', userId).maybeSingle();
  const trimmed = profile?.name?.trim() ?? '';
  if (!trimmed) return { memberId: null, skipped: 'no_name' };

  const links = await fetchMembershipLinks(familyId);
  if (links.error || !links.data) return { memberId: null, skipped: 'links_unavailable' };
  const own = links.data.find((link) => link.userId === userId);
  if (!own) return { memberId: null, skipped: 'not_a_member' };
  if (own.familyMemberId || own.notInList) return { memberId: null, skipped: 'already_set' };

  const created = await createFamilyMember({
    userId,
    familyId,
    name: trimmed,
    dateOfBirth: null,
    relationship: 'parent',
  });
  if (created.error || !created.data) return { memberId: null, skipped: 'create_failed' };

  const linked = await setMyFamilyMember(familyId, created.data.id);
  if (linked.error) return { memberId: created.data.id, skipped: 'link_failed' };
  return { memberId: created.data.id, skipped: null };
}

export function isAlreadyLinkedError(error: RelationshipServiceError | null): boolean {
  return Boolean(error && (error.code === '23505' || error.message.includes('member_already_linked')));
}

/** The list changed under the manager: the person/account is gone or no longer linkable. */
export function isLinkRejectedError(error: RelationshipServiceError | null): boolean {
  return Boolean(
    error && ['member_not_linkable', 'member_not_in_family', 'account_not_in_family'].some((token) => error.message.includes(token)),
  );
}

/** Alert copy for a failed manager link (docs/plans/manager-account-linking.md §4.4). */
export function linkAccountErrorAlert(error: unknown): { title: string; message: string } {
  const serviceError = error as RelationshipServiceError | null;
  if (isAlreadyLinkedError(serviceError)) {
    return {
      title: 'Already taken',
      message: 'Someone else already says this is them. Unlink them on that person’s page first.',
    };
  }
  if (isLinkRejectedError(serviceError)) {
    return { title: 'Could not link', message: 'That didn’t work. The list has been refreshed.' };
  }
  return { title: 'Could not link', message: 'Please try again.' };
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
