import { useEffect, useMemo, useState } from 'react';
import { useFamilyBooks } from './useFamilyBooks';
import { StatusChip, bookStatusLabel } from './StatusChip';
import { firstSignedKey, pickListThumbnailCandidates } from './thumbnail';
import { getMediaUrls } from '../media/coalescer';
import { ConnectedShopHeader } from '../shell/ConnectedShopHeader';
import { useHolidayCardTiles } from './useHolidayCardTiles';
import { bookTileAriaLabel, homeSections, NOTHING_YET_COPY, type CardTile } from './keepsakes';
import type { CardTilePreview } from './cardPreview';
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
  const { tiles: cardTiles, previews: cardPreviews, loading: cardsLoading } = useHolidayCardTiles(familyIds);
  const [thumbUrls, setThumbUrls] = useState<Map<string, string>>(new Map());

  // Candidate cover keys per ready book; the first one `get-media-url` signs is used.
  const thumbKeys = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const book of books ?? []) {
      if (book.status !== 'ready') continue;
      const keys = pickListThumbnailCandidates(book);
      if (keys.length > 0) map.set(book.id, keys);
    }
    return map;
  }, [books]);
  const keysSignature = Array.from(thumbKeys.values()).flat().join('|');

  useEffect(() => {
    const keys = Array.from(new Set(Array.from(thumbKeys.values()).flat()));
    if (keys.length === 0) return;
    let cancelled = false;
    getMediaUrls(keys)
      .then((urls) => {
        if (!cancelled) setThumbUrls(urls);
      })
      .catch((e: unknown) => console.warn('book cover URLs failed', e instanceof Error ? e.message : e));
    return () => {
      cancelled = true;
    };
    // thumbKeys is derived from `books`; its serialized keys keep this from re-running every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysSignature]);

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
                  <HolidayCardTile tile={tile} preview={cardPreviews[tile.cardId] ?? null} onOpen={() => onOpenCard(tile.cardId)} />
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
                const thumbKey = firstSignedKey(thumbKeys.get(book.id) ?? [], thumbUrls);
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
                          <img src={thumbUrl} alt="" className="book-card__thumb-img" loading="lazy" decoding="async" />
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

/**
 * A holiday card tile: a little card (the front photo at the card's 7:5 / 5:7
 * proportion with its greeting under it) once the front is known; while the
 * card is being made (or has no preview) the year on a soft panel. Status chip
 * either way.
 */
function HolidayCardTile({ tile, preview, onOpen }: { tile: CardTile; preview: CardTilePreview | null; onOpen: () => void }) {
  const portrait = preview?.orientation === 'portrait';
  return (
    <button type="button" className="book-card" aria-label={tile.ariaLabel} onClick={onOpen}>
      <div className="book-card__thumb book-card__thumb--card" aria-hidden="true">
        {preview ? (
          <div className="card-mini">
            <img
              className={`card-mini__photo${portrait ? ' card-mini__photo--portrait' : ''}`}
              src={preview.url}
              alt=""
              width={preview.width ?? undefined}
              height={preview.height ?? undefined}
              loading="lazy"
              decoding="async"
            />
            <span className="card-mini__greeting">{preview.greeting}</span>
          </div>
        ) : (
          <span className="book-card__card-year">{tile.year}</span>
        )}
      </div>
      <div className="book-card__meta">
        <span className="book-card__label">{tile.title}</span>
        <span className={`status-chip status-chip--card-${tile.state}`}>{tile.label}</span>
      </div>
    </button>
  );
}
