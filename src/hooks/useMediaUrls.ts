import { useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { getMediaUrls } from '@/services/media';

const MEDIA_URL_STALE_TIME = 50 * 60 * 1000;
const MEDIA_URL_GC_TIME = 55 * 60 * 1000;
// get-media-url's per-request key cap (MAX_KEYS in
// supabase/functions/get-media-url/index.ts).
const MEDIA_URL_BATCH_SIZE = 50;

export interface MediaUrlsQueryOptions {
  queryKey: readonly ['media-urls', string, string];
  queryFn: () => Promise<Record<string, string>>;
  staleTime: number;
  gcTime: number;
}

/**
 * The shared query definition for a media-key grouping. Keep this grouping
 * shape stable: the query base and Record-shaped data are persisted for
 * offline cold starts and are consumed by every existing media caller.
 */
export function mediaUrlsQueryOptions(
  keys: string[],
  cacheVersion?: string | null,
): MediaUrlsQueryOptions {
  const normalizedKeys = keys.filter(Boolean);

  return {
    queryKey: [
      'media-urls',
      normalizedKeys.slice().sort().join('|'),
      cacheVersion ?? '',
    ],
    queryFn: async () => {
      const { data, error } = await getMediaUrls(normalizedKeys);

      if (error) {
        throw error;
      }

      return data?.urls ?? {};
    },
    staleTime: MEDIA_URL_STALE_TIME,
    // gcTime > staleTime, both under the R2 signed-URL's 60min expiry
    // (Workstream C7): keeps an already-fetched URL cached across brief
    // unmounts (e.g. scrolling a card off-screen and back) instead of
    // evicting it 5min after last use (the react-query default) and
    // refetching sooner than necessary.
    gcTime: MEDIA_URL_GC_TIME,
  };
}

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
  const options = mediaUrlsQueryOptions(keys, cacheVersion);

  return useQuery({
    ...options,
    enabled: normalizedKeys.length > 0,
    placeholderData: (previousData) => previousData,
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

/**
 * Looks up still-fresh signed URLs for `keys` in ANY existing media-urls
 * query, whatever grouping it was fetched under (e.g. a timeline card's
 * single-key query). Freshness uses the same staleTime as the queries
 * themselves, so a URL returned here is always well inside its 60min R2
 * signature window -- including ones restored from the persisted cache.
 */
export function readCachedMediaUrls(
  queryClient: QueryClient,
  keys: string[],
  now: number = Date.now(),
): Record<string, string> {
  const wanted = new Set(keys);
  const found: Record<string, string> = {};
  if (wanted.size === 0) return found;

  for (const query of queryClient.getQueryCache().findAll({ queryKey: ['media-urls'] })) {
    const { data, dataUpdatedAt } = query.state;
    if (!data || now - dataUpdatedAt >= MEDIA_URL_STALE_TIME) continue;
    for (const [key, url] of Object.entries(data as Record<string, string>)) {
      if (wanted.has(key) && url && !found[key]) found[key] = url;
    }
  }
  return found;
}

/**
 * For list surfaces that render many rows' images at once (the family
 * activity sheet): reuses URLs already signed elsewhere (usually the
 * timeline -- with `mediaImageSource` pinning cacheKey to the object key,
 * those also hit expo-image's disk cache), and signs only the remainder in
 * as few get-media-url requests as possible, instead of one request per row.
 */
export function useBatchedMediaUrls(keys: string[]): Record<string, string> {
  const queryClient = useQueryClient();
  const keySignature = Array.from(new Set(keys.filter(Boolean))).sort().join('|');

  // Resolved once per distinct key set, so the uncached chunk query keys
  // stay stable across re-renders (and across the fetched results landing
  // in the cache, which would otherwise re-split the chunks).
  const { cached, chunks } = useMemo(() => {
    const unique = keySignature ? keySignature.split('|') : [];
    const cachedUrls = readCachedMediaUrls(queryClient, unique);
    const missing = unique.filter((key) => !cachedUrls[key]);
    const batches: string[][] = [];
    for (let i = 0; i < missing.length; i += MEDIA_URL_BATCH_SIZE) {
      batches.push(missing.slice(i, i + MEDIA_URL_BATCH_SIZE));
    }
    return { cached: cachedUrls, chunks: batches };
  }, [keySignature, queryClient]);

  const fetched = useQueries({
    queries: chunks.map((chunk) => mediaUrlsQueryOptions(chunk)),
  });

  return Object.assign({}, cached, ...fetched.map((result) => result.data ?? {}));
}
