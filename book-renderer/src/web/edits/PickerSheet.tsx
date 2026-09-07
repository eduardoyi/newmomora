import { useEffect, useMemo, useState } from 'react';
import { fetchPickerPool, saveEdit, type PickerPoolItem } from './editsApi';
import { getMediaUrls } from '../media/coalescer';
import { aspectMismatchHint } from './aspectHint';
import { isAssetInBook, type InBookAssets } from '../media/inBookAssets';
import type { MemoryBookEditsShape } from '../../model/edits';
import './PickerSheet.css';

type FilterMode = 'not-in-book' | 'all';

export function PickerSheet({
  bookId,
  slotKey,
  isCover,
  targetAspect,
  inBookAssets,
  onClose,
  onSaved,
}: {
  bookId: string;
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
  onClose: () => void;
  onSaved: (edits: MemoryBookEditsShape) => void;
}) {
  const [items, setItems] = useState<PickerPoolItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thumbUrls, setThumbUrls] = useState<Map<string, string>>(new Map());
  const [savingMediaId, setSavingMediaId] = useState<string | null>(null);
  // Item 4: a mismatched photo is confirmed via a short "use anyway?" step
  // rather than a permanent sentence under every thumbnail.
  const [confirmItem, setConfirmItem] = useState<PickerPoolItem | null>(null);
  // Item 5: defaults to the honest "not in book" view — real photo
  // libraries make "in book" the common case, so that's the useful default.
  const [filterMode, setFilterMode] = useState<FilterMode>('not-in-book');

  async function loadPage(fromCursor: string | null, append: boolean) {
    if (append) setLoadingMore(true);
    else setLoading(true);
    const page = await fetchPickerPool(bookId, fromCursor);
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
    setLoading(false);
    setLoadingMore(false);
  }

  useEffect(() => {
    void loadPage(null, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

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
    onSaved(result.edits);
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

        {error && <p className="picker-sheet__error">{error}</p>}

        <div className="picker-sheet__grid">
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
              </button>
            );
          })}
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
