import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { galleryCaptionSettingsQueryKey, galleryImportQueryKey } from '@/hooks/queryKeys';
import {
  createGalleryImportRun,
  getGalleryCaptionSettings,
  updateGalleryCaptionSettings,
  type GalleryImportRun,
} from '@/services/gallery-import';
import { isGalleryImportFeatureEnabled } from '@/utils/gallery-import-flags';
import { GALLERY_IMPORT_ALGORITHM_VERSION } from '@/constants/gallery-import';

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
