import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, render, waitFor } from '@testing-library/react-native';
import { QueryClient, type Query } from '@tanstack/react-query';
import { persistQueryClientRestore, persistQueryClientSave } from '@tanstack/react-query-persist-client';

import { AppState, Text } from 'react-native';
import React from 'react';

import {
  billingStatusQueryKeyBase,
  blockedFamilyAccountsQueryKeyBase,
  calendarMemoriesQueryKeyBase,
  contentReportsQueryKeyBase,
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
  createQueryCachePersister,
  PERSISTED_CALENDAR_RANGE_MAX,
  PERSISTED_MEDIA_URLS_MAX,
  PERSISTED_MEMORY_DETAIL_MAX,
  PERSISTED_QUERY_CACHE_BUSTER,
  PERSISTED_QUERY_CACHE_KEY,
  PERSISTED_QUERY_CACHE_MAX_AGE_MS,
  PERSISTER_THROTTLE_MS,
  PersistedQueryProvider,
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
    ['content-safety reports', contentReportsQueryKeyBase],
    ['content-safety blocks', blockedFamilyAccountsQueryKeyBase],
  ])('persists a successful %s query', (_label, base) => {
    expect(shouldDehydrateQuery(buildQuery([base, 'family-1']))).toBe(true);
  });

  it.each([
    ['generation-status', 'generation-status'],
    ['memories-search', 'memories-search'],
    ['family-member-profiles', 'family-member-profiles'],
    // Session-only by design (a revealed hidden item must re-hide next launch).
    ['content-safety reveals', 'content-safety-reveals'],
    // Store-customer specific; refetched once RevenueCat configures.
    ['RevenueCat offerings', 'revenuecat-offerings'],
    ['an unrecognized key', 'some-other-query'],
  ])('excludes %s (not on the allow-list)', (_label, base) => {
    expect(shouldDehydrateQuery(buildQuery([base, 'family-1']))).toBe(false);
  });

  it('excludes a date-anchored Timeline list and the month-picker counts', () => {
    expect(shouldDehydrateQuery(buildQuery([memoriesQueryKeyBase, 'family-1', 'anchored', '2025-03-31']))).toBe(false);
    expect(shouldDehydrateQuery(buildQuery(['memory-month-counts', 'family-1']))).toBe(false);
    // The member-filtered list under the same base still persists.
    expect(shouldDehydrateQuery(buildQuery([memoriesQueryKeyBase, 'family-1', 'member', 'm1']))).toBe(true);
  });

  it('excludes an allow-listed key that has not resolved yet', () => {
    expect(shouldDehydrateQuery(buildQuery([memoriesQueryKeyBase, 'family-1'], 'pending'))).toBe(false);
    expect(shouldDehydrateQuery(buildQuery([memoriesQueryKeyBase, 'family-1'], 'error'))).toBe(false);
  });
});

