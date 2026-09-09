import { useEffect, useMemo, useState } from 'react';
import { useFamilyBooks } from './useFamilyBooks';
import { StatusChip } from './StatusChip';
import { pickListThumbnailKey } from './thumbnail';
import { getMediaUrls } from '../media/coalescer';
import { signOut } from '../auth/useAuthSession';
import { useDocumentTitle } from '../useDocumentTitle';
import './BookListScreen.css';

export function BookListScreen({
  onOpenBook,
  onOpenOrders,
}: {
  onOpenBook: (bookId: string) => void;
  /** memory-book-5c order-status UX round, item 2: a quiet, always-visible
   * entry point to `/orders` — unlike the `BookViewScreen` entry point,
   * this one doesn't gate on whether the buyer has any orders yet (there's
   * no book-scoped context here to check against, and an empty orders list
   * has its own honest empty-state copy). */
  onOpenOrders: () => void;
}) {
  useDocumentTitle('Your books · Momora');
  const { books, error, loading } = useFamilyBooks();
  const [thumbUrls, setThumbUrls] = useState<Map<string, string>>(new Map());

  const thumbKeys = useMemo(() => {
    const map = new Map<string, string>();
    for (const book of books ?? []) {
      if (book.status !== 'ready') continue;
      const key = pickListThumbnailKey(book.book_document);
      if (key) map.set(book.id, key);
    }
    return map;
  }, [books]);

  useEffect(() => {
    const keys = Array.from(new Set(thumbKeys.values()));
    if (keys.length === 0) return;
    let cancelled = false;
    getMediaUrls(keys).then((urls) => {
      if (cancelled) return;
      setThumbUrls(urls);
    });
    return () => {
      cancelled = true;
    };
    // thumbKeys is a derived Map recomputed from `books` — comparing its
    // serialized values keeps this effect from re-running every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Array.from(thumbKeys.values()).join('|')]);

  return (
    <div className="book-list">
      <header className="book-list__header">
        <div className="book-list__wordmark">
          Momora<span className="book-list__wordmark-dot">.</span>
        </div>
        <div className="book-list__header-actions">
          <button type="button" className="book-list__orders-link" onClick={onOpenOrders}>
            Your orders
          </button>
          <button type="button" className="book-list__signout" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <div className="book-list__body">
        <h1 className="book-list__title">Memory Books</h1>

        {loading && <p className="book-list__hint">Loading your family's books…</p>}
        {error && <p className="book-list__error">{error}</p>}

        {!loading && !error && (books?.length ?? 0) === 0 && (
          <p className="book-list__hint">
            No Memory Books yet. Start one from the Momora app — it will show up here once it's generating.
          </p>
        )}

        <ul className="book-list__grid">
          {(books ?? []).map((book) => {
            const thumbKey = thumbKeys.get(book.id);
            const thumbUrl = thumbKey ? thumbUrls.get(thumbKey) : undefined;
            const clickable = book.status === 'ready';
            return (
              <li key={book.id}>
                <button
                  type="button"
                  className={`book-card${clickable ? '' : ' book-card--disabled'}`}
                  disabled={!clickable}
                  onClick={() => clickable && onOpenBook(book.id)}
                >
                  <div className="book-card__thumb">
                    {thumbUrl ? (
                      <img src={thumbUrl} alt="" className="book-card__thumb-img" />
                    ) : (
                      <div className="book-card__thumb-placeholder" aria-hidden="true" />
                    )}
                  </div>
                  <div className="book-card__meta">
                    <span className="book-card__label">
                      {book.child?.name ? `${book.child.name} — ${book.scope_label}` : book.scope_label}
                    </span>
                    <StatusChip status={book.status} />
                  </div>
                  {book.status === 'failed' && book.failure_reason && (
                    <span className="book-card__failure">{book.failure_reason}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
