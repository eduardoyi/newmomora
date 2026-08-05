import { useQuery } from '@tanstack/react-query';

import { getMediaUrls } from '@/services/media';

/**
 * `cacheVersion` busts the presigned-URL react-query cache on edits (pass
 * `memory.updated_at`/`member.updated_at` after saves) so a stale signed URL
 * is never served for a row whose fields just changed. It is NOT about
 * object bytes changing in place -- they never do: regenerated illustrations,
 * new portrait versions, and media edits all mint a FRESH R2 object key per
 * attempt, and nothing in this app overwrites an existing key's bytes.
 * expo-image callers rely on that invariant to key their disk cache on the
 * object key itself (see src/utils/media-image-source.ts) -- keep it that
 * way; overwriting bytes under a reused key would silently serve stale
 * cached images to any client that already has that key cached.
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
