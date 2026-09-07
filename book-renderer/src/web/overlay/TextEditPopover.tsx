import { useEffect, useState } from 'react';
import { saveEdit } from '../edits/editsApi';
import type { MemoryBookEditsShape } from '../../model/edits';
import type { PositionedTextRegion } from './useOverlayGeometry';
import './EditOverlay.css';

/**
 * Floating popover editor for one text region, anchored just below its
 * on-page rect (polish-round item 3). Self-contained — same `saveEdit`
 * flow `EditPanel.tsx`'s `TextFieldEditor` already uses, kept as a
 * separate small component here rather than shared, since the two have
 * different trigger/positioning models (blur-to-commit in a static sidebar
 * list vs. an anchored popover with explicit Save/Cancel).
 */
export function TextEditPopover({
  bookId,
  region,
  onClose,
  onSaved,
}: {
  bookId: string;
  region: PositionedTextRegion;
  onClose: () => void;
  onSaved: (edits: MemoryBookEditsShape) => void;
}) {
  const [value, setValue] = useState(region.value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(region.value);
  }, [region.target, region.value]);

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setError(null);
    const result = await saveEdit(bookId, { kind: 'text', target: region.target, value });
    setSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onSaved(result.edits);
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
          <button type="button" className="text-popover__button text-popover__button--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="text-popover__button"
            disabled={saving || value === region.value}
            onClick={() => void handleSave()}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </>
  );
}
