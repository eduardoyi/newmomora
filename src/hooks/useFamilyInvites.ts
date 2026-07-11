import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { familyInvitesQueryKey } from '@/hooks/queryKeys';
import { fetchFamilyInvites, revokeFamilyInvite, type FamilyInvite } from '@/services/invites';

function toError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) {
    return error;
  }

  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return new Error(error.message);
  }

  return new Error(fallbackMessage);
}

/**
 * Invites for a family (manager+ only -- RLS returns nothing for viewers, so
 * callers gate `enabled` on role to avoid a pointless request). Exposes the
 * pending/redeemed slices the sharing screens and the Settings approvals
 * badge care about.
 */
export function useFamilyInvites(
  familyId: string | null | undefined,
  options?: { enabled?: boolean },
) {
  const queryClient = useQueryClient();
  const queryKey = familyInvitesQueryKey(familyId);

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      if (!familyId) {
        return [];
      }

      const { data, error } = await fetchFamilyInvites(familyId);

      if (error) {
        throw toError(error, 'Could not load invites');
      }

      return data ?? [];
    },
    enabled: Boolean(familyId) && (options?.enabled ?? true),
  });

  const invites: FamilyInvite[] = query.data ?? [];

  const revokeMutation = useMutation({
    mutationFn: async (inviteId: string) => {
      const { error } = await revokeFamilyInvite(inviteId);

      if (error) {
        throw toError(error, 'Could not revoke the invite');
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  return {
    invites,
    pendingInvites: invites.filter((invite) => invite.status === 'pending'),
    redeemedInvites: invites.filter((invite) => invite.status === 'redeemed'),
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    revokeInvite: revokeMutation.mutateAsync,
    isRevoking: revokeMutation.isPending,
  };
}
