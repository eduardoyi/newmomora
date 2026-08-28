import type { TemplateProps } from './types';
import { PageFrame } from './PageFrame';
import { SafeArea } from './common/SafeArea';
import { PhotoTile } from './common/PhotoTile';
import { FooterIndex, type FooterIndexEntry } from './common/FooterIndex';
import { SectionHeader, type SectionHeaderParams } from './common/SectionHeader';
import { Folio } from './common/Folio';
import { getLanguage } from './furniture';
import { layoutFlexGrid } from './layout/flexGridLayout';
import { SAFE_BOX_MM, SECTION_HEADER_RESERVE_MM, footerReserveMm } from './mm';
import type { PhotoSlotContent, TextSlotContent } from '../model/types';
import './FlexGrid.css';

/**
 * The workhorse template (Momora Book Layout System 1b §3 "Retícula
 * flexible"): 2-6 photos, asymmetric column/baseline-snapped placement,
 * impossible-aspect photos contained on pale lavender instead of cropped,
 * a numbered footer index at the foot of the page. Doubles as the
 * "month-opener" composition when `params.sectionHeader` is set — the
 * segment title occupies the top of the safe box and the grid packs into
 * the remaining space below it (this is the fix for section titles being
 * silently dropped).
 */
export function FlexGrid({ page, manifest, bookSlug, showGuides }: TemplateProps) {
  const photoSlots = page.slots.filter((s): s is { id: string; kind: 'photo'; content: PhotoSlotContent } => s.kind === 'photo');
  const textSlots = page.slots.filter((s): s is { id: string; kind: 'text'; content: TextSlotContent } => s.kind === 'text');
  const sectionHeader = (page.params.sectionHeader ?? null) as SectionHeaderParams | null;
  const footerIndex = (page.params.footerIndex ?? []) as FooterIndexEntry[];
  const language = getLanguage(manifest);

  const headerReserve = sectionHeader ? SECTION_HEADER_RESERVE_MM : 0;
  const footerReserve = footerIndex.length > 0 || textSlots.length > 0 ? footerReserveMm(photoSlots.some((s) => Boolean(s.content.qr))) : 0;
  const contentHeight = SAFE_BOX_MM - headerReserve - footerReserve;
  const pageNumber = page.pageNumbers?.[0];
  const isEvenPage = page.isEvenPage ?? true;

  const rects = layoutFlexGrid(
    photoSlots.map((s) => ({ aspect: s.content.targetAspect, hero: s.content.hero })),
    SAFE_BOX_MM,
    contentHeight,
  );

  return (
    <PageFrame isSpread={false} showGuides={showGuides} className="flex-grid-page">
      <SafeArea isSpread={false}>
        <div className="flex-grid" data-testid="flex-grid">
          {sectionHeader && <SectionHeader {...sectionHeader} isSpread={false} />}
          <div
            className="flex-grid__canvas"
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: `${(headerReserve / SAFE_BOX_MM) * 100}%`,
              height: `${(contentHeight / SAFE_BOX_MM) * 100}%`,
            }}
          >
            {photoSlots.map((slot, i) => {
              const r = rects[i];
              if (!r) return null;
              return (
                <div
                  key={slot.id}
                  className="flex-grid__cell"
                  style={{
                    position: 'absolute',
                    left: `${(r.xMm / SAFE_BOX_MM) * 100}%`,
                    top: `${(r.yMm / contentHeight) * 100}%`,
                    width: `${(r.wMm / SAFE_BOX_MM) * 100}%`,
                    height: `${(r.hMm / contentHeight) * 100}%`,
                  }}
                >
                  <PhotoTile content={slot.content} bookSlug={bookSlug} isSpread={false} language={language} />
                </div>
              );
            })}
          </div>
          {textSlots.length > 0 && (
            <div className="flex-grid__notes" style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
              {textSlots.map((slot) => (
                <p key={slot.id} className="flex-grid__note">
                  {slot.content.text}
                </p>
              ))}
            </div>
          )}
          <FooterIndex entries={footerIndex} isSpread={false} language={language} isEvenPage={isEvenPage} />
        </div>
      </SafeArea>
      {pageNumber != null && <Folio pageNumber={pageNumber} isEvenPage={isEvenPage} isSpread={false} />}
    </PageFrame>
  );
}
