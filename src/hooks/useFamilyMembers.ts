import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { familyMembersQueryKey as buildFamilyMembersQueryKey } from '@/hooks/queryKeys';
import {
  createFamilyMemberWithPhoto,
  deleteFamilyMember,
  fetchFamilyMembers,
  updateFamilyMemberWithPhoto,
  type CreateFamilyMemberWithPhotoInput,
  type FamilyMember,
} from '@/services/family-members';
import { generatePortraitIllustration } from '@/services/ai';

export function useFamilyMembers() {
  const { user } = useAuth();
  const { familyId } = useFamily();
  const queryClient = useQueryClient();
  const previousPortraitStatusRef = useRef<Map<string, string>>(new Map());
  const familyMembersQueryKey = buildFamilyMembersQueryKey(familyId);

  const query = useQuery({
    queryKey: familyMembersQueryKey,
    queryFn: async () => {
      const { data, error } = await fetchFamilyMembers();

      if (error) {
        throw error;
      }

      return data ?? [];
    },
    enabled: Boolean(user) && Boolean(familyId),
    refetchInterval: (queryState) => {
      const members = queryState.state.data ?? [];
      const hasGeneratingPortrait = members.some(
        (member) =>
          member.illustrated_profile_status === 'pending' ||
          member.illustrated_profile_status === 'generating',
      );

      return hasGeneratingPortrait ? 5000 : false;
    },
  });

  const createMutation = useMutation({
    mutationFn: async (input: Omit<CreateFamilyMemberWithPhotoInput, 'userId' | 'familyId'>) => {
      if (!user) {
        throw new Error('You must be signed in to add a family member');
      }
      if (!familyId) {
        throw new Error('You must have a family to add a family member');
      }

      const { data, error } = await createFamilyMemberWithPhoto({
        ...input,
        userId: user.id,
        familyId,
      });

      if (error) {
        throw error;
      }

      return data as FamilyMember;
    },
    onSuccess: (member) => {
      queryClient.invalidateQueries({ queryKey: familyMembersQueryKey });
      if (member?.id) {
        void generatePortraitIllustration(member.id).finally(() => {
          queryClient.invalidateQueries({ queryKey: familyMembersQueryKey });
        });
      }
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (input: {
      memberId: string;
      name?: string;
      dateOfBirth?: string;
      gender?: string | null;
      additionalInfo?: string | null;
      nicknames?: string[];
      photoUri?: string;
      photoContentType?: string;
      regeneratePortrait?: boolean;
    }) => {
      if (!user) {
        throw new Error('You must be signed in to update a family member');
      }
      if (!familyId) {
        throw new Error('You must have a family to update a family member');
      }

      const { data, error } = await updateFamilyMemberWithPhoto({
        memberId: input.memberId,
        userId: user.id,
        familyId,
        name: input.name,
        dateOfBirth: input.dateOfBirth,
        gender: input.gender,
        additionalInfo: input.additionalInfo,
        nicknames: input.nicknames,
        photoUri: input.photoUri,
        photoContentType: input.photoContentType,
        regeneratePortrait: input.regeneratePortrait,
      });

      if (error) {
        throw error;
      }

      const member = data as FamilyMember;

      if (input.photoUri && input.regeneratePortrait && member?.id) {
        void generatePortraitIllustration(member.id).finally(() => {
          queryClient.invalidateQueries({ queryKey: familyMembersQueryKey });
        });
      }

      return member;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: familyMembersQueryKey });
    },
  });

  useEffect(() => {
    const members = query.data ?? [];
    let portraitBecameReady = false;

    for (const member of members) {
      const previousStatus = previousPortraitStatusRef.current.get(member.id);
      previousPortraitStatusRef.current.set(member.id, member.illustrated_profile_status);

      if (
        member.illustrated_profile_status === 'ready' &&
        (previousStatus === 'pending' || previousStatus === 'generating')
      ) {
        portraitBecameReady = true;
      }
    }

    if (!portraitBecameReady) {
      return;
    }

    void query.refetch();
    queryClient.invalidateQueries({ queryKey: ['media-urls'] });
  }, [query.data, query.refetch, queryClient]);

  const deleteMutation = useMutation({
    mutationFn: async (memberId: string) => {
      const { error } = await deleteFamilyMember(memberId);

      if (error) {
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: familyMembersQueryKey });
    },
  });

  return {
    members: query.data ?? [],
    isLoading: query.isLoading,
    isRefetching: query.isRefetching,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    createMember: createMutation.mutateAsync,
    isCreating: createMutation.isPending,
    createError: createMutation.error,
    updateMember: updateMutation.mutateAsync,
    isUpdating: updateMutation.isPending,
    deleteMember: deleteMutation.mutateAsync,
    isDeleting: deleteMutation.isPending,
    hasMembers: (query.data?.length ?? 0) > 0,
  };
}

export function useOnboardingStatus() {
  const { members, isLoading } = useFamilyMembers();

  return {
    isLoading,
    needsFamilyMember: !isLoading && members.length === 0,
    memberCount: members.length,
  };
}
