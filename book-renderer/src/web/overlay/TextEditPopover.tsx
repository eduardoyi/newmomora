import { useState } from 'react';
import { saveEdit, type UndoAction } from '../edits/editsApi';
import type { MemoryBookEditsShape, TextEditRecord } from '../../model/edits';
import type { PositionedTextRegion } from './useOverlayGeometry';
import { TextPopoverView } from './TextPopoverView';

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
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave(value: string) {
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

  // Anchored just below the region's own rect (both are relative to the
  // same stage container — see `useOverlayGeometry`). `maxWidth` +
  // `.text-popover`'s own CSS keep it from overflowing the stage on a
  // narrow phone viewport regardless of where the region sits.
  const style: React.CSSProperties = {
    left: Math.max(8, region.rect.left),
    top: region.rect.top + region.rect.height + 6,
  };

  return (
    <TextPopoverView
      label={region.label}
      approximateHint={region.approximate}
      value={region.value}
      resetKey={region.target}
      placeholder={region.placeholder}
      multiline={region.multiline}
      canReset={currentEdit !== null}
      saving={saving}
      resetting={resetting}
      error={error}
      style={style}
      onSave={(v) => void handleSave(v)}
      onReset={() => void handleReset()}
      onClose={onClose}
    />
  );
}
