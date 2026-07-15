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
    placeholderData: (previousData) => previousData,
    staleTime: 50 * 60 * 1000,
    // gcTime > staleTime, both under the R2 signed-URL's 60min expiry
    // (Workstream C7): keeps an already-fetched URL cached across brief
    // unmounts (e.g. scrolling a card off-screen and back) instead of
    // evicting it 5min after last use (the react-query default) and
    // refetching sooner than necessary.
    gcTime: 55 * 60 * 1000,
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
