import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { useIsRestoring, type InfiniteData, type Query } from '@tanstack/react-query';
import {
  PersistQueryClientProvider,
  persistQueryClientSave,
  type PersistedClient,
} from '@tanstack/react-query-persist-client';
import { useEffect, type ReactNode } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';

import { BrandSplash } from '@/components/brand-splash';
import { isMemoriesListQueryKey } from '@/hooks/memory-cache';
import {
  ANCHORED_MEMORIES_KEY_SEGMENT,
  billingStatusQueryKeyBase,
  blockedFamilyAccountsQueryKeyBase,
  calendarMemoriesQueryKeyBase,
  contentReportsQueryKeyBase,
  familyMembershipsQueryKeyBase,
  familyMembersQueryKeyBase,
  lookingBackQueryKeyBase,
  memoriesQueryKeyBase,
  portraitVersionsQueryKeyBase,
  userProfileQueryKeyBase,
} from '@/hooks/queryKeys';
import { queryClient } from '@/lib/query-client';
import { clearAllLookingBackPendingViews } from '@/services/looking-back';

// Cold-start offline reads (docs/plans/offline-awareness-and-share-cards.md
// O4): the whole dehydrated client is stored under this ONE AsyncStorage
// key. Android throws "Row too big to fit into CursorWindow" reading rows
// over ~2MB from SQLite-backed storage -- writes succeed, restores fail,
// and a heavy user (this feature's target audience) silently loses offline
// cold-start. serializePersistedClient below trims every InfiniteData list
// query down to its first page before it's ever written, which is the
// primary defense; the library's own restore path (persistQueryClientRestore
// in @tanstack/query-persist-client-core) already treats ANY throw during
// restore -- a corrupt payload, an oversized read, whatever -- as "clear
// storage and start empty" rather than crashing, which is what keeps a
// pre-existing oversized payload (written before this trimming shipped, or
// hit some other size cliff) from becoming a boot loop. See
// query-persistence.test.ts's restore-failure case.
export const PERSISTED_QUERY_CACHE_KEY = 'momora-query-cache';

// Bump whenever a persisted query's cached SHAPE changes in a way an older
// persisted entry can't be safely hydrated into (the InfiniteData migration,
// docs/plans/performance-optimizations.md Workstream A, is the cautionary
// tale this guards against). A buster mismatch makes the library discard
// the whole persisted cache instead of feeding stale-shaped data into a
// hook that assumes the new one.
// v3: memories gained myReaction/topReactions (emoji reactions).
// Adding keys to the allow-list (family-billing-status, content-reports,
// blocked-family-accounts) deliberately did NOT bump this: a buster guards
// the shape of entries an older build already wrote, and those three never
// existed in any older persisted blob, so there is nothing stale-shaped to
// hydrate. Bumping would only throw away every user's warm cache on update.
export const PERSISTED_QUERY_CACHE_BUSTER = 'v3';

export const PERSISTED_QUERY_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Allow-list, not a deny-list: a query only persists if its base key is
// named here. New query types default to NOT persisting -- that's the safe
// direction (worst case is an extra cold-start network round-trip) versus
// silently persisting something like generation-status or a search result
// that should never survive a restart.
const PERSISTABLE_QUERY_KEY_BASES: readonly unknown[] = [
  // Memories lists (InfiniteData, trimmed to first page by the custom
  // serialize below) AND memory detail (nested under the same base --
  // see memoryDetailQueryKey in queryKeys.ts).
  memoriesQueryKeyBase,
  // The Timeline Calendar view's month-range fetches, nested under this base.
  calendarMemoriesQueryKeyBase,
  familyMembersQueryKeyBase,
  portraitVersionsQueryKeyBase,
  familyMembershipsQueryKeyBase,
  userProfileQueryKeyBase,
  // The daily set is bounded (four package DTOs plus at most forty enriched
  // memories) and account-scoped in its query key. Persisting it preserves
  // the last known rail during an offline cold start without adding a second
  // large AsyncStorage row.
  lookingBackQueryKeyBase,
  // Signed R2 URLs. An expired persisted URL is harmless: expo-image's
  // cacheKey (O5) means a disk-cache hit never touches the network, and a
  // miss just fails the same way an absent URL would -- but EXCLUDING this
  // key would mean an offline cold start never gives useMediaUrl anything
  // to hand expo-image in the first place, defeating O5's cacheKey work
  // entirely. See docs/features/offline.md "Why media-urls is persisted".
  'media-urls',
  // Billing status is persisted so index.tsx's cold-start gate
  // (`memberships.length > 0 && !billingStatus && isBillingLoading`) is
  // satisfied from the restored cache instead of waiting on a NetInfo + RPC
  // round trip. It restores stale (staleTime 60s) and revalidates on mount.
  // Only a real success payload is dehydrated -- see
  // isPersistableBillingStatusData. docs/features/subscriptions.md
  // "Cold start and persisted status".
  billingStatusQueryKeyBase,
  // The memory detail screen shows a full-screen spinner while the content-
  // safety reports/blocks queries load; unpersisted, a cold open (widget,
  // notification) waited on two network calls even with the memory cached.
  // Both are account+family scoped in their keys and purged with the rest of
  // the cache on sign-out/family loss. 'content-safety-reveals' is NOT here:
  // it is session-only by design (a hidden item the user chose to reveal must
  // re-hide on the next launch).
  contentReportsQueryKeyBase,
  blockedFamilyAccountsQueryKeyBase,
  // EXCLUDED deliberately: 'generation-status' (poll-only, meaningless
  // hydrated), 'memories-search' (transient results), 'family-member-profiles',
  // 'revenuecat-offerings' (store-customer specific, re-fetched once RevenueCat
  // configures) and 'content-safety-reveals' (not in this list --
  // default-excluded).
];

