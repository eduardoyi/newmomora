import { useEffect, useState } from 'react';
import type { SkippedEdit } from '../../model/edits';
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
 */
export function SkippedEditsToast({ skipped }: { skipped: SkippedEdit[] }) {
  const [dismissed, setDismissed] = useState(false);
  const signature = skipped.map((s) => `${s.kind}:${s.key}`).join('\n');

  useEffect(() => {
    setDismissed(false);
  }, [signature]);

  if (skipped.length === 0 || dismissed) return null;

  return (
    <div className="skipped-edits-toast" role="status">
      <span>
        {skipped.length} saved edit{skipped.length === 1 ? '' : 's'} no longer apply to this book (the content they
        targeted changed).
      </span>
      <button type="button" className="skipped-edits-toast__close" onClick={() => setDismissed(true)} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
