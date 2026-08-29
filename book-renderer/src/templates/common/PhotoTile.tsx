import type { PhotoSlotContent } from '../../model/types';
import { assetUrl } from '../../model/loader';
import { ptCqw } from '../mm';
import { colors } from '../../theme';
import { getFurniture, type Language } from '../furniture';
import { ScanMark } from './ScanMark';
import './PhotoTile.css';

/**
 * Renders one photo hole: image only, no caption (captions live in the
 * page's numbered footer index — see common/FooterIndex; owner review
 * round 3 item 7 retired the one on-page-caption exception photo-story used
 * to have). A small numeral (5.7pt, OUTSIDE the photo, below its bottom-left
 * corner) ties the tile back to its footer-index entry when `content.index`
 * is set. A video tile additionally gets its own scan-to-watch affordance
 * directly below the image, right-aligned (owner review round 3 item 8 —
 * moved off the shared footer strip). Crop conservatism: `looseFit` means
 * the asset's native aspect ratio missed every standard crop box by more
 * than +/-20%, so we contain it on pale lavender rather than force a crop —
 * a multi-photo-grid-only concept now (item 4); a solo/pair tile is always
 * sized to its own native aspect by the caller, so `looseFit` is false and
 * this path never triggers there.
 */
export function PhotoTile({
  content,
  bookSlug,
  isSpread,
  language,
  aspectRatio,
  metaPlacement = 'below',
}: {
  content: PhotoSlotContent;
  bookSlug: string;
  isSpread: boolean;
  language: Language;
  /**
   * Box aspect ratio to render at. Defaults to the fitter's own
   * `content.targetAspect` (kept in lockstep with `looseFit`) — only pass
   * this to deliberately override.
   */
  aspectRatio?: number;
  /**
   * Round-9 item 4: where the meta strip (numeral + scan-to-watch group)
   * renders relative to the image. Defaults to `'below'` (the ordinary
   * strip, unchanged for every pair/grid tile and every non-solo-video
   * page) — `'left'`/`'right'` are for a SOLO video page only, anchored
   * just outside the image's bottom corner instead
   * (`layoutSoloVideoAnchor` in anchorMediaLayout.ts decides which, and the
   * caller must pass the SAME value here it used to size the image, or the
   * two can drift).
   */
  metaPlacement?: 'left' | 'right' | 'below';
}) {
  const box = aspectRatio ?? content.targetAspect;
  const furniture = getFurniture(language);
  return (
    <figure className={`photo-tile${content.hero ? ' photo-tile--hero' : ''}`}>
      <div className="photo-tile__frame" style={{ aspectRatio: `${box}`, background: colors.surface2 }}>
        <img
          src={assetUrl(bookSlug, content.assetFile)}
          alt=""
          className="photo-tile__img"
          style={{ objectFit: content.looseFit ? 'contain' : 'cover' }}
        />
      </div>
      {(content.index != null || content.qr) && (
        <div className={`photo-tile__meta${metaPlacement !== 'below' ? ` photo-tile__meta--${metaPlacement}` : ''}`}>
          {content.index != null && (
            <figcaption className="photo-tile__numeral" style={{ fontSize: ptCqw(5.7, isSpread), color: colors.numeral }}>
              {content.index}
            </figcaption>
          )}
          {content.qr && (
            <div className="photo-tile__scan">
              <span className="photo-tile__scan-text" style={{ fontSize: ptCqw(6, isSpread), color: colors.ink3 }}>
                {furniture.scanToWatch}
              </span>
              <ScanMark size="inline" isSpread={isSpread} shareToken={content.shareToken} />
            </div>
          )}
        </div>
      )}
    </figure>
  );
}