// Billing status is persisted so the cold-start gate in app/index.tsx is
// satisfied from the restored cache -- but only a genuine success payload. The
// queryFn resolves `{ data, error }`, so a 'success' query can hold an error.
describe('shouldDehydrateQuery billing status guard', () => {
  const freshStatus = { family_id: 'family-1', has_write_access: true, cached_at: 1, is_offline: false };
  const billingKey = [billingStatusQueryKeyBase, 'family-1'];

  function billingQuery(data: unknown) {
    return { queryKey: billingKey, state: { status: 'success', data } } as unknown as Query;
  }

  it('persists a real success payload', () => {
    expect(shouldDehydrateQuery(billingQuery({ data: freshStatus, error: null }))).toBe(true);
  });

  it('does not persist a resolved query that carries only an error (data: null)', () => {
    expect(
      shouldDehydrateQuery(billingQuery({ data: null, error: { message: 'Could not check subscription access' } })),
    ).toBe(false);
  });

  it('does not persist an error payload even if it somehow has data', () => {
    expect(shouldDehydrateQuery(billingQuery({ data: freshStatus, error: { message: 'boom' } }))).toBe(false);
  });

  it('does not persist the is_offline fallback read', () => {
    expect(shouldDehydrateQuery(billingQuery({ data: { ...freshStatus, is_offline: true }, error: null }))).toBe(false);
  });

  it.each([[undefined], [null], ['oops'], [{}], [{ data: 'nope', error: null }]])(
    'does not persist a malformed payload (%p)',
    (data) => {
      expect(shouldDehydrateQuery(billingQuery(data))).toBe(false);
    },
  );

  it('does not persist a billing query that has not succeeded', () => {
    expect(
      shouldDehydrateQuery({
        queryKey: billingKey,
        state: { status: 'error', data: { data: freshStatus, error: null } },
      } as unknown as Query),
    ).toBe(false);
  });

  it('applies the guard only to billing: other allow-listed keys with arbitrary data still persist', () => {
    expect(
      shouldDehydrateQuery({
        queryKey: [familyMembersQueryKeyBase, 'family-1'],
        state: { status: 'success', data: null },
      } as unknown as Query),
    ).toBe(true);
  });

  it('keeps the billing key base in lock-step with use-billing', () => {
    // query-persistence cannot import use-billing (use-auth -> query-persistence
    // cycle), so the dependency-free base in queryKeys.ts must match it. The
    // content-safety bases are imported by useContentSafety from queryKeys.ts,
    // so they cannot drift.
    /* eslint-disable @typescript-eslint/no-require-imports -- lazy require keeps the heavy hook graph out of the other tests */
    const { billingStatusQueryKey } = require('@/hooks/use-billing') as typeof import('@/hooks/use-billing');
    /* eslint-enable @typescript-eslint/no-require-imports */
    expect(billingStatusQueryKey[0]).toBe(billingStatusQueryKeyBase);
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
      secondarySubjectFamilyMemberId: null,
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
            waveform: null,
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
          myReaction: null,
          topReactions: [],
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

describe('serializePersistedClient caps', () => {
  function entry(queryKey: readonly unknown[], dataUpdatedAt: number) {
    return {
      queryKey,
      queryHash: JSON.stringify(queryKey),
      state: { data: { at: dataUpdatedAt }, status: 'success', dataUpdatedAt },
    };
  }

  function serialize(queries: ReturnType<typeof entry>[]) {
    const client = {
      timestamp: Date.now(),
      buster: PERSISTED_QUERY_CACHE_BUSTER,
      clientState: { mutations: [], queries },
    } as never;
    return (JSON.parse(serializePersistedClient(client)) as { clientState: { queries: ReturnType<typeof entry>[] } })
      .clientState.queries;
  }

  // Oldest first: index i has dataUpdatedAt i + 1, so the newest are the tail.
  const detail = (count: number) =>
    Array.from({ length: count }, (_, i) => entry([memoriesQueryKeyBase, 'f1', 'detail', `m${i}`], i + 1));
  const calendar = (count: number) =>
    Array.from({ length: count }, (_, i) => entry([calendarMemoriesQueryKeyBase, 'f1', 'range', `s${i}`, `e${i}`], i + 1));
  const media = (count: number) =>
    Array.from({ length: count }, (_, i) => entry(['media-urls', `key-${i}`, ''], i + 1));

  it('keeps only the newest memory-detail queries', () => {
    const queries = serialize(detail(PERSISTED_MEMORY_DETAIL_MAX + 5));
    expect(queries).toHaveLength(PERSISTED_MEMORY_DETAIL_MAX);
    // m0..m4 are the five oldest and are the ones dropped.
    expect(queries.map((q) => q.queryKey[3])).not.toContain('m0');
    expect(queries.map((q) => q.queryKey[3])).not.toContain('m4');
    expect(queries.map((q) => q.queryKey[3])).toContain('m5');
    expect(queries.map((q) => q.queryKey[3])).toContain(`m${PERSISTED_MEMORY_DETAIL_MAX + 4}`);
  });

  it('keeps only the newest calendar range queries', () => {
    const queries = serialize(calendar(PERSISTED_CALENDAR_RANGE_MAX + 3));
    expect(queries.map((q) => q.queryKey[3])).toEqual(
      Array.from({ length: PERSISTED_CALENDAR_RANGE_MAX }, (_, i) => `s${i + 3}`),
    );
  });

  it('keeps only the newest media-urls queries', () => {
    const queries = serialize(media(PERSISTED_MEDIA_URLS_MAX + 2));
    expect(queries).toHaveLength(PERSISTED_MEDIA_URLS_MAX);
    expect(queries.map((q) => q.queryKey[1])).not.toContain('key-0');
    expect(queries.map((q) => q.queryKey[1])).not.toContain('key-1');
    expect(queries.map((q) => q.queryKey[1])).toContain(`key-${PERSISTED_MEDIA_URLS_MAX + 1}`);
  });

  it('caps each category independently and leaves other queries (and lists) alone', () => {
    const list = entry([memoriesQueryKeyBase, 'f1'], 1);
    const members = entry([familyMembersQueryKeyBase, 'f1'], 1);
    const queries = serialize([
      list,
      members,
      ...detail(PERSISTED_MEMORY_DETAIL_MAX + 1),
      ...calendar(PERSISTED_CALENDAR_RANGE_MAX + 1),
      ...media(PERSISTED_MEDIA_URLS_MAX + 1),
    ]);

    expect(queries.filter((q) => q.queryKey[0] === memoriesQueryKeyBase && q.queryKey[2] === 'detail')).toHaveLength(
      PERSISTED_MEMORY_DETAIL_MAX,
    );
    expect(queries.filter((q) => q.queryKey[0] === calendarMemoriesQueryKeyBase)).toHaveLength(
      PERSISTED_CALENDAR_RANGE_MAX,
    );
    expect(queries.filter((q) => q.queryKey[0] === 'media-urls')).toHaveLength(PERSISTED_MEDIA_URLS_MAX);
    // Not a detail query: the list is not counted against the detail cap.
    expect(queries.some((q) => q.queryKey[0] === memoriesQueryKeyBase && q.queryKey.length === 2)).toBe(true);
    expect(queries.some((q) => q.queryKey[0] === familyMembersQueryKeyBase)).toBe(true);
  });

  it('does not drop anything at or below the caps', () => {
    const queries = serialize([
      ...detail(PERSISTED_MEMORY_DETAIL_MAX),
      ...calendar(PERSISTED_CALENDAR_RANGE_MAX),
      ...media(PERSISTED_MEDIA_URLS_MAX),
    ]);
    expect(queries).toHaveLength(PERSISTED_MEMORY_DETAIL_MAX + PERSISTED_CALENDAR_RANGE_MAX + PERSISTED_MEDIA_URLS_MAX);
  });
});

describe('persister throttle', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses a 4s write throttle', async () => {
    expect(PERSISTER_THROTTLE_MS).toBe(4000);
    jest.useFakeTimers();

    const client = (marker: string) => ({
      timestamp: Date.now(),
      buster: PERSISTED_QUERY_CACHE_BUSTER,
      clientState: {
        mutations: [],
        queries: [
          {
            queryKey: [familyMembersQueryKeyBase, marker],
            queryHash: marker,
            state: { data: [], status: 'success' },
          },
        ],
      },
    });

    // The first write goes straight out; a second inside the window waits.
    await asyncStoragePersister.persistClient(client('first') as never);
    expect(await AsyncStorage.getItem(PERSISTED_QUERY_CACHE_KEY)).toContain('first');

    const second = asyncStoragePersister.persistClient(client('second') as never);
    await jest.advanceTimersByTimeAsync(PERSISTER_THROTTLE_MS - 500);
    expect(await AsyncStorage.getItem(PERSISTED_QUERY_CACHE_KEY)).not.toContain('second');

    await jest.advanceTimersByTimeAsync(1000);
    await second;
    expect(await AsyncStorage.getItem(PERSISTED_QUERY_CACHE_KEY)).toContain('second');
  });
});

function renderProvider() {
  return React.createElement(PersistedQueryProvider, null, React.createElement(Text, null, 'ready'));
}

describe('background flush', () => {
  type AppStateHandler = (state: string) => void;
  let handlers: AppStateHandler[];
  let remove: jest.Mock;
  let addEventListener: jest.SpyInstance;

  beforeEach(async () => {
    await AsyncStorage.clear();
    queryClient.clear();
    handlers = [];
    remove = jest.fn();
    addEventListener = jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _type: string,
      handler: AppStateHandler,
    ) => {
      handlers.push(handler);
      return { remove };
    }) as never);
  });

  afterEach(() => {
    addEventListener.mockRestore();
    jest.restoreAllMocks();
    queryClient.clear();
  });

  it('persists immediately on background, ignores foreground, and cleans up on unmount', async () => {
    queryClient.setQueryData([familyMembersQueryKeyBase, 'family-1'], [{ id: 'member-1' }]);

    const view = render(renderProvider());
    await waitFor(() => expect(view.getByText('ready')).toBeTruthy());
    expect(handlers).toHaveLength(1);

    // Make sure whatever the library's own subscriber wrote does not count.
    await AsyncStorage.removeItem(PERSISTED_QUERY_CACHE_KEY);

    await act(async () => {
      handlers[0]('active');
    });
    expect(await AsyncStorage.getItem(PERSISTED_QUERY_CACHE_KEY)).toBeNull();

    await act(async () => {
      handlers[0]('background');
    });
    await waitFor(async () => {
      expect(await AsyncStorage.getItem(PERSISTED_QUERY_CACHE_KEY)).toContain('member-1');
    });

    view.unmount();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('does not subscribe until the persisted cache has been restored', async () => {
    let finishRestore: (value: undefined) => void = () => {};
    jest.spyOn(asyncStoragePersister, 'restoreClient').mockImplementation(
      () => new Promise((resolve) => { finishRestore = resolve; }),
    );

    const view = render(renderProvider());
    expect(view.queryByText('ready')).toBeNull();
    expect(addEventListener).not.toHaveBeenCalled();

    await act(async () => {
      finishRestore(undefined);
    });
    await waitFor(() => expect(view.getByText('ready')).toBeTruthy());
    expect(addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    view.unmount();
  });
});

describe('purge / restore integration', () => {
  const dehydrateOptions = { shouldDehydrateQuery };
  // asyncStoragePersister is throttled (4s) per write; these tests write
  // back-to-back, so persist through an unthrottled persister on the same
  // key/serializer and restore through the real one.
  const savePersister = createQueryCachePersister(0);

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
    await savePersister.persistClient({
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
      persister: savePersister,
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

  it('restores a persisted billing status as stale data, so it revalidates on mount', async () => {
    const key = [billingStatusQueryKeyBase, 'family-1'];
    const status = { family_id: 'family-1', has_write_access: true, cached_at: 1, is_offline: false };
    queryClient.setQueryData(key, { data: status, error: null });
    // Saved a few minutes ago; use-billing's staleTime is 60s.
    const savedAt = Date.now() - 5 * 60 * 1000;
    queryClient.getQueryCache().find({ queryKey: key })!.state.dataUpdatedAt = savedAt;

    await persistQueryClientSave({
      queryClient,
      persister: savePersister,
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

    expect(restoreClient.getQueryData(key)).toEqual({ data: status, error: null });
    const restored = restoreClient.getQueryCache().find({ queryKey: key })!;
    expect(restored.state.dataUpdatedAt).toBe(savedAt);
    expect(restored.isStaleByTime(60 * 1000)).toBe(true);
  });

  it('does not persist a resolved billing error or an offline fallback', async () => {
    queryClient.setQueryData([billingStatusQueryKeyBase, 'family-1'], {
      data: null,
      error: { message: 'Could not check subscription access' },
    });
    queryClient.setQueryData([billingStatusQueryKeyBase, 'family-2'], {
      data: { family_id: 'family-2', is_offline: true },
      error: null,
    });

    await persistQueryClientSave({
      queryClient,
      persister: savePersister,
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

    expect(restoreClient.getQueryCache().getAll()).toHaveLength(0);
  });
});
