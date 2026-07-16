import { QueryClient, type InfiniteData } from '@tanstack/react-query';

import {
  findMemoryInListCache,
  invalidateMemoryQueries,
  isMemoriesListQueryKey,
  patchMemoryInCaches,
  prependMemoryToListCaches,
  removeMemoryFromListCaches,
  setMemoryEmotionInCache,
  setMemoryIllustrationPendingInCache,
} from '@/hooks/memory-cache';
import { calendarMemoriesQueryKeyBase, memoriesQueryKey, memoryDetailQueryKey } from '@/hooks/queryKeys';
import type { MemoriesPage, MemoryWithTags } from '@/services/memories';

const FAMILY_ID = 'family-1';

function buildMemory(overrides: Partial<MemoryWithTags> = {}): MemoryWithTags {
  return {
    id: 'memory-1',
    user_id: 'user-1',
    family_id: FAMILY_ID,
    content: 'Hello',
    memory_date: '2026-05-24',
    memory_type: 'text_only',
    emotion: null,
    illustration_key: null,
    illustration_status: 'none',
    illustration_prompt: null,
    media_key: null,
    media_content_type: null,
    link_previews: {},
    created_at: '2026-05-24T00:00:00.000Z',
    updated_at: '2026-05-24T00:00:00.000Z',
    taggedMembers: [],
    mediaAssets: [],
    likeCount: 0,
    commentCount: 0,
    likedByMe: false,
    ...overrides,
  } as MemoryWithTags;
}

function buildInfiniteData(
  pages: { memories: MemoryWithTags[]; nextCursor: MemoriesPage['nextCursor'] }[],
): InfiniteData<MemoriesPage> {
  return {
    pages,
    pageParams: pages.map(() => null),
  };
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
}

describe('isMemoriesListQueryKey', () => {
  it('matches the base timeline key and a member-filtered key', () => {
    expect(isMemoriesListQueryKey(memoriesQueryKey(FAMILY_ID))).toBe(true);
    expect(isMemoriesListQueryKey([...memoriesQueryKey(FAMILY_ID), 'member', 'member-1'])).toBe(true);
  });

  it('excludes the detail key and unrelated queries', () => {
    expect(isMemoriesListQueryKey(memoryDetailQueryKey(FAMILY_ID, 'memory-1'))).toBe(false);
    expect(isMemoriesListQueryKey(['generation-status', FAMILY_ID])).toBe(false);
    expect(isMemoriesListQueryKey(['memories-search', FAMILY_ID, 'query'])).toBe(false);
  });
});

describe('findMemoryInListCache', () => {
  it('finds a memory nested inside InfiniteData pages, scoped to the family', () => {
    const queryClient = createQueryClient();
    const target = buildMemory({ id: 'memory-2' });
    queryClient.setQueryData(
      memoriesQueryKey(FAMILY_ID),
      buildInfiniteData([
        { memories: [buildMemory({ id: 'memory-1' }), target], nextCursor: null },
      ]),
    );

    expect(findMemoryInListCache(queryClient, FAMILY_ID, 'memory-2')?.id).toBe('memory-2');
  });

  it('does not leak another family\'s cache', () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      memoriesQueryKey('family-2'),
      buildInfiniteData([{ memories: [buildMemory({ id: 'memory-1' })], nextCursor: null }]),
    );

    expect(findMemoryInListCache(queryClient, FAMILY_ID, 'memory-1')).toBeUndefined();
  });
});

describe('patchMemoryInCaches', () => {
  it('patches the matching row across InfiniteData list pages, the calendar array, and the detail cache', () => {
    const queryClient = createQueryClient();
    const memory = buildMemory({ id: 'memory-1', emotion: null });
    queryClient.setQueryData(
      memoriesQueryKey(FAMILY_ID),
      buildInfiniteData([{ memories: [memory], nextCursor: null }]),
    );
    queryClient.setQueryData([calendarMemoriesQueryKeyBase, FAMILY_ID, 'range', 'a', 'b'], [memory]);
    queryClient.setQueryData(memoryDetailQueryKey(FAMILY_ID, 'memory-1'), memory);

    patchMemoryInCaches(queryClient, FAMILY_ID, 'memory-1', { emotion: 'joy' });

    const list = queryClient.getQueryData<InfiniteData<MemoriesPage>>(memoriesQueryKey(FAMILY_ID));
    expect(list?.pages[0]?.memories[0]?.emotion).toBe('joy');
    const calendar = queryClient.getQueryData<MemoryWithTags[]>([
      calendarMemoriesQueryKeyBase,
      FAMILY_ID,
      'range',
      'a',
      'b',
    ]);
    expect(calendar?.[0]?.emotion).toBe('joy');
    const detail = queryClient.getQueryData<MemoryWithTags>(memoryDetailQueryKey(FAMILY_ID, 'memory-1'));
    expect(detail?.emotion).toBe('joy');
  });

  it('leaves the calendar oldest-date string entry untouched (Array.isArray guard)', () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData([calendarMemoriesQueryKeyBase, FAMILY_ID, 'oldest-date'], '2026-01-01');

    expect(() => patchMemoryInCaches(queryClient, FAMILY_ID, 'memory-1', { emotion: 'joy' })).not.toThrow();
    expect(queryClient.getQueryData([calendarMemoriesQueryKeyBase, FAMILY_ID, 'oldest-date'])).toBe(
      '2026-01-01',
    );
  });

  it('accepts a function patch computed from the current cached memory', () => {
    const queryClient = createQueryClient();
    const memory = buildMemory({ id: 'memory-1', commentCount: 2 });
    queryClient.setQueryData(
      memoriesQueryKey(FAMILY_ID),
      buildInfiniteData([{ memories: [memory], nextCursor: null }]),
    );

    patchMemoryInCaches(queryClient, FAMILY_ID, 'memory-1', (current) => ({
      commentCount: current.commentCount + 1,
    }));

    const list = queryClient.getQueryData<InfiniteData<MemoriesPage>>(memoriesQueryKey(FAMILY_ID));
    expect(list?.pages[0]?.memories[0]?.commentCount).toBe(3);
  });
});

