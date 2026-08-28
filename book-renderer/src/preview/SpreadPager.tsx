import type { BookManifest, BookPage } from '../model/types';
import { TemplateRenderer } from '../templates';
import './SpreadPager.css';

/**
 * The preview always shows the book as facing spreads — the way it sits in
 * a reader's hands — except the cover, which stands alone (owner decision,
 * visual-review round 2, item 3). `pages` is 1 or 2 entries: 1 for the
 * cover or a genuine cross-gutter spread template (through-the-years,
 * panorama-spread), 2 for an ordinary left+right facing pair.
 */
export function SpreadPager({
  pages,
  manifest,
  bookSlug,
  showGuides,
  zoomed,
  pageLabel,
  onPrev,
  onNext,
}: {
  pages: BookPage[];
  manifest: BookManifest;
  bookSlug: string;
  showGuides: boolean;
  zoomed: boolean;
  pageLabel: string;
  onPrev: () => void;
  onNext: () => void;
}) {
  const isFacingPair = pages.length === 2;
  return (
    <div className="spread-pager">
      <button
        type="button"
        className="spread-pager__nav spread-pager__nav--prev"
        onClick={onPrev}
        aria-label="Previous page"
      >
        ‹
      </button>
      <div className={`spread-pager__stage${zoomed ? ' spread-pager__stage--zoomed' : ''}`}>
        <div className={`spread-pager__frame${pages[0].isSpread || isFacingPair ? ' spread-pager__frame--spread' : ''}`}>
          {isFacingPair ? (
            <div className="spread-pager__facing">
              {pages.map((page) => (
                <div className="spread-pager__facing-half" key={page.id}>
                  <TemplateRenderer page={page} manifest={manifest} bookSlug={bookSlug} showGuides={showGuides} />
                </div>
              ))}
            </div>
          ) : (
            <TemplateRenderer page={pages[0]} manifest={manifest} bookSlug={bookSlug} showGuides={showGuides} />
          )}
        </div>
        <div className="spread-pager__caption">
          {pageLabel} · {pages.map((p) => p.templateId).join(' + ')} · {pages[0].sourceElementId}
        </div>
      </div>
      <button
        type="button"
        className="spread-pager__nav spread-pager__nav--next"
        onClick={onNext}
        aria-label="Next page"
      >
        ›
      </button>
    </div>
  );
}
