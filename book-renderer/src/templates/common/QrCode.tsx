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

export interface QrCodeProps {
  /** The exact string encoded — always `memoryViewerUrl(memoryId)` from `model/qr.ts`, never anything else. */
  value: string;
  /** Rendered size (both width and height — a QR is always square) in mm, at the page's own scale. */
  mm: number;
  isSpread: boolean;
  className?: string;
}

export function QrCode({ value, mm, isSpread, className }: QrCodeProps) {
  // Error-correction M (~15% recovery) at the design system's documented
  // 13mm/26mm mark sizes comfortably clears the module-density floor a
  // consumer phone camera can resolve at arm's length print distance —
  // "M or better" per the print-pipeline brief.
  const qr = useMemo(() => QRCode.create(value, { errorCorrectionLevel: 'M' }), [value]);
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
    >
      <rect x={0} y={0} width={total} height={total} fill={colors.white} />
      {/* Warm scan-ink, never pure black (canvas's own "warm ink" rule — see ScanMark.tsx). */}
      <g fill={colors.scanInk}>{rects}</g>
    </svg>
  );
}
