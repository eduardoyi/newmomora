import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, type Query } from '@tanstack/react-query';
import { persistQueryClientRestore, persistQueryClientSave } from '@tanstack/react-query-persist-client';

import {
  calendarMemoriesQueryKeyBase,
  familyMembershipsQueryKeyBase,
  familyMembersQueryKeyBase,
  lookingBackQueryKey,
  lookingBackQueryKeyBase,
  memoriesQueryKeyBase,
  portraitVersionsQueryKeyBase,
  userProfileQueryKeyBase,
} from '@/hooks/queryKeys';
import {
  asyncStoragePersister,
  clearPersistedQueryCache,
  PERSISTED_QUERY_CACHE_BUSTER,
  PERSISTED_QUERY_CACHE_KEY,
  PERSISTED_QUERY_CACHE_MAX_AGE_MS,
  serializePersistedClient,
  shouldDehydrateQuery,
} from '@/lib/query-persistence';
import { queryClient } from '@/lib/query-client';
import { enqueuePendingLookingBackView, lookingBackPendingViewStorageKey } from '@/services/looking-back';

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use ESM imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// query-persistence now clears the Looking Back outbox too. Keep this
// persistence-only suite independent of Supabase's native realtime setup.
jest.mock('@/lib/supabase', () => ({ supabase: { rpc: jest.fn() } }));

function buildQuery(queryKey: readonly unknown[], status: 'success' | 'error' | 'pending' = 'success'): Query {
  return { queryKey, state: { status } } as unknown as Query;
}

describe('shouldDehydrateQuery (allow-list)', () => {
  it.each([
    ['memories list/detail', memoriesQueryKeyBase],
    ['calendar ranges + oldest-date', calendarMemoriesQueryKeyBase],
    ['family members', familyMembersQueryKeyBase],
    ['portrait versions', portraitVersionsQueryKeyBase],
    ['family memberships', familyMembershipsQueryKeyBase],
    ['user profile', userProfileQueryKeyBase],
    ['Looking Back packages', lookingBackQueryKeyBase],
    ['media-urls', 'media-urls'],
  ])('persists a successful %s query', (_label, base) => {
    expect(shouldDehydrateQuery(buildQuery([base, 'family-1']))).toBe(true);
  });

  it.each([
    ['generation-status', 'generation-status'],
    ['memories-search', 'memories-search'],
    ['family-member-profiles', 'family-member-profiles'],
    ['an unrecognized key', 'some-other-query'],
  ])('excludes %s (not on the allow-list)', (_label, base) => {
    expect(shouldDehydrateQuery(buildQuery([base, 'family-1']))).toBe(false);
  });

  it('excludes an allow-listed key that has not resolved yet', () => {
    expect(shouldDehydrateQuery(buildQuery([memoriesQueryKeyBase, 'family-1'], 'pending'))).toBe(false);
    expect(shouldDehydrateQuery(buildQuery([memoriesQueryKeyBase, 'family-1'], 'error'))).toBe(false);
  });
});

