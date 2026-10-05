import { useEffect, useState, type CSSProperties } from 'react';
import './EditOverlay.css';

/**
 * The presentational half of the floating text editor (extracted from
 * `TextEditPopover.tsx` so the holiday card editor shares the book's exact
 * markup and CSS): label, input/textarea, Reset / Cancel / Save. It owns only
 * the draft `value`; saving, resetting and errors are the caller's. The book's
 * `TextEditPopover` is a thin wrapper that supplies `saveEdit`; the card editor
 * (`src/card/preview`) supplies a local edits store. Output markup is unchanged
 * from the pre-extraction popover.
 */
export interface TextPopoverViewProps {
  label: string;
  /** Shown after the label ("tap to add"), the book's approximate-anchor hint. */
  approximateHint?: boolean;
  /** The current value; the draft restarts from it whenever it (or `resetKey`) changes. */
  value: string;
  resetKey: string;
  placeholder?: string;
  multiline: boolean;
  /** True when a saved edit exists, i.e. "Reset to original" is offered. */
  canReset: boolean;
  saving: boolean;
  resetting: boolean;
  error: string | null;
  style: CSSProperties;
  onSave: (value: string) => void;
  onReset: () => void;
  onClose: () => void;
  /** Called on every keystroke (the card editor re-fits live behind the popover). */
  onDraft?: (value: string) => void;
  /** A gentle message under the input; when `blockSave` is set Save is disabled (the card never shrinks text below its readable minimum). */
  warning?: string | null;
  blockSave?: boolean;
  /** Extra rows of the textarea (card letters are longer than book captions). */
  rows?: number;
  /** Required fields cannot be saved empty. */
  required?: boolean;
}

export function TextPopoverView({
  label,
  approximateHint,
  value: initialValue,
  resetKey,
  placeholder,
  multiline,
  canReset,
  saving,
  resetting,
  error,
  style,
  onSave,
  onReset,
  onClose,
  onDraft,
  warning,
  blockSave,
  rows,
  required,
}: TextPopoverViewProps) {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    setValue(initialValue);
  }, [resetKey, initialValue]);

  const Field = multiline ? 'textarea' : 'input';
  const empty = required === true && value.trim() === '';

  return (
    <>
      <div className="text-popover__backdrop" onClick={onClose} />
      <div className="text-popover" style={style} onClick={(e) => e.stopPropagation()}>
        <span className="text-popover__label">
          {label}
          {approximateHint && <span className="text-popover__approx-hint"> · tap to add</span>}
        </span>
        <Field
          className="text-popover__input"
          value={value}
          placeholder={placeholder}
          rows={multiline ? (rows ?? 3) : undefined}
          autoFocus
          onChange={(e) => {
            setValue(e.target.value);
            onDraft?.(e.target.value);
          }}
        />
        {warning && <p className="text-popover__error">{warning}</p>}
        {error && <p className="text-popover__error">{error}</p>}
        <div className="text-popover__actions">
          {canReset && (
            <button
              type="button"
              className="text-popover__button text-popover__button--ghost text-popover__button--reset"
              disabled={saving || resetting}
              onClick={onReset}
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
            disabled={saving || resetting || value === initialValue || blockSave === true || empty}
            onClick={() => onSave(value)}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </>
  );
}
