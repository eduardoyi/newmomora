import scanMarkUrl from '../../assets/scan-mark.svg';
import { mmCqw, QR_SIZE_MM, AUDIO_MARK_SIZE_MM } from '../mm';

/**
 * The real scan-mark asset (design-handoff/assets/scan-mark.svg), warm ink
 * #4A3F35 on white — never a fake/random QR-looking pattern, and never pure
 * black. Two sizes, one drawing: 13mm on a credit line (video/audio inline
 * default) and 26mm for audio-note, where the mark IS the page image.
 *
 * NOT yet a real, scannable code — phase 2 wires the short-URL QR
 * (momora.com/b/<token>, see docs/plans/memory-book.md §7). This renders the
 * static brand mark at the correct size/placement so the layout is final.
 */
export function ScanMark({ size, isSpread }: { size: 'inline' | 'audio'; isSpread: boolean }) {
  const mm = size === 'audio' ? AUDIO_MARK_SIZE_MM : QR_SIZE_MM;
  return (
    <img
      src={scanMarkUrl}
      alt=""
      className="scan-mark"
      // The canvas renders the mark at opacity .9 everywhere it appears —
      // never full-strength black-on-white — matching its own documented
      // "warm ink, never pure black" rule.
      style={{ width: mmCqw(mm, isSpread), height: mmCqw(mm, isSpread), flex: 'none', opacity: 0.9 }}
    />
  );
}
