import { useEffect, useMemo, useState } from 'react';
import { useBookIndex, useBook } from './useBookData';
import { BookPicker } from './BookPicker';
import { SpreadPager } from './SpreadPager';
import { VariantSwitcher } from './VariantSwitcher';
import { buildDigestDemoPages } from './digestDemo';
import { GapsPanel } from './GapsPanel';
import { BookMap } from './BookMap';
import type { BookPage } from '../model/types';

/** Applies a live-picked variant to a page, swapping in that variant's own slots. */
function applyVariant(page: BookPage, variantIndex: number): BookPage {
  const variant = page.variants[variantIndex];
  if (!variant) return page;
  return {
    ...page,
    templateId: variant.templateId,
    params: variant.params,
    slots: variant.slots ?? page.slots,
  };
}

/**
 * The preview always shows the book as facing spreads, the way it sits in
 * a reader's hands, except the cover (owner decision, visual-review round
 * 2, item 3). A "unit" is what one Prev/Next step shows: the cover alone,
 * a genuine cross-gutter spread template alone (through-the-years,
 * panorama-spread), or an ordinary left+right pair of single pages.
 */
export interface DisplayUnit {
  rawIndices: number[];
}

/**
 * Bug fix (owner review round 4, item 8): pairing used to be pure array-
 * index adjacency (i, i+1) — but the fitter's own page ARRAY can drift out
 * of sync with true book-binding parity around a spread or a section
 * boundary (an isSpread unit consumes one array slot but two printed page
 * NUMBERS). Pairing two pages that aren't actually a genuine even/odd
 * (left/right) facing pair made some interior pages render alone in the
 * preview even though the true book would show them beside a neighbor.
 * Pairing now checks each page's OWN `isEvenPage` (computed authoritatively
 * by the fitter's `numberPages`) instead of just trusting array position.
 */
/**
 * Exported (round-5b addition) so the web app's `BookViewScreen` can reuse
 * the EXACT same facing-pair pagination the local preview uses — the
 * single-renderer rule (plan §3) means the web preview must page through a
 * book identically to this app, not re-derive its own (potentially
 * drifted) copy of this bug-fixed logic.
 */
export function computeUnits(pages: BookPage[]): DisplayUnit[] {
  const units: DisplayUnit[] = [];
  let i = 0;
  while (i < pages.length) {
    const page = pages[i];
    const next = pages[i + 1];
    if (page.templateId === 'cover-wrap' || page.isSpread) {
      units.push({ rawIndices: [i] });
      i += 1;
      continue;
    }
    if (
      next &&
      !next.isSpread &&
      next.templateId !== 'cover-wrap' &&
      page.isEvenPage === true &&
      next.isEvenPage === false
    ) {
      units.push({ rawIndices: [i, i + 1] });
      i += 2;
    } else {
      units.push({ rawIndices: [i] });
      i += 1;
    }
  }
  return units;
}

