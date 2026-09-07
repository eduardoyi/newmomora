import { useEffect, useState } from 'react';
import { saveEdit, type UndoAction } from '../edits/editsApi';
import type { MemoryBookEditsShape, TextEditRecord } from '../../model/edits';
import type { PositionedTextRegion } from './useOverlayGeometry';
import './EditOverlay.css';

/**
 * Floating popover editor for one text region, anchored just below its
 * on-page rect (polish-round item 3). Self-contained — the only editor for
 * a text target now that always-on inline editing (owner-approved
 * follow-up round) removed the `EditPanel` sidebar's own blur-to-commit
 * `TextFieldEditor`; this popover's explicit Save/Cancel is the sole flow.
 *
 * Owner-approved round-3 polish, item 3: `currentEdit` is the saved
 * `edits.text[region.target]` record, if any — `null` means this field is
 * still showing its computed default (furniture default, or the outline's
 * own text), nothing to reset. Every successful save/reset reports an
 * `UndoAction` alongside the new `edits` object so the book view's toast can
 * offer a one-shot "Undo" that restores exactly the value this action
 * overwrote.
 */
export function TextEditPopover({
  bookId,
  region,
  currentEdit,
  onClose,
  onSaved,
}: {
  bookId: string;
  region: PositionedTextRegion;
  currentEdit: TextEditRecord | null;
  onClose: () => void;
  onSaved: (edits: MemoryBookEditsShape, undo: UndoAction) => void;
}) {
  const [value, setValue] = useState(region.value);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(region.value);
  }, [region.target, region.value]);

  async function handleSave() {
    if (saving || resetting) return;
    setSaving(true);
    setError(null);
    const result = await saveEdit(bookId, { kind: 'text', target: region.target, value });
    setSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onSaved(result.edits, { category: 'text', key: region.target, previous: currentEdit });
    onClose();
  }

  async function handleReset() {
    if (saving || resetting || !currentEdit) return;
    setResetting(true);
    setError(null);
    const result = await saveEdit(bookId, { kind: 'delete', category: 'text', key: region.target });
    setResetting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onSaved(result.edits, { category: 'text', key: region.target, previous: currentEdit });
    onClose();
  }

  const Field = region.multiline ? 'textarea' : 'input';
  // Anchored just below the region's own rect (both are relative to the
  // same stage container — see `useOverlayGeometry`). `maxWidth` +
  // `.text-popover`'s own CSS keep it from overflowing the stage on a
  // narrow phone viewport regardless of where the region sits.
  const style: React.CSSProperties = {
    left: Math.max(8, region.rect.left),
    top: region.rect.top + region.rect.height + 6,
  };

  return (
    <>
      <div className="text-popover__backdrop" onClick={onClose} />
      <div className="text-popover" style={style} onClick={(e) => e.stopPropagation()}>
        <span className="text-popover__label">
          {region.label}
          {region.approximate && <span className="text-popover__approx-hint"> · tap to add</span>}
        </span>
        <Field
          className="text-popover__input"
          value={value}
          placeholder={region.placeholder}
          rows={region.multiline ? 3 : undefined}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
        />
        {error && <p className="text-popover__error">{error}</p>}
        <div className="text-popover__actions">
          {currentEdit && (
            <button
              type="button"
              className="text-popover__button text-popover__button--ghost text-popover__button--reset"
              disabled={saving || resetting}
              onClick={() => void handleReset()}
            >
              {resetting ? 'Resetting…' : 'Reset to original'}
            </button>
          )}
          <button type="button" className="text-popover__button text-popover__button--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="text-popover__button"
            disabled={saving || resetting || value === region.value}
            onClick={() => void handleSave()}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </>
  );
}
