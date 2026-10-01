import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import {
  familyMembersQueryKeyBase,
  familyMembershipLinksQueryKey,
  familyMembershipLinksQueryKeyBase,
  familySuggestionsQueryKey,
  familySuggestionsQueryKeyBase,
} from '@/hooks/queryKeys';
import {
  fetchMembershipLinks,
  fetchPendingSuggestions,
  linkFamilyMemberAccount,
  requestRelationshipSuggestions,
  resolveSuggestions,
  setMyFamilyMember,
  unlinkFamilyMemberAccount,
  type FamilyMemberSuggestion,
  type MembershipLink,
} from '@/services/family-relationships';
import type { FamilyMember } from '@/services/family-members';
import { sideKeyOf } from '@/utils/family-relationships';
import { canEditFamilyContent } from '@/utils/roles';

/**
 * A pending suggestion is only worth showing while it still applies: a
 * relationship/side suggestion whose `based_on` no longer matches the
 * member's current value was overtaken by a manual edit (the resolve RPC
 * would dismiss it anyway), and a nickname already on the member is moot.
 */
export function isSuggestionCurrent(suggestion: FamilyMemberSuggestion, member: FamilyMember | undefined): boolean {
  if (!member) return false;
  switch (suggestion.field) {
    case 'relationship':
      return (suggestion.based_on ?? null) === (member.relationship ?? null);
    case 'family_side':
      return (suggestion.based_on ?? null) === sideKeyOf(member);
    case 'nickname':
      return !(member.nicknames ?? []).some((n) => n.trim().toLowerCase() === suggestion.value.trim().toLowerCase());
    default:
      return false;
  }
}

const EMPTY_LINKS: MembershipLink[] = [];

export function useFamilyRelationships(members: FamilyMember[]) {
  const { user } = useAuth();
  const { familyId, role } = useFamily();
  const queryClient = useQueryClient();
  const canEdit = canEditFamilyContent(role);
  const requestedRef = useRef<string | null>(null);

  const suggestionsQuery = useQuery({
    queryKey: familySuggestionsQueryKey(familyId),
    queryFn: async () => {
      if (!familyId) return [];
      const { data, error } = await fetchPendingSuggestions(familyId);
      if (error) throw error;
      return data ?? [];
    },
    enabled: Boolean(user) && Boolean(familyId) && canEdit,
  });

  const linksQuery = useQuery({
    queryKey: familyMembershipLinksQueryKey(familyId),
    queryFn: async () => {
      if (!familyId) return [];
      const { data, error } = await fetchMembershipLinks(familyId);
      if (error) throw error;
      return data ?? [];
    },
    enabled: Boolean(user) && Boolean(familyId),
  });

  const membersById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const suggestions = useMemo(
    () => (suggestionsQuery.data ?? []).filter((s) => isSuggestionCurrent(s, membersById.get(s.family_member_id))),
    [suggestionsQuery.data, membersById],
  );

  const myLink = useMemo(
    () => (linksQuery.data ?? []).find((link) => link.userId === user?.id) ?? null,
    [linksQuery.data, user?.id],
  );

  /** Member ids claimed by another account in this family. */
  const claimedByOthers = useMemo(
    () => new Set(
      (linksQuery.data ?? [])
        .filter((link) => link.userId !== user?.id && link.familyMemberId)
        .map((link) => link.familyMemberId as string),
    ),
    [linksQuery.data, user?.id],
  );

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: [familySuggestionsQueryKeyBase] });
    void queryClient.invalidateQueries({ queryKey: [familyMembershipLinksQueryKeyBase] });
    void queryClient.invalidateQueries({ queryKey: [familyMembersQueryKeyBase] });
  }, [queryClient]);

  const resolveMutation = useMutation({
    mutationFn: async (input: { accept: string[]; dismiss: string[] }) => {
      if (!familyId) throw new Error('No active family');
      const { error } = await resolveSuggestions(familyId, input.accept, input.dismiss);
      if (error) throw error;
    },
    onSettled: invalidate,
  });

  const linkMutation = useMutation({
    mutationFn: async (input: { memberId: string | null; notInList?: boolean }) => {
      if (!familyId) throw new Error('No active family');
      const { error } = await setMyFamilyMember(familyId, input.memberId, input.notInList ?? false);
      if (error) throw error;
    },
    onSettled: invalidate,
  });

  const unlinkMutation = useMutation({
    mutationFn: async (memberId: string) => {
      if (!familyId) throw new Error('No active family');
      const { error } = await unlinkFamilyMemberAccount(familyId, memberId);
      if (error) throw error;
    },
    onSettled: invalidate,
  });

  // Owner/manager links another account to a person (manager-account-linking).
  const linkAccountMutation = useMutation({
    mutationFn: async (input: { userId: string; memberId: string }) => {
      if (!familyId) throw new Error('No active family');
      const { error } = await linkFamilyMemberAccount(familyId, input.userId, input.memberId);
      if (error) throw error;
    },
    onSettled: invalidate,
  });

  /** Fire-and-forget, at most once per family per mount; the server throttles. */
  const requestSuggestions = useCallback(() => {
    if (!familyId || !canEdit || requestedRef.current === familyId) return;
    requestedRef.current = familyId;
    void requestRelationshipSuggestions(familyId).then((result) => {
      if (result && !result.skipped && result.suggested > 0) {
        void queryClient.invalidateQueries({ queryKey: familySuggestionsQueryKey(familyId) });
      }
    });
  }, [familyId, canEdit, queryClient]);

  return {
    canEdit,
    suggestions,
    isLoadingSuggestions: suggestionsQuery.isLoading,
    myLink,
    myMemberId: myLink?.familyMemberId ?? null,
    claimedByOthers,
    /** Every account's link in the family (for `isInviteTargetEligible`). */
    links: linksQuery.data ?? EMPTY_LINKS,
    refetchLinks: linksQuery.refetch,
    isLoadingLinks: linksQuery.isLoading,
    resolve: resolveMutation.mutateAsync,
    isResolving: resolveMutation.isPending,
    linkMe: linkMutation.mutateAsync,
    isLinking: linkMutation.isPending,
    unlinkAccount: unlinkMutation.mutateAsync,
    linkAccount: linkAccountMutation.mutateAsync,
    isLinkingAccount: linkAccountMutation.isPending,
    requestSuggestions,
  };
}
