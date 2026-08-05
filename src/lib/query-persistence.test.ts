import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, type Query } from '@tanstack/react-query';
import { persistQueryClientRestore, persistQueryClientSave } from '@tanstack/react-query-persist-client';

import {
  calendarMemoriesQueryKeyBase,
  familyMembershipsQueryKeyBase,
  familyMembersQueryKeyBase,
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

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use ESM imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

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
  function buildPersistedClient(queries: Array<{ queryKey: readonly unknown[]; data: unknown }>) {
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
});

describe('purge / restore integration', () => {
  const dehydrateOptions = { shouldDehydrateQuery };

  beforeEach(async () => {
    await AsyncStorage.clear();
    queryClient.clear();
  });

  it('clearPersistedQueryCache empties both the live and persisted cache', async () => {
    queryClient.setQueryData([familyMembersQueryKeyBase, 'family-1'], [{ id: 'member-1' }]);
    await AsyncStorage.setItem(PERSISTED_QUERY_CACHE_KEY, 'anything');

    await clearPersistedQueryCache();

    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(await AsyncStorage.getItem(PERSISTED_QUERY_CACHE_KEY)).toBeNull();
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
