import { useState, type RefObject } from 'react';
import type { BookManifest, BookPage, PhotoSlotContent } from '../../model/types';
import type { MemoryBookEditsShape } from '../../model/edits';
import type { UndoAction } from '../edits/editsApi';
import { PickerSheet } from '../edits/PickerSheet';
import { FocalPointModal } from '../edits/FocalPointModal';
import { useOverlayGeometry, type PositionedPhotoRegion } from './useOverlayGeometry';
import { TextEditPopover } from './TextEditPopover';
import { needsReposition } from './repositionGate';
import type { InBookAssets } from '../media/inBookAssets';
import { nextOtherOccurrence, type AssetOccurrence } from '../book/duplicateAssets';
import './EditOverlay.css';

/** Approximate front-cover-panel aspect for the focal-point crop preview —
 * `WraparoundCover` derives its front-panel geometry internally from
 * `PHYSICAL.pageSizeMm` rather than exposing it in `params`, so this is a
 * stated approximation, not the exact render (same caveat
 * `FocalPointModal.tsx`'s own header comment makes about the crop preview
 * generally). */
const COVER_APPROX_ASPECT = 1;

/**
 * Geometry-overlay in-place editing surface (polish-round item 3): an
 * absolutely-positioned sibling layer over the rendered spread, driven
 * entirely by the fitted document's own slot/field data via
 * `useOverlayGeometry`. Adds ZERO props/markup to any template component —
 * see `geometry.ts`'s and `useOverlayGeometry.ts`'s header comments for how
 * the mapping works without touching template internals.
 *
 * `containerRef` must point at a `position: relative` element that wraps
 * exactly the rendered `<SpreadPager>` this overlay sits on top of — every
 * region rect `useOverlayGeometry` produces is relative to that SAME
 * element's own bounding box (see `BookViewScreen.tsx`'s `book-view__stage`
 * wrapper, shared with item 1's viewport-fit sizing).
 */
