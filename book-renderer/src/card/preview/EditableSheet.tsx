import { useState } from 'react';
import { CardBack } from '../CardBack';
import { CardFront } from '../CardFront';
import { CardSheet, type CardOverlays } from '../CardSheet';
import type { CardDocument, RegionTarget, TextRegion } from '../document';
import type { Rect } from '../geometry';
import { TextPopoverView } from '../../web/overlay/TextPopoverView';
import '../../web/overlay/EditOverlay.css';

const MM_PX = 96 / 25.4;

/** What the editor needs to know about one editable text field right now. */
export interface FieldState {
  /** The text shown in the editor (the saved edit or the generated default, un-normalized). */
  value: string;
  /** True when a saved edit exists (Reset to original is offered). */
  edited: boolean;
  placeholder?: string;
}

/**
 * One side of the card at `zoom` px/mm with the book's in-place editing
 * affordances on top: hover a text field to see it outlined, click it to edit
 * in the floating popover (live re-fit behind it); hover the front picture for
 * Replace / Reposition. The overlay is built from the fitted document's own
 * region rects (mm), so it needs no markup inside the card components (the
 * same "zero props in the templates" rule the book overlay follows).
 */
export function EditableSheet({
  doc,
  side,
  zoom,
  overlays,
  editable,
  fields,
  activeTarget,
  warning,
  blockSave,
  onOpenText,
  onDraft,
  onCloseText,
  onSaveText,
  onResetText,
  onReplace,
  onReposition,
}: {
  doc: CardDocument;
  side: 'front' | 'back';
  zoom: number;
  overlays?: CardOverlays;
  editable: boolean;
  fields: Record<RegionTarget, FieldState>;
  activeTarget: RegionTarget | null;
  warning: string | null;
  blockSave: boolean;
  onOpenText: (t: RegionTarget) => void;
  onDraft: (value: string) => void;
  onCloseText: () => void;
  onSaveText: (t: RegionTarget, value: string) => void;
  onResetText: (t: RegionTarget) => void;
  onReplace: () => void;
  onReposition: () => void;
}) {
  const { geometry } = doc;
  const w = geometry.pageW * zoom;
  const h = geometry.pageH * zoom;
  const px = (r: Rect) => ({ left: r.x * zoom, top: r.y * zoom, width: r.w * zoom, height: r.h * zoom });
  const regions = doc.regions.filter((r) => r.side === side);
  const active = regions.find((r) => r.target === activeTarget) ?? null;
  const [photoActive, setPhotoActive] = useState(false);
  const clip = doc.front.image.clip;

  function hotspot(r: TextRegion): Rect {
    // Comfortable minimum target (≥ 14 x 6 mm), centred on the text.
    const mw = Math.max(r.rect.w, 14);
    const mh = Math.max(r.rect.h, 6);
    return { x: r.rect.x - (mw - r.rect.w) / 2, y: r.rect.y - (mh - r.rect.h) / 2, w: mw, h: mh };
  }

  function popoverStyle(r: TextRegion): React.CSSProperties {
    if (r.target === 'letter') {
      // The letter is tall: dock the editor to the bottom of the screen so the card stays in view while typing.
      return { position: 'fixed', left: '50%', top: 'auto', bottom: 16, transform: 'translateX(-50%)', width: 'min(440px, calc(100vw - 24px))' };
    }
    const box = px(hotspot(r));
    return { left: Math.max(8, Math.min(box.left, w - 328)), top: Math.min(box.top + box.height + 6, h - 60) };
  }

  return (
    <div className="cp-sheetwrap" style={{ width: w, height: h }}>
      <div className="cp-frame" style={{ width: w, height: h }}>
        <div style={{ transform: `scale(${zoom / MM_PX})`, transformOrigin: 'top left', width: geometry.pageW * MM_PX, height: geometry.pageH * MM_PX }}>
          <CardSheet geometry={geometry} background={side === 'front' ? doc.front.paper : doc.back.paper} overlays={overlays} testId={`sheet-${side}`}>
            {side === 'front' ? <CardFront doc={doc.front} /> : <CardBack doc={doc.back} />}
          </CardSheet>
        </div>
      </div>

      {editable && (
        <div className="edit-overlay" data-testid={`overlay-${side}`}>
          {side === 'front' && (
            <div
              className={`edit-overlay__photo${photoActive ? ' edit-overlay__photo--active' : ''}`}
              style={px(clip)}
              onClick={() => setPhotoActive((a) => !a)}
              onMouseLeave={() => setPhotoActive(false)}
              data-testid="photo-hotspot"
            >
              <div className="edit-overlay__photo-actions">
                <button type="button" className="edit-overlay__photo-button" onClick={(e) => { e.stopPropagation(); onReplace(); }}>
                  Replace
                </button>
                {doc.front.image.canReposition && (
                  <button type="button" className="edit-overlay__photo-button" onClick={(e) => { e.stopPropagation(); onReposition(); }}>
                    Reposition
                  </button>
                )}
              </div>
            </div>
          )}
          {regions.map((r) => (
            <button
              key={r.target}
              type="button"
              className="edit-overlay__text"
              style={px(hotspot(r))}
              onClick={() => onOpenText(r.target)}
              aria-label={`Edit ${r.label}`}
              title={`Edit ${r.label.toLowerCase()}`}
              data-target={r.target}
            />
          ))}
        </div>
      )}

      {editable && active && (
        <TextPopoverView
          label={active.label}
          value={fields[active.target].value}
          resetKey={active.target}
          placeholder={fields[active.target].placeholder}
          multiline={active.multiline}
          rows={active.target === 'letter' ? 9 : 3}
          required={active.required}
          canReset={fields[active.target].edited}
          saving={false}
          resetting={false}
          error={null}
          warning={warning}
          blockSave={blockSave}
          style={popoverStyle(active)}
          onDraft={onDraft}
          onSave={(v) => onSaveText(active.target, v)}
          onReset={() => onResetText(active.target)}
          onClose={onCloseText}
        />
      )}
    </div>
  );
}
