// Dispatch jitter: a batch of films (history backfill, month-end) would
// otherwise create ~20 Fly machines from the same image in the same second,
// and some of those saw a partial root filesystem (Sep 2026). Each machine
// start waits a deterministic pseudo-random 0-45 s first. Derived from the
// attempt id + mode only, so a replayed Workflow computes the same value.
export const MAX_JITTER_SECONDS = 45;

/** FNV-1a 32-bit: small, synchronous, stable across runtimes. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Whole seconds in [0, MAX_JITTER_SECONDS]. */
export function dispatchJitterSeconds(attemptId: string, mode: string): number {
  return fnv1a(`${attemptId}:${mode}`) % (MAX_JITTER_SECONDS + 1);
}
