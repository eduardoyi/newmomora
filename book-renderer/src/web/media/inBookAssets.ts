import type { BookDocument, PhotoSlotContent } from '../../model/types';
import type { MemoryBookEditsShape } from '../../model/edits';

/**
 * Polish-round item 5: the server's own `picker_pool` `alreadyInBook` flag
 * compares a candidate against the MANIFEST's assets — a superset of what's
 * actually PLACED in the fitted book (for a kept-everything-scope book,
 * that's every photo the family has, making the flag true for nearly
 * everything and useless as a filter). This computes the honest, narrower
 * set CLIENT-SIDE, from the fitted document the web app already has in
 * hand — no Edge Function change needed; the server flag stays exactly
 * what it was, used only as a pre-fit fallback (see `PickerSheet.tsx`).
 */
export interface InBookAssets {
  /** R2 object keys (manifest `file` / `PhotoSlotContent.assetFile` values) actually placed on some fitted page or the cover. */
  assetFiles: Set<string>;
  /** `mediaId`s referenced by a saved image edit (replace/cover) — matched directly against `PickerPoolItem.mediaId`, a stronger guarantee than the assetFile comparison for a slot whose file has been edit-substituted (see this module's own doc comment on why both sets exist). */
  mediaIds: Set<string>;
}

export function collectInBookAssets(document: BookDocument, edits: MemoryBookEditsShape): InBookAssets {
  const assetFiles = new Set<string>();
  const mediaIds = new Set<string>();

  for (const page of document.pages) {
    if (page.templateId === 'cover-wrap' && typeof page.params.assetFile === 'string') {
      assetFiles.add(page.params.assetFile);
    }
    for (const slot of page.slots) {
      if (slot.content.kind !== 'photo') continue;
      assetFiles.add((slot.content as PhotoSlotContent).assetFile);
    }
  }

  for (const record of Object.values(edits.images ?? {})) {
    mediaIds.add(record.mediaId);
  }

  return { assetFiles, mediaIds };
}

/** Whether a picker-pool candidate (identified by its own mediaId + the preview key the pool returned) is already placed in the book, per the honest client-side sets above. */
export function isAssetInBook(inBook: InBookAssets, mediaId: string, previewKey: string): boolean {
  return inBook.assetFiles.has(previewKey) || inBook.mediaIds.has(mediaId);
}
