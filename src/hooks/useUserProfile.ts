import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { cancelAccountDeletion, deleteUserAccount } from '@/services/ai';
import { fetchUserProfile, updateUserProfile, type UpdateUserProfileInput } from '@/services/user-profile';

export const userProfileQueryKey = ['user-profile'] as const;

export function useUserProfile() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: userProfileQueryKey,
    queryFn: async () => {
      const { data, error } = await fetchUserProfile();

      if (error) {
        throw error;
      }

      return data;
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (input: UpdateUserProfileInput) => {
      const { data, error } = await updateUserProfile(input);

      if (error) {
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: userProfileQueryKey });
    },
  });

  const deleteAccountMutation = useMutation({
    mutationFn: async () => {
      const { error } = await deleteUserAccount();

      if (error) {
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: userProfileQueryKey });
    },
  });

  const cancelDeletionMutation = useMutation({
    mutationFn: async () => {
      const { error } = await cancelAccountDeletion();

      if (error) {
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: userProfileQueryKey });
    },
  });

  return {
    profile: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    updateProfile: updateMutation.mutateAsync,
    isUpdating: updateMutation.isPending,
    deleteAccount: deleteAccountMutation.mutateAsync,
    isDeletingAccount: deleteAccountMutation.isPending,
    cancelAccountDeletion: cancelDeletionMutation.mutateAsync,
    isCancelingDeletion: cancelDeletionMutation.isPending,
  };
}
