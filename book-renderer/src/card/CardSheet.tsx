import type { CSSProperties, ReactNode } from 'react';
import { CARD, type CardGeometry, type Rect } from './geometry';
import './card.css';

export interface CardOverlays {
  trim?: boolean;
  safe?: boolean;
  bleed?: boolean;
}

/** An absolutely positioned millimetre box. */
export function box(r: Rect): CSSProperties {
  return { position: 'absolute', left: `${r.x}mm`, top: `${r.y}mm`, width: `${r.w}mm`, height: `${r.h}mm` };
}

/**
 * One printed side: the full page (bleed included) at its exact size in mm,
 * with explicit width AND height (Chromium print quirk) and a hidden overflow.
 * `overlays` (preview only) draw the trim, bleed and safe-area guides.
 */
export function CardSheet({
  geometry,
  background,
  overlays,
  children,
  testId,
}: {
  geometry: CardGeometry;
  background: string;
  overlays?: CardOverlays;
  children: ReactNode;
  testId?: string;
}) {
  const { pageW, pageH, trim } = geometry;
  const safe = CARD.safeMm;
  return (
    <div className="card-sheet" data-testid={testId} style={{ width: `${pageW}mm`, height: `${pageH}mm`, background }}>
      {children}
      {overlays?.bleed && (
        <div className="card-abs" style={{ ...box({ x: 0, y: 0, w: pageW, h: pageH }), outline: '0.3mm dashed rgba(220,60,60,.9)', outlineOffset: '-0.15mm', pointerEvents: 'none' }} />
      )}
      {overlays?.trim && <div className="card-abs" style={{ ...box(trim), outline: '0.3mm solid rgba(220,60,60,.95)', outlineOffset: '-0.15mm', pointerEvents: 'none' }} />}
      {overlays?.safe && (
        <div
          className="card-abs"
          style={{ ...box({ x: trim.x + safe, y: trim.y + safe, w: trim.w - 2 * safe, h: trim.h - 2 * safe }), outline: '0.3mm dashed rgba(40,160,90,.95)', outlineOffset: '-0.15mm', pointerEvents: 'none' }}
        />
      )}
    </div>
  );
}
