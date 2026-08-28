import type { TemplateProps } from './types';
import { PageFrame } from './PageFrame';
import { assetUrl } from '../model/loader';
import type { PhotoSlotContent } from '../model/types';
import './PanoramaSpread.css';

const CROP_BAND_POSITION: Record<NonNullable<PhotoSlotContent['cropBand']>, string> = {
  center: 'center',
};

/**
 * One wide image spanning both facing pages — the only composition allowed
 * to cross the spine (Momora Book Layout System 1b §3 "Panorama"). No
 * folio, no footer index, no antetítulo: its credit accumulates on the
 * NEXT content page's footer index instead (fitter.ts `pendingCredit`).
 *
 * Crop: a 2:1 window (the spread's own trim proportions are already close
 * to 2:1) anchored by `content.cropBand` — always `'center'` for now; a
 * real crop-position control is a V5 editor item (item 11, visual-review
 * batch), so the field exists without a UI yet.
 */
export function PanoramaSpread({ page, bookSlug, showGuides }: TemplateProps) {
  const photoSlot = page.slots.find((s): s is { id: string; kind: 'photo'; content: PhotoSlotContent } => s.kind === 'photo');
  if (!photoSlot) return <PageFrame isSpread showGuides={showGuides} />;
  const content = photoSlot.content;
  const verticalAnchor = content.cropBand ? CROP_BAND_POSITION[content.cropBand] : 'center';

  return (
    <PageFrame isSpread showGuides={showGuides} className="panorama-page">
      <img
        src={assetUrl(bookSlug, content.assetFile)}
        alt=""
        className="panorama__img"
        style={{ objectFit: 'cover', objectPosition: `center ${verticalAnchor}` }}
      />
    </PageFrame>
  );
}
