import { useEffect, useRef, useState } from 'react';
import { useVisualViewport } from './useCardHooks';

/**
 * The phone / touch text editor: a full-width sheet pinned to the VISUAL
 * viewport (`window.visualViewport`), so when the soft keyboard opens the sheet
 * shrinks to the space above it and Save / Cancel stay reachable. The letter
 * opens in reading mode (no keyboard until you tap into it): at ~7 px on the
 * miniature card it is unreadable, here it is 17 px with the card's own serif.
 */
export function PhoneTextSheet({
  label,
  value: initialValue,
  resetKey,
  placeholder,
  multiline,
  required,
  canReset,
  warning,
  blockSave,
  fontFamily,
  reading,
  onDraft,
  onSave,
  onReset,
  onClose,
}: {
  label: string;
  value: string;
  resetKey: string;
  placeholder?: string;
  multiline: boolean;
  required: boolean;
  canReset: boolean;
  warning: string | null;
  blockSave: boolean;
  /** CSS font-family for the text (the aliased serif for the letter). */
  fontFamily?: string;
  /** Open without focusing the field (letter: read first). */
  reading: boolean;
  onDraft: (value: string) => void;
  onSave: (value: string) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const vv = useVisualViewport(true);
  const fieldRef = useRef<HTMLTextAreaElement & HTMLInputElement>(null);

  useEffect(() => {
    setValue(initialValue);
  }, [resetKey, initialValue]);

  // Lock the page behind the sheet (so a scroll does not move the card under the keyboard).
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    if (!reading) fieldRef.current?.focus();
  }, [reading]);

  const empty = required && value.trim() === '';
  const Field = multiline ? 'textarea' : 'input';

  return (
    <div className="ce-textsheet" style={{ top: vv.offsetTop, height: vv.height }} role="dialog" aria-modal="true" aria-label={label}>
      <header className="ce-textsheet__head">
        <h2 className="ce-textsheet__title">{label}</h2>
        <button type="button" className="ce-textsheet__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <div className="ce-textsheet__body">
        <Field
          // Both elements share the ref type loosely; this is the single focusable field.
          ref={fieldRef as never}
          className={`ce-textsheet__field${multiline ? ' ce-textsheet__field--multi' : ''}`}
          style={{ fontFamily }}
          value={value}
          placeholder={placeholder}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement & HTMLInputElement>) => {
            setValue(e.target.value);
            onDraft(e.target.value);
          }}
        />
        {warning && <p className="ce-textsheet__warning">{warning}</p>}
      </div>
      <footer className="ce-textsheet__foot" style={{ paddingBottom: vv.keyboardOpen ? 12 : undefined }}>
        {canReset && (
          <button type="button" className="ce-btn ce-btn--ghost" onClick={onReset}>
            Reset to original
          </button>
        )}
        <span className="ce-spacer" />
        <button type="button" className="ce-btn ce-btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="ce-btn" disabled={value === initialValue || blockSave || empty} onClick={() => onSave(value)}>
          Save
        </button>
      </footer>
    </div>
  );
}
