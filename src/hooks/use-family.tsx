import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';

import { useAuth } from '@/hooks/use-auth';
import { useUserProfile } from '@/hooks/useUserProfile';
import {
  calendarMemoriesQueryKeyBase,
  familyMemberProfilesQueryKeyBase,
  familyMembersQueryKeyBase,
  memoriesQueryKeyBase,
} from '@/hooks/queryKeys';
import { useMemoriesRealtime } from '@/hooks/useMemoriesRealtime';
import { fetchMyFamilyMemberships } from '@/services/family';

export interface FamilyMembershipSummary {
  id: string;
  familyId: string;
  role: string;
  name: string;
}

interface FamilyContextValue {
  family: { id: string; name: string } | null;
  familyId: string | null;
  role: string | null;
  memberships: FamilyMembershipSummary[];
  isLoading: boolean;
  setActiveFamily: (familyId: string) => Promise<void>;
  /** Re-fetches the caller's membership list (e.g. after create_family or redeeming an invite). */
  refetchMemberships: () => Promise<unknown>;
  /**
   * True once the user has had at least one family membership this session
   * and now has none -- distinguishes "just got removed" from "brand new
   * user who never had a family" so the no-family screen can show the right
   * copy.
   */
  justLostAccess: boolean;
}

export const familyMembershipsQueryKey = ['family-memberships'] as const;

const FamilyContext = createContext<FamilyContextValue | null>(null);

export function FamilyProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { profile, updateProfile, isLoading: isProfileLoading } = useUserProfile();
  const hadFamilyRef = useRef(false);
  const correctingRef = useRef(false);

  const membershipsQuery = useQuery({
    queryKey: [...familyMembershipsQueryKey, user?.id],
    queryFn: async () => {
      if (!user) {
        return [];
      }

      const { data, error } = await fetchMyFamilyMemberships(user.id);

      if (error) {
        throw new Error(error.message);
      }

      const memberships: FamilyMembershipSummary[] = [];
      for (const row of data ?? []) {
        if (!row.family) {
          // RLS-invisible (e.g. soft-deleted family, non-owner) -- skip rather
          // than surface a membership row with no family to show.
          continue;
        }
        memberships.push({
          id: row.id,
          familyId: row.family_id,
          role: row.role,
          name: row.family.name,
        });
      }
      return memberships;
    },
    enabled: Boolean(user),
  });

  const memberships = membershipsQuery.data ?? [];
  const isMembershipsLoading = Boolean(user) && membershipsQuery.isLoading;
  const isLoading = isMembershipsLoading || (Boolean(user) && isProfileLoading);

  const activeFamilyId = profile?.active_family_id ?? null;

  const resolvedMembership = useMemo(() => {
    if (memberships.length === 0) {
      return null;
    }

    const match = activeFamilyId
      ? memberships.find((membership) => membership.familyId === activeFamilyId)
      : undefined;

    return match ?? memberships[0];
  }, [memberships, activeFamilyId]);

  // Workstream D2 (docs/plans/performance-optimizations.md): mounted once
  // here (family-provider level, so it's active for the whole authenticated
  // session the same way useNotificationResponseRouting is mounted at the
  // (app) layout level) rather than per-screen -- FamilyProvider already
  // computes the resolved active familyId reactively, so a family switch
  // naturally resubscribes the channel via this hook's own effect deps.
  useMemoriesRealtime(resolvedMembership?.familyId ?? null);

  // Stale/removed active_family_id: fall back to the first membership and
  // persist the correction so future loads don't need to re-derive it.
  useEffect(() => {
    if (!user || isLoading || !resolvedMembership || correctingRef.current) {
      return;
    }

    if (activeFamilyId === resolvedMembership.familyId) {
      return;
    }

    correctingRef.current = true;
    void updateProfile({ activeFamilyId: resolvedMembership.familyId })
      .catch(() => {
        // Best-effort correction -- if it fails, the same fallback logic
        // just re-derives resolvedMembership on next render.
      })
      .finally(() => {
        correctingRef.current = false;
      });
  }, [user, isLoading, resolvedMembership, activeFamilyId, updateProfile]);

  useEffect(() => {
    if (memberships.length > 0) {
      hadFamilyRef.current = true;
    }
  }, [memberships.length]);

  const justLostAccess = hadFamilyRef.current && !isMembershipsLoading && memberships.length === 0;

  const setActiveFamily = useCallback(
    async (familyId: string) => {
      await updateProfile({ activeFamilyId: familyId });
      queryClient.invalidateQueries({ queryKey: [memoriesQueryKeyBase] });
      queryClient.invalidateQueries({ queryKey: [calendarMemoriesQueryKeyBase] });
      queryClient.invalidateQueries({ queryKey: [familyMembersQueryKeyBase] });
      queryClient.invalidateQueries({ queryKey: [familyMemberProfilesQueryKeyBase] });
    },
    [updateProfile, queryClient],
  );

  const refetchMemberships = useCallback(async () => {
    return membershipsQuery.refetch();
  }, [membershipsQuery]);

  const value = useMemo<FamilyContextValue>(
    () => ({
      family: resolvedMembership
        ? { id: resolvedMembership.familyId, name: resolvedMembership.name }
        : null,
      familyId: resolvedMembership?.familyId ?? null,
      role: resolvedMembership?.role ?? null,
      memberships,
      isLoading,
      setActiveFamily,
      refetchMemberships,
      justLostAccess,
    }),
    [resolvedMembership, memberships, isLoading, setActiveFamily, refetchMemberships, justLostAccess],
  );

  return <FamilyContext.Provider value={value}>{children}</FamilyContext.Provider>;
}

export function useFamily(): FamilyContextValue {
  const context = useContext(FamilyContext);

  if (!context) {
    throw new Error('useFamily must be used within FamilyProvider');
  }

  return context;
}
