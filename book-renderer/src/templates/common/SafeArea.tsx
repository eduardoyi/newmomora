import type { CSSProperties, ReactNode } from 'react';
import { getSafeInsetPct } from '../mm';

/**
 * Insets children to the safe zone (10mm inside trim, per Stage C) using
 * absolute top/bottom/left/right percentages — NOT CSS padding percentages,
 * which resolve against the container's width on every side (a common CSS
 * trap that would make vertical insets wrong on a square/near-square page).
 */
export function SafeArea({
  isSpread,
  style,
  className,
  children,
}: {
  isSpread: boolean;
  style?: CSSProperties;
  className?: string;
  children?: ReactNode;
}) {
  const { x, y } = getSafeInsetPct(isSpread);
  return (
    <div
      className={`safe-area${className ? ` ${className}` : ''}`}
      style={{
        position: 'absolute',
        top: `${y}%`,
        bottom: `${y}%`,
        left: `${x}%`,
        right: `${x}%`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
