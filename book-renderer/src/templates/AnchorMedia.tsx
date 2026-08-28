import type { TemplateProps } from './types';
import { PageFrame } from './PageFrame';
import { SafeArea } from './common/SafeArea';
import { PhotoTile } from './common/PhotoTile';
import { FooterIndex, type FooterIndexEntry } from './common/FooterIndex';
import { SectionHeader, type SectionHeaderParams } from './common/SectionHeader';
import { Folio } from './common/Folio';
import { getLanguage } from './furniture';
import {
  tallSoloCanSitBesideHeader,
  layoutSoloAnchor,
  layoutAnchorPair,
  layoutTallSoloBesideHeader,
  layoutSoloVideoAnchor,
  classifyOrientation,
  type AnchorRect,
  type SoloVideoScanPlacement,
} from './layout/anchorMediaLayout';
import { SAFE_BOX_MM, SECTION_HEADER_RESERVE_MM, FOOTER_RESERVE_MM, footerReserveMm } from './mm';
import type { PhotoSlotContent } from '../model/types';
import './AnchorMedia.css';

/**
 * The book's workhorse (Momora Book Layout System 1b §3 "Ancla", revised by
 * owner review round 3 items 3/4/6, round 4 items 2/6): 1-2 photos at their
 * OWN native aspect — no forced crop box, no lavender containment (that's a
 * multi-photo-grid concept only now). A solo photo renders large by
 * default (~165mm on its long side) — or, on a month-opener (a section
 * header present), FILLS the header-reduced content box generously instead
 * of being boxed in at that standalone target (item 2). A pair's dominant
 * slot is decided by ASPECT (item 6): whichever photo is more elongated
 * (wide or tall) claims its own full axis; a caller hint only breaks a
 * near-tie between two similarly-shaped photos. Both cases are clamped to
 * the available content height so a tall/portrait video can never overflow
 * into the footer (item 14). Video credit lives with its own photo now
 * (see PhotoTile), not stacked in the shared footer index.
 */
