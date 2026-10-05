import { useEffect, useState } from 'react';
import { getMediaUrls } from '../media/coalescer';
import { saveEdit, type UndoAction } from './editsApi';
import type { MemoryBookEditsShape } from '../../model/edits';
import { FocalPointModalView } from './FocalPointModalView';

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
  /** Also doubles as this slot's `previous` value for the toast's one-shot
   * Undo (owner-approved round-3 polish, item 3) — the caller
   * (`EditOverlay.tsx`) derives this from `edits.focalPoints[slotKey]`, the
   * exact record a save/reset here overwrites. */
  initial: { x: number; y: number } | null;
  onClose: () => void;
  onSaved: (edits: MemoryBookEditsShape, undo: UndoAction) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMediaUrls([assetFile]).then((urls) => {
      if (!cancelled) setUrl(urls.get(assetFile) ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [assetFile]);

  // `initial` is `{x,y}|null` (this modal's own render-preview state
  // doesn't need the `slot` field), but `UndoAction.focalPoints.previous`
  // is a full `FocalPointEditRecord` (mirroring the server's stored shape,
  // `slot` included) — this re-wraps it, never re-deriving `x`/`y`.
  const previousFocalPoint = initial ? { slot: slotKey, x: initial.x, y: initial.y } : null;

  async function handleSave(point: { x: number; y: number }) {
    setSaving(true);
    setError(null);
    const result = await saveEdit(bookId, { kind: 'focalPoint', slot: slotKey, x: point.x, y: point.y });
    setSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onSaved(result.edits, { category: 'focalPoints', key: slotKey, previous: previousFocalPoint });
    onClose();
  }

  /** Item 3: "Reset to original position" — removes the saved focal-point
   * override for this slot, restoring the default (0.5, 0.5) browser-native
   * center on next render. Only offered when a saved override exists. */
  async function handleReset() {
    if (saving || resetting || !initial) return;
    setResetting(true);
    setError(null);
    const result = await saveEdit(bookId, { kind: 'delete', category: 'focalPoints', key: slotKey });
    setResetting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onSaved(result.edits, { category: 'focalPoints', key: slotKey, previous: previousFocalPoint });
    onClose();
  }

  return (
    <FocalPointModalView
      url={url}
      targetAspect={targetAspect}
      initial={initial}
      saving={saving}
      resetting={resetting}
      error={error}
      onSave={(p) => void handleSave(p)}
      onReset={() => void handleReset()}
      onClose={onClose}
    />
  );
}
