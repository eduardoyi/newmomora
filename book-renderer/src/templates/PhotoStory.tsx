import type { TemplateProps } from './types';
import { PageFrame } from './PageFrame';
import { SafeArea } from './common/SafeArea';
import { PhotoTile } from './common/PhotoTile';
import { Folio } from './common/Folio';
import { SectionHeader, type SectionHeaderParams } from './common/SectionHeader';
import { getLanguage } from './furniture';
import type { PhotoSlotContent } from '../model/types';
import './PhotoStory.css';

/**
 * "1 foto + pie corto" — RETIRED from the fitter's own scoring as of owner
 * review round 3 item 7 ("captions for photo/video memories ALWAYS in the
 * footer index — on-page captions retired; illustrated memories remain the
 * sole on-page-text exception"). `photo-story`'s whole reason for being a
 * distinct template from `anchor-media` was its on-page caption, so the
 * fitter no longer ever selects it (see fitter.ts — `scorePhotoStory` is
 * gone from `GRID_SCORERS`); every solo/paired photo memory routes through
 * `anchor-media` now, footer caption and all. This component is kept only
 * so a `photo-story`-tagged `BookPage` (e.g. from an older saved document)
 * still renders something reasonable — the photo, large, no on-page text.
 */
export function PhotoStory({ page, manifest, bookSlug, showGuides }: TemplateProps) {
  const photoSlot = page.slots.find((s): s is { id: string; kind: 'photo'; content: PhotoSlotContent } => s.kind === 'photo');
  const sectionHeader = (page.params.sectionHeader ?? null) as SectionHeaderParams | null;
  const pageNumber = page.pageNumbers?.[0];
  const isEvenPage = page.isEvenPage ?? true;
  const language = getLanguage(manifest);

  return (
    <PageFrame isSpread={false} showGuides={showGuides} className="photo-story-page">
      <SafeArea isSpread={false}>
        <div className="photo-story" data-testid="photo-story">
          {sectionHeader && <SectionHeader {...sectionHeader} isSpread={false} />}
          {photoSlot && (
            <div
              className="photo-story__photo"
              style={{ marginTop: sectionHeader ? '38%' : 0, aspectRatio: `${photoSlot.content.targetAspect}` }}
            >
              <PhotoTile content={photoSlot.content} bookSlug={bookSlug} isSpread={false} language={language} />
            </div>
          )}
        </div>
      </SafeArea>
      {pageNumber != null && <Folio pageNumber={pageNumber} isEvenPage={isEvenPage} isSpread={false} />}
    </PageFrame>
  );
}