function isPersistableQueryKey(queryKey: readonly unknown[]): boolean {
  return PERSISTABLE_QUERY_KEY_BASES.includes(queryKey[0]);
}

// fetchFamilyBillingStatus resolves `{ data, error }` rather than throwing, so
// a query can be status 'success' while carrying `data: null` + an error
// object (RPC failed, no usable offline cache). Persisting that would make the
// next launch's index.tsx render BillingStatusGate from a stale error before
// any network call. `is_offline: true` is itself a fallback read of the
// AsyncStorage billing cache (see services/billing.ts), not fresh server
// truth, so it is also never restored as if it were.
function isPersistableBillingStatusData(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const { data: status, error } = data as { data?: unknown; error?: unknown };
  if (error || !status || typeof status !== 'object') return false;
  return (status as { is_offline?: unknown }).is_offline !== true;
}

// Only a query that actually resolved is worth restoring -- mirrors
// react-query's own `defaultShouldDehydrateQuery` (status === 'success')
// AND narrows to the allow-list above.
export function shouldDehydrateQuery(query: Query): boolean {
  return (
    query.state.status === 'success' &&
    isPersistableQueryKey(query.queryKey) &&
    (query.queryKey[0] !== billingStatusQueryKeyBase || isPersistableBillingStatusData(query.state.data)) &&
    // A date-anchored Timeline list is a transient view, not the feed: restoring
    // it on cold start would reopen the app somewhere in the past.
    query.queryKey[2] !== ANCHORED_MEMORIES_KEY_SEGMENT
  );
}

// Caps on what serializePersistedClient WRITES (the in-memory cache is
// untouched). Each keeps the newest queries by `state.dataUpdatedAt`, so the
// one AsyncStorage row stays bounded however long the app has been used.
/** Newest memory-detail queries (under memoriesQueryKeyBase, segment 'detail') kept on disk. */
export const PERSISTED_MEMORY_DETAIL_MAX = 30;
/** Newest Timeline Calendar month-range queries kept on disk. */
export const PERSISTED_CALENDAR_RANGE_MAX = 6;
// The timeline's first page is re-fetched on every launch, so its media-urls
// queries always carry the newest dataUpdatedAt and survive this cap -- an
// offline cold start of the first page keeps its signed URLs.
/** Newest 'media-urls' queries (each covers a group of up to 50 object keys) kept on disk. */
export const PERSISTED_MEDIA_URLS_MAX = 400;

type PersistedQueries = PersistedClient['clientState']['queries'];

function isMemoryDetailQueryKey(queryKey: readonly unknown[]): boolean {
  return queryKey[0] === memoriesQueryKeyBase && queryKey[2] === 'detail';
}

function isCalendarRangeQueryKey(queryKey: readonly unknown[]): boolean {
  return queryKey[0] === calendarMemoriesQueryKeyBase;
}

function isMediaUrlsQueryKey(queryKey: readonly unknown[]): boolean {
  return queryKey[0] === 'media-urls';
}

// Drops all but the `max` most recently updated queries among those matching
// `matches`; non-matching queries and relative order are preserved.
function keepNewest(
  queries: PersistedQueries,
  matches: (queryKey: readonly unknown[]) => boolean,
  max: number,
): PersistedQueries {
  const matching = queries.filter((query) => matches(query.queryKey));
  if (matching.length <= max) {
    return queries;
  }

  const keep = new Set(
    matching
      .sort((a, b) => (b.state.dataUpdatedAt ?? 0) - (a.state.dataUpdatedAt ?? 0))
      .slice(0, max),
  );
  return queries.filter((query) => !matches(query.queryKey) || keep.has(query));
}

function isInfiniteData(value: unknown): value is InfiniteData<unknown> {
  return Boolean(value) && typeof value === 'object' && Array.isArray((value as InfiniteData<unknown>).pages);
}

