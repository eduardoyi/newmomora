import type { BookIndexEntry } from '../vite-plugins/book-index-plugin';

export function BookPicker({
  books,
  selected,
  onSelect,
}: {
  books: BookIndexEntry[];
  selected: string | null;
  onSelect: (slug: string) => void;
}) {
  return (
    <label className="book-picker">
      <span className="book-picker__label">Book</span>
      <select
        className="book-picker__select"
        value={selected ?? ''}
        onChange={(e) => onSelect(e.target.value)}
      >
        {books.map((b) => (
          <option key={b.slug} value={b.slug}>
            {b.childName} — {b.scopeLabel || b.slug}
          </option>
        ))}
      </select>
    </label>
  );
}
