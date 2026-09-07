import { COVER_SLOT_KEY, slotKey, type MemoryBookEditsShape } from '../../model/edits';
import type { PhotoSlotContent } from '../../model/types';

/**
 * Recovers the STABLE `images`/`focalPoints` edit key for a rendered photo
 * slot, correctly even after that slot's photo has already been replaced by
 * a previous `imageReplace` edit.
 *
 * Why this is needed: `edits.ts`'s `slotKey(memoryId, assetFile)` (Design
 * Decision 6) is built from a memory's ORIGINAL manifest asset file —
 * `applyPreFit` looks up `nextManifest.memories[memoryId].assets.find(a =>
 * a.file === assetFile)` against the PRISTINE (pre-substitution) manifest.
 * Once an edit has substituted a NEW file into that slot, the rendered
 * `PhotoSlotContent.assetFile` the templates show is that NEW file — naively
 * building `slotKey(memoryId, content.assetFile)` from the RENDERED slot
 * would therefore construct a key that no longer resolves against the
 * pristine manifest (the original file is gone from `content.assetFile`),
 * silently orphaning every subsequent edit (reposition, or a second
 * replace) on an already-edited slot.
 *
 * The fix: `edits.images` already tells us, for every `imageReplace`/
 * `coverPhoto` record, which substituted `file` was written into which
 * stable key (`record.slot`) — so a slot whose CURRENT `assetFile` matches
 * some edit's `record.file` recovers that edit's own key directly (already
 * correct, whatever it is); a slot that matches no edit's substituted file
 * is UNedited, meaning its current `assetFile` IS the original one, so the
 * ordinary `slotKey(memoryId, assetFile)` is correct as-is.
 */
export function resolveEditableSlotKey(content: PhotoSlotContent, edits: MemoryBookEditsShape): string {
  for (const [key, record] of Object.entries(edits.images ?? {})) {
    if (record.file === content.assetFile && key !== COVER_SLOT_KEY) {
      return key;
    }
  }
  return slotKey(content.memoryId, content.assetFile);
}

/** Same idea for the cover slot, which is always the literal `'cover'` key
 * regardless of whether it's been edited — kept as a tiny wrapper so call
 * sites never hardcode the sentinel string themselves. */
export function coverSlotKey(): string {
  return COVER_SLOT_KEY;
}
