import { useState, type RefObject } from 'react';
import type { BookPage, PhotoSlotContent } from '../../model/types';
import type { MemoryBookEditsShape } from '../../model/edits';
import { PickerSheet } from '../edits/PickerSheet';
import { FocalPointModal } from '../edits/FocalPointModal';
import { useOverlayGeometry, type PositionedPhotoRegion, type PositionedTextRegion } from './useOverlayGeometry';
import { TextEditPopover } from './TextEditPopover';
import type { InBookAssets } from '../media/inBookAssets';
import './EditOverlay.css';

/** Approximate front-cover-panel aspect for the focal-point crop preview —
 * mirrors `EditPanel.tsx`'s own `COVER_APPROX_ASPECT` (same documented
 * approximation: `WraparoundCover` derives its front-panel geometry
 * internally from `PHYSICAL.pageSizeMm` rather than exposing it in
 * `params`). */
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
  containerRef,
  pages,
  edits,
  inBookAssets,
  onEditsSaved,
}: {
  bookId: string;
  containerRef: RefObject<HTMLElement | null>;
  pages: BookPage[];
  edits: MemoryBookEditsShape;
  inBookAssets: InBookAssets;
  onEditsSaved: (edits: MemoryBookEditsShape) => void;
}) {
  const { photoRegions, textRegions } = useOverlayGeometry(containerRef, pages, edits);
  const [activePhotoKey, setActivePhotoKey] = useState<string | null>(null);
  const [pickerRegion, setPickerRegion] = useState<PositionedPhotoRegion | null>(null);
  const [focalRegion, setFocalRegion] = useState<PositionedPhotoRegion | null>(null);
  const [textRegion, setTextRegion] = useState<PositionedTextRegion | null>(null);

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

  return (
    <div className="edit-overlay" aria-hidden={photoRegions.length === 0 && textRegions.length === 0}>
      {photoRegions.map((region) => (
        <div
          key={region.key}
          className={`edit-overlay__photo${activePhotoKey === region.key ? ' edit-overlay__photo--active' : ''}`}
          style={{ left: region.rect.left, top: region.rect.top, width: region.rect.width, height: region.rect.height }}
          onClick={() => setActivePhotoKey((k) => (k === region.key ? null : region.key))}
        >
          <div className="edit-overlay__photo-actions">
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
          </div>
        </div>
      ))}

      {textRegions.map((region) => (
        <button
          key={region.target}
          type="button"
          className={`edit-overlay__text${region.approximate ? ' edit-overlay__text--approx' : ''}`}
          style={{ left: region.rect.left, top: region.rect.top, width: region.rect.width, height: region.rect.height }}
          onClick={() => setTextRegion(region)}
          aria-label={`Edit ${region.label}`}
        />
      ))}

      {pickerRegion && (
        <PickerSheet
          bookId={bookId}
          slotKey={pickerRegion.key}
          isCover={pickerRegion.isCover}
          targetAspect={targetAspectFor(pickerRegion)}
          inBookAssets={inBookAssets}
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
        <TextEditPopover bookId={bookId} region={textRegion} onClose={() => setTextRegion(null)} onSaved={onEditsSaved} />
      )}
    </div>
  );
}
