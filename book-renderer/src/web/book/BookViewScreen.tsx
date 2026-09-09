import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditableBook } from './useEditableBook';
import { useBookAssetProvider } from '../media/useBookAssetProvider';
import { collectManifestAssetKeys } from '../media/manifestKeys';
import { collectInBookAssets, type InBookAssets } from '../media/inBookAssets';
import { computeUnits, buildSyntheticClosingPartner } from '../../preview/App';
import { SpreadPager } from '../../preview/SpreadPager';
import { StatusChip } from '../books/StatusChip';
import { SkippedEditsToast } from '../edits/SkippedEditsToast';
import { EditSavedToast } from '../edits/EditSavedToast';
import { EditOverlay } from '../overlay/EditOverlay';
import { computeUnitAspect } from './unitAspect';
import { useFitToViewportWidth } from './useFitToViewport';
import { FirstVisitHint } from './FirstVisitHint';
import { useDocumentTitle } from '../useDocumentTitle';
import { CheckoutScreen } from '../order/CheckoutScreen';
import { useHasPastOrders } from '../order/useHasPastOrders';
import { computeDuplicateAssetOccurrences } from './duplicateAssets';
import { computeReflowResult } from './reflowNotice';
import type { UndoAction } from '../edits/editsApi';
import type { MemoryBookEditsShape } from '../../model/edits';
import type { BookPage } from '../../model/types';
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
export function BookViewScreen({
  bookId,
  onBack,
  onOrderPlaced,
  onOpenOrders,
}: {
  bookId: string;
  onBack: () => void;
  /** memory-book-5c plan Step 6: called with the new order's id once
   * `CheckoutScreen`'s checkout session mocks a paid order (fixture mode
   * only — the real flow leaves the page for Stripe instead, see
   * `CheckoutScreen.tsx#handlePay`). The caller navigates to `/order/<id>`. */
  onOrderPlaced: (orderId: string) => void;
  /** order-status UX round, item 2: navigates to `/orders`. Only surfaced
   * next to "Order this book" once `useHasPastOrders` confirms the buyer
   * has at least one — see that hook's own header comment. */
  onOpenOrders: () => void;
}) {
  const { loading, error, data, applyEditsPatch, handleEditsSaved, pendingUndo, undoing, handleUndo, dismissUndo } =
    useEditableBook(bookId);
  const [unitIndex, setUnitIndex] = useState(0);
  const [orderingOpen, setOrderingOpen] = useState(false);
  const hasPastOrders = useHasPastOrders();

  // Stripe Checkout's `cancel_url` (memory-book-orders/index.ts's
  // `create_checkout` handler) lands back here as `/b/<id>?checkout=cancelled`
  // — a one-time, dismissible notice that no charge happened, same "read the
  // query param once, then scrub it" shape `OrderStatusScreen`'s own
  // `?checkout=success` banner uses. `replaceState` (not `pushState`) so a
  // back-button press from here doesn't bounce the visitor right back to
  // this same query string.
  const [checkoutCancelled, setCheckoutCancelled] = useState(
    () => new URLSearchParams(window.location.search).get('checkout') === 'cancelled',
  );
  useEffect(() => {
    if (!checkoutCancelled) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('checkout');
    window.history.replaceState(null, '', url.pathname + url.search);
  }, [checkoutCancelled]);

  // Item 3: "<child> — <scope label> · Momora" once the book has loaded —
  // same naming BookListScreen's own row label uses (`book.child.name` /
  // `book.scope_label`) — so the tab title and the list row a visitor came
  // from always agree. `null` (a no-op for the hook) until `data.book`
  // exists, so a loading/error state never flashes a placeholder title.
  useDocumentTitle(
    data?.book
      ? `${data.book.child?.name ? `${data.book.child.name} — ${data.book.scope_label}` : data.book.scope_label} · Momora`
      : null,
  );
  // Item 1: the stage wrapper both the viewport-fit hook measures/sizes AND
  // the item-3 overlay positions its regions relative to (its bounding box
  // is the coordinate origin `useOverlayGeometry`'s rects are measured
  // against — see EditOverlay.tsx's own header comment).
  const stageRef = useRef<HTMLDivElement>(null);

  const pages = data?.document.pages ?? [];
  const units = useMemo(() => computeUnits(pages), [pages]);
  const unitCount = units.length;
  // Items 3/4 (owner-approved editing-UX round): a raw document page index
  // -> unit index lookup, same pattern the local preview app's own
  // `App.tsx` builds for its variant switcher — both the duplicate-badge
  // jump (item 3) and the post-save auto-scroll (item 4) navigate by RAW
  // page index, never a unit index directly, since the page that answers
  // "where is this slot now" only exists in document terms.
  const rawIndexToUnit = useMemo(() => {
    const map = new Map<number, number>();
    units.forEach((unit, ui) => unit.rawIndices.forEach((raw) => map.set(raw, ui)));
    return map;
  }, [units]);
  const navigateToPageIndex = useCallback(
    (rawIndex: number) => {
      const ui = rawIndexToUnit.get(rawIndex);
      if (ui !== undefined) setUnitIndex(ui);
    },
    [rawIndexToUnit],
  );
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

  // Item 3: every asset file duplicated across the WHOLE fitted document —
  // recomputed only when the document itself changes, not on every
  // page-navigation click.
  const duplicateOccurrences = useMemo(() => computeDuplicateAssetOccurrences(pages), [pages]);

  // Item 4: post-save auto-scroll + full-bleed/panorama demotion notice.
  // `pendingReflowRef` carries the just-saved slot key + the document's
  // `pages` from immediately BEFORE the save across the render where
  // `data` itself updates (the refit happens inside `useEditableBook`'s own
  // `data` useMemo, one render after this callback runs) — the effect
  // below reacts once the refitted `pages` actually lands, comparing
  // before/after via `computeReflowResult` (pure, no DOM, unit-tested on
  // its own).
  const pendingReflowRef = useRef<{ slotKey: string; beforePages: BookPage[] } | null>(null);
  const [demoted, setDemoted] = useState(false);

  const handleEditOverlaySaved = useCallback(
    (nextEdits: MemoryBookEditsShape, undo: UndoAction) => {
      setDemoted(false);
      // Only an image edit (replace/cover/reset) can move a slot to a new
      // page or change its template — text/focalPoint saves never reflow,
      // so they skip the reflow bookkeeping entirely (`pendingReflowRef`
      // stays `null`, and the effect below no-ops for them).
      pendingReflowRef.current =
        undo.category === 'images' && data ? { slotKey: undo.key, beforePages: data.document.pages } : null;
      handleEditsSaved(nextEdits, undo);
    },
    [data, handleEditsSaved],
  );

  useEffect(() => {
    const pending = pendingReflowRef.current;
    if (!pending || !data) return;
    pendingReflowRef.current = null; // one-shot per save
    const result = computeReflowResult(pending.beforePages, data.document.pages, pending.slotKey);
    if (result.rawIndex !== null) navigateToPageIndex(result.rawIndex);
    setDemoted(result.demoted);
  }, [data, navigateToPageIndex]);

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

  const bookLabel = data.book.child?.name ? `${data.book.child.name} — ${data.book.scope_label}` : data.book.scope_label;

  // memory-book-5c plan Step 6, Design Decision 5: a full-takeover checkout
  // flow, not a modal over the pager — same "swap the whole screen" shape
  // `App.tsx` already uses between the book list and this component, rather
  // than another `EditOverlay`-style layered surface (checkout has its own
  // multi-step flow with its own back button, not a single-purpose sheet).
  if (orderingOpen) {
    return (
      <CheckoutScreen
        bookId={bookId}
        bookLabel={bookLabel}
        onBack={() => setOrderingOpen(false)}
        onOrderPlaced={onOrderPlaced}
      />
    );
  }

  return (
    <div className="book-view">
      <header className="book-view__header">
        <button type="button" className="book-view__back" onClick={onBack}>
          ← Your books
        </button>
        <span className="book-view__title">{bookLabel}</span>
        {/* memory-book-5c plan Step 6: only an owner/manager can place an
            order (mirrors `memory-book-orders/index.ts`'s `create_draft`
            role check) — gating visibility on `data.canEdit` avoids showing
            a viewer-role family member a button that would just 403. Always
            reachable once shown: unlike editing affordances, this isn't a
            hover-only hitbox. */}
        {data.canEdit && (
          <div className="book-view__order-actions">
            {hasPastOrders && (
              <button type="button" className="book-view__orders-link" onClick={onOpenOrders}>
                Your orders
              </button>
            )}
            <button type="button" className="book-view__order-cta" onClick={() => setOrderingOpen(true)}>
              Order this book
            </button>
          </div>
        )}
      </header>

      {checkoutCancelled && (
        <div className="book-view__checkout-cancelled" role="status">
          <span>Checkout was cancelled — you weren't charged.</span>
          <button type="button" aria-label="Dismiss" onClick={() => setCheckoutCancelled(false)}>
            ×
          </button>
        </div>
      )}

      {data.canEdit && <FirstVisitHint />}

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
                // Item 2: the web app shows only the page-number label — no
                // template ids / outline element ids (that debug info stays
                // in the local preview app, whose own call site never
                // passes this prop, so it defaults to `true` unchanged).
                debugCaption={false}
              />
              {data.canEdit && (
                <EditOverlay
                  bookId={bookId}
                  familyId={data.book.family_id}
                  containerRef={stageRef}
                  pages={rawPages}
                  manifest={data.editedManifest}
                  edits={data.edits}
                  inBookAssets={inBookAssets}
                  duplicateOccurrences={duplicateOccurrences}
                  onNavigateToPage={navigateToPageIndex}
                  onEditsSaved={handleEditOverlaySaved}
                />
              )}
            </div>
          )}
        </div>
      </div>

      {data.canEdit && <SkippedEditsToast bookId={bookId} skipped={data.skipped} onRemoved={applyEditsPatch} />}
      {data.canEdit && (
        <EditSavedToast
          pending={pendingUndo}
          undoing={undoing}
          demoted={demoted}
          onUndo={() => void handleUndo()}
          onDismiss={dismissUndo}
        />
      )}
    </div>
  );
}