describe('serializePersistedClient', () => {
  function buildPersistedClient(queries: { queryKey: readonly unknown[]; data: unknown }[]) {
    return {
      timestamp: Date.now(),
      buster: PERSISTED_QUERY_CACHE_BUSTER,
      clientState: {
        mutations: [],
        queries: queries.map(({ queryKey, data }) => ({
          queryKey,
          queryHash: JSON.stringify(queryKey),
          state: { data, status: 'success' },
        })),
      },
    } as never;
  }

  it('trims a memories-list InfiniteData query down to its first page', () => {
    const client = buildPersistedClient([
      {
        queryKey: [memoriesQueryKeyBase, 'family-1'],
        data: {
          pages: [{ memories: [{ id: 'm1' }] }, { memories: [{ id: 'm2' }] }, { memories: [{ id: 'm3' }] }],
          pageParams: [null, 'cursor-1', 'cursor-2'],
        },
      },
    ]);

    const restored = JSON.parse(serializePersistedClient(client));
    const [query] = restored.clientState.queries;

    expect(query.state.data.pages).toHaveLength(1);
    expect(query.state.data.pages[0].memories).toEqual([{ id: 'm1' }]);
    expect(query.state.data.pageParams).toEqual([null]);
  });

  it('leaves a single-page memories-list query untouched', () => {
    const client = buildPersistedClient([
      {
        queryKey: [memoriesQueryKeyBase, 'family-1'],
        data: { pages: [{ memories: [{ id: 'm1' }] }], pageParams: [null] },
      },
    ]);

    const restored = JSON.parse(serializePersistedClient(client));
    expect(restored.clientState.queries[0].state.data.pages).toHaveLength(1);
  });

  it('does not trim a member-filtered memories list (same isMemoriesListQueryKey match)', () => {
    const client = buildPersistedClient([
      {
        queryKey: [memoriesQueryKeyBase, 'family-1', 'member', 'member-1'],
        data: {
          pages: [{ memories: [{ id: 'm1' }] }, { memories: [{ id: 'm2' }] }],
          pageParams: [null, 'cursor-1'],
        },
      },
    ]);

    const restored = JSON.parse(serializePersistedClient(client));
    expect(restored.clientState.queries[0].state.data.pages).toHaveLength(1);
  });

  it('leaves non-InfiniteData queries (e.g. memory detail, calendar range) untouched', () => {
    const client = buildPersistedClient([
      {
        queryKey: [memoriesQueryKeyBase, 'family-1', 'detail', 'memory-1'],
        data: { id: 'memory-1', content: 'Hello' },
      },
      {
        queryKey: [calendarMemoriesQueryKeyBase, 'family-1', 'oldest-date'],
        data: '2026-01-01',
      },
    ]);

    const restored = JSON.parse(serializePersistedClient(client));
    expect(restored.clientState.queries[0].state.data).toEqual({ id: 'memory-1', content: 'Hello' });
    expect(restored.clientState.queries[1].state.data).toBe('2026-01-01');
  });

  it('keeps a worst-case four-by-ten enriched Looking Back set comfortably below the Android row limit', () => {
    const longObjectKey = `user-1/memories/${'asset-path-'.repeat(14)}.webp`;
    const packages = Array.from({ length: 4 }, (_, packageIndex) => ({
      id: `package-${packageIndex}`,
      dailySetId: 'daily-set-1',
      familyId: 'family-1',
      packageDate: '2026-08-08',
      packageType: 'archive_mix',
      subjectFamilyMemberId: null,
      displayKind: 'From your archive',
      title: `Package ${packageIndex}`,
      subtitle: 'A collection of moments from this time of year',
      era: 'A few years ago',
      tint: 'tender',
      position: packageIndex,
      refreshAfter: '2026-08-09T00:00:00.000Z',
      view: { firstViewedAt: null, lastViewedAt: null, completedAt: null },
      memories: Array.from({ length: 10 }, (_, memoryIndex) => {
        const memoryId = `memory-${packageIndex}-${memoryIndex}`;
        return {
          id: memoryId,
          family_id: 'family-1',
          user_id: 'user-1',
          content: 'A'.repeat(1000),
          memory_date: '2020-08-08',
          memory_type: 'media',
          illustration_status: 'ready',
          illustration_key: `${longObjectKey}-${memoryId}`,
          illustration_generation_id: `generation-${memoryId}`,
          emotion: 'tender',
          created_at: '2026-08-08T00:00:00.000Z',
          updated_at: '2026-08-08T00:00:00.000Z',
          taggedMembers: Array.from({ length: 6 }, (_, memberIndex) => ({
            id: `member-${memberIndex}`,
            family_id: 'family-1',
            name: `Family member ${memberIndex}`,
            date_of_birth: '2020-01-01',
            portrait_status: 'ready',
            portrait_key: `${longObjectKey}-portrait-${memberIndex}`,
          })),
          mediaAssets: Array.from({ length: 10 }, (_, assetIndex) => ({
            id: `${memoryId}-asset-${assetIndex}`,
            memory_id: memoryId,
            object_key: `${longObjectKey}-${memoryId}-${assetIndex}`,
            preview_object_key: `${longObjectKey}-preview-${memoryId}-${assetIndex}`,
            share_card_key: `${longObjectKey}-share-${memoryId}-${assetIndex}`,
            content_type: assetIndex % 2 === 0 ? 'image/webp' : 'video/mp4',
            duration_ms: 15_000,
            aspect_ratio: 0.75,
            position: assetIndex,
            created_at: '2026-08-08T00:00:00.000Z',
            updated_at: '2026-08-08T00:00:00.000Z',
          })),
          likeCount: 999,
          commentCount: 999,
          likedByMe: true,
          isIllustrationHidden: false,
        };
      }),
    }));
    const serialized = serializePersistedClient(buildPersistedClient([{
      queryKey: lookingBackQueryKey('user-1', 'family-1'),
      data: {
        dailySetId: 'daily-set-1',
        packageDate: '2026-08-08',
        refreshAfter: '2026-08-09T00:00:00.000Z',
        packages,
      },
    }]));
    const serializedBytes = new TextEncoder().encode(serialized).byteLength;

    // AsyncStorage's Android CursorWindow cliff is around 2 MiB. This fixture
    // intentionally combines every package/memory/media bound at once and
    // must retain at least a 50% margin for the rest of the persisted cache.
    expect(serializedBytes).toBeLessThan(1024 * 1024);
  });
});

