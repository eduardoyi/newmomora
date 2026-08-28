import scanMarkUrl from '../../assets/scan-mark.svg';
import { mmCqw, QR_SIZE_MM, AUDIO_MARK_SIZE_MM } from '../mm';
import { QrCode } from './QrCode';
import { memoryViewerUrl } from '../../model/qr';

/**
 * The scan mark. Two sizes, one meaning: 13mm on a credit line (video/audio
 * inline default) and 26mm for audio-note, where the mark IS the page image.
 *
 * Phase 2 (real QR): when the caller has a `memoryId` (every video/audio
 * call site does — the two that don't yet, see below), this renders an
 * actual scannable QR encoding `memoryViewerUrl(memoryId)` (`model/qr.ts`),
 * drawn as pure SVG at the same warm-ink #4A3F35 color and mm size the
 * static mark always used — the visual contract is unchanged, only the
 * pattern inside it is now real.
 *
 * Without a `memoryId` this still falls back to the static brand-mark asset
 * (design-handoff/assets/scan-mark.svg) — the ONE remaining caller is
 * `FooterIndex.tsx`'s synthetic full-bleed/panorama-video credit line,
 * whose `FooterIndexEntry` (built in `fitter.ts`, out of scope for this
 * change) doesn't carry a memoryId to encode. Never fabricates one.
 */
export function ScanMark({ size, isSpread, memoryId }: { size: 'inline' | 'audio'; isSpread: boolean; memoryId?: string }) {
  const mm = size === 'audio' ? AUDIO_MARK_SIZE_MM : QR_SIZE_MM;

  if (memoryId) {
    return <QrCode value={memoryViewerUrl(memoryId)} mm={mm} isSpread={isSpread} className="scan-mark" />;
  }

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
