import { useEffect, useState } from 'react';
import type { FrontPhotoProvider, PickerItem } from './photoProvider';
import '../../web/edits/PickerSheet.css';

/**
 * "Choose a photo" for the card front: the book's PickerSheet interaction and
 * CSS (backdrop, header, tabs, thumbnail grid with a date under each, Reset to
 * original), fed by a `FrontPhotoProvider` instead of the book's picker_pool
 * server call. Picking applies at once (the card follows the picture's
 * orientation, so there is no "does it fit this slot" confirm step).
 */
function formatDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

type Tab = 'photo' | 'illustration';

export function CardPhotoPicker({
  provider,
  currentId,
  canReset,
  currentOrientation,
  onPick,
  onReset,
  onClose,
  title = 'Choose the front',
  dismissible = true,
}: {
  provider: FrontPhotoProvider;
  currentId: string;
  canReset: boolean;
  currentOrientation: 'landscape' | 'portrait';
  onPick: (item: PickerItem) => void;
  onReset: () => void;
  onClose: () => void;
  title?: string;
  /** False = the sheet cannot be closed without picking (a forced re-pick). */
  dismissible?: boolean;
}) {
  const [items, setItems] = useState<PickerItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('photo');

  useEffect(() => {
    let cancelled = false;
    provider
      .list(null)
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setCursor(page.nextCursor);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [provider]);

  async function loadMore() {
    if (!cursor) return;
    const page = await provider.list(cursor);
    setItems((prev) => [...prev, ...page.items]);
    setCursor(page.nextCursor);
  }

  const visible = items.filter((i) => i.kind === tab);
  const hasIllustrations = items.some((i) => i.kind === 'illustration');

  return (
    <div className="picker-sheet__backdrop" onClick={dismissible ? onClose : undefined}>
      <div className="picker-sheet" onClick={(e) => e.stopPropagation()}>
        <header className="picker-sheet__header">
          <h2 className="picker-sheet__title">{title}</h2>
          {dismissible && (
            <button type="button" className="picker-sheet__close" onClick={onClose} aria-label="Close">
              ×
            </button>
          )}
        </header>

        {canReset && (
          <div className="picker-sheet__reset-row">
            <button type="button" className="picker-sheet__reset" onClick={onReset}>
              Reset to original photo
            </button>
          </div>
        )}

        {hasIllustrations && (
          <div className="picker-sheet__filter" role="tablist" aria-label="Photos or illustrated scenes">
            {(['photo', 'illustration'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                className={`picker-sheet__filter-tab${tab === t ? ' picker-sheet__filter-tab--active' : ''}`}
                onClick={() => setTab(t)}
              >
                {t === 'photo' ? 'Photos' : 'Illustrated'}
              </button>
            ))}
          </div>
        )}

        {error && <p className="picker-sheet__error">{error}</p>}

        <div className="picker-sheet__grid">
          {loading && <p className="picker-sheet__hint">Loading photos…</p>}
          {!loading && visible.length === 0 && <p className="picker-sheet__hint">Nothing here yet.</p>}
          {visible.map((item) => {
            const orientation = item.height > item.width ? 'portrait' : 'landscape';
            return (
              <button key={item.id} type="button" className="picker-item" onClick={() => onPick(item)} aria-label={`Use this ${item.kind}`}>
                <div className="picker-item__thumb">
                  <img src={item.thumbUrl} alt="" className="picker-item__thumb-img" loading="lazy" />
                  {item.id === currentId && <span className="picker-item__badge">Current</span>}
                  {item.rank === 1 && item.id !== currentId && <span className="picker-item__badge">Top pick</span>}
                </div>
                <span className="picker-item__date">
                  {item.kind === 'photo' && item.date ? formatDate(item.date) : (item.label ?? '')}
                  {orientation !== currentOrientation ? ` · ${orientation}` : ''}
                </span>
              </button>
            );
          })}
        </div>

        {cursor && (
          <button type="button" className="picker-sheet__load-more" onClick={() => void loadMore()}>
            Load more
          </button>
        )}
      </div>
    </div>
  );
}