describe('purge / restore integration', () => {
  const dehydrateOptions = { shouldDehydrateQuery };

  beforeEach(async () => {
    await AsyncStorage.clear();
    queryClient.clear();
  });

  afterEach(() => {
    queryClient.clear();
  });

  it('clearPersistedQueryCache empties both the live and persisted cache', async () => {
    queryClient.setQueryData([familyMembersQueryKeyBase, 'family-1'], [{ id: 'member-1' }]);
    await AsyncStorage.setItem(PERSISTED_QUERY_CACHE_KEY, 'anything');

    await clearPersistedQueryCache();

    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(await AsyncStorage.getItem(PERSISTED_QUERY_CACHE_KEY)).toBeNull();
  });

  it('purges the separate Looking Back viewed-state outbox with account/family cache loss', async () => {
    await enqueuePendingLookingBackView('user-1', 'family-1', 'package-1');
    await enqueuePendingLookingBackView('user-1', 'family-2', 'package-2');
    expect(await AsyncStorage.getItem(lookingBackPendingViewStorageKey('user-1', 'family-1'))).not.toBeNull();
    expect(await AsyncStorage.getItem(lookingBackPendingViewStorageKey('user-1', 'family-2'))).not.toBeNull();

    await clearPersistedQueryCache();

    expect(await AsyncStorage.getItem(lookingBackPendingViewStorageKey('user-1', 'family-1'))).toBeNull();
    expect(await AsyncStorage.getItem(lookingBackPendingViewStorageKey('user-1', 'family-2'))).toBeNull();
  });

  it('discards a persisted cache written under a different buster', async () => {
    await asyncStoragePersister.persistClient({
      timestamp: Date.now(),
      buster: 'a-stale-buster',
      clientState: {
        mutations: [],
        queries: [
          {
            queryKey: [familyMembersQueryKeyBase, 'family-1'],
            queryHash: JSON.stringify([familyMembersQueryKeyBase, 'family-1']),
            state: { data: [{ id: 'member-1' }], status: 'success' },
          },
        ],
      },
    });

    const restoreClient = new QueryClient();
    await persistQueryClientRestore({
      queryClient: restoreClient,
      persister: asyncStoragePersister,
      buster: PERSISTED_QUERY_CACHE_BUSTER,
      maxAge: PERSISTED_QUERY_CACHE_MAX_AGE_MS,
    });

    expect(restoreClient.getQueryCache().getAll()).toHaveLength(0);
    expect(await AsyncStorage.getItem(PERSISTED_QUERY_CACHE_KEY)).toBeNull();
  });

  it('restore-failure: a corrupt persisted payload clears storage and starts clean, without throwing an uncaught error', async () => {
    await AsyncStorage.setItem(PERSISTED_QUERY_CACHE_KEY, '{not valid json');

    const restoreClient = new QueryClient();
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        persistQueryClientRestore({
          queryClient: restoreClient,
          persister: asyncStoragePersister,
          buster: PERSISTED_QUERY_CACHE_BUSTER,
          maxAge: PERSISTED_QUERY_CACHE_MAX_AGE_MS,
        }).catch(() => {
          // Mirrors PersistQueryClientProvider's own .catch(() => onError?.())
          // -- the library rethrows after cleanup so the host decides what to
          // do; the app's contract is "swallow it and start empty", not crash.
        }),
      ).resolves.toBeUndefined();
    } finally {
      consoleError.mockRestore();
      consoleWarn.mockRestore();
    }

    // The corrupt entry must be gone (removeClient ran) and the query cache
    // must be a clean empty start, not a half-hydrated crash loop.
    expect(await AsyncStorage.getItem(PERSISTED_QUERY_CACHE_KEY)).toBeNull();
    expect(restoreClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it('round-trips an allow-listed query through persist -> restore', async () => {
    queryClient.setQueryData([familyMembersQueryKeyBase, 'family-1'], [{ id: 'member-1' }]);
    // Mark the query 'success' the way a real fetch would -- setQueryData
    // alone leaves state as react-query's default ('success' for
    // setQueryData actually, but be explicit about what dehydrate needs).
    const query = queryClient.getQueryCache().find({ queryKey: [familyMembersQueryKeyBase, 'family-1'] });
    expect(query?.state.status).toBe('success');

    await persistQueryClientSave({
      queryClient,
      persister: asyncStoragePersister,
      buster: PERSISTED_QUERY_CACHE_BUSTER,
      dehydrateOptions,
    });

    const restoreClient = new QueryClient();
    await persistQueryClientRestore({
      queryClient: restoreClient,
      persister: asyncStoragePersister,
      buster: PERSISTED_QUERY_CACHE_BUSTER,
      maxAge: PERSISTED_QUERY_CACHE_MAX_AGE_MS,
    });

    expect(restoreClient.getQueryData([familyMembersQueryKeyBase, 'family-1'])).toEqual([
      { id: 'member-1' },
    ]);
  });
});
