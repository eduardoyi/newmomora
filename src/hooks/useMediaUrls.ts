import { useQuery } from '@tanstack/react-query';

import { getMediaUrls } from '@/services/media';

/**
 * Bust presigned-URL cache when object bytes change in place (e.g. regenerated
 * memory illustration at the same R2 key). Pass memory.updated_at after saves.
 */
export function useMediaUrls(keys: string[], cacheVersion?: string | null) {
  const normalizedKeys = keys.filter(Boolean);

  return useQuery({
    queryKey: ['media-urls', normalizedKeys.slice().sort().join('|'), cacheVersion ?? ''],
    queryFn: async () => {
      const { data, error } = await getMediaUrls(normalizedKeys);

      if (error) {
        throw error;
      }

      return data?.urls ?? {};
    },
    enabled: normalizedKeys.length > 0,
    staleTime: 50 * 60 * 1000,
  });
}

export function useMediaUrl(
  key: string | null | undefined,
  cacheVersion?: string | null,
) {
  const query = useMediaUrls(key ? [key] : [], cacheVersion);

  return {
    url: key ? query.data?.[key] : undefined,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
