import { COVER_SLOT_KEY, slotKey } from '../../model/edits';
import type { PhotoSlotContent } from '../../model/types';

/**
 * Recovers the STABLE `images`/`focalPoints` edit key for a rendered photo
 * slot, correctly even after that slot's photo has already been replaced by
 * a previous `imageReplace` edit.
 *
 * Why this exists: `edits.ts`'s `slotKey(memoryId, assetFile)` (Design
 * Decision 6) is built from a memory's ORIGINAL manifest asset file —
 * `applyPreFit` looks up the target against the PRISTINE (pre-substitution)
 * manifest. Once an edit has substituted a NEW file into that slot, the
 * rendered `PhotoSlotContent.assetFile` is that new file, so the naive key
 * built from the rendered slot would orphan every subsequent edit on it.
 *
 * Resolution is an EXACT lookup on `editedFromFile` — the slot's pristine
 * identity, stamped by `substituteAsset` at apply time and threaded through
 * the fitter (`ManifestAsset.editedFromFile`'s doc comment). The previous
 * implementation instead reverse-engineered identity by scanning the edit
 * records for one whose substituted FILE matched the rendered file — which
 * collides the moment one photo occupies two slots (owner-hit 2026-09-09:
 * after replacing slot A with a photo that natively lives in slot B, slot
 * B's key resolved to slot A's edit record, so every replace attempted on
 * B silently retargeted A).
 */
export function resolveEditableSlotKey(content: PhotoSlotContent): string {
  return slotKey(content.memoryId, content.editedFromFile ?? content.assetFile);
}

/** Same idea for the cover slot, which is always the literal `'cover'` key
 * regardless of whether it's been edited — kept as a tiny wrapper so call
 * sites never hardcode the sentinel string themselves. */
export function coverSlotKey(): string {
  return COVER_SLOT_KEY;
}