// Trims every persisted memories-list query (the unfiltered timeline AND
// any cached member-filtered variant) down to its first loaded page before
// it's ever written to disk. A deep-scrolled timeline otherwise persists
// every loaded page of enriched rows under the one AsyncStorage key -- see
// the CursorWindow comment above. Restored data is stale-but-visible either
// way; O3's reconnect/foreground trim-refresh reconciles from page 1
// regardless of how many pages were cached in memory, so trimming before
// persist is functionally free. Memory-detail, calendar-range and media-urls
// queries are additionally capped to their newest N (see the
// PERSISTED_*_MAX constants).
export function serializePersistedClient(persistedClient: PersistedClient): string {
  let queries = persistedClient.clientState.queries;
  queries = keepNewest(queries, isMemoryDetailQueryKey, PERSISTED_MEMORY_DETAIL_MAX);
  queries = keepNewest(queries, isCalendarRangeQueryKey, PERSISTED_CALENDAR_RANGE_MAX);
  queries = keepNewest(queries, isMediaUrlsQueryKey, PERSISTED_MEDIA_URLS_MAX);

  const trimmed: PersistedClient = {
    ...persistedClient,
    clientState: {
      ...persistedClient.clientState,
      queries: queries.map((query) => {
        if (!isMemoriesListQueryKey(query.queryKey)) {
          return query;
        }

        const data = query.state.data;
        if (!isInfiniteData(data) || data.pages.length <= 1) {
          return query;
        }

        return {
          ...query,
          state: {
            ...query.state,
            data: {
              pages: data.pages.slice(0, 1),
              pageParams: data.pageParams.slice(0, 1),
            },
          },
        };
      }),
    },
  };

  return JSON.stringify(trimmed);
}

// The library saves on every query-cache event (scrolling the timeline fires
// them constantly), each a full re-serialize of the one row. 4s keeps writes
// off the hot path; usePersistOnBackground flushes so the last change is
// never lost to the wider window.
export const PERSISTER_THROTTLE_MS = 4000;

export function createQueryCachePersister(throttleTime: number) {
  return createAsyncStoragePersister({
    storage: AsyncStorage,
    key: PERSISTED_QUERY_CACHE_KEY,
    serialize: serializePersistedClient,
    throttleTime,
  });
}

export const asyncStoragePersister = createQueryCachePersister(PERSISTER_THROTTLE_MS);

// Same key/serializer, no throttle. persistQueryClientSave on the throttled
// persister would still wait out the remaining window (asyncThrottle sleeps
// until nextExecutionTime), which is exactly what a background flush must not
// do -- the JS thread can be suspended within seconds of leaving the app.
const flushPersister = createQueryCachePersister(0);

// Persists the live cache immediately when the app leaves the foreground.
// 'inactive' is iOS-only (app-switcher / control-center pull-down); Android
// goes straight to 'background'. `enabled` must be false until restore has
// finished: flushing the still-empty cache would overwrite the stored one
// before it was hydrated.
function usePersistOnBackground(enabled: boolean) {
  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'background' || (state === 'inactive' && Platform.OS === 'ios')) {
        void persistQueryClientSave({
          queryClient,
          persister: flushPersister,
          buster: PERSISTED_QUERY_CACHE_BUSTER,
          dehydrateOptions: { shouldDehydrateQuery },
        }).catch(() => {
          // Best-effort: the throttled subscriber write remains the fallback.
        });
      }
    });

    return () => subscription.remove();
  }, [enabled]);
}

// Purges the persisted cache AND the live in-memory cache. Call on
// sign-out, account deletion, and leaving/being removed from a family (see
// call sites in use-auth.tsx and use-family.tsx) -- a device handed to
// another user, or a former member re-opening the app, must never cold-boot
// into memories they no longer have access to. Persisted data is scoped by
// familyId inside each query key, but the whole client lives under one
// AsyncStorage key (see PERSISTED_QUERY_CACHE_KEY above), so there's no
// cheaper way to evict just one family's slice -- a full purge here is the
// deliberately blunt, safe option.
export async function clearPersistedQueryCache(): Promise<void> {
  queryClient.clear();
  await Promise.all([
    asyncStoragePersister.removeClient(),
    clearAllLookingBackPendingViews(),
  ]);
}

function RestoreGate({ children }: { children: ReactNode }) {
  const isRestoring = useIsRestoring();
  usePersistOnBackground(!isRestoring);

  if (isRestoring) {
    return <BrandSplash />;
  }

  return <>{children}</>;
}

// Swaps QueryClientProvider for PersistQueryClientProvider (AppProviders)
// and holds `children` on the branded splash (BrandSplash) until the persisted
// cache has been restored (or definitively failed to restore) -- restore
// from AsyncStorage is fast (<100ms typical), so this removes the
// empty-state-flash risk that would otherwise come from AuthProvider/
// FamilyProvider mounting and firing their own queries WHILE restore is
// still in flight.
export function PersistedQueryProvider({ children }: { children: ReactNode }) {
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister: asyncStoragePersister,
        buster: PERSISTED_QUERY_CACHE_BUSTER,
        maxAge: PERSISTED_QUERY_CACHE_MAX_AGE_MS,
        dehydrateOptions: { shouldDehydrateQuery },
      }}
    >
      <RestoreGate>{children}</RestoreGate>
    </PersistQueryClientProvider>
  );
}
