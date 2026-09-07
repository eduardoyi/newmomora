import { useEffect, useState } from 'react';
import type { MemoryBookEditsShape, SkippedEdit } from '../../model/edits';
import { saveEdit, skippedDeleteInput } from './editsApi';
import './SkippedEditsToast.css';

/**
 * Always-on inline editing (owner-approved follow-up round, feature 3):
 * `EditPanel` — removed entirely — used to surface `skipped` orphaned
 * edits (a saved edit whose stable key no longer resolves against the
 * current outline/manifest/document, per `edits.ts`'s own doc comment) in
 * its sidebar banner. With no sidebar left, this is the same notice as a
 * small dismissible toast instead. Dismissal resets whenever the skipped
 * SET actually changes (a different book, or a fresh `skipped` list after
 * an edit save) — re-appearing for a genuinely new orphan even if the
 * previous batch was dismissed, never for the same one twice in a row.
 *
 * Owner follow-up round item 1 ("Skipped-edits toast: resolvable"): the "×"
 * only hides this particular toast instance — the orphan(s) are still in the
 * saved `edits` row, so the toast comes right back on the next load, forever.
 * "Remove" instead calls through to the SAME `delete` op every edit surface's
 * own "Reset to original" uses (`editsApi.ts`'s `SaveEditInput`), once per
 * orphan, so the row itself is cleaned up — after that, `skipped` naturally
 * comes back empty on the next render (`useEditableBook`'s `applyEditsPatch`
 * re-derives `document`/`skipped` from the server's own returned `edits`,
 * same optimistic-re-render path every other edit surface already uses), and
 * this toast has nothing left to show, on this load or any future one.
 */
export function SkippedEditsToast({
  bookId,
  skipped,
  onRemoved,
}: {
  bookId: string;
  skipped: SkippedEdit[];
  onRemoved: (edits: MemoryBookEditsShape) => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signature = skipped.map((s) => `${s.kind}:${s.key}`).join('\n');

  useEffect(() => {
    setDismissed(false);
    setError(null);
  }, [signature]);

  if (skipped.length === 0 || dismissed) return null;

  async function handleRemove() {
    setRemoving(true);
    setError(null);
    // Sequential, not `Promise.all` — every call round-trips through the
    // same edit row (real backend or the fixture stand-in), so firing them
    // concurrently would race two read-modify-writes against each other.
    // Each response's `edits` already reflects every delete applied so far,
    // so only the LAST one needs to reach the caller.
    let latest: MemoryBookEditsShape | null = null;
    for (const orphan of skipped) {
      const result = await saveEdit(bookId, skippedDeleteInput(orphan));
      if (result.error) {
        setRemoving(false);
        setError(result.error);
        if (latest) onRemoved(latest);
        return;
      }
      latest = result.edits;
    }
    setRemoving(false);
    if (latest) onRemoved(latest);
  }

  return (
    <div className="skipped-edits-toast" role="status">
      <div className="skipped-edits-toast__body">
        <span>
          {skipped.length === 1
            ? '1 saved edit no longer applies to this book (the content it targeted changed).'
            : `${skipped.length} saved edits no longer apply to this book (the content they targeted changed).`}
        </span>
        {error && <span className="skipped-edits-toast__error">{error}</span>}
      </div>
      <button type="button" className="skipped-edits-toast__remove" disabled={removing} onClick={() => void handleRemove()}>
        {removing ? 'Removing…' : 'Remove'}
      </button>
      <button type="button" className="skipped-edits-toast__close" onClick={() => setDismissed(true)} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
