// Module-level singleton seen-set for the `illustration_completed` analytics
// event (docs/plans/analytics-implementation.md WP3 item 3). Two independent
// observers -- `useGenerationStatusPolling` and `useMemoriesRealtime` -- can
// each notice the same ready/failed transition (realtime forces a poll tick
// on SUBSCRIBED), so the seen-set must be ONE singleton imported by both
// hooks, not per-hook state. Lives here, not inside `src/services/analytics.ts`,
// so that module stays pure transport.
//
// In-memory only: cross-launch duplicates are acceptable (see the
// implementation plan's risk note) -- this only dedupes within a single app
// session.
export type IllustrationOutcome = 'ready' | 'failed';

const seenOutcomes = new Set<string>();

function outcomeKey(memoryId: string, outcome: IllustrationOutcome): string {
  return `${memoryId}:${outcome}`;
}

/**
 * Returns `true` exactly once per `(memoryId, outcome)` pair -- callers
 * should report the `illustration_completed` event only when this returns
 * `true`. Subsequent calls with the same pair return `false`.
 */
export function shouldReportIllustrationOutcome(memoryId: string, outcome: IllustrationOutcome): boolean {
  const key = outcomeKey(memoryId, outcome);
  if (seenOutcomes.has(key)) {
    return false;
  }
  seenOutcomes.add(key);
  return true;
}
