// "Posted this session" marker for the Timeline artwork reveal
// (docs/plans/artwork-scanning-v2.md decision 8). The pending-uploads queue
// marks a freshly posted artwork memory right before it replaces its pending
// card in the list caches; the ArtworkCard that mounts for it consumes the
// mark once and plays the swing-in. Memories loaded from the server or
// refetched were never marked, so they never animate, and a consumed mark is
// gone -- a remount (scroll away and back, refetch) can't replay it.
//
// In memory only, on purpose: a cold start must never replay a reveal.

const pendingReveals = new Set<string>();

export function markArtworkForReveal(memoryId: string): void {
  pendingReveals.add(memoryId);
}

/** True exactly once per mark. */
export function consumeArtworkReveal(memoryId: string): boolean {
  return pendingReveals.delete(memoryId);
}

/** Test seam: clears every outstanding mark. */
export function resetArtworkReveals(): void {
  pendingReveals.clear();
}
