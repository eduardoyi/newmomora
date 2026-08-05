import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
    // networkMode decision (docs/plans/offline-awareness-and-share-cards.md
    // O6, load-bearing): v5 mutations default to `networkMode: 'online'`.
    // Nothing set `onlineManager` before src/lib/connectivity.ts, so that
    // default was inert -- mutations never paused. The moment connectivity
    // wiring starts reflecting real device state, every `useMutation` in the
    // app (useMemories, useMemoryEngagement, useUserProfile,
    // usePortraitVersions, useMemberManagement, useContentSafety,
    // use-billing, useFamilyMembers, useFamilyInvites, ...) would silently
    // switch to pause-and-replay: mutateAsync hangs while offline, then
    // fires later -- spinners never resolve, posts fire after the user gave
    // up. Queries keep the default 'online' semantics (pausing queries
    // offline is exactly what we want); mutations are pinned to 'always' so
    // they fail fast with a normal network error instead, matching the
    // inline-error UX in new-memory.tsx and use-pending-memory-uploads.tsx.
    // See query-client.test.ts for a test pinning this default.
    mutations: {
      networkMode: 'always',
    },
  },
});
