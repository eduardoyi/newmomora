import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditableBook } from './useEditableBook';
import { useBookAssetProvider } from '../media/useBookAssetProvider';
import { collectManifestAssetKeys } from '../media/manifestKeys';
import { collectInBookAssets, type InBookAssets } from '../media/inBookAssets';
import { computeUnits, buildSyntheticClosingPartner } from '../../preview/App';
import { SpreadPager } from '../../preview/SpreadPager';
import { StatusChip } from '../books/StatusChip';
import { SkippedEditsToast } from '../edits/SkippedEditsToast';
import { EditOverlay } from '../overlay/EditOverlay';
import { computeUnitAspect } from './unitAspect';
import { useFitToViewportWidth } from './useFitToViewport';
import './BookViewScreen.css';

const EMPTY_IN_BOOK: InBookAssets = { assetFiles: new Set(), mediaIds: new Set() };

/**
 * Always-on inline editing (owner-approved follow-up round, feature 3): the
 * old `editMode` toggle + `EditPanel` sidebar are gone. `EditOverlay` now
 * mounts unconditionally whenever `data.canEdit` — its own hitboxes render
 * NOTHING visible until hover (desktop, via `:hover` in `EditOverlay.css`)
 * or tap (touch — a tap fires `click` directly with no hover state, opening
 * the picker/popover immediately; see that file's per-region CSS), so nothing
 * about a read-only viewer's rendered page changes by this being always
 * mounted rather than toggled.
 */
export function BookViewScreen({ bookId, onBack }: { bookId: string; onBack: () => void }) {
  const { loading, error, data, applyEditsPatch } = useEditableBook(bookId);
  const [unitIndex, setUnitIndex] = useState(0);
  // Item 1: the stage wrapper both the viewport-fit hook measures/sizes AND
  // the item-3 overlay positions its regions relative to (its bounding box
  // is the coordinate origin `useOverlayGeometry`'s rects are measured
  // against — see EditOverlay.tsx's own header comment).
  const stageRef = useRef<HTMLDivElement>(null);

  const pages = data?.document.pages ?? [];
  const units = useMemo(() => computeUnits(pages), [pages]);
  const unitCount = units.length;
  const currentUnit = units[unitIndex] ?? null;
  const rawPages = useMemo(() => {
    if (!currentUnit) return [];
    const real = currentUnit.rawIndices.map((i) => pages[i]);
    // Item 2: the closing/parity-blank page's synthetic, display-only
    // facing partner — same construction the local preview app uses (see
    // `preview/App.tsx`'s `computeUnits`/`buildSyntheticClosingPartner`),
    // reused here rather than re-derived so the two apps can never drift.
    if (currentUnit.syntheticRightBlank && real[0]) {
      return [real[0], buildSyntheticClosingPartner(real[0])];
    }
    return real;
  }, [currentUnit, pages]);

  const unitAspect = useMemo(() => computeUnitAspect(rawPages), [rawPages]);
  const fitMaxWidthPx = useFitToViewportWidth(stageRef, unitAspect);

  useEffect(() => {
    setUnitIndex(0);
  }, [bookId]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Editing is always-on now (no more `editMode` toggle to gate this
      // on) — guard directly against the actual focused element instead, so
      // arrow keys still type normally inside the text popover's
      // input/textarea (`TextEditPopover.tsx`) without hijacking the page
      // for navigation, while every other arrow-key press still pages.
      const active = document.activeElement;
      const isTyping = active instanceof HTMLElement && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
      if (isTyping) return;
      if (e.key === 'ArrowRight') setUnitIndex((i) => Math.min(i + 1, unitCount - 1));
      if (e.key === 'ArrowLeft') setUnitIndex((i) => Math.max(i - 1, 0));
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [unitCount]);

  const assetKeys = useMemo(
    () => (data ? collectManifestAssetKeys(data.editedManifest) : []),
    [data],
  );
  const { onImageErrorCapture } = useBookAssetProvider(data?.book.status === 'ready' ? bookId : null, assetKeys);

  // Item 5: the honest, client-computed in-book sets, from the fitted
  // document actually rendered (not the server's broader manifest-based
  // flag — see `media/inBookAssets.ts`'s own doc comment).
  const inBookAssets = useMemo(
    () => (data ? collectInBookAssets(data.document, data.edits) : EMPTY_IN_BOOK),
    [data],
  );

  if (loading) {
    return (
      <div className="book-view book-view--center">
        <p className="book-view__hint">Loading book…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="book-view book-view--center">
        <p className="book-view__error">{error}</p>
        <button type="button" className="book-view__back" onClick={onBack}>
          Back to your books
        </button>
      </div>
    );
  }
  if (!data) return null;

  if (data.book.status !== 'ready') {
    return (
      <div className="book-view book-view--center">
        <StatusChip status={data.book.status} />
        <p className="book-view__hint">
          {data.book.status === 'failed'
            ? data.book.failure_reason ?? 'This book failed to generate.'
            : 'This book is still being made — check back soon.'}
        </p>
        <button type="button" className="book-view__back" onClick={onBack}>
          Back to your books
        </button>
      </div>
    );
  }

  const pageLabel =
    currentUnit && currentUnit.rawIndices.length === 2
      ? `Pages ${currentUnit.rawIndices[0] + 1}-${currentUnit.rawIndices[1] + 1} / ${pages.length}`
      : `Page ${(currentUnit?.rawIndices[0] ?? 0) + 1} / ${pages.length}`;

  return (
    <div className="book-view">
      <header className="book-view__header">
        <button type="button" className="book-view__back" onClick={onBack}>
          ← Your books
        </button>
        <span className="book-view__title">
          {data.book.child?.name ? `${data.book.child.name} — ${data.book.scope_label}` : data.book.scope_label}
        </span>
      </header>

      <div className="book-view__body" onErrorCapture={onImageErrorCapture}>
        <div className="book-view__main">
          {currentUnit && (
            <div className="book-view__stage" ref={stageRef} style={fitMaxWidthPx ? { maxWidth: `${fitMaxWidthPx}px` } : undefined}>
              <SpreadPager
                pages={rawPages}
                manifest={data.editedManifest}
                bookSlug={data.book.id}
                showGuides={false}
                zoomed={false}
                pageLabel={pageLabel}
                onPrev={() => setUnitIndex((i) => Math.max(i - 1, 0))}
                onNext={() => setUnitIndex((i) => Math.min(i + 1, unitCount - 1))}
              />
              {data.canEdit && (
                <EditOverlay
                  bookId={bookId}
                  containerRef={stageRef}
                  pages={rawPages}
                  manifest={data.editedManifest}
                  edits={data.edits}
                  inBookAssets={inBookAssets}
                  onEditsSaved={applyEditsPatch}
                />
              )}
            </div>
          )}
        </div>
      </div>

      {data.canEdit && <SkippedEditsToast skipped={data.skipped} />}
    </div>
  );
}
