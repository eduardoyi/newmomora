import { useRef, useState } from 'react';
import './FocalPointModal.css';

/**
 * The presentational half of the reposition modal (extracted from
 * `FocalPointModal.tsx` so the holiday card editor shares the exact drag box,
 * reticle and CSS). It owns the draft point and the drag; resolving the image
 * URL, saving and resetting are the caller's. Output markup is unchanged from
 * the pre-extraction modal.
 */
export interface FocalPointModalViewProps {
  /** The resolved image URL (null while loading). */
  url: string | null;
  targetAspect: number;
  /** The saved point, if any: also decides whether "Reset to original position" is offered. */
  initial: { x: number; y: number } | null;
  saving: boolean;
  resetting: boolean;
  error: string | null;
  title?: string;
  hint?: string;
  onSave: (point: { x: number; y: number }) => void;
  onReset: () => void;
  onClose: () => void;
}

export function FocalPointModalView({
  url,
  targetAspect,
  initial,
  saving,
  resetting,
  error,
  title = 'Reposition photo',
  hint = 'Drag to choose what stays in view when this photo is cropped.',
  onSave,
  onReset,
  onClose,
}: FocalPointModalViewProps) {
  const [point, setPoint] = useState(initial ?? { x: 0.5, y: 0.5 });
  const boxRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  function pointFromEvent(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const box = boxRef.current;
    if (!box) return point;
    const rect = box.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    return { x, y };
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    draggingRef.current = true;
    (e.target as Element).setPointerCapture(e.pointerId);
    setPoint(pointFromEvent(e));
  }
  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    setPoint(pointFromEvent(e));
  }
  function handlePointerUp() {
    draggingRef.current = false;
  }

  return (
    <div className="focal-modal__backdrop" onClick={onClose}>
      <div className="focal-modal" onClick={(e) => e.stopPropagation()}>
        <header className="focal-modal__header">
          <h2 className="focal-modal__title">{title}</h2>
          <button type="button" className="focal-modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <p className="focal-modal__hint">{hint}</p>

        <div
          ref={boxRef}
          className="focal-modal__box"
          style={{ aspectRatio: `${targetAspect}` }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          {url ? (
            <img
              src={url}
              alt=""
              className="focal-modal__img"
              style={{ objectPosition: `${point.x * 100}% ${point.y * 100}%` }}
              draggable={false}
            />
          ) : (
            <div className="focal-modal__placeholder" />
          )}
          <div className="focal-modal__reticle" style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }} />
        </div>

        {error && <p className="focal-modal__error">{error}</p>}

        <div className="focal-modal__actions">
          {initial && (
            <button
              type="button"
              className="focal-modal__button focal-modal__button--ghost focal-modal__button--reset"
              disabled={saving || resetting}
              onClick={onReset}
            >
              {resetting ? 'Resetting…' : 'Reset to original position'}
            </button>
          )}
          <button type="button" className="focal-modal__button focal-modal__button--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="focal-modal__button" disabled={saving || resetting} onClick={() => onSave(point)}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
