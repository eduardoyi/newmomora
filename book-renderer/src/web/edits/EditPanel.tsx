import { useEffect, useState } from 'react';
import type { BookPage, PhotoSlotContent } from '../../model/types';
import type { MemoryBookEditsShape, SkippedEdit } from '../../model/edits';
import { computeEditablePhotoSlots, computeTextFields, type EditablePhotoSlot } from '../book/editableFields';
import { saveEdit } from './editsApi';
import { getMediaUrls } from '../media/coalescer';
import { PickerSheet } from './PickerSheet';
import { FocalPointModal } from './FocalPointModal';
import type { InBookAssets } from '../media/inBookAssets';
import './EditPanel.css';

/** Approximate front-cover-panel aspect for the focal-point crop preview —
 * `WraparoundCover` doesn't expose a computed front-panel aspect in
 * `params` (the geometry is derived internally from `PHYSICAL.pageSizeMm`,
 * a near-square 210x210mm trim), so this is a stated approximation, not the
 * exact render, same "honest approximation" caveat `FocalPointModal`'s own
 * header comment makes about the crop preview generally. */
const COVER_APPROX_ASPECT = 1;

export function EditPanel({
  bookId,
  pages,
  edits,
  skipped,
  inBookAssets,
  onEditsSaved,
}: {
  bookId: string;
  pages: BookPage[];
  edits: MemoryBookEditsShape;
  skipped: SkippedEdit[];
  /** Item 5's honest, client-computed in-book sets — threaded down to `PickerSheet`. */
  inBookAssets: InBookAssets;
  onEditsSaved: (edits: MemoryBookEditsShape) => void;
}) {
  const textFields = computeTextFields(pages);
  const photoSlots = computeEditablePhotoSlots(pages, edits);

  const [pickerSlot, setPickerSlot] = useState<EditablePhotoSlot | null>(null);
  const [focalSlot, setFocalSlot] = useState<EditablePhotoSlot | null>(null);
  const [dismissedSkipped, setDismissedSkipped] = useState(false);

  return (
    <div className="edit-panel">
      {skipped.length > 0 && !dismissedSkipped && (
        <div className="edit-panel__skipped">
          <span>
            {skipped.length} saved edit{skipped.length === 1 ? '' : 's'} no longer apply to this book (the content
            they targeted changed).
          </span>
          <button type="button" onClick={() => setDismissedSkipped(true)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {textFields.length === 0 && photoSlots.length === 0 && (
        <p className="edit-panel__empty">Nothing on this page can be edited yet.</p>
      )}

      {textFields.map((field) => (
        <TextFieldEditor key={field.target} bookId={bookId} field={field} onSaved={onEditsSaved} />
      ))}

      {photoSlots.length > 0 && (
        <div className="edit-panel__photos">
          <h3 className="edit-panel__section-title">Photos on this page</h3>
          {photoSlots.map((slot) => (
            <PhotoSlotEditor
              key={slot.key}
              slot={slot}
              onReplace={() => setPickerSlot(slot)}
              onReposition={() => setFocalSlot(slot)}
            />
          ))}
        </div>
      )}

      {pickerSlot && (
        <PickerSheet
          bookId={bookId}
          slotKey={pickerSlot.key}
          isCover={pickerSlot.isCover}
          targetAspect={findTargetAspect(pages, pickerSlot)}
          inBookAssets={inBookAssets}
          onClose={() => setPickerSlot(null)}
          onSaved={onEditsSaved}
        />
      )}

      {focalSlot && (
        <FocalPointModal
          bookId={bookId}
          slotKey={focalSlot.key}
          assetFile={focalSlot.assetFile}
          targetAspect={findTargetAspect(pages, focalSlot) ?? COVER_APPROX_ASPECT}
          initial={edits.focalPoints?.[focalSlot.key] ?? null}
          onClose={() => setFocalSlot(null)}
          onSaved={onEditsSaved}
        />
      )}
    </div>
  );
}

function findTargetAspect(pages: BookPage[], slot: EditablePhotoSlot): number | null {
  if (slot.isCover) return null;
  for (const page of pages) {
    for (const s of page.slots) {
      if (s.content.kind !== 'photo') continue;
      const content = s.content as PhotoSlotContent;
      if (content.memoryId === slot.memoryId && content.assetFile === slot.assetFile) {
        return content.targetAspect;
      }
    }
  }
  return null;
}

function TextFieldEditor({
  bookId,
  field,
  onSaved,
}: {
  bookId: string;
  field: ReturnType<typeof computeTextFields>[number];
  onSaved: (edits: MemoryBookEditsShape) => void;
}) {
  const [value, setValue] = useState(field.value);
  const [saved, setSaved] = useState(field.value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(field.value);
    setSaved(field.value);
  }, [field.target, field.value]);

  async function commit() {
    if (value === saved || saving) return;
    setSaving(true);
    setError(null);
    const result = await saveEdit(bookId, { kind: 'text', target: field.target, value });
    setSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setSaved(value);
    onSaved(result.edits);
  }

  const Field = field.multiline ? 'textarea' : 'input';

  return (
    <label className="edit-field">
      <span className="edit-field__label">{field.label}</span>
      <Field
        className="edit-field__input"
        value={value}
        placeholder={field.placeholder}
        rows={field.multiline ? 3 : undefined}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commit()}
      />
      {saving && <span className="edit-field__status">Saving…</span>}
      {error && <span className="edit-field__error">{error}</span>}
    </label>
  );
}

function PhotoSlotEditor({
  slot,
  onReplace,
  onReposition,
}: {
  slot: EditablePhotoSlot;
  onReplace: () => void;
  onReposition: () => void;
}) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMediaUrls([slot.assetFile]).then((urls) => {
      if (!cancelled) setThumbUrl(urls.get(slot.assetFile) ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [slot.assetFile]);

  return (
    <div className="photo-slot-editor">
      <div className="photo-slot-editor__thumb">
        {thumbUrl ? <img src={thumbUrl} alt="" /> : <div className="photo-slot-editor__thumb-placeholder" />}
      </div>
      <div className="photo-slot-editor__meta">
        <span className="photo-slot-editor__label">{slot.isCover ? 'Cover photo' : 'Photo'}</span>
        <div className="photo-slot-editor__actions">
          <button type="button" onClick={onReplace}>
            Replace
          </button>
          <button type="button" onClick={onReposition}>
            Reposition
          </button>
        </div>
      </div>
    </div>
  );
}
