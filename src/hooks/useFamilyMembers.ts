import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

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
import { generatePortraitVersion } from '@/services/portrait-versions';
import { useFamilyPortraitVersions } from '@/hooks/usePortraitVersions';
import {
  getLocalTodayIso,
  groupPortraitVersionsByMember,
  resolveMemberPortraitFields,
  type PortraitDateSource,
} from '@/utils/portrait-versions';

export function useFamilyMembers() {
  const { user } = useAuth();
  const { familyId } = useFamily();
  const queryClient = useQueryClient();
  const portraitVersionsQuery = useFamilyPortraitVersions();
  const familyMembersQueryKey = buildFamilyMembersQueryKey(familyId);

  const startPortraitGeneration = (portraitVersionId: string) => {
    void (async () => {
      try {
        await generatePortraitVersion(portraitVersionId);
      } catch {
        // Server-owned attempt state is polled; a client timeout must not
        // overwrite an attempt that may still complete successfully.
      } finally {
        queryClient.invalidateQueries({ queryKey: familyMembersQueryKey });
        queryClient.invalidateQueries({ queryKey: ['portrait-versions'] });
      }
    })();
  };

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
  });

  const members = useMemo(() => {
    // During the expand/cutover window, keep legacy avatar fields visible
    // until the portrait-version query has actually resolved.
    if (portraitVersionsQuery.data === undefined) {
      return query.data ?? [];
    }
    const portraitMap = groupPortraitVersionsByMember(portraitVersionsQuery.data ?? []);
    const today = getLocalTodayIso();
    return (query.data ?? []).map((member) => {
      const versions = portraitMap.get(member.id) ?? [];
      return versions.length === 0
        ? member
        : { ...member, ...resolveMemberPortraitFields(versions, today, member.updated_at) };
    });
  }, [query.data, portraitVersionsQuery.data]);

  const createMutation = useMutation({
    mutationFn: async (input: Omit<CreateFamilyMemberWithPhotoInput, 'userId' | 'familyId'>) => {
      if (!user) {
        throw new Error('You must be signed in to add a family member');
      }
      if (!familyId) {
        throw new Error('You must have a family to add a family member');
      }

      const { data, portraitVersion, error } = await createFamilyMemberWithPhoto({
        ...input,
        userId: user.id,
        familyId,
      });

      if (error) {
        throw error;
      }

      return { member: data as FamilyMember, portraitVersion };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: familyMembersQueryKey });
      queryClient.invalidateQueries({ queryKey: ['portrait-versions'] });
      if (result.portraitVersion?.id) {
        startPortraitGeneration(result.portraitVersion.id);
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
      photoReferenceDate?: string;
      photoDateSource?: Exclude<PortraitDateSource, 'legacy_unknown'>;
      /** Deprecated compatibility input; a new photo always creates a version. */
      regeneratePortrait?: boolean;
    }) => {
      if (!user) {
        throw new Error('You must be signed in to update a family member');
      }
      if (!familyId) {
        throw new Error('You must have a family to update a family member');
      }

      const { data, portraitVersion, error } = await updateFamilyMemberWithPhoto({
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
        photoReferenceDate: input.photoReferenceDate,
        photoDateSource: input.photoDateSource,
      });

      if (error) {
        throw error;
      }

      if (portraitVersion?.id) {
        startPortraitGeneration(portraitVersion.id);
      }

      return data as FamilyMember;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: familyMembersQueryKey });
      queryClient.invalidateQueries({ queryKey: ['portrait-versions'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (memberId: string) => {
      const { error } = await deleteFamilyMember(memberId);

      if (error) {
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: familyMembersQueryKey });
      queryClient.invalidateQueries({ queryKey: ['portrait-versions'] });
      queryClient.invalidateQueries({ queryKey: ['memories'] });
      queryClient.invalidateQueries({ queryKey: ['media-urls'] });
    },
  });

  return {
    members,
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
    hasMembers: members.length > 0,
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
