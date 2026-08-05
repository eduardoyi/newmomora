import { onlineManager } from '@tanstack/react-query';

// React Native's fetch implementation throws a plain TypeError with this
// (or a very similar) message on connectivity loss; other transports
// (timeouts, DNS failures) tend to mention "network", "fetch", "timeout",
// or "connection" too. This is intentionally a heuristic, not a discriminated
// error type: postMediaMemory's error path (src/services/memory-posting.ts
// toError) collapses every failure -- validation, content-safety rejection,
// usage-limit, and genuine network failures alike -- down to a plain `Error`
// with only a `.message`, so there is no structured `code` left to switch on
// by the time it reaches the pending-uploads queue.
const NETWORK_ERROR_MESSAGE_PATTERN = /network|fetch|time(d)?[\s-]?out|connection|offline/i;

// Used by use-pending-memory-uploads.tsx (O6,
// docs/plans/offline-awareness-and-share-cards.md) to decide which failed
// posts are safe to auto-retry on reconnect: a network-caused failure is
// worth a fresh attempt once connectivity returns (the device just
// couldn't reach the server), but a content-safety rejection or
// validation/usage-limit failure would just fail again identically --
// auto-retrying those would re-fire doomed posts and double-count
// `memory_save_failed` analytics.
export function isNetworkFailure(error: unknown): boolean {
  if (error instanceof Error && NETWORK_ERROR_MESSAGE_PATTERN.test(error.message)) {
    return true;
  }

  // Corroborating signal for a network error whose message doesn't happen
  // to match the pattern above: the device is offline RIGHT NOW. This can
  // only false-positive if some other kind of failure coincidentally landed
  // in the same tick the device dropped offline -- an acceptable tradeoff
  // for not missing genuine network failures with unfamiliar wording.
  return !onlineManager.isOnline();
}