export function EditOverlay({
  bookId,
  familyId,
  containerRef,
  pages,
  manifest,
  edits,
  inBookAssets,
  duplicateOccurrences,
  onNavigateToPage,
  onEditsSaved,
}: {
  bookId: string;
  /** Threaded down to `PickerSheet`'s person filter (item 1) — see
   * `useFamilyMembers.ts`'s own doc comment for why this is a plain prop
   * rather than a second `picker_pool` server round trip. */
  familyId: string;
  containerRef: RefObject<HTMLElement | null>;
  pages: BookPage[];
  manifest: BookManifest;
  edits: MemoryBookEditsShape;
  inBookAssets: InBookAssets;
  /** Item 3: every asset file duplicated across the WHOLE fitted document
   * (not just the pages currently on screen) — computed once by
   * `BookViewScreen` from `data.document.pages`, see
   * `duplicateAssets.ts`'s own doc comment. */
  duplicateOccurrences: Map<string, AssetOccurrence[]>;
  /** Item 3's badge click target — `BookViewScreen` owns the unit/page
   * navigation state this overlay has no access to. Takes a RAW document
   * page index (`AssetOccurrence.pageIndex`), same currency
   * `computeUnits`'s `rawIndices` uses. */
  onNavigateToPage: (rawPageIndex: number) => void;
  onEditsSaved: (edits: MemoryBookEditsShape, undo: UndoAction) => void;
}) {
  const { photoRegions, textRegions } = useOverlayGeometry(containerRef, pages, edits, manifest);
  const [activePhotoKey, setActivePhotoKey] = useState<string | null>(null);
  const [pickerRegion, setPickerRegion] = useState<PositionedPhotoRegion | null>(null);
  const [focalRegion, setFocalRegion] = useState<PositionedPhotoRegion | null>(null);
  // Bug fix (owner-reported, "diagnose live" round): tracks only the WHICH
  // (a stable `target` string), never the captured `PositionedTextRegion`
  // object itself. `useOverlayGeometry` recomputes `textRegions` live off a
  // `ResizeObserver`/`MutationObserver` (window resize, an image finishing
  // load, the popover's OWN mount, ...), but this piece of state used to
  // hold a POSITION SNAPSHOT taken at click time that never got refreshed —
  // reproduced live: open a text popover, then resize the window (which the
  // new fit-to-viewport hook, `useFitToViewportWidth`, reacts to by
  // resizing `.book-view__stage`, reflowing every page-frame under it) —
  // the underlying text visibly moves to its new position while the
  // popover stayed frozen at the old one, "floating detached" below/beside
  // where the text actually ended up. Deriving the region fresh from the
  // live `textRegions` array below (same pattern the photo regions already
  // use, which render straight off live data with no separate snapshot)
  // keeps the popover glued to its text through every relayout while open.
  const [activeTextTarget, setActiveTextTarget] = useState<string | null>(null);
  const textRegion = activeTextTarget ? (textRegions.find((r) => r.target === activeTextTarget) ?? null) : null;

  function targetAspectFor(region: PositionedPhotoRegion): number | null {
    if (region.isCover) return null;
    for (const page of pages) {
      for (const slot of page.slots) {
        if (slot.content.kind !== 'photo') continue;
        const content = slot.content as PhotoSlotContent;
        if (content.memoryId === region.memoryId && content.assetFile === region.assetFile) return content.targetAspect;
      }
    }
    return null;
  }

  /**
   * Reposition gating (polish-round item 1): the photo's own native aspect
   * ratio, alongside `targetAspectFor`'s crop-box aspect, feeds
   * `needsReposition` (`repositionGate.ts`) to decide whether the
   * Reposition button is worth offering. For an ordinary slot this is
   * `PhotoSlotContent.assetAspectRatio`, already on the fitted document —
   * no extra lookup. The cover slot carries no `PhotoSlotContent` (its
   * photo lives in `cover-wrap`'s own `params.assetFile`), so this falls
   * back to a manifest-wide lookup by file name, same "photo aspect data
   * that exists" spirit as `COVER_APPROX_ASPECT`'s own documented
   * approximation for the cover's SLOT aspect below.
   */
  function nativeAspectFor(region: PositionedPhotoRegion): number | null {
    if (!region.isCover) {
      for (const page of pages) {
        for (const slot of page.slots) {
          if (slot.content.kind !== 'photo') continue;
          const content = slot.content as PhotoSlotContent;
          if (content.memoryId === region.memoryId && content.assetFile === region.assetFile) return content.assetAspectRatio;
        }
      }
      return null;
    }
    for (const memory of Object.values(manifest.memories)) {
      const asset = memory.assets.find((a) => a.file === region.assetFile);
      if (asset) return asset.aspectRatio;
    }
    return null;
  }

  function showRepositionFor(region: PositionedPhotoRegion): boolean {
    const slotAspect = targetAspectFor(region) ?? (region.isCover ? COVER_APPROX_ASPECT : null);
    return needsReposition(nativeAspectFor(region), slotAspect);
  }

  /** Item 3: where this region's duplicate badge should jump, or `null`
   * when this asset isn't duplicated (no badge) or every occurrence lives
   * on the page already on screen (badge would have nowhere new to go). */
  function duplicateTargetFor(region: PositionedPhotoRegion): AssetOccurrence | null {
    const occurrences = duplicateOccurrences.get(region.assetFile);
    if (!occurrences) return null;
    return nextOtherOccurrence(occurrences, region.pageId, region.key);
  }

  return (
    <div className="edit-overlay" aria-hidden={photoRegions.length === 0 && textRegions.length === 0}>
      {photoRegions.map((region) => {
        // Item 4: video slots are locked in v1 — no Replace affordance on a
        // slot backed by a video-poster asset (Reposition is unaffected,
        // still gated independently by item 1's crop-delta threshold below).
        const showReplace = !region.isVideoPoster;
        // Item 1: hide Reposition once the photo is effectively uncropped
        // at this slot's own aspect — nothing meaningful left to adjust.
        const showReposition = showRepositionFor(region);
        const duplicateTarget = duplicateTargetFor(region);
        if (!showReplace && !showReposition && !duplicateTarget) return null; // nothing left to offer — no empty hover affordance.
        return (
          <div
            key={region.key}
            className={`edit-overlay__photo${activePhotoKey === region.key ? ' edit-overlay__photo--active' : ''}`}
            style={{ left: region.rect.left, top: region.rect.top, width: region.rect.width, height: region.rect.height }}
            onClick={() => setActivePhotoKey((k) => (k === region.key ? null : region.key))}
          >
            <div className="edit-overlay__photo-actions">
              {showReplace && (
                <button
                  type="button"
                  className="edit-overlay__photo-button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPickerRegion(region);
                  }}
                >
                  Replace
                </button>
              )}
              {showReposition && (
                <button
                  type="button"
                  className="edit-overlay__photo-button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setFocalRegion(region);
                  }}
                >
                  Reposition
                </button>
              )}
            </div>
            {duplicateTarget && (
              // Item 3: unlike the Replace/Reposition actions above, this
              // stays visible without hover (it's information, not an
              // affordance that needs discovering) — subtle by staying
              // small and low-contrast rather than by hiding.
              <button
                type="button"
                className="edit-overlay__duplicate-badge"
                title="Also used on another page — jump there"
                aria-label="This photo is also used on another page — jump there"
                onClick={(e) => {
                  e.stopPropagation();
                  onNavigateToPage(duplicateTarget.pageIndex);
                }}
              >
                ⇄
              </button>
            )}
          </div>
        );
      })}

      {textRegions.map((region) => (
        <button
          key={region.target}
          type="button"
          className={`edit-overlay__text${region.approximate ? ' edit-overlay__text--approx' : ''}`}
          style={{ left: region.rect.left, top: region.rect.top, width: region.rect.width, height: region.rect.height }}
          onClick={() => setActiveTextTarget(region.target)}
          aria-label={`Edit ${region.label}`}
        />
      ))}

      {pickerRegion && (
        <PickerSheet
          bookId={bookId}
          familyId={familyId}
          slotKey={pickerRegion.key}
          isCover={pickerRegion.isCover}
          targetAspect={targetAspectFor(pickerRegion)}
          inBookAssets={inBookAssets}
          currentEdit={edits.images?.[pickerRegion.key] ?? null}
          onClose={() => setPickerRegion(null)}
          onSaved={onEditsSaved}
        />
      )}

      {focalRegion && (
        <FocalPointModal
          bookId={bookId}
          slotKey={focalRegion.key}
          assetFile={focalRegion.assetFile}
          targetAspect={targetAspectFor(focalRegion) ?? COVER_APPROX_ASPECT}
          initial={edits.focalPoints?.[focalRegion.key] ?? null}
          onClose={() => setFocalRegion(null)}
          onSaved={onEditsSaved}
        />
      )}

      {textRegion && (
        <TextEditPopover
          bookId={bookId}
          region={textRegion}
          currentEdit={edits.text?.[textRegion.target] ?? null}
          onClose={() => setActiveTextTarget(null)}
          onSaved={onEditsSaved}
        />
      )}
    </div>
  );
}
