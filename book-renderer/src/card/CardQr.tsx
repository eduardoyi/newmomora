import { useMemo, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { colors } from '../theme';
import { QUIET_ZONE_MODULES, QrBadgeOverlay } from '../templates/common/QrCode';

/**
 * The card's QR: same drawing as the book's scan marks (ECC H, warm scan-ink
 * modules, 28% play badge in the middle, 4-module quiet zone) but sized in
 * millimetres instead of the book page's container units. `mm` is the whole
 * square INCLUDING the quiet zone.
 */
export function CardQr({ value, mm }: { value: string; mm: number }) {
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
      viewBox={`0 0 ${total} ${total}`}
      width={`${mm}mm`}
      height={`${mm}mm`}
      style={{ display: 'block', width: `${mm}mm`, height: `${mm}mm` }}
      role="img"
      aria-label=""
      data-testid="card-qr"
      data-qr-modules={size}
      shapeRendering="crispEdges"
    >
      <rect x={0} y={0} width={total} height={total} fill={colors.white} />
      <g fill={colors.scanInk}>{rects}</g>
      <QrBadgeOverlay center={total / 2} codeSize={size} kind="play" />
    </svg>
  );
}

/** Module size in mm for a QR of `mm` total size (quiet zone included). */
export function qrModuleMm(value: string, mm: number): number {
  const modules = QRCode.create(value, { errorCorrectionLevel: 'H' }).modules.size;
  return mm / (modules + QUIET_ZONE_MODULES * 2);
}
