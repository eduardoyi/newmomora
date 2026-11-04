import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { useFamily } from '@/hooks/use-family';
import { useAuth } from '@/hooks/use-auth';
import {
  blockedFamilyAccountsQueryKeyBase,
  contentReportsQueryKeyBase,
  keepsakesOverviewQueryKeyBase,
} from '@/hooks/queryKeys';
import { clearMemoryWidgetForScope } from '@/hooks/useMemoryWidgetSync';
import {
  createContentReport,
  fetchMyBlockedFamilyAccounts,
  fetchMyContentReports,
  setFamilyAccountBlocked,
  type BlockedFamilyAccount,
  type ContentReport,
  type ReportReason,
  type ReportTargetType,
} from '@/services/content-safety';

export function contentReportsQueryKey(userId: string | null | undefined, familyId: string | null | undefined) {
  return [contentReportsQueryKeyBase, userId, familyId] as const;
}

export function blockedFamilyAccountsQueryKey(userId: string | null | undefined, familyId: string | null | undefined) {
  return [blockedFamilyAccountsQueryKeyBase, userId, familyId] as const;
}

export function contentSafetyRevealsQueryKey(userId: string | null | undefined, familyId: string | null | undefined) {
  return ['content-safety-reveals', userId, familyId] as const;
}

// Stable empties: `query.data ?? []` would mint a new array every render while
// a query is disabled/loading and defeat the memoized return below.
const EMPTY_REPORTS: ContentReport[] = [];
const EMPTY_BLOCKS: BlockedFamilyAccount[] = [];

interface ContentSafetyReveals {
  reportIds: string[];
  blockIds: string[];
}

function targetKey(
  familyId: string | null | undefined,
  targetType: ReportTargetType,
  targetId: string,
  targetVersionId?: string | null,
) {
  const version = targetType === 'memory_illustration' ? (targetVersionId ?? 'no-generation') : 'target';
  return `${familyId ?? 'none'}:${targetType}:${targetId}:${version}`;
}