describe('setMemoryIllustrationPendingInCache / setMemoryEmotionInCache', () => {
  it('patch illustration_status to pending with a fresh updated_at', () => {
    const queryClient = createQueryClient();
    const memory = buildMemory({ id: 'memory-1', illustration_status: 'failed', updated_at: '2020-01-01T00:00:00.000Z' });
    queryClient.setQueryData(
      memoriesQueryKey(FAMILY_ID),
      buildInfiniteData([{ memories: [memory], nextCursor: null }]),
    );

    setMemoryIllustrationPendingInCache(queryClient, FAMILY_ID, 'memory-1');

    const list = queryClient.getQueryData<InfiniteData<MemoriesPage>>(memoriesQueryKey(FAMILY_ID));
    const patched = list?.pages[0]?.memories[0];
    expect(patched?.illustration_status).toBe('pending');
    expect(new Date(patched?.updated_at ?? 0).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('patches emotion', () => {
    const queryClient = createQueryClient();
    const memory = buildMemory({ id: 'memory-1', emotion: null });
    queryClient.setQueryData(
      memoriesQueryKey(FAMILY_ID),
      buildInfiniteData([{ memories: [memory], nextCursor: null }]),
    );

    setMemoryEmotionInCache(queryClient, FAMILY_ID, 'memory-1', 'calm');

    const list = queryClient.getQueryData<InfiniteData<MemoriesPage>>(memoriesQueryKey(FAMILY_ID));
    expect(list?.pages[0]?.memories[0]?.emotion).toBe('calm');
  });
});

describe('invalidateMemoryQueries', () => {
  it('invalidates the memories list with refetchType none, and calendar with the default (refetching) type', () => {
    const queryClient = createQueryClient();
    const spy = jest.spyOn(queryClient, 'invalidateQueries');

    invalidateMemoryQueries(queryClient);

    expect(spy).toHaveBeenCalledWith({ queryKey: ['memories'], refetchType: 'none' });
    expect(spy).toHaveBeenCalledWith({ queryKey: [calendarMemoriesQueryKeyBase] });
  });
});

describe('prependMemoryToListCaches', () => {
  it('inserts a newer memory at the front of page 1', () => {
    const queryClient = createQueryClient();
    const existing = buildMemory({ id: 'memory-old', memory_date: '2026-05-20', created_at: '2026-05-20T00:00:00.000Z' });
    queryClient.setQueryData(
      memoriesQueryKey(FAMILY_ID),
      buildInfiniteData([{ memories: [existing], nextCursor: null }]),
    );

    const created = buildMemory({ id: 'memory-new', memory_date: '2026-05-24', created_at: '2026-05-24T00:00:00.000Z' });
    prependMemoryToListCaches(queryClient, FAMILY_ID, created);

    const list = queryClient.getQueryData<InfiniteData<MemoriesPage>>(memoriesQueryKey(FAMILY_ID));
    expect(list?.pages[0]?.memories.map((m) => m.id)).toEqual(['memory-new', 'memory-old']);
  });

  it('inserts a backdated memory at its sorted position within a loaded page', () => {
    const queryClient = createQueryClient();
    const newest = buildMemory({ id: 'memory-1', memory_date: '2026-05-24', created_at: '2026-05-24T00:00:00.000Z' });
    const oldest = buildMemory({ id: 'memory-2', memory_date: '2026-05-20', created_at: '2026-05-20T00:00:00.000Z' });
    queryClient.setQueryData(
      memoriesQueryKey(FAMILY_ID),
      buildInfiniteData([{ memories: [newest, oldest], nextCursor: null }]),
    );

    const backdated = buildMemory({ id: 'memory-mid', memory_date: '2026-05-22', created_at: '2026-05-22T00:00:00.000Z' });
    prependMemoryToListCaches(queryClient, FAMILY_ID, backdated);

    const list = queryClient.getQueryData<InfiniteData<MemoriesPage>>(memoriesQueryKey(FAMILY_ID));
    expect(list?.pages[0]?.memories.map((m) => m.id)).toEqual(['memory-1', 'memory-mid', 'memory-2']);
  });

  it('drops a row that sorts past the loaded window when there is a next page to fetch', () => {
    const queryClient = createQueryClient();
    const loaded = buildMemory({ id: 'memory-1', memory_date: '2026-05-24', created_at: '2026-05-24T00:00:00.000Z' });
    queryClient.setQueryData(
      memoriesQueryKey(FAMILY_ID),
      buildInfiniteData([
        { memories: [loaded], nextCursor: { memoryDate: '2026-05-24', createdAt: '2026-05-24T00:00:00.000Z' } },
      ]),
    );

    const ancient = buildMemory({ id: 'memory-ancient', memory_date: '2020-01-01', created_at: '2020-01-01T00:00:00.000Z' });
    prependMemoryToListCaches(queryClient, FAMILY_ID, ancient);

    const list = queryClient.getQueryData<InfiniteData<MemoriesPage>>(memoriesQueryKey(FAMILY_ID));
    expect(list?.pages[0]?.memories.map((m) => m.id)).toEqual(['memory-1']);
  });

  it('appends a row that sorts past the loaded window when there is no next page (whole library loaded)', () => {
    const queryClient = createQueryClient();
    const loaded = buildMemory({ id: 'memory-1', memory_date: '2026-05-24', created_at: '2026-05-24T00:00:00.000Z' });
    queryClient.setQueryData(
      memoriesQueryKey(FAMILY_ID),
      buildInfiniteData([{ memories: [loaded], nextCursor: null }]),
    );

    const ancient = buildMemory({ id: 'memory-ancient', memory_date: '2020-01-01', created_at: '2020-01-01T00:00:00.000Z' });
    prependMemoryToListCaches(queryClient, FAMILY_ID, ancient);

    const list = queryClient.getQueryData<InfiniteData<MemoriesPage>>(memoriesQueryKey(FAMILY_ID));
    expect(list?.pages[0]?.memories.map((m) => m.id)).toEqual(['memory-1', 'memory-ancient']);
  });

  it('skips a memory that is already present in a loaded page', () => {
    const queryClient = createQueryClient();
    const existing = buildMemory({ id: 'memory-1', memory_date: '2026-05-24', created_at: '2026-05-24T00:00:00.000Z' });
    queryClient.setQueryData(
      memoriesQueryKey(FAMILY_ID),
      buildInfiniteData([{ memories: [existing], nextCursor: null }]),
    );

    prependMemoryToListCaches(queryClient, FAMILY_ID, buildMemory({ id: 'memory-1', content: 'duplicate' }));

    const list = queryClient.getQueryData<InfiniteData<MemoriesPage>>(memoriesQueryKey(FAMILY_ID));
    expect(list?.pages[0]?.memories).toHaveLength(1);
    expect(list?.pages[0]?.memories[0]?.content).toBe('Hello');
  });

  it('only prepends into a member-filtered cache when the memory tags that member', () => {
    const queryClient = createQueryClient();
    const memberKey = [...memoriesQueryKey(FAMILY_ID), 'member', 'member-1'];
    queryClient.setQueryData(memberKey, buildInfiniteData([{ memories: [], nextCursor: null }]));

    const untagged = buildMemory({ id: 'memory-untagged', taggedMembers: [] });
    prependMemoryToListCaches(queryClient, FAMILY_ID, untagged);
    expect(
      queryClient.getQueryData<InfiniteData<MemoriesPage>>(memberKey)?.pages[0]?.memories,
    ).toHaveLength(0);

    const tagged = buildMemory({
      id: 'memory-tagged',
      taggedMembers: [{ id: 'member-1' } as MemoryWithTags['taggedMembers'][number]],
    });
    prependMemoryToListCaches(queryClient, FAMILY_ID, tagged);
    expect(
      queryClient.getQueryData<InfiniteData<MemoriesPage>>(memberKey)?.pages[0]?.memories.map((m) => m.id),
    ).toEqual(['memory-tagged']);
  });
});

describe('removeMemoryFromListCaches', () => {
  it('removes the memory from every loaded page of every matching list cache', () => {
    const queryClient = createQueryClient();
    const target = buildMemory({ id: 'memory-1' });
    const other = buildMemory({ id: 'memory-2' });
    queryClient.setQueryData(
      memoriesQueryKey(FAMILY_ID),
      buildInfiniteData([{ memories: [target], nextCursor: null }, { memories: [other], nextCursor: null }]),
    );

    removeMemoryFromListCaches(queryClient, FAMILY_ID, 'memory-1');

    const list = queryClient.getQueryData<InfiniteData<MemoriesPage>>(memoriesQueryKey(FAMILY_ID));
    expect(list?.pages[0]?.memories).toHaveLength(0);
    expect(list?.pages[1]?.memories.map((m) => m.id)).toEqual(['memory-2']);
  });
});