export function App() {
  const { index, error: indexError } = useBookIndex();
  const [slug, setSlug] = useState<string | null>(null);
  const { book, error: bookError, loading } = useBook(slug);

  const [unitIndex, setUnitIndex] = useState(0);
  const [showGuides, setShowGuides] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [showMap, setShowMap] = useState(true);
  const [showGaps, setShowGaps] = useState(true);
  // Owner round-11 option (b) exploration: replaces the page list with
  // client-built illustrated-digest spreads from THIS book's own short
  // illustrated memories (see src/preview/digestDemo.ts). Demo-only.
  const [digestDemo, setDigestDemo] = useState(false);
  const [variantChoice, setVariantChoice] = useState<Record<string, number>>({});

  useEffect(() => {
    if (index && index.books.length > 0 && !slug) {
      setSlug(index.books[0].slug);
    }
  }, [index, slug]);

  useEffect(() => {
    setUnitIndex(0);
    setVariantChoice({});
  }, [slug]);

  const realPages = book?.fit.document.pages ?? [];
  const pages = useMemo(
    () => (digestDemo && book ? buildDigestDemoPages(book.manifest) : realPages),
    [digestDemo, book, realPages],
  );
  const units = useMemo(() => computeUnits(pages), [pages]);
  const unitCount = units.length;
  const rawIndexToUnit = useMemo(() => {
    const map = new Map<number, number>();
    units.forEach((unit, ui) => unit.rawIndices.forEach((raw) => map.set(raw, ui)));
    return map;
  }, [units]);

  const currentUnit = units[unitIndex] ?? null;
  const rawPages = useMemo(() => (currentUnit ? currentUnit.rawIndices.map((i) => pages[i]) : []), [currentUnit, pages]);
  const displayPages = useMemo(
    () =>
      rawPages.map((p) => {
        const choice = variantChoice[p.id];
        return choice !== undefined ? applyVariant(p, choice) : p;
      }),
    [rawPages, variantChoice],
  );

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'ArrowRight') setUnitIndex((i) => Math.min(i + 1, unitCount - 1));
      if (e.key === 'ArrowLeft') setUnitIndex((i) => Math.max(i - 1, 0));
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [unitCount]);

  const currentRawIndex = currentUnit?.rawIndices[0] ?? 0;
  const pageLabel =
    currentUnit && currentUnit.rawIndices.length === 2
      ? `Pages ${currentUnit.rawIndices[0] + 1}-${currentUnit.rawIndices[1] + 1} / ${pages.length}`
      : `Page ${currentRawIndex + 1} / ${pages.length}`;

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">Momora — Book Preview</h1>
        {index && index.books.length > 0 && (
          <BookPicker books={index.books} selected={slug} onSelect={setSlug} />
        )}
        <div className="app__toggles">
          <label>
            <input type="checkbox" checked={showGuides} onChange={(e) => setShowGuides(e.target.checked)} />
            Guides
          </label>
          <label>
            <input type="checkbox" checked={zoomed} onChange={(e) => setZoomed(e.target.checked)} />
            Zoom
          </label>
          <label>
            <input type="checkbox" checked={showMap} onChange={(e) => setShowMap(e.target.checked)} />
            Book map
          </label>
          <label>
            <input type="checkbox" checked={showGaps} onChange={(e) => setShowGaps(e.target.checked)} />
            Gaps
          </label>
          <label>
            <input type="checkbox" checked={digestDemo} onChange={(e) => { setDigestDemo(e.target.checked); setUnitIndex(0); }} />
            Digest demo
          </label>
        </div>
      </header>

      {indexError && <div className="app__error">Could not load book index: {indexError}</div>}

      {index && index.books.length === 0 && (
        <div className="app__empty">
          No books found. Drop a <code>book-renderer/book-data/&lt;slug&gt;/</code> folder with
          <code>manifest.json</code> + <code>book.outline.json</code> (see the <code>sample/</code> book for the shape).
        </div>
      )}

      {bookError && <div className="app__error">Could not load book: {bookError}</div>}
      {loading && <div className="app__loading">Loading…</div>}

      {book && currentUnit && slug && (
        <div className="app__body">
          <div className="app__main">
            <SpreadPager
              pages={displayPages}
              manifest={book.manifest}
              bookSlug={slug}
              showGuides={showGuides}
              zoomed={zoomed}
              pageLabel={pageLabel}
              onPrev={() => setUnitIndex((i) => Math.max(i - 1, 0))}
              onNext={() => setUnitIndex((i) => Math.min(i + 1, unitCount - 1))}
            />
            <div className="app__variants">
              {rawPages.map((p) => (
                <VariantSwitcher
                  key={p.id}
                  variants={p.variants}
                  selectedIndex={variantChoice[p.id] ?? 0}
                  onSelect={(i) => setVariantChoice((prev) => ({ ...prev, [p.id]: i }))}
                />
              ))}
            </div>
          </div>
          <aside className="app__sidebar">
            {showGaps && <GapsPanel gaps={book.fit.gaps} capacity={book.fit.capacity} violations={book.violations} />}
            {showMap && (
              <BookMap
                pages={pages}
                manifest={book.manifest}
                bookSlug={slug}
                currentIndex={currentRawIndex}
                onSelect={(rawIndex) => setUnitIndex(rawIndexToUnit.get(rawIndex) ?? 0)}
              />
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
