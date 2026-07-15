import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import {
  familyMembersQueryKeyBase,
  memoriesQueryKeyBase,
  portraitVersionsQueryKey,
  portraitVersionsQueryKeyBase,
} from '@/hooks/queryKeys';
import {
  createPortraitVersion,
  deletePortraitVersion,
  fetchFamilyPortraitVersions,
  generatePortraitVersion,
  updatePortraitVersionDate,
  type CreatePortraitVersionInput,
} from '@/services/portrait-versions';
import {
  isPortraitGenerationStalled,
  type PortraitDateSource,
} from '@/utils/portrait-versions';

function toError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return new Error(error.message);
  }
  return new Error(fallback);
}

function invalidatePortraitConsumers(queryClient: ReturnType<typeof useQueryClient>): void {
  queryClient.invalidateQueries({ queryKey: [portraitVersionsQueryKeyBase] });
  queryClient.invalidateQueries({ queryKey: [familyMembersQueryKeyBase] });
  queryClient.invalidateQueries({ queryKey: [memoriesQueryKeyBase] });
}

export function useFamilyPortraitVersions() {
  const { user } = useAuth();
  const { familyId } = useFamily();

  return useQuery({
    queryKey: portraitVersionsQueryKey(familyId),
    queryFn: async () => {
      if (!familyId) return [];
      const { data, error } = await fetchFamilyPortraitVersions(familyId);
      if (error) throw toError(error, 'Could not load portrait timeline');
      return data ?? [];
    },
    enabled: Boolean(user && familyId),
    staleTime: 5 * 60 * 1000,
    refetchInterval: (queryState) => {
      const hasActiveWork = (queryState.state.data ?? []).some(
        (version) =>
          (!isPortraitGenerationStalled(version) && (
            version.illustrated_profile_status === 'pending' ||
            version.illustrated_profile_status === 'generating' ||
            Boolean(version.generation_token)
          )) ||
          Boolean(version.deletion_token),
      );
      return hasActiveWork ? 3000 : false;
    },
  });
}

export interface CreatePortraitVersionMutationInput {
  photoUri: string;
  photoContentType: string;
  referenceDate: string;
  dateSource: Exclude<PortraitDateSource, 'legacy_unknown'>;
  dateOfBirth?: string | null;
}

export function usePortraitVersions(familyMemberId: string) {
  const { user } = useAuth();
  const { familyId } = useFamily();
  const queryClient = useQueryClient();
  const query = useFamilyPortraitVersions();
  const versions = useMemo(
    () =>
      (query.data ?? [])
        .filter((version) => version.family_member_id === familyMemberId)
        .sort(
          (a, b) =>
            (b.reference_date ?? '').localeCompare(a.reference_date ?? '') ||
            b.created_at.localeCompare(a.created_at) ||
            b.id.localeCompare(a.id),
        ),
    [query.data, familyMemberId],
  );

  const createMutation = useMutation({
    mutationFn: async (input: CreatePortraitVersionMutationInput) => {
      if (!user || !familyId) throw new Error('You must be signed in to add a portrait');
      const { data, error } = await createPortraitVersion({
        ...input,
        userId: user.id,
        familyId,
        familyMemberId,
      });
      if (error || !data) throw toError(error, 'Could not add portrait');
      return data;
    },
    onSuccess: (version) => {
      invalidatePortraitConsumers(queryClient);
      void generatePortraitVersion(version.id).finally(() => invalidatePortraitConsumers(queryClient));
    },
  });

  const editMutation = useMutation({
    mutationFn: async (input: { portraitVersionId: string; referenceDate: string; dateOfBirth?: string | null }) => {
      const { data, error } = await updatePortraitVersionDate(
        input.portraitVersionId,
        input.referenceDate,
        { dateOfBirth: input.dateOfBirth },
      );
      if (error || !data) throw toError(error, 'Could not update portrait date');
      return data;
    },
    onSuccess: () => invalidatePortraitConsumers(queryClient),
  });

  const generationMutation = useMutation({
    mutationFn: async (portraitVersionId: string) => {
      const { error } = await generatePortraitVersion(portraitVersionId);
      if (error) throw toError(error, 'Could not generate portrait');
    },
    onSettled: () => invalidatePortraitConsumers(queryClient),
  });

  const deleteMutation = useMutation({
    mutationFn: async (portraitVersionId: string) => {
      const { error } = await deletePortraitVersion(portraitVersionId);
      if (error) throw toError(error, 'Could not delete portrait');
    },
    onSettled: () => invalidatePortraitConsumers(queryClient),
  });

  return {
    versions,
    isLoading: query.isLoading,
    isRefetching: query.isRefetching,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    createVersion: createMutation.mutateAsync,
    editVersionDate: editMutation.mutateAsync,
    retryVersion: generationMutation.mutateAsync,
    regenerateVersion: generationMutation.mutateAsync,
    deleteVersion: deleteMutation.mutateAsync,
    isCreating: createMutation.isPending,
    editingVersionId: editMutation.isPending ? editMutation.variables?.portraitVersionId ?? null : null,
    retryingVersionId: generationMutation.isPending ? generationMutation.variables ?? null : null,
    regeneratingVersionId: generationMutation.isPending ? generationMutation.variables ?? null : null,
    deletingVersionId: deleteMutation.isPending ? deleteMutation.variables ?? null : null,
  };
}

export type { CreatePortraitVersionInput };
