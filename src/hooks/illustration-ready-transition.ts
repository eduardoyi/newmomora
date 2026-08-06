import type { QueryClient } from '@tanstack/react-query';

import { calendarMemoriesQueryKeyBase } from '@/hooks/queryKeys';
import { shouldWarmShareCardForReadyTransition } from '@/lib/share-card-warm-dedupe';
import { warmShareCardFireAndForget } from '@/services/share-card';

// Deliberately its OWN module, not folded into memory-cache.ts: that file is
// documented as pure cache-SHAPE logic ("Extracted out of useMemories.ts so
// useGenerationStatusPolling and the pending media-upload queue can patch
// the same caches without reimplementing shape detection") and is imported
// by a wide swath of hooks/components that have nothing to do with share
// cards (query-persistence.tsx, app-providers.tsx, useMemoryEngagement.ts,
// useCalendarMemories.ts, ...). warmShareCardFireAndForget's module
// transitively constructs the real Supabase client (src/lib/supabase.ts, at
// IMPORT time, not call time) -- pulling that into memory-cache.ts broke
// every one of those unrelated consumers' tests that don't mock
// '@/lib/supabase' (they never needed to before). Keeping this warm-firing
// side effect in its own module means only the three actual call sites
// (useMemory in useMemories.ts, useGenerationStatusPolling.ts,
// useMemoriesRealtime.ts) pay for that import.

// Central handler for an illustration ready transition (illustration_status
// flips to 'ready' from 'pending'/'generating'). Three independent
// observers can each notice the same transition -- useMemory's detail-hook
// effect, useGenerationStatusPolling's applyStatusPatches, and
// useMemoriesRealtime's UPDATE handler (useMemories.ts,
// useGenerationStatusPolling.ts, useMemoriesRealtime.ts respectively) --
// so this is the ONE place that both invalidates the caches a finished
// illustration affects (unchanged from before this function existed: signed
// media URLs need a fresh look, and the calendar's cached rows for this
// memory are stale) AND fires the store-through share-card cache warm,
// deduped so the three observers produce exactly one warm request per
// illustration generation (see share-card-warm-dedupe.ts's header for why
// text_illustration is the only memory type that reaches this transition,
// and 20260806140000_share_card_illustration_key_trigger.sql for the
// incident this warm timing fixes -- warming at illustration-ready instead
// of at memory-create time means compose-share-card never renders a card
// before the illustration it depends on actually exists).
export function handleIllustrationReadyTransition(
  queryClient: QueryClient,
  memoryId: string,
  illustrationGenerationId: string | null,
): void {
  queryClient.invalidateQueries({ queryKey: ['media-urls'] });
  queryClient.invalidateQueries({ queryKey: [calendarMemoriesQueryKeyBase] });

  if (shouldWarmShareCardForReadyTransition(memoryId, illustrationGenerationId)) {
    warmShareCardFireAndForget(memoryId);
  }
}
