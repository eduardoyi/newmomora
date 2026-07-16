import { useQuery } from '@tanstack/react-query';

import { familyMemberProfilesQueryKey } from '@/hooks/queryKeys';
import { useAuth } from '@/hooks/use-auth';
import { fetchFamilyMemberProfiles, type FamilyMemberProfile } from '@/services/family';

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
 * Names/roles for every current + former member of a family, used to
 * resolve "Added by {name}" attribution and the Settings member list.
 * Cached per authenticated caller + family via get_family_member_profiles
 * because caller-local blocked-only former rows must never cross accounts.
 * The definer RPC (see
 * supabase/migrations/20260711120000_family_sharing.sql) rather than a
 * direct table read, since `user_profiles` RLS stays "own row only".
 */
export function useFamilyMemberProfiles(familyId: string | null | undefined) {
  const { user } = useAuth();
  const userId = user?.id;
  const query = useQuery({
    queryKey: familyMemberProfilesQueryKey(userId, familyId),
    queryFn: async () => {
      if (!familyId) {
        return [];
      }

      const { data, error } = await fetchFamilyMemberProfiles(familyId);

      if (error) {
        throw toError(error, 'Could not load family members');
      }

      return data ?? [];
    },
    enabled: Boolean(userId && familyId),
    staleTime: 5 * 60 * 1000,
  });

  return {
    profiles: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
  };
}

export function resolveAttributionName(
  profiles: FamilyMemberProfile[],
  userId: string | null | undefined,
): string {
  if (!userId) {
    return 'a former member';
  }

  const profile = profiles.find((candidate) => candidate.user_id === userId);
  return profile?.name ?? 'a former member';
}
