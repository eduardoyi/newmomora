import { useEffect, useState } from 'react';
import type { UndoAction } from './editsApi';
import './EditSavedToast.css';

const AUTO_DISMISS_MS = 6000;

/**
 * Owner-approved round-3 polish, item 3b: a one-shot "Saved · Undo" toast
 * after any successful save/reset from the inline edit surfaces
 * (`TextEditPopover`/`PickerSheet`/`FocalPointModal`). `pending` is a fresh
 * `UndoAction` object each time `BookViewScreen`'s `handleEditsSaved` runs —
 * a NEW save always replaces whatever undo was pending before it (no
 * multi-level history, per the brief), and this component's own effects key
 * off that object's reference identity to reset its dismissed/timer state
 * whenever a new one lands, even if its content happens to be identical to
 * the last one.
 *
 * This component is purely presentational — it doesn't call `saveEdit`
 * itself; `onUndo` (owned by `BookViewScreen`, which already holds `edits`/
 * `applyEditsPatch`) does the actual replay-save and clears `pending` back
 * to `null` on completion, which this component also treats as "nothing to
 * show".
 */
export function EditSavedToast({
  pending,
  undoing,
  demoted,
  onUndo,
  onDismiss,
}: {
  pending: UndoAction | null;
  undoing: boolean;
  /** Item 4 (owner-approved editing-UX round): true when this save's
   * edited slot was full-bleed/panorama BEFORE and isn't anymore AFTER the
   * refit (`reflowNotice.ts`'s `computeReflowResult`) — folds an extra
   * sentence into the SAME toast rather than stacking a second one (the
   * brief: "don't stack confusingly — one combined toast is fine"). */
  demoted: boolean;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(false);
  }, [pending]);

  useEffect(() => {
    if (!pending || dismissed || undoing) return;
    const timer = setTimeout(() => setDismissed(true), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [pending, dismissed, undoing]);

  if (!pending || dismissed) return null;

  return (
    <div className={`edit-saved-toast${demoted ? ' edit-saved-toast--demoted' : ''}`} role="status">
      <span className="edit-saved-toast__message">
        Saved.
        {demoted && (
          <span className="edit-saved-toast__demotion">
            {' '}
            This photo may be too small to print full-page, so it moved to a regular spot.
          </span>
        )}
      </span>
      <button type="button" className="edit-saved-toast__undo" disabled={undoing} onClick={onUndo}>
        {undoing ? 'Undoing…' : 'Undo'}
      </button>
      <button
        type="button"
        className="edit-saved-toast__close"
        aria-label="Dismiss"
        onClick={() => {
          setDismissed(true);
          onDismiss();
        }}
      >
        ×
      </button>
    </div>
  );
}
