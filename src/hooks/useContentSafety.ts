import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useFamily } from '@/hooks/use-family';
import { useAuth } from '@/hooks/use-auth';
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

export const contentReportsQueryKeyBase = 'content-reports' as const;
export const blockedFamilyAccountsQueryKeyBase = 'blocked-family-accounts' as const;

export function contentReportsQueryKey(userId: string | null | undefined, familyId: string | null | undefined) {
  return [contentReportsQueryKeyBase, userId, familyId] as const;
}

export function blockedFamilyAccountsQueryKey(userId: string | null | undefined, familyId: string | null | undefined) {
  return [blockedFamilyAccountsQueryKeyBase, userId, familyId] as const;
}

export function contentSafetyRevealsQueryKey(userId: string | null | undefined, familyId: string | null | undefined) {
  return ['content-safety-reveals', userId, familyId] as const;
}

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
  const revealedReportIds = new Set(revealsQuery.data.reportIds);
  const revealedBlockIds = new Set(revealsQuery.data.blockIds);

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
    },
  });

  return {
    reports: reportsQuery.data ?? [],
    blocks: blocksQuery.data ?? [],
    isLoading: reportsQuery.isLoading || blocksQuery.isLoading,
    isError: reportsQuery.isError || blocksQuery.isError,
    refetch: async () => {
      await Promise.all([reportsQuery.refetch(), blocksQuery.refetch()]);
    },
    report: reportMutation.mutateAsync,
    isReporting: reportMutation.isPending,
    setAccountBlocked: blockMutation.mutateAsync,
    isUpdatingBlock: blockMutation.isPending,
    getBlockForUser: (userId: string | null | undefined) => userId ? blocksByUser.get(userId) : undefined,
    isUserBlocked: (userId: string | null | undefined) => {
      const block = userId ? blocksByUser.get(userId) : undefined;
      return Boolean(block && !revealedBlockIds.has(block.id));
    },
    revealBlockedUser: (blockedUserId: string) => {
      const block = blocksByUser.get(blockedUserId);
      if (!block) return;
      queryClient.setQueryData<ContentSafetyReveals>(contentSafetyRevealsQueryKey(userId, familyId), (current) => ({
        reportIds: current?.reportIds ?? [],
        blockIds: [...new Set([...(current?.blockIds ?? []), block.id])],
      }));
    },
    hasActiveReport: (
      targetType: ReportTargetType,
      targetId: string | null | undefined,
      targetVersionId?: string | null,
    ) => Boolean(
      targetId && reportsByTarget.has(targetKey(familyId, targetType, targetId, targetVersionId))
    ),
    isTargetReported: (
      targetType: ReportTargetType,
      targetId: string | null | undefined,
      targetVersionId?: string | null,
    ) => {
      const report = targetId
        ? reportsByTarget.get(targetKey(familyId, targetType, targetId, targetVersionId))
        : undefined;
      return Boolean(report && !revealedReportIds.has(report.id));
    },
    revealTarget: (
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
    },
  };
}
