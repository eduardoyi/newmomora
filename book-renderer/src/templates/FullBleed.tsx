import type { TemplateProps } from './types';
import { PageFrame } from './PageFrame';
import { assetUrl } from '../model/loader';
import type { PhotoSlotContent } from '../model/types';
import './FullBleed.css';

/**
 * Single photo, edge to edge — reserved for the 3-4 best photos in the
 * whole book (Momora Book Layout System 1b §3 "A sangre"). Never any text
 * over the image: the caption/credit is deferred to the next content
 * page's footer index (see fitter.ts `pendingCredit`). No folio either.
 */
export function FullBleed({ page, bookSlug, showGuides }: TemplateProps) {
  const photoSlot = page.slots.find((s): s is { id: string; kind: 'photo'; content: PhotoSlotContent } => s.kind === 'photo');
  if (!photoSlot) return <PageFrame isSpread={false} showGuides={showGuides} />;
  const content = photoSlot.content;

  return (
    <PageFrame isSpread={false} showGuides={showGuides} className="full-bleed-page">
      {/* Full-bleed always fills the page edge to edge — lavender
          letterboxing is a multi-photo-composition concept only; a
          full-bleed page has no lavender to fall back to, so it always
          crops (never contains), regardless of `looseFit`. */}
      <img src={assetUrl(bookSlug, content.assetFile)} alt="" className="full-bleed__img" style={{ objectFit: 'cover' }} />
    </PageFrame>
  );
}
