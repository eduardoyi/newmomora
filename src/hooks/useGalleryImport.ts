import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import {
  galleryCaptionSettingsQueryKey,
  galleryImportCandidatesQueryKey,
  galleryImportQueryKey,
  galleryImportRunStatusQueryKey,
} from '@/hooks/queryKeys';
import {
  createGalleryImportRun,
  getGalleryCaptionSettings,
  getGalleryImportCandidates,
  getGalleryImportRun,
  updateGalleryCaptionSettings,
  type GalleryImportCandidate,
  type GalleryImportRun,
} from '@/services/gallery-import';
import { isGalleryImportFeatureEnabled } from '@/utils/gallery-import-flags';
import { GALLERY_IMPORT_ALGORITHM_VERSION } from '@/constants/gallery-import';
import {
  deriveGalleryImportEntryStatus,
  type GalleryImportEntryStatus,
} from '@/utils/gallery-import-entry-state';
import {
  loadLatestGalleryImportCheckpoint,
  type GalleryImportCheckpoint,
} from '@/utils/gallery-import-checkpoint';

export function useGalleryImport() {
  const { user } = useAuth();
  const { familyId } = useFamily();
  const queryClient = useQueryClient();
  const isEnabled = isGalleryImportFeatureEnabled;
  const queryKey = galleryImportQueryKey(user?.id, familyId);
  const query = useQuery<GalleryImportRun | null>({
    queryKey,
    // Server reads are device-bound and require the locally held run
    // capability. Screens with a run id load that checkpoint first and call
    // getGalleryImportRun directly; there is intentionally no family-wide
    // polling endpoint that could expose another device's candidates.
    queryFn: async () => null,
    enabled: false,
    staleTime: 15_000,
  });
  const createRun = useMutation({
    mutationFn: async (input: { consentVersion: string; permissionMode: 'full' | 'limited' }) => {
      if (!isEnabled) throw new Error('Gallery import is not available yet.');
      if (!familyId) throw new Error('Choose a family before starting a gallery import.');
      const { data, error } = await createGalleryImportRun({
        familyId,
        algorithmVersion: GALLERY_IMPORT_ALGORITHM_VERSION,
        consentVersion: input.consentVersion,
        permissionMode: input.permissionMode,
      });
      if (error || !data) throw new Error(error?.message ?? 'Could not start the gallery import.');
      return data;
    },
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, result.run);
    },
  });

  return {
    run: isEnabled ? query.data ?? null : null,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    createRun: createRun.mutateAsync,
    isCreatingRun: createRun.isPending,
  };
}

export function useGalleryCaptionSettings() {
  const { familyId, role } = useFamily();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = galleryCaptionSettingsQueryKey(user?.id, familyId);
  const canEdit = role === 'owner';
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      if (!familyId) return null;
      const { data, error } = await getGalleryCaptionSettings(familyId);
      if (error) throw new Error(error.message);
      return data;
    },
    enabled: isGalleryImportFeatureEnabled && Boolean(user && familyId && canEdit),
  });
  const save = useMutation({
    mutationFn: async (input: { language: string; instructions: string }) => {
      if (!isGalleryImportFeatureEnabled) throw new Error('Gallery import is not available yet.');
      if (!familyId || !canEdit) throw new Error('Only the family owner can change caption settings.');
      const { data, error } = await updateGalleryCaptionSettings({ familyId, ...input });
      if (error || !data) throw new Error(error?.message ?? 'Could not save caption settings.');
      return data;
    },
    onSuccess: (settings) => queryClient.setQueryData(queryKey, settings),
  });
  return {
    settings: isGalleryImportFeatureEnabled && canEdit ? query.data ?? null : null,
    isLoading: query.isLoading,
    isSaving: save.isPending,
    error: query.error ?? save.error,
    save: save.mutateAsync,
  };
}

/**
 * Drives the Timeline entry point (the small import glyph + its status
 * drawer). Unlike `useGalleryImport` above, this one DOES reach the server:
 * it loads this device's local checkpoint (there is no family-wide run
 * lookup -- see the comment on `useGalleryImport`'s query above) and, when
 * one exists, asks the server for that run's live status via
 * `getGalleryImportRun`. `deriveGalleryImportEntryStatus` turns the pair into
 * the glyph's six-state, single-source-of-truth status.
 */
export function useGalleryImportEntryStatus(options: { enabled?: boolean } = {}): GalleryImportEntryStatus & {
  checkpoint: GalleryImportCheckpoint | null;
  run: GalleryImportRun | null;
  isLoading: boolean;
  refetch: () => Promise<void>;
} {
  const enabled = (options.enabled ?? true) && isGalleryImportFeatureEnabled;
  const { user } = useAuth();
  const { familyId } = useFamily();
  const userId = user?.id;
  const [checkpoint, setCheckpoint] = useState<GalleryImportCheckpoint | null>(null);
  const [isCheckpointLoading, setIsCheckpointLoading] = useState(true);

  const reloadCheckpoint = useCallback(async () => {
    if (!enabled || !userId || !familyId) {
      setCheckpoint(null);
      setIsCheckpointLoading(false);
      return;
    }
    setIsCheckpointLoading(true);
    const next = await loadLatestGalleryImportCheckpoint(userId, familyId);
    setCheckpoint(next);
    setIsCheckpointLoading(false);
  }, [enabled, familyId, userId]);

  useEffect(() => {
    void reloadCheckpoint();
  }, [reloadCheckpoint]);

  const runQuery = useQuery<GalleryImportRun | null>({
    queryKey: galleryImportRunStatusQueryKey(checkpoint?.runId),
    queryFn: async () => {
      if (!checkpoint) return null;
      const { data, error } = await getGalleryImportRun({
        runId: checkpoint.runId,
        runCapability: checkpoint.runCapability,
      });
      if (error) throw new Error(error.message);
      return data;
    },
    enabled: enabled && Boolean(checkpoint),
    staleTime: 15_000,
  });

  const status = useMemo(
    () => deriveGalleryImportEntryStatus(checkpoint, runQuery.data ?? null),
    [checkpoint, runQuery.data],
  );

  const refetch = useCallback(async () => {
    await reloadCheckpoint();
    await runQuery.refetch();
  }, [reloadCheckpoint, runQuery]);

  return {
    checkpoint,
    run: runQuery.data ?? null,
    ...status,
    isLoading: isCheckpointLoading || (Boolean(checkpoint) && runQuery.isLoading),
    refetch,
  };
}

/**
 * The candidate list behind the status drawer -- thumbnails plus the
 * kept/ready/set-aside counts the design's resume/expiring copy needs.
 * Fetched lazily (only while `enabled`, i.e. the drawer is open): candidate
 * previews are short-lived signed URLs, not something to hold open a
 * standing subscription for.
 */
export function useGalleryImportRunCandidates(
  checkpoint: GalleryImportCheckpoint | null,
  enabled: boolean,
) {
  return useQuery<GalleryImportCandidate[]>({
    queryKey: galleryImportCandidatesQueryKey(checkpoint?.runId),
    queryFn: async () => {
      if (!checkpoint) return [];
      const { data, error } = await getGalleryImportCandidates({
        runId: checkpoint.runId,
        capability: checkpoint.runCapability,
      });
      if (error) throw new Error(error.message);
      return data?.candidates ?? [];
    },
    enabled: isGalleryImportFeatureEnabled && enabled && Boolean(checkpoint),
    staleTime: 10_000,
  });
}
