// A tiny deterministic string hash -- picks a stable SoundTrace seed for a
// SAVED audio memory (keyed on the memory's own id, which never changes),
// mirroring the `seedFromUri` helpers new-memory.tsx and
// voice-speak-it-modal.tsx already declare locally for an UNSAVED clip's
// local recording URI (docs/plans/audio-memories-v1.md P2.2/P2.3 -- those
// predate this file and hash a different kind of key, so they're left as
// their own local copies rather than migrated here). Every Phase 3 surface
// that renders a saved audio memory's trace/tile/mark without already
// holding a clip-specific seed reaches for this one instead of re-deriving
// its own, so the same clip draws the identical "hand-inked" line on every
// screen (card, detail, calendar stamp, member-profile thumb).
export function seedFromKey(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) % 233280;
  }
  return Math.abs(hash) || 1;
}
