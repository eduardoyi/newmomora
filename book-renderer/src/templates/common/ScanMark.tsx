import scanMarkUrl from '../../assets/scan-mark.svg';
import { mmCqw, QR_SIZE_MM, AUDIO_MARK_SIZE_MM } from '../mm';
import { QrCode } from './QrCode';
import { shareViewerUrl } from '../../model/qr';

/**
 * The scan mark. Two sizes, one meaning: 13mm on a credit line (video/audio
 * inline default) and 26mm for audio-note, where the mark IS the page image.
 *
 * Real QR, Round-19 (revocable tokens): when the caller has a `shareToken`
 * (a `media_share_tokens.token` resolved from the manifest's own
 * `ManifestMemory.shareToken` — every video/audio call site does, when the
 * export pipeline minted one), this renders an actual scannable QR encoding
 * `shareViewerUrl(shareToken)` (`model/qr.ts`), drawn as pure SVG at the
 * same warm-ink #4A3F35 color and mm size the static mark always used — the
 * visual contract is unchanged, only the pattern inside it is now real.
 * This deliberately takes the TOKEN, never the raw memory id — see
 * `model/qr.ts`'s header note on why (revocability).
 *
 * Without a `shareToken` this still falls back to the static brand-mark
 * asset (design-handoff/assets/scan-mark.svg) — either a manifest exported
 * before tokens existed (predates Round-19 — never fabricate a link from
 * the memory id in that case), or `FooterIndex.tsx`'s synthetic full-bleed/
 * panorama-video credit line, whose `FooterIndexEntry` (built in
 * `fitter.ts`, out of scope for this change) doesn't carry one to encode.
 */
export function ScanMark({
  size,
  isSpread,
  shareToken,
}: {
  size: 'inline' | 'audio';
  isSpread: boolean;
  shareToken?: string | null;
}) {
  const mm = size === 'audio' ? AUDIO_MARK_SIZE_MM : QR_SIZE_MM;
  // Print-polish round (owner decision 2026-09-14, item D2): every `size:
  // 'audio'` call site is the AudioNote page (the mark IS the page, always
  // audio), and every `size: 'inline'` call site is a video mark (PhotoTile,
  // the full-bleed/panorama video's FooterIndex credit, AnchorMedia's solo/
  // pair video placement) — `size` alone is already an exact proxy for
  // which badge belongs on this mark, with zero new prop threading needed
  // at any call site.
  const badge = size === 'audio' ? 'audio' : 'play';

  if (shareToken) {
    return <QrCode value={shareViewerUrl(shareToken)} mm={mm} isSpread={isSpread} className="scan-mark" badge={badge} />;
  }

  // No badge on the static placeholder: it's a fixed pre-drawn brand-mark
  // ASSET, not a QrCode this component composes a badge into — the same
  // gap Round-19's own header comment already documents (a placeholder
  // never encodes anything real, so there's no scan behavior for a play/
  // audio badge to be honest ABOUT). Practically dead code today per that
  // same comment (every current video/audio call site has a shareToken).
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
