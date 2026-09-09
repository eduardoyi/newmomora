import type { BookPage, PhotoSlotContent } from '../../model/types';
import { resolveEditableSlotKey } from './slotKeys';

/** One place a duplicated photo actually sits — a specific slot on a
 * specific page. `pageIndex` is the RAW index into the fitted document's
 * `pages` array (what `computeUnits`/`BookViewScreen`'s own
 * `rawIndexToUnit` map needs to navigate there), `slotKey` is the stable
 * `resolveEditableSlotKey` identity (what tells two occurrences on the
 * SAME page apart). */
export interface AssetOccurrence {
  pageId: string;
  pageIndex: number;
  slotKey: string;
}

/**
 * Item 3 (owner-approved editing-UX round): every `PhotoSlotContent.assetFile`
 * that occupies 2+ photo slots across the fitted document's pages, keyed by
 * that asset file, occurrences kept in DOCUMENT order (so "jump to the next
 * occurrence" always advances forward through the book, wrapping at the
 * end — see `EditOverlay.tsx`'s badge click handler). Serves the owner's own
 * described workflow: place a photo somewhere new, then jump back to its
 * original spot to replace it there too.
 *
 * The cover photo is deliberately excluded — it isn't a `PhotoSlotContent`
 * slot (its file lives on `cover-wrap`'s own `params.assetFile`), and the
 * plan scopes this to photo SLOTS specifically. A photo that's both the
 * cover AND a body photo will show no badge on either occurrence — a
 * narrower, explicitly-scoped behavior, not an oversight.
 */
export function computeDuplicateAssetOccurrences(pages: BookPage[]): Map<string, AssetOccurrence[]> {
  const byAsset = new Map<string, AssetOccurrence[]>();

  pages.forEach((page, pageIndex) => {
    for (const slot of page.slots) {
      if (slot.content.kind !== 'photo') continue;
      const content = slot.content as PhotoSlotContent;
      const occurrence: AssetOccurrence = {
        pageId: page.id,
        pageIndex,
        slotKey: resolveEditableSlotKey(content),
      };
      const list = byAsset.get(content.assetFile);
      if (list) list.push(occurrence);
      else byAsset.set(content.assetFile, [occurrence]);
    }
  });

  for (const [assetFile, occurrences] of byAsset) {
    if (occurrences.length < 2) byAsset.delete(assetFile);
  }

  return byAsset;
}

/**
 * The occurrence a duplicate badge's click should jump to: the next entry
 * in document order after `fromPageId`/`fromSlotKey`, skipping forward past
 * any further occurrence that's still on the SAME page (a badge should
 * always move the viewer somewhere new). Returns `null` when every
 * occurrence lives on the current page (nothing else to jump to) or the
 * list has fewer than 2 entries (shouldn't happen — callers only render a
 * badge once `computeDuplicateAssetOccurrences` already filtered to 2+).
 */
export function nextOtherOccurrence(
  occurrences: AssetOccurrence[],
  fromPageId: string,
  fromSlotKey: string,
): AssetOccurrence | null {
  if (occurrences.length < 2) return null;
  const currentIndex = occurrences.findIndex((o) => o.pageId === fromPageId && o.slotKey === fromSlotKey);
  const start = currentIndex === -1 ? 0 : currentIndex;
  for (let step = 1; step <= occurrences.length; step++) {
    const candidate = occurrences[(start + step) % occurrences.length];
    if (candidate.pageId !== fromPageId) return candidate;
  }
  return null;
}
