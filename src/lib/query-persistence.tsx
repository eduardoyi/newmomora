import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { useIsRestoring, type InfiniteData, type Query } from '@tanstack/react-query';
import {
  PersistQueryClientProvider,
  type PersistedClient,
} from '@tanstack/react-query-persist-client';
import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { colors } from '@/constants/theme';
import { isMemoriesListQueryKey } from '@/hooks/memory-cache';
import {
  calendarMemoriesQueryKeyBase,
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
export const PERSISTED_QUERY_CACHE_BUSTER = 'v2';

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
  // Calendar ranges + the 'oldest-date' entry, both nested under this base.
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
  // EXCLUDED deliberately: 'generation-status' (poll-only, meaningless
  // hydrated), 'memories-search' (transient results), 'family-member-profiles'
  // and billing/session state (not in this list -- default-excluded).
];

function isPersistableQueryKey(queryKey: readonly unknown[]): boolean {
  return PERSISTABLE_QUERY_KEY_BASES.includes(queryKey[0]);
}

// Only a query that actually resolved is worth restoring -- mirrors
// react-query's own `defaultShouldDehydrateQuery` (status === 'success')
// AND narrows to the allow-list above.
export function shouldDehydrateQuery(query: Query): boolean {
  return query.state.status === 'success' && isPersistableQueryKey(query.queryKey);
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
// persist is functionally free.
export function serializePersistedClient(persistedClient: PersistedClient): string {
  const trimmed: PersistedClient = {
    ...persistedClient,
    clientState: {
      ...persistedClient.clientState,
      queries: persistedClient.clientState.queries.map((query) => {
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

export const asyncStoragePersister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: PERSISTED_QUERY_CACHE_KEY,
  serialize: serializePersistedClient,
});

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

  if (isRestoring) {
    return (
      <View style={styles.restoring}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  return <>{children}</>;
}

// Swaps QueryClientProvider for PersistQueryClientProvider (AppProviders)
// and holds `children` on a splash-equivalent spinner until the persisted
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

const styles = StyleSheet.create({
  restoring: {
    alignItems: 'center',
    backgroundColor: colors.background,
    flex: 1,
    justifyContent: 'center',
  },
});
