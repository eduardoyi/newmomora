import { onlineManager, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import { AppState } from 'react-native';

import { useAuth } from '@/hooks/use-auth';
import { useContentSafety } from '@/hooks/useContentSafety';
import { useFamily } from '@/hooks/use-family';
import { useFamilyPortraitVersions } from '@/hooks/usePortraitVersions';
import { lookingBackQueryKey } from '@/hooks/queryKeys';
import {
  enqueuePendingLookingBackView,
  fetchLookingBackPackages,
  flushPendingLookingBackViews,
  getPendingLookingBackViews,
  markLookingBackPackageViewed,
  mergeLookingBackPendingViews,
  type LookingBackPackage,
  type LookingBackPackageMetadata,
  type LookingBackPackageSet,
} from '@/services/looking-back';
import { fetchMemoriesByIds, type MemoryWithTags } from '@/services/memories';
import type { FamilyMember } from '@/services/family-members';
import { resolveMemoryTagPortraits } from '@/utils/portrait-versions';

export type LookingBackTaggedMember = FamilyMember & {
  /** Profile/portrait reports must never leak a name in the viewer footer. */
  isLookingBackHidden?: boolean;
};

export interface LookingBackMemory extends Omit<MemoryWithTags, 'taggedMembers'> {
  taggedMembers: LookingBackTaggedMember[];
  /** A report hides only an AI illustration; the written memory remains. */
  isIllustrationHidden: boolean;
}

export interface LookingBackPackageWithMemories extends Omit<LookingBackPackage, 'memories'> {
  memories: LookingBackMemory[];
}

interface LookingBackRawData {
  dailySetId: string | null;
  packageDate: string | null;
  refreshAfter: string | null;
  packages: LookingBackPackageWithMemories[];
}

export interface UseLookingBackPackagesOptions {
  enabled?: boolean;
}

function assemblePackages(
  packageSet: LookingBackPackageSet,
  memories: readonly MemoryWithTags[],
): LookingBackPackageWithMemories[] {
  const memoriesById = new Map(memories.map((memory) => [memory.id, memory]));

  return packageSet.packages.map((item: LookingBackPackageMetadata) => ({
    ...item,
    memories: item.memoryIds.flatMap((memoryId) => {
      const memory = memoriesById.get(memoryId);
      return memory ? [{ ...memory, isIllustrationHidden: false }] : [];
    }),
  }));
}

function attachPendingViews(
  rawData: LookingBackRawData,
  pendingViews: Awaited<ReturnType<typeof getPendingLookingBackViews>>,
): LookingBackRawData {
  return {
    ...rawData,
    packages: mergeLookingBackPendingViews(rawData.packages, pendingViews),
  };
}

/**
 * Loads one immutable server-materialized daily set. Optional-package failures
 * resolve to an empty successful value so the Timeline can continue without a
 * rail. Content-safety selection happens below useQuery, never inside the
 * query function where hooks would be invalid.
 */
export function useLookingBackPackages(options: UseLookingBackPackagesOptions = {}) {
  const { enabled = true } = options;
  const { user } = useAuth();
  const { familyId } = useFamily();
  const {
    isError: isContentSafetyError,
    isLoading: isContentSafetyLoading,
    isTargetReported,
    isUserBlocked,
  } = useContentSafety();
  const portraitVersionsQuery = useFamilyPortraitVersions();
  const queryClient = useQueryClient();
  const queryKey = lookingBackQueryKey(user?.id, familyId);
  const canLoad = Boolean(enabled && user?.id && familyId);

  const query = useQuery({
    queryKey,
    enabled: canLoad,
    // The active set is immutable until refresh_after. Refetching a whole
    // Timeline merely because NetInfo rose is wasteful; the explicit effects
    // below only reconcile when the server-defined boundary has passed.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async (): Promise<LookingBackRawData> => {
      if (!user?.id || !familyId) {
        return { dailySetId: null, packageDate: null, refreshAfter: null, packages: [] };
      }

      const result = await fetchLookingBackPackages(familyId);
      if (!result.data) {
        // Availability AND authorization failures collapse to no optional
        // rail. The normal family/timeline queries retain their own errors.
        return { dailySetId: null, packageDate: null, refreshAfter: null, packages: [] };
      }

      const orderedIds = result.data.packages.flatMap((item) => item.memoryIds);
      const memoriesResult = await fetchMemoriesByIds(familyId, orderedIds);
      if (memoriesResult.error || !memoriesResult.data) {
        return {
          dailySetId: result.data.dailySetId,
          packageDate: result.data.packageDate,
          refreshAfter: result.data.refreshAfter,
          packages: [],
        };
      }

      const rawData: LookingBackRawData = {
        dailySetId: result.data.dailySetId,
        packageDate: result.data.packageDate,
        refreshAfter: result.data.refreshAfter,
        packages: assemblePackages(result.data, memoriesResult.data),
      };
      let pendingViews: Awaited<ReturnType<typeof getPendingLookingBackViews>> = [];
      try {
        pendingViews = await getPendingLookingBackViews(user.id, familyId);
      } catch {
        // A device-storage failure should behave like an empty outbox; the
        // optional rail still renders from the server materialization.
      }
      const merged = attachPendingViews(rawData, pendingViews);

      // The outbox survives an interrupted request. Do not await its network
      // flush: merged local state is the source of truth for this render.
      void flushPendingLookingBackViews(user.id, familyId).catch(() => {});
      return merged;
    },
  });

  // A viewer may finish a package after one live memory is deleted. Keep the
  // safety-filtered set separate from the rail threshold so it can skip the
  // missing frame without abruptly losing a still-safe three-memory package.
  const viewerPackages = useMemo(() => {
    const rawPackages = query.data?.packages ?? [];
    if (isContentSafetyLoading || isContentSafetyError) {
      // Avoid exposing a package before report/block state is known. Unlike a
      // Timeline error this is an optional rail, so absence is the safe UI.
      return [] as LookingBackPackageWithMemories[];
    }

    return rawPackages
      .map((item) => {
        const portraitResolvedMemories = portraitVersionsQuery.data === undefined
          ? item.memories
          : resolveMemoryTagPortraits(item.memories, portraitVersionsQuery.data);
        const visibleMemories = portraitResolvedMemories.flatMap((memory) => {
          if (
            isUserBlocked(memory.user_id) ||
            isTargetReported('memory', memory.id)
          ) {
            return [];
          }

          const taggedMembers = memory.taggedMembers.map((member) => ({
            ...member,
            isLookingBackHidden: isTargetReported('family_member_profile', member.id)
              || isTargetReported('family_member_portrait', member.resolvedPortraitVersion?.id),
          }));
          return [{
            ...memory,
            taggedMembers,
            isIllustrationHidden: isTargetReported(
              'memory_illustration',
              memory.id,
              memory.illustration_generation_id,
            ),
          }];
        });

        // `packages` below applies the Timeline's four-memory threshold;
        // this collection intentionally does not.
        const subject = item.subjectFamilyMemberId
          ? visibleMemories.flatMap((memory) => memory.taggedMembers).find((member) => member.id === item.subjectFamilyMemberId)
          : null;
        const subjectHidden = Boolean(item.subjectFamilyMemberId && (
          isTargetReported('family_member_profile', item.subjectFamilyMemberId)
          || isTargetReported('family_member_portrait', subject?.resolvedPortraitVersion?.id)
        ));
        return {
          ...item,
          // `member_at_age` titles are generated with the subject name. A
          // later report must not keep that stale string visible in an open
          // snapshot or the rail.
          title: subjectHidden && item.packageType === 'member_at_age' ? 'A family memory' : item.title,
          memories: visibleMemories as LookingBackMemory[],
        };
      });
  }, [isContentSafetyError, isContentSafetyLoading, isTargetReported, isUserBlocked, portraitVersionsQuery.data, query.data?.packages]);

  const packages = useMemo(
    () => viewerPackages.filter((item) => item.memories.length >= 4),
    [viewerPackages],
  );

  const markPackageViewed = useCallback(async (packageId: string) => {
    if (!user?.id || !familyId) return;
    let pending: Awaited<ReturnType<typeof enqueuePendingLookingBackView>>;
    try {
      pending = await enqueuePendingLookingBackView(user.id, familyId, packageId);
    } catch {
      // The storage outbox is the durable path, but a full/unavailable local
      // store must not turn a real viewing action into a permanent no-op.
      pending = {
        packageId,
        firstViewedAt: new Date().toISOString(),
        lastViewedAt: new Date().toISOString(),
        completedAt: null,
      };
      void markLookingBackPackageViewed(packageId).catch(() => {});
    }

    queryClient.setQueryData<LookingBackRawData>(queryKey, (current) => current
      ? attachPendingViews(current, [pending])
      : current,
    );
    void flushPendingLookingBackViews(user.id, familyId).catch(() => {});
  }, [familyId, queryClient, queryKey, user?.id]);

  const markPackageCompleted = useCallback(async (packageId: string) => {
    if (!user?.id || !familyId) return;
    let pending: Awaited<ReturnType<typeof enqueuePendingLookingBackView>>;
    try {
      pending = await enqueuePendingLookingBackView(user.id, familyId, packageId, { completed: true });
    } catch {
      const occurredAt = new Date().toISOString();
      pending = { packageId, firstViewedAt: occurredAt, lastViewedAt: occurredAt, completedAt: occurredAt };
      void markLookingBackPackageViewed(packageId, true).catch(() => {});
    }

    queryClient.setQueryData<LookingBackRawData>(queryKey, (current) => current
      ? attachPendingViews(current, [pending])
      : current,
    );
    void flushPendingLookingBackViews(user.id, familyId).catch(() => {});
  }, [familyId, queryClient, queryKey, user?.id]);

  const refreshAfter = query.data?.refreshAfter;
  const refetchLookingBack = query.refetch;

  const refetchIfDailySetExpired = useCallback(() => {
    if (!refreshAfter || Number.isNaN(Date.parse(refreshAfter)) || Date.parse(refreshAfter) > Date.now()) {
      return;
    }
    void refetchLookingBack();
  }, [refreshAfter, refetchLookingBack]);

  const reconcileLookingBack = useCallback(() => {
    // The server returns the same immutable daily set, while rehydrating its
    // live memory rows catches an edit/delete that occurred while offline.
    void refetchLookingBack();
  }, [refetchLookingBack]);

  useEffect(() => {
    if (!refreshAfter) return;
    const delay = Date.parse(refreshAfter) - Date.now();
    if (Number.isNaN(delay)) return;

    const timer = setTimeout(refetchIfDailySetExpired, Math.max(0, delay + 1));
    return () => clearTimeout(timer);
  }, [refreshAfter, refetchIfDailySetExpired]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      reconcileLookingBack();
      if (user?.id && familyId) void flushPendingLookingBackViews(user.id, familyId).catch(() => {});
    });
    return () => subscription.remove();
  }, [familyId, reconcileLookingBack, user?.id]);

  useEffect(() => {
    let wasOnline = onlineManager.isOnline();
    const unsubscribe = onlineManager.subscribe(() => {
      const isOnline = onlineManager.isOnline();
      if (!wasOnline && isOnline) {
        reconcileLookingBack();
        if (user?.id && familyId) void flushPendingLookingBackViews(user.id, familyId).catch(() => {});
      }
      wasOnline = isOnline;
    });
    return unsubscribe;
  }, [familyId, reconcileLookingBack, user?.id]);

  return {
    ...query,
    packages,
    viewerPackages,
    dailySetId: query.data?.dailySetId ?? null,
    packageDate: query.data?.packageDate ?? null,
    refreshAfter: query.data?.refreshAfter ?? null,
    // Package retrieval is intentionally fail-quiet. Its service query is a
    // successful empty result on any optional failure, so callers don't need
    // an error state that competes with the Timeline.
    isLookingBackAvailable: !isContentSafetyLoading && !isContentSafetyError,
    markPackageViewed,
    markPackageCompleted,
  };
}
