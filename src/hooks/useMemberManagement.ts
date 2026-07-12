import { useMutation, useQueryClient } from '@tanstack/react-query';

import { familyMemberProfilesQueryKey } from '@/hooks/queryKeys';
import { familyMembershipsQueryKey } from '@/hooks/use-family';
import {
  removeMember,
  updateMemberRole,
  type FamilyMemberProfile,
  type MemberManagedRole,
} from '@/services/family';

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
 * Thrown when a role-change/removal mutation's `.select()` comes back with
 * zero rows -- RLS allowed the request but there was nothing left to match,
 * because someone else already changed or removed that membership. The
 * caller should refresh the list rather than show a scary error (docs/
 * features/family-sharing.md, member-management edge cases).
 */
export class MemberChangedElsewhereError extends Error {
  constructor() {
    super('Looks like something changed — the list has been refreshed.');
    this.name = 'MemberChangedElsewhereError';
  }
}

interface ChangeRoleInput {
  userId: string;
  role: MemberManagedRole;
}

/**
 * Promote/demote/remove mutations for the Settings member list (docs/
 * features/family-sharing.md, roles & permission semantics table). Applies
 * optimistically to the `get_family_member_profiles` cache and rolls back on
 * failure; `family_memberships` RLS is the real enforcement -- these
 * mutations just surface its outcome.
 */
export function useMemberManagement(familyId: string | null | undefined) {
  const queryClient = useQueryClient();
  const profilesKey = familyMemberProfilesQueryKey(familyId);

  const changeRoleMutation = useMutation({
    mutationFn: async ({ userId, role }: ChangeRoleInput) => {
      if (!familyId) {
        throw new Error('You must have a family to manage members');
      }

      const { data, error } = await updateMemberRole(familyId, userId, role);

      if (error) {
        throw toError(error, 'Could not update role');
      }

      if (!data || data.length === 0) {
        throw new MemberChangedElsewhereError();
      }

      return { userId, role };
    },
    onMutate: async ({ userId, role }: ChangeRoleInput) => {
      await queryClient.cancelQueries({ queryKey: profilesKey });
      const previousProfiles = queryClient.getQueryData<FamilyMemberProfile[]>(profilesKey);

      if (previousProfiles) {
        queryClient.setQueryData<FamilyMemberProfile[]>(
          profilesKey,
          previousProfiles.map((profile) =>
            profile.user_id === userId ? { ...profile, role } : profile,
          ),
        );
      }

      return { previousProfiles };
    },
    onError: (_error, _variables, context) => {
      if (context?.previousProfiles) {
        queryClient.setQueryData(profilesKey, context.previousProfiles);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: profilesKey });
      queryClient.invalidateQueries({ queryKey: familyMembershipsQueryKey });
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: async (userId: string) => {
      if (!familyId) {
        throw new Error('You must have a family to manage members');
      }

      const { data, error } = await removeMember(familyId, userId);

      if (error) {
        throw toError(error, 'Could not remove member');
      }

      if (!data || data.length === 0) {
        throw new MemberChangedElsewhereError();
      }

      return userId;
    },
    onMutate: async (userId: string) => {
      await queryClient.cancelQueries({ queryKey: profilesKey });
      const previousProfiles = queryClient.getQueryData<FamilyMemberProfile[]>(profilesKey);

      if (previousProfiles) {
        // Mirror the server's shape for a removed member rather than
        // dropping the row outright -- get_family_member_profiles keeps a
        // former member visible (role null, is_active_member false) when
        // they still show up as a creator elsewhere, and the UI already
        // renders that state as "Former member".
        queryClient.setQueryData<FamilyMemberProfile[]>(
          profilesKey,
          previousProfiles.map((profile) =>
            profile.user_id === userId
              ? { ...profile, role: null, is_active_member: false }
              : profile,
          ),
        );
      }

      return { previousProfiles };
    },
    onError: (_error, _variables, context) => {
      if (context?.previousProfiles) {
        queryClient.setQueryData(profilesKey, context.previousProfiles);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: profilesKey });
      queryClient.invalidateQueries({ queryKey: familyMembershipsQueryKey });
    },
  });

  return {
    changeRole: changeRoleMutation.mutateAsync,
    isChangingRole: changeRoleMutation.isPending,
    removeMember: removeMemberMutation.mutateAsync,
    isRemovingMember: removeMemberMutation.isPending,
  };
}
