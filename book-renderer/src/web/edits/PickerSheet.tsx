import { useEffect, useState } from 'react';
import { fetchPickerPool, saveEdit, type PickerPoolItem } from './editsApi';
import { getMediaUrls } from '../media/coalescer';
import { aspectMismatchHint } from './aspectHint';
import type { MemoryBookEditsShape } from '../../model/edits';
import './PickerSheet.css';

export function PickerSheet({
  bookId,
  slotKey,
  isCover,
  targetAspect,
  onClose,
  onSaved,
}: {
  bookId: string;
  slotKey: string;
  isCover: boolean;
  targetAspect: number | null;
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

  async function handlePick(item: PickerPoolItem) {
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

  return (
    <div className="picker-sheet__backdrop" onClick={onClose}>
      <div className="picker-sheet" onClick={(e) => e.stopPropagation()}>
        <header className="picker-sheet__header">
          <h2 className="picker-sheet__title">Choose a photo</h2>
          <button type="button" className="picker-sheet__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {error && <p className="picker-sheet__error">{error}</p>}

        <div className="picker-sheet__grid">
          {loading && <p className="picker-sheet__hint">Loading photos…</p>}
          {!loading && items.length === 0 && <p className="picker-sheet__hint">No photos found in this book's time period.</p>}
          {items.map((item) => {
            const url = thumbUrls.get(item.previewKey);
            const hint = aspectMismatchHint(item.aspectRatio, targetAspect);
            return (
              <button
                key={item.mediaId}
                type="button"
                className="picker-item"
                disabled={savingMediaId !== null}
                onClick={() => void handlePick(item)}
              >
                <div className="picker-item__thumb">
                  {url ? <img src={url} alt="" className="picker-item__thumb-img" /> : <div className="picker-item__thumb-placeholder" />}
                  {item.alreadyInBook && <span className="picker-item__badge">In book</span>}
                  {savingMediaId === item.mediaId && <span className="picker-item__saving">Saving…</span>}
                </div>
                {hint && <p className="picker-item__hint">{hint}</p>}
              </button>
            );
          })}
        </div>

        {cursor && (
          <button type="button" className="picker-sheet__load-more" disabled={loadingMore} onClick={() => void loadPage(cursor, true)}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </div>
  );
}
