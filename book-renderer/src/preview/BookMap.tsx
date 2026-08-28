import type { BookManifest, BookPage } from '../model/types';
import { TemplateRenderer } from '../templates';
import './BookMap.css';

/** All spreads/pages as thumbnails, for jumping around the book at a glance. */
export function BookMap({
  pages,
  manifest,
  bookSlug,
  currentIndex,
  onSelect,
}: {
  pages: BookPage[];
  manifest: BookManifest;
  bookSlug: string;
  currentIndex: number;
  onSelect: (index: number) => void;
}) {
  return (
    <div className="book-map" role="list">
      {pages.map((page, i) => (
        <button
          key={page.id}
          type="button"
          role="listitem"
          className={`book-map__item${i === currentIndex ? ' book-map__item--active' : ''}`}
          onClick={() => onSelect(i)}
          title={`${i + 1}. ${page.templateId}`}
        >
          <div className="book-map__thumb">
            <TemplateRenderer page={page} manifest={manifest} bookSlug={bookSlug} showGuides={false} />
          </div>
          <span className="book-map__index">{i + 1}</span>
        </button>
      ))}
    </div>
  );
}
