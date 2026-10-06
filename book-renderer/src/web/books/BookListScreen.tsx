import { useEffect, useMemo, useState } from 'react';
import { useFamilyBooks } from './useFamilyBooks';
import { StatusChip, bookStatusLabel } from './StatusChip';
import { pickListThumbnailKey } from './thumbnail';
import { getMediaUrls } from '../media/coalescer';
import { ConnectedShopHeader } from '../shell/ConnectedShopHeader';
import { useHolidayCardTiles } from './useHolidayCardTiles';
import { bookTileAriaLabel, homeSections, NOTHING_YET_COPY, type CardTile } from './keepsakes';
import { useDocumentTitle } from '../useDocumentTitle';
import './BookListScreen.css';

export function BookListScreen({
  onOpenBook,
  onOpenCard,
  onOpenOrders,
  onHome,
}: {
  onOpenBook: (bookId: string) => void;
  /** Opens a holiday card (`/c/<id>`). */
  onOpenCard: (cardId: string) => void;
  /** The header's wordmark ("/"). */
  onHome: () => void;
  /** memory-book-5c order-status UX round, item 2: a quiet, always-visible
   * entry point to `/orders` — unlike the `BookViewScreen` entry point,
   * this one doesn't gate on whether the buyer has any orders yet (there's
   * no book-scoped context here to check against, and an empty orders list
   * has its own honest empty-state copy). */
  onOpenOrders: () => void;
}) {
  useDocumentTitle('Your keepsakes · Momora');
  const { books, error, loading, familyIds } = useFamilyBooks();
  const { tiles: cardTiles, loading: cardsLoading } = useHolidayCardTiles(familyIds);
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

  const sections = homeSections({ loading: loading || cardsLoading, bookCount: books?.length ?? 0, cardCount: cardTiles.length });

  return (
    <div className="book-list">
      <ConnectedShopHeader onHome={onHome} onOpenOrders={onOpenOrders} />

      <div className="book-list__body">
        <h1 className="book-list__title">Your keepsakes</h1>

        {loading && <p className="book-list__hint">Loading your keepsakes…</p>}
        {error && <p className="book-list__error">{error}</p>}

        {sections.empty && !error && <p className="book-list__hint">{NOTHING_YET_COPY}</p>}

        {sections.cards && (
          <section className="book-list__section" aria-labelledby="keepsakes-cards">
            <h2 className="book-list__section-title" id="keepsakes-cards">
              Holiday card
            </h2>
            <ul className="book-list__grid">
              {cardTiles.map((tile) => (
                <li key={tile.cardId}>
                  <HolidayCardTile tile={tile} onOpen={() => onOpenCard(tile.cardId)} />
                </li>
              ))}
            </ul>
          </section>
        )}

        {sections.books && (
          <section className="book-list__section" aria-labelledby="keepsakes-books">
            <h2 className="book-list__section-title" id="keepsakes-books">
              Memory Books
            </h2>
            <ul className="book-list__grid">
              {(books ?? []).map((book) => {
                const thumbKey = thumbKeys.get(book.id);
                const thumbUrl = thumbKey ? thumbUrls.get(thumbKey) : undefined;
                const clickable = book.status === 'ready';
                const name = book.child?.name ? `${book.child.name} — ${book.scope_label}` : book.scope_label;
                return (
                  <li key={book.id}>
                    <button
                      type="button"
                      className={`book-card${clickable ? '' : ' book-card--disabled'}`}
                      disabled={!clickable}
                      aria-label={bookTileAriaLabel(name, bookStatusLabel(book.status))}
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
                        <span className="book-card__label">{name}</span>
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
          </section>
        )}
      </div>
    </div>
  );
}

/** A holiday card tile: the year in the card's own serif on a soft panel, with its status. */
function HolidayCardTile({ tile, onOpen }: { tile: CardTile; onOpen: () => void }) {
  return (
    <button type="button" className="book-card" aria-label={tile.ariaLabel} onClick={onOpen}>
      <div className="book-card__thumb book-card__thumb--card" aria-hidden="true">
        <span className="book-card__card-year">{tile.year}</span>
      </div>
      <div className="book-card__meta">
        <span className="book-card__label">{tile.title}</span>
        <span className={`status-chip status-chip--card-${tile.state}`}>{tile.label}</span>
      </div>
    </button>
  );
}
