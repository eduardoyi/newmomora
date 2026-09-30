// Thumbnails for the Year Film edit sheet's moments (docs/plans/year-film-p2.md
// Step 11). The RPC only knows memory ids, so the memories are loaded through
// the same service Looking Back uses (`fetchMemoriesByIds`, 40 per call),
// the thumbnail is picked exactly like a search result's
// (`searchResultThumbnail`: illustration unless reported, else the list-sized
// preview / video poster, else an image original), and the signed URLs come
// from `useBatchedMediaUrls` (reuses the Timeline's already-signed URLs).
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { yearFilmEditFramesQueryKey } from '@/hooks/queryKeys';
import { useContentSafety } from '@/hooks/useContentSafety';
import { useBatchedMediaUrls } from '@/hooks/useMediaUrls';
import { fetchMemoriesByIds, LOOKING_BACK_MEMORY_FETCH_LIMIT, type MemoryWithTags } from '@/services/memories';
import type { MemoryFallbackKind } from '@/utils/memory-fallback';
import { searchResultThumbnail } from '@/utils/memory-search';

export interface YearFilmEditThumbnail {
  /** R2 key of the still (also the expo-image cache key), or null. */
  key: string | null;
  /** Signed URL for `key`, once available. */
  url: string | undefined;
  fallback: MemoryFallbackKind;
  emotion: string | null;
}

async function fetchMemoriesInChunks(familyId: string, memoryIds: readonly string[]): Promise<MemoryWithTags[]> {
  const memories: MemoryWithTags[] = [];
  for (let i = 0; i < memoryIds.length; i += LOOKING_BACK_MEMORY_FETCH_LIMIT) {
    const { data, error } = await fetchMemoriesByIds(familyId, memoryIds.slice(i, i + LOOKING_BACK_MEMORY_FETCH_LIMIT));
    if (error) throw new Error(error.message);
    memories.push(...(data ?? []));
  }
  return memories;
}

export function useYearFilmEditFrames(familyId: string | null | undefined, memoryIds: readonly string[]) {
  const contentSafety = useContentSafety();
  const signature = useMemo(() => [...new Set(memoryIds)].sort().join('|'), [memoryIds]);

  const query = useQuery({
    queryKey: yearFilmEditFramesQueryKey(familyId, signature),
    queryFn: () => fetchMemoriesInChunks(familyId!, signature.split('|')),
    enabled: Boolean(familyId) && signature.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  // Fail closed like the drawer: nothing that could be reported is drawn
  // until the viewer's reports have loaded.
  const isSafetyReady = !contentSafety.isLoading && !contentSafety.isError;
  const isTargetReported = contentSafety.isTargetReported;

  const thumbnails = useMemo(() => {
    const byId = new Map<string, Omit<YearFilmEditThumbnail, 'url'>>();
    for (const memory of query.data ?? []) {
      if (!isSafetyReady || isTargetReported('memory', memory.id)) {
        byId.set(memory.id, { key: null, fallback: 'blank', emotion: null });
        continue;
      }
      const thumbnail = searchResultThumbnail(
        memory,
        isTargetReported('memory_illustration', memory.id, memory.illustration_generation_id),
      );
      byId.set(memory.id, { key: thumbnail.key, fallback: thumbnail.fallback, emotion: memory.emotion });
    }
    return byId;
  }, [isSafetyReady, isTargetReported, query.data]);

  const keys = useMemo(
    () => [...thumbnails.values()].flatMap((thumbnail) => (thumbnail.key ? [thumbnail.key] : [])),
    [thumbnails],
  );
  const urls = useBatchedMediaUrls(keys);

  const resolve = (memoryId: string): YearFilmEditThumbnail => {
    const thumbnail = thumbnails.get(memoryId);
    if (!thumbnail) return { key: null, url: undefined, fallback: 'blank', emotion: null };
    return { ...thumbnail, url: thumbnail.key ? urls[thumbnail.key] : undefined };
  };

  return { resolve, isLoading: query.isLoading };
}