export function AnchorMedia({ page, manifest, bookSlug, showGuides }: TemplateProps) {
  const photoSlots = page.slots.filter((s): s is { id: string; kind: 'photo'; content: PhotoSlotContent } => s.kind === 'photo');
  const sectionHeader = (page.params.sectionHeader ?? null) as SectionHeaderParams | null;
  const footerIndex = (page.params.footerIndex ?? []) as FooterIndexEntry[];
  const language = getLanguage(manifest);

  const headerReserve = sectionHeader ? SECTION_HEADER_RESERVE_MM : 0;
  // Owner round-10: a MULTI-photo page holding a video renders that video's
  // scan strip BELOW its tile, so the footer reserve must accommodate the
  // strip (`footerReserveMm`) — a solo video handles its own reserve inside
  // `layoutSoloVideoAnchor` (side placement needs none; the below fallback
  // subtracts the extra itself), so a solo page always uses the base value.
  const hasBelowScanVideo = photoSlots.length > 1 && photoSlots.some((s) => Boolean(s.content.qr));
  const footerReserve = footerIndex.length > 0 ? footerReserveMm(hasBelowScanVideo) : 0;
  const contentHeight = SAFE_BOX_MM - headerReserve - footerReserve;
  const pageNumber = page.pageNumbers?.[0];
  const isEvenPage = page.isEvenPage ?? true;
  // A month-opener's header has already eaten into the box — fill what's
  // left generously (item 2) rather than boxing the image in at the
  // standalone-page target size.
  const fill = Boolean(sectionHeader);

  // Round-8 item 2: a TALL solo (portrait photo/video still) on a header
  // page claims a right-hand column at nearly the FULL available height
  // instead of sitting boxed BELOW the header at the header-reduced
  // ~123mm — see `layoutTallSoloBesideHeader`'s own doc comment. Only the
  // FOOTER reserve caps it (unconditionally — same "a tile always needs
  // room for its own meta strip" rationale the pair path already applies —
  // see `anchorMediaLayout.ts`'s `layoutSideBySide` comment), never the
  // header reserve, since the header shares the row with it rather than
  // sitting above it.
  const isTallSoloBesideHeader =
    photoSlots.length === 1 &&
    Boolean(sectionHeader) &&
    classifyOrientation(photoSlots[0].content.assetAspectRatio) === 'tall' &&
    // Round-16 follow-up: a wrapping (e.g. 2-line special) title leaves no
    // clear column — the page uses the ordinary below-header layout instead.
    tallSoloCanSitBesideHeader(SAFE_BOX_MM, sectionHeader?.title ?? null, sectionHeader?.special ?? false);
  const canvasTopMm = isTallSoloBesideHeader ? 0 : headerReserve;
  const canvasHeightMm = isTallSoloBesideHeader ? SAFE_BOX_MM - FOOTER_RESERVE_MM : contentHeight;

  // Round-9 item 4: a SOLO video's scan-to-watch group anchors beside its
  // image (freeing the below-image meta reserve so the image itself can
  // grow slightly) instead of the ordinary below-image strip every
  // pair/grid tile still uses — see `layoutSoloVideoAnchor`'s own doc
  // comment. `metaPlacements[slot.id]` (only ever set for THIS one slot)
  // is threaded straight into PhotoTile so the template and this layout
  // call can never disagree about which side, if any, is in play.
  const metaPlacements: Record<string, SoloVideoScanPlacement> = {};

  let rects: AnchorRect[];
  if (photoSlots.length === 1) {
    const isSoloVideo = Boolean(photoSlots[0].content.qr);
    if (isSoloVideo) {
      const { rect, placement } = layoutSoloVideoAnchor(
        photoSlots[0].content.assetAspectRatio,
        SAFE_BOX_MM,
        canvasHeightMm,
        isTallSoloBesideHeader,
        sectionHeader?.title ?? null,
        sectionHeader?.special ?? false,
      );
      metaPlacements[photoSlots[0].id] = placement;
      rects = [rect];
    } else {
      rects = isTallSoloBesideHeader
        ? [
            layoutTallSoloBesideHeader(
              photoSlots[0].content.assetAspectRatio,
              SAFE_BOX_MM,
              canvasHeightMm,
              sectionHeader?.title ?? null,
              sectionHeader?.special ?? false,
            ),
          ]
        : [layoutSoloAnchor(photoSlots[0].content.assetAspectRatio, SAFE_BOX_MM, contentHeight, fill)];
    }
  } else if (photoSlots.length === 2) {
    // The pairing/highlight pass already decided which slot is dominant
    // (see fitter.ts's `hero` flag) — the layout only needs to know WHICH
    // one, not re-derive it.
    const dominantIsFirst = photoSlots[0].content.hero || !photoSlots[1].content.hero;
    rects = layoutAnchorPair(
      photoSlots[0].content.assetAspectRatio,
      photoSlots[1].content.assetAspectRatio,
      dominantIsFirst,
      SAFE_BOX_MM,
      contentHeight,
      fill,
    );
  } else {
    rects = [];
  }

  return (
    <PageFrame isSpread={false} showGuides={showGuides} className="anchor-media-page">
      <SafeArea isSpread={false}>
        <div className="anchor-media" data-testid="anchor-media">
          {sectionHeader && <SectionHeader {...sectionHeader} isSpread={false} />}
          <div
            className="anchor-media__canvas"
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: `${(canvasTopMm / SAFE_BOX_MM) * 100}%`,
              height: `${(canvasHeightMm / SAFE_BOX_MM) * 100}%`,
            }}
          >
            {photoSlots.map((slot, i) => {
              const r = rects[i];
              if (!r) return null;
              return (
                <div
                  key={slot.id}
                  className="anchor-media__cell"
                  style={{
                    position: 'absolute',
                    left: `${(r.xMm / SAFE_BOX_MM) * 100}%`,
                    top: `${(r.yMm / canvasHeightMm) * 100}%`,
                    width: `${(r.wMm / SAFE_BOX_MM) * 100}%`,
                    height: `${(r.hMm / canvasHeightMm) * 100}%`,
                  }}
                >
                  <PhotoTile
                    content={slot.content}
                    bookSlug={bookSlug}
                    isSpread={false}
                    language={language}
                    aspectRatio={slot.content.assetAspectRatio}
                    metaPlacement={metaPlacements[slot.id] ?? 'below'}
                  />
                </div>
              );
            })}
          </div>
          <FooterIndex entries={footerIndex} isSpread={false} language={language} isEvenPage={isEvenPage} />
        </div>
      </SafeArea>
      {pageNumber != null && <Folio pageNumber={pageNumber} isEvenPage={isEvenPage} isSpread={false} />}
    </PageFrame>
  );
}
