import { ptCqw, getSafeInsetPct } from '../mm';
import { colors } from '../../theme';

/**
 * Folio (Momora Book Layout System 1b §4 "folio · numeral"): page number
 * only, outer corner, 10mm from trim, 7pt Plus Jakarta Sans 500 — the date
 * already lives in the page's own footer index, so the folio never repeats
 * it. Omitted (per the canvas) on panorama-spread, full-bleed, cover, and
 * any page whose content bleeds through the outer-bottom corner.
 *
 * Bug fix (owner review round 3 item 10): this used to sit at `bottom:0` /
 * `left:0` of the PageFrame's own box, i.e. the full-BLEED edge — since
 * Folio is rendered as a sibling of `<SafeArea>` (not inside it), that put
 * the numeral right at the page's cut edge, 10mm tighter than the canvas's
 * spec. It now uses the SAME safe-margin inset `<SafeArea>` itself uses, so
 * the numeral actually lands 10mm inside the trim like every other page
 * element.
 *
 * Note: the canvas draws the folio as page-number-only. If a "page number +
 * month" running-furniture treatment is wanted, that's a deviation from the
 * design source of truth as written and should be confirmed before adding.
 */
export function Folio({ pageNumber, isEvenPage, isSpread }: { pageNumber: number; isEvenPage: boolean; isSpread: boolean }) {
  const { x, y } = getSafeInsetPct(isSpread);
  return (
    <div
      style={{
        position: 'absolute',
        bottom: `${y}%`,
        [isEvenPage ? 'left' : 'right']: `${x}%`,
        fontFamily: 'var(--font-sans)',
        fontWeight: 500,
        fontSize: ptCqw(7, isSpread),
        lineHeight: 1,
        letterSpacing: '0.07em',
        color: colors.ink3,
      }}
    >
      {pageNumber}
    </div>
  );
}