export function useContentSafety() {
  const { familyId } = useFamily();
  const { user } = useAuth();
  const userId = user?.id;
  const queryClient = useQueryClient();
  const revealsQuery = useQuery({
    queryKey: contentSafetyRevealsQueryKey(userId, familyId),
    queryFn: async (): Promise<ContentSafetyReveals> => ({ reportIds: [], blockIds: [] }),
    initialData: { reportIds: [], blockIds: [] },
    staleTime: Infinity,
  });
  const revealedReportIds = useMemo(() => new Set(revealsQuery.data.reportIds), [revealsQuery.data.reportIds]);
  const revealedBlockIds = useMemo(() => new Set(revealsQuery.data.blockIds), [revealsQuery.data.blockIds]);

  const reportsQuery = useQuery({
    queryKey: contentReportsQueryKey(userId, familyId),
    queryFn: async () => {
      if (!familyId) return [];
      const { data, error } = await fetchMyContentReports(familyId);
      if (error) throw new Error(error.message);
      return data ?? [];
    },
    enabled: Boolean(userId && familyId),
  });

  const blocksQuery = useQuery({
    queryKey: blockedFamilyAccountsQueryKey(userId, familyId),
    queryFn: async () => {
      if (!familyId) return [];
      const { data, error } = await fetchMyBlockedFamilyAccounts(familyId);
      if (error) throw new Error(error.message);
      return data ?? [];
    },
    enabled: Boolean(userId && familyId),
  });

  const reportsByTarget = useMemo(
    () => new Map((reportsQuery.data ?? []).map((report) => [
      targetKey(
        familyId,
        report.target_type as ReportTargetType,
        report.target_id,
        report.target_version_id,
      ),
      report,
    ])),
    [familyId, reportsQuery.data],
  );
  const blocksByUser = useMemo(
    () => new Map((blocksQuery.data ?? []).map((block) => [block.blocked_user_id, block])),
    [blocksQuery.data],
  );

  const reportMutation = useMutation({
    mutationFn: async (input: {
      targetType: ReportTargetType;
      targetId: string;
      targetVersionId?: string | null;
      reason: ReportReason;
      note?: string;
    }) => {
      const { data, error } = await createContentReport(input);
      if (error || !data) throw new Error(error?.message ?? 'Could not send report');
      return { ...input, id: data };
    },
    onSuccess: ({ targetType, targetId, targetVersionId, id }) => {
      if (!familyId) return;
      queryClient.setQueryData<ContentReport[]>(contentReportsQueryKey(userId, familyId), (current = []) => [
        {
          id,
          family_id: familyId,
          target_type: targetType,
          target_id: targetId,
          target_version_id: targetVersionId ?? null,
          status: 'open',
          created_at: new Date().toISOString(),
        },
        ...current.filter((report) =>
          report.id !== id &&
          targetKey(familyId, report.target_type, report.target_id, report.target_version_id) !==
            targetKey(familyId, targetType, targetId, targetVersionId)
        ),
      ]);
      if (userId) {
        // A report is an immediate hide decision. Clear before any later
        // refresh so a network failure cannot leave the reported card on the
        // native widget while the normal mutation subscription catches up.
        void clearMemoryWidgetForScope({ accountId: userId, familyId }).catch(() => undefined);
      }
      // A reported memory/illustration leaves the recap pool and previews.
      void queryClient.invalidateQueries({ queryKey: [keepsakesOverviewQueryKeyBase], refetchType: 'none' });
    },
  });

  const blockMutation = useMutation({
    mutationFn: async (input:
      | { shouldBlock: true; membershipId: string }
      | { shouldBlock: false; blockId: string }
    ) => {
      const { data, error } = await setFamilyAccountBlocked(input);
      if (error || !data) throw new Error(error?.message ?? 'Could not update hidden posts');
      return { input, data };
    },
    onSuccess: ({ input, data }) => {
      if (!familyId) return;
      queryClient.setQueryData<BlockedFamilyAccount[]>(
        blockedFamilyAccountsQueryKey(userId, familyId),
        (current = []) => input.shouldBlock
          ? [data, ...current.filter((block) => block.id !== data.id)]
          : current.filter((block) => block.id !== data.id),
      );
      if (userId && input.shouldBlock) {
        void clearMemoryWidgetForScope({ accountId: userId, familyId }).catch(() => undefined);
      }
      // Blocking (or unblocking) an author changes the overview's picture/previews.
      void queryClient.invalidateQueries({ queryKey: [keepsakesOverviewQueryKeyBase], refetchType: 'none' });
    },
  });

  const getBlockForUser = useCallback((blockedUserId: string | null | undefined) => blockedUserId ? blocksByUser.get(blockedUserId) : undefined, [blocksByUser]);
  const isUserBlocked = useCallback((blockedUserId: string | null | undefined) => {
    const block = blockedUserId ? blocksByUser.get(blockedUserId) : undefined;
    return Boolean(block && !revealedBlockIds.has(block.id));
  }, [blocksByUser, revealedBlockIds]);
  const hasActiveReport = useCallback((
    targetType: ReportTargetType,
    targetId: string | null | undefined,
    targetVersionId?: string | null,
  ) => Boolean(targetId && reportsByTarget.has(targetKey(familyId, targetType, targetId, targetVersionId))), [familyId, reportsByTarget]);
  const isTargetReported = useCallback((
    targetType: ReportTargetType,
    targetId: string | null | undefined,
    targetVersionId?: string | null,
  ) => {
    const report = targetId
      ? reportsByTarget.get(targetKey(familyId, targetType, targetId, targetVersionId))
      : undefined;
    return Boolean(report && !revealedReportIds.has(report.id));
  }, [familyId, reportsByTarget, revealedReportIds]);

  const reportsRefetch = reportsQuery.refetch;
  const blocksRefetch = blocksQuery.refetch;
  const refetch = useCallback(async () => {
    await Promise.all([reportsRefetch(), blocksRefetch()]);
  }, [reportsRefetch, blocksRefetch]);

  const revealBlockedUser = useCallback((blockedUserId: string) => {
    const block = blocksByUser.get(blockedUserId);
    if (!block) return;
    queryClient.setQueryData<ContentSafetyReveals>(contentSafetyRevealsQueryKey(userId, familyId), (current) => ({
      reportIds: current?.reportIds ?? [],
      blockIds: [...new Set([...(current?.blockIds ?? []), block.id])],
    }));
  }, [blocksByUser, familyId, queryClient, userId]);

  const revealTarget = useCallback((
    targetType: ReportTargetType,
    targetId: string,
    targetVersionId?: string | null,
  ) => {
    const report = reportsByTarget.get(targetKey(familyId, targetType, targetId, targetVersionId));
    if (!report) return;
    queryClient.setQueryData<ContentSafetyReveals>(contentSafetyRevealsQueryKey(userId, familyId), (current) => ({
      reportIds: [...new Set([...(current?.reportIds ?? []), report.id])],
      blockIds: current?.blockIds ?? [],
    }));
  }, [familyId, queryClient, reportsByTarget, userId]);

  const reports = reportsQuery.data ?? EMPTY_REPORTS;
  const blocks = blocksQuery.data ?? EMPTY_BLOCKS;
  const isLoading = reportsQuery.isLoading || blocksQuery.isLoading;
  const isError = reportsQuery.isError || blocksQuery.isError;
  const { mutateAsync: report, isPending: isReporting } = reportMutation;
  const { mutateAsync: setAccountBlocked, isPending: isUpdatingBlock } = blockMutation;

  // Memoized (docs/plans/performance-optimizations.md, timeline re-render
  // audit): this hook is called by the timeline (whose memoized MemoryCard
  // rows depend on `isTargetReported`/`revealTarget`) and per-pill in the
  // memory detail screen. A fresh object literal each render made every
  // consumer's useCallback/useMemo that listed the whole result as a dep
  // rebuild on every render. Every member is a primitive, a stable query
  // result, or a useCallback keyed on the data it reads.
  return useMemo(() => ({
    reports,
    blocks,
    isLoading,
    isError,
    refetch,
    report,
    isReporting,
    setAccountBlocked,
    isUpdatingBlock,
    getBlockForUser,
    isUserBlocked,
    revealBlockedUser,
    hasActiveReport,
    isTargetReported,
    revealTarget,
  }), [
    reports, blocks, isLoading, isError, refetch, report, isReporting, setAccountBlocked, isUpdatingBlock,
    getBlockForUser, isUserBlocked, revealBlockedUser, hasActiveReport, isTargetReported, revealTarget,
  ]);
}
