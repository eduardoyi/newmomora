// Module-level singleton seen-set for the illustration-ready share-card
// warm (docs/plans/share-card-store-through.md's incident follow-up, see
// 20260806140000_share_card_illustration_key_trigger.sql's header for the
// full incident). Three independent observers can each notice the SAME
// illustration ready transition -- useMemory's detail-hook effect,
// useGenerationStatusPolling, and useMemoriesRealtime (realtime forces a
// poll tick on SUBSCRIBED, and a mounted detail screen races both) -- so the
// seen-set must be ONE singleton imported by all three call sites (via
// handleIllustrationReadyTransition, illustration-ready-transition.ts), not
// per-hook state.
// Mirrors src/lib/illustration-outcome-dedupe.ts's shape exactly.
//
// Keyed on (memoryId, illustrationGenerationId) rather than memoryId alone:
// a regenerated illustration mints a fresh illustration_generation_id (see
// generate-illustration/index.ts's commitDatabase), and that later ready
// transition is a GENUINELY new card to warm -- the staleness trigger
// already cleared the stale share_card_key for it, so skipping the warm
// would just leave that regeneration on the slower cold-compose path
// instead of pre-warming it. Only same-generation duplicate observations
// are deduped.
//
// In-memory only: cross-launch duplicates are acceptable -- a repeat warm
// after a fresh app launch just costs one redundant (idempotent) request to
// compose-share-card's warm mode, same risk profile as
// illustration-outcome-dedupe.ts documents for its own singleton.
const warmedGenerations = new Set<string>();

function warmKey(memoryId: string, illustrationGenerationId: string | null): string {
  return `${memoryId}:${illustrationGenerationId ?? 'unknown'}`;
}

/**
 * Returns `true` exactly once per `(memoryId, illustrationGenerationId)`
 * pair -- callers should fire the share-card warm only when this returns
 * `true`. Subsequent calls with the same pair return `false`.
 *
 * A `null` illustrationGenerationId collapses to a single shared
 * 'unknown' bucket per memory (defensive only -- the ready transition this
 * guards always carries a real generation id in practice, since
 * commitDatabase sets illustration_generation_id and illustration_status
 * together in the same UPDATE) so a caller that can't resolve the id still
 * dedupes across observers instead of warming once per observer.
 */
export function shouldWarmShareCardForReadyTransition(
  memoryId: string,
  illustrationGenerationId: string | null,
): boolean {
  const key = warmKey(memoryId, illustrationGenerationId);
  if (warmedGenerations.has(key)) {
    return false;
  }
  warmedGenerations.add(key);
  return true;
}
