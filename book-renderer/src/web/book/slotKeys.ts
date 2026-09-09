import { COVER_SLOT_KEY, slotKey } from '../../model/edits';
import type { BookPage, PhotoSlotContent } from '../../model/types';

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

/**
 * Item 4 (owner-approved editing-UX round): finds the page currently
 * rendering the STABLE editable slot `slotKey` — how `BookViewScreen`
 * locates a just-saved image edit's page after the document refits (the
 * slot may have moved), and how it decides which page to compare
 * before/after for the full-bleed/panorama demotion notice (see
 * `reflowNotice.ts`). The cover slot carries no `PhotoSlotContent` of its
 * own to key off (its file lives on `cover-wrap`'s own
 * `params.assetFile`), so it resolves to the `cover-wrap` page directly.
 * `null` if the slot doesn't render anywhere in `pages` (shouldn't happen
 * for a slot that was just successfully saved, but never assumed —
 * mirrors `SkippedEditsToast`'s own "orphans cleanly" posture).
 */
export function findPageForEditableSlot(pages: BookPage[], slotKey: string): BookPage | null {
  if (slotKey === COVER_SLOT_KEY) {
    return pages.find((page) => page.templateId === 'cover-wrap') ?? null;
  }
  for (const page of pages) {
    for (const slot of page.slots) {
      if (slot.content.kind !== 'photo') continue;
      if (resolveEditableSlotKey(slot.content as PhotoSlotContent) === slotKey) return page;
    }
  }
  return null;
}
