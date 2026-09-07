import { useEffect, useRef, useState } from 'react';
import { getMediaUrls } from '../media/coalescer';
import { saveEdit } from './editsApi';
import type { MemoryBookEditsShape } from '../../model/edits';
import './FocalPointModal.css';

/**
 * Reposition-in-crop editing (Design Decision 9), implemented as a
 * dedicated modal against a fixed-aspect crop-preview box the user drags
 * within — deliberately NOT a live drag directly on the rendered book page.
 * The preview/print templates (`PhotoTile`/`FullBleed`/`PanoramaSpread`)
 * are read-only rendering components with no editor-affordance hooks, used
 * identically by the print pipeline; retrofitting pointer/drag handlers
 * into them to support one editor surface would couple every consumer of
 * `book-renderer`'s templates to this app's interaction model. This modal
 * uses the SAME resolved image (via the coalescer) and the SAME
 * `targetAspect` the real slot renders at, so the crop preview is an honest
 * approximation of what `objectPosition` will actually do
 * (`templates/common/focalPoint.ts`'s `objectPositionFor`).
 */
export function FocalPointModal({
  bookId,
  slotKey,
  assetFile,
  targetAspect,
  initial,
  onClose,
  onSaved,
}: {
  bookId: string;
  slotKey: string;
  assetFile: string;
  targetAspect: number;
  initial: { x: number; y: number } | null;
  onClose: () => void;
  onSaved: (edits: MemoryBookEditsShape) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [point, setPoint] = useState(initial ?? { x: 0.5, y: 0.5 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getMediaUrls([assetFile]).then((urls) => {
      if (!cancelled) setUrl(urls.get(assetFile) ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [assetFile]);

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

  async function handleSave() {
    setSaving(true);
    setError(null);
    const result = await saveEdit(bookId, { kind: 'focalPoint', slot: slotKey, x: point.x, y: point.y });
    setSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onSaved(result.edits);
    onClose();
  }

  return (
    <div className="focal-modal__backdrop" onClick={onClose}>
      <div className="focal-modal" onClick={(e) => e.stopPropagation()}>
        <header className="focal-modal__header">
          <h2 className="focal-modal__title">Reposition photo</h2>
          <button type="button" className="focal-modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <p className="focal-modal__hint">Drag to choose what stays in view when this photo is cropped.</p>

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
          <button type="button" className="focal-modal__button focal-modal__button--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="focal-modal__button" disabled={saving} onClick={() => void handleSave()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
