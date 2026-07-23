import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

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
  getPortraitGenerationRecoveryKey,
  isPortraitGenerationStalled,
  isPortraitGenerationActive,
  shouldPollPortraitVersions,
  shouldRecoverPortraitGeneration,
  type PortraitDateSource,
} from '@/utils/portrait-versions';
import { canEditFamilyContent } from '@/utils/roles';

// Family pages can mount several consumers of this shared query. Scope
// automatic dispatch markers to their QueryClient so one stale portrait
// attempt is recovered only once across all mounted consumers.
const PORTRAIT_RECOVERY_RETRY_COOLDOWN_MS = 30_000;

interface PortraitRecoveryAttempt {
  retryTimer?: ReturnType<typeof setTimeout>;
  state: 'in_flight' | 'succeeded' | 'cooling_down';
}

const portraitRecoveryAttemptsByQueryClient = new WeakMap<
  QueryClient,
  Map<string, PortraitRecoveryAttempt>
>();

function getPortraitRecoveryAttempts(queryClient: QueryClient): Map<string, PortraitRecoveryAttempt> {
  const existing = portraitRecoveryAttemptsByQueryClient.get(queryClient);
  if (existing) return existing;

  const attempts = new Map<string, PortraitRecoveryAttempt>();
  portraitRecoveryAttemptsByQueryClient.set(queryClient, attempts);
  return attempts;
}

function schedulePortraitRecoveryRetry(
  queryClient: QueryClient,
  attemptKey: string,
  attempt: PortraitRecoveryAttempt,
): void {
  attempt.state = 'cooling_down';
  const retryTimer = setTimeout(() => {
    const attempts = getPortraitRecoveryAttempts(queryClient);
    // A newer marker must never be cleared by an earlier failed request.
    if (attempts.get(attemptKey) !== attempt) return;

    attempts.delete(attemptKey);
    invalidatePortraitConsumers(queryClient);
  }, PORTRAIT_RECOVERY_RETRY_COOLDOWN_MS);
  attempt.retryTimer = retryTimer;

  // Node's Jest process must not be kept alive by a retry backoff. React
  // Native timers do not expose this method, so feature-detect it.
  (retryTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
}

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
  const { familyId, role } = useFamily();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: portraitVersionsQueryKey(familyId),
    queryFn: async () => {
      if (!familyId) return [];
      const { data, error } = await fetchFamilyPortraitVersions(familyId);
      if (error) throw toError(error, 'Could not load portrait timeline');
      return data ?? [];
    },
    enabled: Boolean(user && familyId),
    staleTime: 5 * 60 * 1000,
    // The app provider wires React Native foreground events into TanStack
    // Query focus. Always reconcile this small family-batched query there so
    // a backgrounded app can recover a never-dispatched pending version.
    refetchOnWindowFocus: 'always',
    refetchInterval: (queryState) => {
      return shouldPollPortraitVersions(queryState.state.data ?? []) ? 3000 : false;
    },
  });

  useEffect(() => {
    if (!user || !familyId || !canEditFamilyContent(role) || !query.data) {
      return;
    }

    const attemptedRecoveryKeys = getPortraitRecoveryAttempts(queryClient);
    const recoverableVersions = query.data.filter((version) => shouldRecoverPortraitGeneration(version));

    for (const version of recoverableVersions) {
      const recoveryKey = getPortraitGenerationRecoveryKey(version);
      if (!recoveryKey) continue;

      const attemptKey = `${user.id}:${familyId}:${recoveryKey}`;
      if (attemptedRecoveryKeys.has(attemptKey)) continue;
      const recoveryAttempt: PortraitRecoveryAttempt = { state: 'in_flight' };
      attemptedRecoveryKeys.set(attemptKey, recoveryAttempt);

      // This is a server request only. The client never resets a status,
      // claim token, or timestamp; the dispatcher decides whether to reclaim
      // or supersede the attempt.
      void generatePortraitVersion(version.id)
        .then(({ error }) => {
          if (error) {
            schedulePortraitRecoveryRetry(queryClient, attemptKey, recoveryAttempt);
            return;
          }
          recoveryAttempt.state = 'succeeded';
        })
        .catch(() => {
          schedulePortraitRecoveryRetry(queryClient, attemptKey, recoveryAttempt);
        })
        .finally(() => {
          invalidatePortraitConsumers(queryClient);
        });
    }
  }, [familyId, query.data, query.dataUpdatedAt, queryClient, role, user]);

  return query;
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

  const regenerateVersion = (portraitVersionId: string): Promise<void> => {
    const version = versions.find((candidate) => candidate.id === portraitVersionId);
    if (version && isPortraitGenerationActive(version) && !isPortraitGenerationStalled(version)) {
      // The action control is disabled as well. Keep this guard at the hook
      // boundary so a stale UI event cannot create a duplicate paid job.
      return Promise.resolve();
    }
    return generationMutation.mutateAsync(portraitVersionId);
  };

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
    regenerateVersion,
    deleteVersion: deleteMutation.mutateAsync,
    isCreating: createMutation.isPending,
    editingVersionId: editMutation.isPending ? editMutation.variables?.portraitVersionId ?? null : null,
    retryingVersionId: generationMutation.isPending ? generationMutation.variables ?? null : null,
    regeneratingVersionId: generationMutation.isPending ? generationMutation.variables ?? null : null,
    deletingVersionId: deleteMutation.isPending ? deleteMutation.variables ?? null : null,
  };
}

export type { CreatePortraitVersionInput };
