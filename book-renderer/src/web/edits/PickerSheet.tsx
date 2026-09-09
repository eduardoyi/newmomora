import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchPickerPool, saveEdit, type PickerPoolFilters, type PickerPoolItem, type UndoAction } from './editsApi';
import { getMediaUrls } from '../media/coalescer';
import { aspectMismatchHint } from './aspectHint';
import { isAssetInBook, type InBookAssets } from '../media/inBookAssets';
import { useFamilyMembers } from '../book/useFamilyMembers';
import type { ImageEditRecord, MemoryBookEditsShape } from '../../model/edits';
import './PickerSheet.css';

type FilterMode = 'not-in-book' | 'all';

/** Item 1: `item.date` is a bare `YYYY-MM-DD` (postgres `date`, no time/
 * zone) — parsing it as LOCAL midnight (rather than `new Date(item.date)`,
 * which JS reads as UTC midnight and can display the wrong calendar day
 * west of UTC) is what makes `toLocaleDateString` show the actual memory
 * date, never a timezone-shifted one. */
function formatPickerDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function PickerSheet({
  bookId,
  familyId,
  slotKey,
  isCover,
  targetAspect,
  inBookAssets,
  currentEdit,
  onClose,
  onSaved,
}: {
  bookId: string;
  /** Item 1: threaded down to `useFamilyMembers` for the person filter —
   * see that hook's own doc comment. */
  familyId: string;
  slotKey: string;
  isCover: boolean;
  targetAspect: number | null;
  /**
   * Item 5: the honest, client-computed "actually placed in this book" sets
   * (`collectInBookAssets`). Optional so a call site that doesn't yet have a
   * fitted document (there is none today, but this keeps the contract
   * honest rather than requiring a caller to fabricate empty sets) falls
   * back to the server's own broader `item.alreadyInBook` manifest-based
   * flag — the ONLY place that flag is still consulted.
   */
  inBookAssets?: InBookAssets;
  /** Owner-approved round-3 polish, item 3: the saved `edits.images[slotKey]`
   * record, if any — `null` means this slot is still showing the book's own
   * original photo, nothing to reset. Also the "previous value" a save's
   * reported `UndoAction` restores. */
  currentEdit: ImageEditRecord | null;
  onClose: () => void;
  onSaved: (edits: MemoryBookEditsShape, undo: UndoAction) => void;
}) {
  const [items, setItems] = useState<PickerPoolItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thumbUrls, setThumbUrls] = useState<Map<string, string>>(new Map());
  const [savingMediaId, setSavingMediaId] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  // Item 4: a mismatched photo is confirmed via a short "use anyway?" step
  // rather than a permanent sentence under every thumbnail.
  const [confirmItem, setConfirmItem] = useState<PickerPoolItem | null>(null);
  // Item 5: defaults to the honest "not in book" view — real photo
  // libraries make "in book" the common case, so that's the useful default.
  const [filterMode, setFilterMode] = useState<FilterMode>('not-in-book');
  // Item 1 (owner-approved editing-UX round): date range + person filters,
  // native `<input type="date">` values ('' means unset — either bound is
  // optional). `''` for `memberId` means "everyone".
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [memberId, setMemberId] = useState('');
  const familyMembers = useFamilyMembers(bookId, familyId);

  // Item 2 (+ review fix): two guards with different jobs. `inFlightRef`
  // dedupes APPEND loads only (the "Load more" button and the
  // infinite-scroll sentinel can both fire for the same cursor before
  // React state catches up — the ref flips synchronously, so the second
  // caller sees it). A RESET load (initial mount, any filter change) is
  // never dropped: it SUPERSEDES whatever is in flight via `requestSeqRef`
  // — the stale response checks the sequence before touching state and
  // discards itself, so changing a filter mid-load always wins instead of
  // silently showing the old filter's results under new filter values
  // (the bug a single early-return lock had).
  const inFlightRef = useRef(false);
  const requestSeqRef = useRef(0);

  async function loadPage(fromCursor: string | null, append: boolean) {
    if (append && inFlightRef.current) return;
    const seq = ++requestSeqRef.current;
    inFlightRef.current = true;
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const filters: PickerPoolFilters = {
        dateStart: dateFrom || undefined,
        dateEnd: dateTo || undefined,
        memberId: memberId || undefined,
      };
      const page = await fetchPickerPool(bookId, fromCursor, filters);
      if (seq !== requestSeqRef.current) return; // superseded by a newer reset — its results own the UI
      if (page.error) {
        setError(page.error);
      } else {
        setItems((prev) => (append ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
        const keys = page.items.map((i) => i.previewKey);
        if (keys.length > 0) {
          getMediaUrls(keys).then((urls) => setThumbUrls((prev) => new Map([...prev, ...urls])));
        }
      }
    } finally {
      // A superseded call leaves the flags to its superseder (which set
      // them itself and will clear them when ITS response lands).
      if (seq === requestSeqRef.current) {
        setLoading(false);
        setLoadingMore(false);
        inFlightRef.current = false;
      }
    }
  }

  // Item 1: any filter change resets paging and reloads from scratch (same
  // effect that already re-loads on a `bookId` change) — `loadPage(null,
  // false)` replaces `items` outright rather than appending, so a stale
  // page from the PREVIOUS filter never lingers alongside fresh results.
  useEffect(() => {
    void loadPage(null, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, dateFrom, dateTo, memberId]);

  // Item 2: infinite scroll — an IntersectionObserver sentinel just past
  // the last rendered thumbnail triggers the same `loadPage(cursor, true)`
  // path the "Load more" button below already uses (kept rendered as a
  // fallback for whatever doesn't fire this, e.g. a `jsdom`-style test
  // environment with no real `IntersectionObserver`). `fetchLockRef` inside
  // `loadPage` is what actually prevents a double-fire; this effect just
  // needs a fresh observer whenever the scrollable root or what it should
  // trigger on changes.
  const gridRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = gridRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && cursor) void loadPage(cursor, true);
      },
      { root, rootMargin: '200px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor]);

  async function commitPick(item: PickerPoolItem) {
    if (savingMediaId) return;
    setSavingMediaId(item.mediaId);
    setError(null);
    const result = isCover
      ? await saveEdit(bookId, { kind: 'coverPhoto', mediaId: item.mediaId })
      : await saveEdit(bookId, { kind: 'imageReplace', slot: slotKey, mediaId: item.mediaId });
    setSavingMediaId(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    onSaved(result.edits, { category: 'images', key: slotKey, previous: currentEdit });
    onClose();
  }

  /** Item 3: "Reset to original photo" — removes the saved `imageReplace`/
   * `coverPhoto` edit for this slot, restoring the book's own original
   * photo on next render. */
  async function handleReset() {
    if (savingMediaId || resetting || !currentEdit) return;
    setResetting(true);
    setResetError(null);
    const result = await saveEdit(bookId, { kind: 'delete', category: 'images', key: slotKey });
    setResetting(false);
    if (result.error) {
      setResetError(result.error);
      return;
    }
    onSaved(result.edits, { category: 'images', key: slotKey, previous: currentEdit });
    onClose();
  }

  /**
   * Item 4: a mismatched photo no longer saves on the first tap — the full
   * "may crop tightly / re-arrange" sentence appears once, as a confirm
   * step, only for a photo the parent actually picked. The aspectHint
   * THRESHOLD logic (`aspectMismatchHint`) is unchanged; only when/how its
   * text is shown moved.
   */
  function handlePick(item: PickerPoolItem) {
    if (savingMediaId) return;
    if (aspectMismatchHint(item.aspectRatio, targetAspect)) {
      setConfirmItem(item);
      return;
    }
    void commitPick(item);
  }

  function inBook(item: PickerPoolItem): boolean {
    return inBookAssets ? isAssetInBook(inBookAssets, item.mediaId, item.previewKey) : item.alreadyInBook;
  }

  const visibleItems = useMemo(
    () => (filterMode === 'all' ? items : items.filter((item) => !inBook(item))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, filterMode, inBookAssets],
  );

  return (
    <div className="picker-sheet__backdrop" onClick={onClose}>
      <div className="picker-sheet" onClick={(e) => e.stopPropagation()}>
        <header className="picker-sheet__header">
          <h2 className="picker-sheet__title">Choose a photo</h2>
          <button type="button" className="picker-sheet__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {currentEdit && (
          <div className="picker-sheet__reset-row">
            <button type="button" className="picker-sheet__reset" disabled={resetting} onClick={() => void handleReset()}>
              {resetting ? 'Resetting…' : 'Reset to original photo'}
            </button>
            {resetError && <p className="picker-sheet__error">{resetError}</p>}
          </div>
        )}

        <div className="picker-sheet__filter" role="tablist" aria-label="Filter photos">
          <button
            type="button"
            role="tab"
            aria-selected={filterMode === 'not-in-book'}
            className={`picker-sheet__filter-tab${filterMode === 'not-in-book' ? ' picker-sheet__filter-tab--active' : ''}`}
            onClick={() => setFilterMode('not-in-book')}
          >
            Not in book
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filterMode === 'all'}
            className={`picker-sheet__filter-tab${filterMode === 'all' ? ' picker-sheet__filter-tab--active' : ''}`}
            onClick={() => setFilterMode('all')}
          >
            All photos
          </button>
        </div>

        {/* Item 1: date range + person filters — narrows the SERVER pool
            (unlike the "Not in book"/"All photos" tabs above, which filter
            the already-fetched `items` client-side), so changing either
            resets paging (`loadPage(null, false)` in the effect above). */}
        <div className="picker-sheet__date-filter">
          <label className="picker-sheet__date-label">
            From
            <input
              type="date"
              className="picker-sheet__date-input"
              value={dateFrom}
              max={dateTo || undefined}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </label>
          <label className="picker-sheet__date-label">
            To
            <input
              type="date"
              className="picker-sheet__date-input"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(e) => setDateTo(e.target.value)}
            />
          </label>
          {/* Fixture mode's roster is always empty (see `useFamilyMembers`'s
              own doc comment) — hidden rather than shown as a dead-end
              "Everyone"-only select with nothing else to pick. */}
          {familyMembers.length > 0 && (
            <label className="picker-sheet__date-label">
              Person
              <select
                className="picker-sheet__member-select"
                value={memberId}
                onChange={(e) => setMemberId(e.target.value)}
                aria-label="Filter by family member"
              >
                <option value="">Everyone</option>
                {familyMembers.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {error && <p className="picker-sheet__error">{error}</p>}

        <div className="picker-sheet__grid" ref={gridRef}>
          {loading && <p className="picker-sheet__hint">Loading photos…</p>}
          {!loading && visibleItems.length === 0 && items.length > 0 && (
            <p className="picker-sheet__hint">Every photo loaded so far is already in this book — try "All photos" or load more.</p>
          )}
          {!loading && items.length === 0 && <p className="picker-sheet__hint">No photos found in this book's time period.</p>}
          {visibleItems.map((item) => {
            const url = thumbUrls.get(item.previewKey);
            const mismatched = aspectMismatchHint(item.aspectRatio, targetAspect) !== null;
            return (
              <button
                key={item.mediaId}
                type="button"
                className="picker-item"
                disabled={savingMediaId !== null}
                onClick={() => handlePick(item)}
              >
                <div className="picker-item__thumb">
                  {url ? <img src={url} alt="" className="picker-item__thumb-img" /> : <div className="picker-item__thumb-placeholder" />}
                  {inBook(item) && <span className="picker-item__badge">In book</span>}
                  {mismatched && (
                    <span className="picker-item__mismatch-icon" title="Proportions don't match this spot" aria-label="Proportions don't match this spot">
                      !
                    </span>
                  )}
                  {savingMediaId === item.mediaId && <span className="picker-item__saving">Saving…</span>}
                </div>
                {/* Item 1: a compact absolute date under each thumbnail. */}
                <span className="picker-item__date">{formatPickerDate(item.date)}</span>
              </button>
            );
          })}
          {/* Item 2: the infinite-scroll trigger — a 1px, non-interactive
              sentinel the grid's own IntersectionObserver watches. Only
              rendered while there's a next page, same guard the "Load
              more" button below already uses. */}
          {cursor && <div ref={sentinelRef} className="picker-sheet__sentinel" aria-hidden="true" />}
        </div>

        {cursor && (
          <button type="button" className="picker-sheet__load-more" disabled={loadingMore} onClick={() => void loadPage(cursor, true)}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        )}

        {confirmItem && (
          <div className="picker-sheet__confirm-backdrop" onClick={() => setConfirmItem(null)}>
            <div className="picker-sheet__confirm" onClick={(e) => e.stopPropagation()}>
              <p className="picker-sheet__confirm-text">{aspectMismatchHint(confirmItem.aspectRatio, targetAspect)} Use anyway?</p>
              <div className="picker-sheet__confirm-actions">
                <button type="button" className="picker-sheet__confirm-cancel" onClick={() => setConfirmItem(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="picker-sheet__confirm-use"
                  onClick={() => {
                    const item = confirmItem;
                    setConfirmItem(null);
                    void commitPick(item);
                  }}
                >
                  Use anyway
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
