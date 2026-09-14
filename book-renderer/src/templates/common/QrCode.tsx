import { useMemo, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { colors } from '../../theme';
import { mmCqw } from '../mm';

/**
 * Real, scannable QR codes (phase 2 — retires the static scan-mark placeholder
 * for every call site that supplies a `memoryId`; see `ScanMark.tsx`).
 * Pure SVG output (no canvas/PNG dependency — `qrcode`'s synchronous
 * `create()` just builds the module matrix, this component draws it), so it
 * renders identically in the browser preview, the print pipeline's headless
 * Puppeteer pass, and a plain `renderToStaticMarkup()` unit test.
 */

/**
 * White space (in QR modules, not mm) surrounding the dark matrix on every
 * side — the ISO/IEC 18004 recommended minimum quiet zone a scanner needs to
 * lock onto the mark, independent of whatever mm size it's ultimately
 * printed at.
 */
const QUIET_ZONE_MODULES = 4;

export type QrBadge = 'play' | 'audio';

export interface QrCodeProps {
  /** The exact string encoded — always `shareViewerUrl(shareToken)` from `model/qr.ts`, never anything else (or the dedication page's own stable, decorative `https://usemomora.com` sample — see ScanMark.tsx's header comment). */
  value: string;
  /** Rendered size (both width and height — a QR is always square) in mm, at the page's own scale. */
  mm: number;
  isSpread: boolean;
  className?: string;
  /**
   * Print-polish round (owner decision 2026-09-14, item D2): a small
   * centered badge overlaid on the code identifying the mark's media kind
   * at a glance — a play triangle for a video mark, a music/waveform glyph
   * for an audio one. Omitted (undefined) draws a plain code with no badge.
   * Covers at most ~18% of the code's own module width (well under the
   * ≤20% spec) and never touches the quiet zone.
   */
  badge?: QrBadge;
}

export function QrCode({ value, mm, isSpread, className, badge }: QrCodeProps) {
  // Error-correction H (~30% recovery — print-polish round item D2):
  // bumped from M so the centered badge overlay (which physically covers
  // real modules) still leaves a comfortably scannable code. H's higher
  // module density is a non-issue at these physical mark sizes/print
  // distances — the design system's own "M or better" floor is still met.
  const qr = useMemo(() => QRCode.create(value, { errorCorrectionLevel: 'H' }), [value]);
  const size = qr.modules.size;
  const total = size + QUIET_ZONE_MODULES * 2;

  const rects: ReactNode[] = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (qr.modules.get(row, col)) {
        rects.push(<rect key={row * size + col} x={col + QUIET_ZONE_MODULES} y={row + QUIET_ZONE_MODULES} width={1} height={1} />);
      }
    }
  }

  return (
    <svg
      className={className}
      viewBox={`0 0 ${total} ${total}`}
      style={{ width: mmCqw(mm, isSpread), height: mmCqw(mm, isSpread), flex: 'none', opacity: 0.9 }}
      role="img"
      aria-label=""
      data-testid="qr-code"
      data-qr-modules={size}
      data-qr-badge={badge ?? undefined}
    >
      <rect x={0} y={0} width={total} height={total} fill={colors.white} />
      {/* Warm scan-ink, never pure black (canvas's own "warm ink" rule — see ScanMark.tsx). */}
      <g fill={colors.scanInk}>{rects}</g>
      {badge && <QrBadgeOverlay center={total / 2} codeSize={size} kind={badge} />}
    </svg>
  );
}

/**
 * The centered badge itself, in the SAME module-unit coordinate space the
 * dark-module `<rect>`s above use (so it composes at any print/preview
 * scale with zero extra math) — a white rounded square (page-white, same as
 * the code's own background) with either a solid play triangle or a
 * 3-bar audio/waveform glyph, both in `colors.scanInk` to match the mark's
 * own module color. Drawn AFTER the dark modules in document order, so it
 * visually sits on top of whatever modules its footprint overlaps — the H
 * error-correction level above is what keeps the code scannable despite
 * that real coverage.
 */
function QrBadgeOverlay({ center, codeSize, kind }: { center: number; codeSize: number; kind: QrBadge }) {
  // 18% of the code's own module width — under the ≤20% spec, with a hair
  // of margin for rounding.
  const badgeSize = codeSize * 0.18;
  const x = center - badgeSize / 2;
  const y = center - badgeSize / 2;

  return (
    <g data-testid="qr-badge">
      <rect x={x} y={y} width={badgeSize} height={badgeSize} rx={badgeSize * 0.18} fill={colors.white} />
      {kind === 'play' ? (
        <polygon
          points={[
            [x + badgeSize * 0.38, y + badgeSize * 0.26],
            [x + badgeSize * 0.38, y + badgeSize * 0.74],
            [x + badgeSize * 0.76, y + badgeSize * 0.5],
          ]
            .map(([px, py]) => `${px},${py}`)
            .join(' ')}
          fill={colors.scanInk}
        />
      ) : (
        <AudioBadgeBars x={x} y={y} size={badgeSize} />
      )}
    </g>
  );
}

/** A small 3-bar equalizer/waveform glyph — deliberately simple geometry (rounded rects, no stems/flags) so it stays crisp at the ~2mm print size a badge renders at. */
function AudioBadgeBars({ x, y, size }: { x: number; y: number; size: number }) {
  const barWidth = size * 0.13;
  const gap = size * 0.1;
  const heights = [0.3, 0.56, 0.4].map((f) => size * f);
  const totalWidth = barWidth * 3 + gap * 2;
  const startX = x + (size - totalWidth) / 2;
  const centerY = y + size / 2;

  return (
    <g fill={colors.scanInk}>
      {heights.map((h, i) => (
        <rect
          key={i}
          x={startX + i * (barWidth + gap)}
          y={centerY - h / 2}
          width={barWidth}
          height={h}
          rx={barWidth / 2}
        />
      ))}
    </g>
  );
}
