import type { ReactNode } from 'react';
import { PHYSICAL } from '../model/types';
import { pageDims, mmToPctWidth, mmToPctHeight, SAFE_INSET_MM, getSafeInsetPct, mmCqw } from './mm';
import './PageFrame.css';

/**
 * Physical model (docs/plans/memory-book.md Stage C):
 *   page = 210x210mm + 3mm bleed each side; safe margin 10mm inside trim.
 * A spread is two facing pages: 420mm wide (+ bleed on the two outer edges).
 *
 * This frame renders at CSS-scaled size honoring the exact aspect ratio —
 * never a hardcoded pixel size — so the on-screen preview is proportionally
 * identical to the print geometry (preview = print, per Stage C).
 */

export { getSafeInsetPct };

export interface PageFrameProps {
  isSpread: boolean;
  showGuides?: boolean;
  className?: string;
  children?: ReactNode;
  /**
   * Explicit canvas size (mm), overriding the normal page/spread binary —
   * used only by the wraparound cover, whose width is back+spine+front and
   * doesn't fit the fixed page/spread aspect ratios. When set, `fontSize`
   * (the 1mm-per-em base — see below) is derived from `widthMm` directly
   * rather than through `mmCqw`, which only knows the page/spread cases.
   */
  explicitDimsMm?: { widthMm: number; heightMm: number };
}

export function PageFrame({ isSpread, showGuides = false, className, children, explicitDimsMm }: PageFrameProps) {
  const { widthMm, heightMm } = explicitDimsMm ?? pageDims(isSpread);
  const safeInsetXPct = mmToPctWidth(SAFE_INSET_MM, isSpread);
  const safeInsetYPct = mmToPctHeight(SAFE_INSET_MM, isSpread);
  const trimInsetXPct = mmToPctWidth(PHYSICAL.bleedMm, isSpread);
  const trimInsetYPct = mmToPctHeight(PHYSICAL.bleedMm, isSpread);

  return (
    <div
      className={`page-frame${className ? ` ${className}` : ''}`}
      style={{
        aspectRatio: `${widthMm} / ${heightMm}`,
        // Base type size = 1mm in `cqw` units, so every plain `em` gap/size
        // in template CSS (a rule's width, a flex gap, an icon's padding)
        // scales with the frame's own rendered width too — not just the
        // font-sizes set explicitly via `ptCqw`. This is the other half of
        // making a page thumbnail-safe (see PageFrame.css's container-type
        // comment): without it, `em`-based spacing would stay pinned to the
        // browser's default font size and blow out at book-map thumbnail scale.
        fontSize: explicitDimsMm ? `${(1 / explicitDimsMm.widthMm) * 100}cqw` : mmCqw(1, isSpread),
      }}
      data-testid="page-frame"
      data-spread={isSpread}
    >
      <div className="page-frame__content">{children}</div>
      {showGuides && (
        <div className="page-frame__guides" aria-hidden="true">
          <div
            className="page-frame__guide page-frame__guide--trim"
            style={{
              top: `${trimInsetYPct}%`,
              left: `${trimInsetXPct}%`,
              right: `${trimInsetXPct}%`,
              bottom: `${trimInsetYPct}%`,
            }}
          />
          <div
            className="page-frame__guide page-frame__guide--safe"
            style={{
              top: `${safeInsetYPct}%`,
              left: `${safeInsetXPct}%`,
              right: `${safeInsetXPct}%`,
              bottom: `${safeInsetYPct}%`,
            }}
          />
          {isSpread && (
            <div className="page-frame__guide page-frame__guide--gutter" style={{ left: '50%' }} />
          )}
        </div>
      )}
    </div>
  );
}
