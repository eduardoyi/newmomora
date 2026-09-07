import { useEffect, useMemo, useState } from 'react';
import { useEditableBook } from './useEditableBook';
import { useBookAssetProvider } from '../media/useBookAssetProvider';
import { collectManifestAssetKeys } from '../media/manifestKeys';
import { computeUnits } from '../../preview/App';
import { SpreadPager } from '../../preview/SpreadPager';
import { StatusChip } from '../books/StatusChip';
import { EditPanel } from '../edits/EditPanel';
import './BookViewScreen.css';

export function BookViewScreen({ bookId, onBack }: { bookId: string; onBack: () => void }) {
  const { loading, error, data, applyEditsPatch } = useEditableBook(bookId);
  const [unitIndex, setUnitIndex] = useState(0);
  const [editMode, setEditMode] = useState(false);

  const pages = data?.document.pages ?? [];
  const units = useMemo(() => computeUnits(pages), [pages]);
  const unitCount = units.length;
  const currentUnit = units[unitIndex] ?? null;
  const rawPages = useMemo(() => (currentUnit ? currentUnit.rawIndices.map((i) => pages[i]) : []), [currentUnit, pages]);

  useEffect(() => {
    setUnitIndex(0);
  }, [bookId]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (editMode) return; // Don't hijack arrow keys while typing in an edit field.
      if (e.key === 'ArrowRight') setUnitIndex((i) => Math.min(i + 1, unitCount - 1));
      if (e.key === 'ArrowLeft') setUnitIndex((i) => Math.max(i - 1, 0));
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [unitCount, editMode]);

  const assetKeys = useMemo(
    () => (data ? collectManifestAssetKeys(data.editedManifest) : []),
    [data],
  );
  const { onImageErrorCapture } = useBookAssetProvider(data?.book.status === 'ready' ? bookId : null, assetKeys);

  if (loading) {
    return (
      <div className="book-view book-view--center">
        <p className="book-view__hint">Loading book…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="book-view book-view--center">
        <p className="book-view__error">{error}</p>
        <button type="button" className="book-view__back" onClick={onBack}>
          Back to your books
        </button>
      </div>
    );
  }
  if (!data) return null;

  if (data.book.status !== 'ready') {
    return (
      <div className="book-view book-view--center">
        <StatusChip status={data.book.status} />
        <p className="book-view__hint">
          {data.book.status === 'failed'
            ? data.book.failure_reason ?? 'This book failed to generate.'
            : 'This book is still being made — check back soon.'}
        </p>
        <button type="button" className="book-view__back" onClick={onBack}>
          Back to your books
        </button>
      </div>
    );
  }

  const pageLabel =
    currentUnit && currentUnit.rawIndices.length === 2
      ? `Pages ${currentUnit.rawIndices[0] + 1}-${currentUnit.rawIndices[1] + 1} / ${pages.length}`
      : `Page ${(currentUnit?.rawIndices[0] ?? 0) + 1} / ${pages.length}`;

  return (
    <div className="book-view">
      <header className="book-view__header">
        <button type="button" className="book-view__back" onClick={onBack}>
          ← Your books
        </button>
        <span className="book-view__title">
          {data.book.child?.name ? `${data.book.child.name} — ${data.book.scope_label}` : data.book.scope_label}
        </span>
        {data.canEdit && (
          <button
            type="button"
            className={`book-view__edit-toggle${editMode ? ' book-view__edit-toggle--active' : ''}`}
            onClick={() => setEditMode((v) => !v)}
          >
            {editMode ? 'Done editing' : 'Edit'}
          </button>
        )}
      </header>

      <div className="book-view__body" onErrorCapture={onImageErrorCapture}>
        <div className="book-view__main">
          {currentUnit && (
            <SpreadPager
              pages={rawPages}
              manifest={data.editedManifest}
              bookSlug={data.book.id}
              showGuides={false}
              zoomed={false}
              pageLabel={pageLabel}
              onPrev={() => setUnitIndex((i) => Math.max(i - 1, 0))}
              onNext={() => setUnitIndex((i) => Math.min(i + 1, unitCount - 1))}
            />
          )}
        </div>

        {editMode && data.canEdit && (
          <aside className="book-view__sidebar">
            <EditPanel
              bookId={bookId}
              pages={rawPages}
              edits={data.edits}
              skipped={data.skipped}
              onEditsSaved={applyEditsPatch}
            />
          </aside>
        )}
      </div>
    </div>
  );
}
