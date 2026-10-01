import type {
  BookDocument,
  BookManifest,
  BookOutline,
  BookPage,
  PhotoSlotContent,
  IllustrationSlotContent,
  TextSlotContent,
  DigestEntryContent,
  PortraitStripContent,
} from './types';
// Round-13: pure-TS `.types.ts` companions, not the `.tsx` files — see the
// same note in `fitter.ts`. `audit.ts` has no React/DOM dependency either.
import type { FooterIndexEntry } from '../templates/common/FooterIndex.types';
import type { SectionHeaderParams } from '../templates/common/SectionHeader.types';
import { tallSoloCanSitBesideHeader,
  layoutAnchorPair,
  layoutTallSoloBesideHeader,
  layoutSoloVideoAnchor,
  classifyOrientation,
  PHOTO_META_RESERVE_MM,
  type AnchorRect,
} from '../templates/layout/anchorMediaLayout';
import { layoutFlexGrid } from '../templates/layout/flexGridLayout';
import { digestColumnsForPage, layoutDigestColumn } from '../templates/layout/illustratedDigestLayout';
import {
  layoutTtyItem,
  ttyOuterLayoutFor,
  ttyItemAbsoluteRect,
  ttyChildAbsoluteRect,
} from '../templates/layout/throughTheYearsLayout';
import {
  SAFE_BOX_MM,
  SAFE_INSET_MM,
  SPREAD_WIDTH_MM,
  SPREAD_HEIGHT_MM,
  SECTION_HEADER_RESERVE_MM,
  FOOTER_RESERVE_MM,
  footerReserveMm,
  MIN_PAIR_FILL_RATIO,
  illustratedStackTopMm,
  illustratedCaptionHeightEstimateMm,
  illustratedIlloFitHeightMm,
  ILLUSTRATED_STACK_GAP_MM,
  ILLUSTRATED_FOLIO_CLEARANCE_MM,
  modelSectionHeaderTitle,
  DIGEST_ILLO_WIDTH_MM,
  DIGEST_FOLIO_CLEARANCE_MM,
  canvasPxToTrimMm,
} from '../templates/mm';
import {
  BLANK_REASONS,
  PRODIGI_MIN_PAGES,
  fullBleedCropLoss,
  FULL_BLEED_HERO_MAX_CROP_LOSS,
  isChapterMode,
  shownAssetsOf,
} from './fitter';

/**
 * Automated content-integrity audit (owner review round 5, item 1) — run
 * AFTER every fit, on the finished `BookDocument`. Two real failures shipped
 * past every existing check before this existed (Enzo's Oct/Nov/Dec 2024
 * silently erased by the page-cap squeeze; Mara's "Retratos con Mirian"
 * spread-title rendering with zero member pages behind it) — this is the
 * safety net that catches that CLASS of bug going forward, not just those
 * two instances (both of which are also fixed at the root; see fitter.ts).
 *
 * Pure function, no DOM: recomputes real geometry using the SAME pure
 * layout functions the templates themselves render with
 * (`layoutAnchorPair`, `layoutFlexGrid`) rather than approximating it, so
 * the audit can never drift from what the book actually looks like.
 */

export type IntegrityCheck =
  | 'month-continuity'
  | 'section-title-orphan'
  | 'geometric-overlap'
  | 'blank-accounting'
  | 'even-page-count'
  | 'fill-ratio'
  | 'crop-loss'
  | 'photo-count'
  | 'illustrated-stack-overflow'
  | 'illustrated-digest'
  | 'through-the-years'
  | 'media-memory-without-media'
  | 'unrenderable-slots'
  | 'title-then-empty';

export interface IntegrityViolation {
  check: IntegrityCheck;
  message: string;
  elementId?: string;
  pageId?: string;
}

export interface AuditOptions {
  /**
   * Memory ids the fitter deliberately omitted (`FitResult.capacity.omittedMemoryIds`).
   * Lets `media-memory-without-media` also catch a kept memory that vanished
   * entirely; without it only a memory that prints SOMETHING (caption,
   * illustration) yet none of its media can be recognised.
   */
  omittedMemoryIds?: Iterable<string>;
}

export function auditBookDocument(
  document: BookDocument,
  outline: BookOutline,
  manifest: BookManifest,
  options: AuditOptions = {},
): IntegrityViolation[] {
  return [
    ...auditMonthContinuity(document, outline, manifest),
    ...auditSectionTitleOrphans(document, outline),
    ...auditGeometricOverlap(document),
    ...auditBlankAccounting(document),
    ...auditEvenPageCount(document),
    ...auditFillRatio(document),
    ...auditFullBleedCropLoss(document),
    ...auditPhotoCount(document),
    ...auditIllustratedStackOverflow(document),
    ...auditIllustratedDigest(document),
    ...auditThroughTheYears(document),
    ...auditMediaMemoryWithoutMedia(document, outline, manifest, options.omittedMemoryIds),
    ...auditUnrenderableSlots(document),
    ...auditTitleThenEmpty(document),
  ];
}

function groupPagesBySource(document: BookDocument): Map<string, BookPage[]> {
  const map = new Map<string, BookPage[]>();
  for (const page of document.pages) {
    if (!map.has(page.sourceElementId)) map.set(page.sourceElementId, []);
    map.get(page.sourceElementId)!.push(page);
  }
  return map;
}

// ---------------------------------------------------------------------------
// (a) Month continuity — every calendar-month backbone section that had
// memories in the outline must still appear (chronologically, in the
// outline's own element order) with at least one real page behind it.
// ---------------------------------------------------------------------------

function auditMonthContinuity(document: BookDocument, outline: BookOutline, manifest: BookManifest): IntegrityViolation[] {
  const violations: IntegrityViolation[] = [];
  const pagesByElement = groupPagesBySource(document);
  const backboneElements = outline.elements.filter((e) => e.kind === 'backbone');
  const pooledMemoryIds = new Set<string>();
  for (const page of document.pages) {
    if (page.templateId !== 'quote-collection') continue;
    for (const id of slotMemoryIds(page)) pooledMemoryIds.add(id);
  }

  // Erasure check (the diagnosed Enzo bug): a backbone element is a
  // calendar month by construction — if the outline gave it memories at
  // all, the printed book must show SOMETHING for it, however thin.
  for (const element of backboneElements) {
    if (element.memoryIds.length === 0) continue;
    const pages = pagesByElement.get(element.id) ?? [];
    // Chapter-mode quote pooling (Phase 2b fix 4): a section whose memories
    // were all pooled into the chapter's quote collection has no pages of its
    // own, but its memories ARE printed — not an erasure.
    if (pages.length === 0 && element.memoryIds.some((id) => pooledMemoryIds.has(id))) continue;
    if (pages.length === 0) {
      violations.push({
        check: 'month-continuity',
        elementId: element.id,
        message: `Month "${element.title}" (${element.id}) had ${element.memoryIds.length} memor${
          element.memoryIds.length === 1 ? 'y' : 'ies'
        } in the outline but produced zero pages in the printed book.`,
      });
    }
  }

  // Chronological-order check: each surviving backbone section's earliest
  // memory date (a robust, language/format-independent proxy — never
  // parses the outline's own English-formatted title/subtitle strings)
  // must be non-decreasing across the outline's own element order.
  let lastDate: Date | null = null;
  let lastLabel: string | null = null;
  for (const element of backboneElements) {
    const dates = element.memoryIds
      .map((id) => manifest.memories[id]?.date)
      .filter((d): d is string => Boolean(d))
      .map((d) => new Date(d))
      .filter((d) => !Number.isNaN(d.getTime()));
    if (dates.length === 0) continue;
    const earliest = dates.reduce((a, b) => (a < b ? a : b));
    if (lastDate && earliest.getTime() < lastDate.getTime()) {
      violations.push({
        check: 'month-continuity',
        elementId: element.id,
        message: `Section "${element.title}" (${element.id}) is out of chronological order — it starts before the preceding section "${lastLabel}".`,
      });
    }
    lastDate = earliest;
    lastLabel = element.title;
  }

  return violations;
}

// ---------------------------------------------------------------------------
// (b) No titled section (spread-title, via themed/firsts/birthday) with zero content
// pages behind it before the next section (the diagnosed Mara "Retratos con
// Mirian" bug — fixed at the root in fitter.ts's dissolve-when-empty guard;
// this is the permanent regression backstop).
// ---------------------------------------------------------------------------

function auditSectionTitleOrphans(document: BookDocument, outline: BookOutline): IntegrityViolation[] {
  const violations: IntegrityViolation[] = [];
  const pagesByElement = groupPagesBySource(document);
  for (const element of outline.elements) {
    if (element.kind !== 'themed' && element.kind !== 'firsts' && element.kind !== 'birthday') continue;
    const pages = pagesByElement.get(element.id) ?? [];
    const hasTitle = pages.some((p) => p.templateId === 'spread-title');
    const hasContent = pages.some((p) => p.templateId !== 'spread-title');
    if (hasTitle && !hasContent) {
      violations.push({
        check: 'section-title-orphan',
        elementId: element.id,
        message: `Section "${element.title}" (${element.id}) has a title page but zero content pages behind it.`,
      });
    }
  }
  violations.push(...auditChapterTitleOrphans(document, outline));
  return violations;
}

/**
 * Multi-year chapter openers: a chapter's `spread-title` page must be
 * followed by at least one real content page before the next chapter's title
 * (or the closing / end of the book). Only iterates chapter elements, so
 * books without them (year, calendar-year, legacy `custom`) are unaffected.
 */
function auditChapterTitleOrphans(document: BookDocument, outline: BookOutline): IntegrityViolation[] {
  const chapterElements = new Map(outline.elements.filter((e) => e.kind === 'chapter').map((e) => [e.id, e]));
  if (chapterElements.size === 0) return [];
  const violations: IntegrityViolation[] = [];
  const pages = document.pages;
  const isChapterTitle = (page: BookPage) => page.templateId === 'spread-title' && chapterElements.has(page.sourceElementId);
  for (let i = 0; i < pages.length; i++) {
    if (!isChapterTitle(pages[i])) continue;
    let hasContent = false;
    for (let j = i + 1; j < pages.length; j++) {
      const next = pages[j];
      if (isChapterTitle(next) || next.templateId === 'closing') break;
      if (next.templateId !== 'blank') {
        hasContent = true;
        break;
      }
    }
    if (!hasContent) {
      const element = chapterElements.get(pages[i].sourceElementId)!;
      violations.push({
        check: 'section-title-orphan',
        elementId: element.id,
        pageId: pages[i].id,
        message: `Chapter "${element.title}" (${element.id}) has a title page but zero content pages behind it before the next chapter or the closing.`,
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// (c) Geometric overlap — no two photo slots on a page intersect, and
// nothing overlaps a scan block's reserved box. Recomputes real rects via
// the same pure layout functions AnchorMedia.tsx / FlexGrid.tsx render
// with, from the page's own params/slots — never a DOM measurement.
// ---------------------------------------------------------------------------

interface Rect {
  xMm: number;
  yMm: number;
  wMm: number;
  hMm: number;
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.xMm < b.xMm + b.wMm && a.xMm + a.wMm > b.xMm && a.yMm < b.yMm + b.hMm && a.yMm + a.hMm > b.yMm;
}

/** The box a photo's own numeral/scan-mark strip occupies just past its bottom edge (PhotoTile.css `top:100%`) — padded onto its rect for the "nothing overlaps a scan block" half of check (c). */
function withMetaReserve(r: AnchorRect): Rect {
  return { xMm: r.xMm, yMm: r.yMm, wMm: r.wMm, hMm: r.hMm + PHOTO_META_RESERVE_MM };
}

function auditGeometricOverlap(document: BookDocument): IntegrityViolation[] {
  const violations: IntegrityViolation[] = [];

  for (const page of document.pages) {
    if (page.templateId === 'anchor-media') {
      const photoSlots = page.slots.filter((s): s is typeof s & { content: PhotoSlotContent } => s.kind === 'photo');
      if (photoSlots.length === 1) {
        // Round-8 item 2: a TALL solo beside a header claims a right-hand
        // column via a DIFFERENT pure function than the ordinary below-
        // header solo — recompute it the same way `AnchorMedia.tsx` does so
        // this backstop can never drift, and confirm it (plus its own meta
        // strip) never overflows the safe box or the header-to-footer band
        // it was sized against (a solo otherwise has nothing else to
        // overlap — there's only ever one photo slot on this page).
        const sectionHeader = (page.params.sectionHeader ?? null) as SectionHeaderParams | null;
        const isSoloVideo = Boolean(photoSlots[0].content.qr);
        const isTall =
          sectionHeader &&
          classifyOrientation(photoSlots[0].content.assetAspectRatio) === 'tall' &&
          // Round-16 follow-up: mirrors AnchorMedia.tsx exactly — a wrapping
          // title forces the below-header composition, so the beside-header
          // geometry (and its overlap checks) must not be recomputed here.
          // Phase 2d: the same predicate also refuses a column that would
          // intersect a non-wrapping-but-wide title (same args as the template).
          tallSoloCanSitBesideHeader(
            SAFE_BOX_MM,
            sectionHeader.title,
            sectionHeader.special,
            photoSlots[0].content.assetAspectRatio,
            isSoloVideo,
          );
        if (isTall) {
          const availableHeightMm = SAFE_BOX_MM - FOOTER_RESERVE_MM;
          // Round-9 item 4: a solo VIDEO recomputes via the SAME shared
          // function `AnchorMedia.tsx` calls (`layoutSoloVideoAnchor`) —
          // its rect already reflects whichever meta-reserve decision it
          // made (side placement frees it; the 'below' fallback re-applies
          // it), so this backstop can never drift from either.
          const rect = isSoloVideo
            ? layoutSoloVideoAnchor(
                photoSlots[0].content.assetAspectRatio,
                SAFE_BOX_MM,
                availableHeightMm,
                true,
                sectionHeader!.title,
                sectionHeader!.special,
              ).rect
            : layoutTallSoloBesideHeader(
                photoSlots[0].content.assetAspectRatio,
                SAFE_BOX_MM,
                availableHeightMm,
                sectionHeader!.title,
                sectionHeader!.special,
              );
          // A non-video tall solo's own meta strip always renders below it
          // (never a side placement — that's video-only), so the overflow
          // check still pads for it unconditionally there; a solo video's
          // rect already has whichever reserve it needed baked in (see
          // above), so no extra padding is added for it here.
          const metaPad = isSoloVideo ? 0 : PHOTO_META_RESERVE_MM;
          const overflowsX = rect.xMm < -1e-6 || rect.xMm + rect.wMm > SAFE_BOX_MM + 1e-6;
          const overflowsY = rect.yMm < -1e-6 || rect.yMm + rect.hMm + metaPad > availableHeightMm + FOOTER_RESERVE_MM + 1e-6;
          if (overflowsX || overflowsY) {
            violations.push({
              check: 'geometric-overlap',
              pageId: page.id,
              message: `Page ${page.id}: the tall-solo-beside-header image (or its meta strip) overflows the safe area.`,
            });
          }
          // Round-9 item 3: the image column's own title-aware width cap
          // (`tallSoloHeaderWidthCapMm`) is DERIVED from the modeled title
          // box, so this should never trip by construction for a
          // single-line title — this is the permanent regression backstop,
          // recomputing the SAME title model the layout function used.
          const titleModel = modelSectionHeaderTitle(SAFE_BOX_MM, sectionHeader!.title, sectionHeader!.special);
          const titleRect: Rect = { xMm: 0, yMm: 0, wMm: titleModel.widthMm, hMm: SECTION_HEADER_RESERVE_MM };
          if (titleModel.widthMm > 0 && rectsIntersect(rect, titleRect)) {
            violations.push({
              check: 'geometric-overlap',
              pageId: page.id,
              message: `Page ${page.id}: the tall-solo-beside-header image overlaps the section header's own modeled title box.`,
            });
          }
        } else if (isSoloVideo) {
          // Round-9 item 4: a CENTERED solo video (no header, or a header
          // present but the image isn't tall enough for the beside-header
          // arrangement) also recomputes via `layoutSoloVideoAnchor` — the
          // permanent regression backstop for its own meta-reserve
          // decision. An ordinary (non-video) centered solo has no
          // dedicated geometric check here (unchanged, out of round-9's
          // scope) — only a solo VIDEO's placement decision is new.
          const headerReserve = sectionHeader ? SECTION_HEADER_RESERVE_MM : 0;
          const availableHeightMm = SAFE_BOX_MM - headerReserve - FOOTER_RESERVE_MM;
          const { rect } = layoutSoloVideoAnchor(photoSlots[0].content.assetAspectRatio, SAFE_BOX_MM, availableHeightMm, false);
          const overflowsX = rect.xMm < -1e-6 || rect.xMm + rect.wMm > SAFE_BOX_MM + 1e-6;
          const overflowsY = rect.yMm < -1e-6 || rect.yMm + rect.hMm > availableHeightMm + 1e-6;
          if (overflowsX || overflowsY) {
            violations.push({
              check: 'geometric-overlap',
              pageId: page.id,
              message: `Page ${page.id}: the centered solo-video image (or its meta strip) overflows the safe area.`,
            });
          }
        }
        continue;
      }
      if (photoSlots.length !== 2) continue; // more than 2 never reaches anchor-media
      const sectionHeader = page.params.sectionHeader ?? null;
      const footerIndex = (page.params.footerIndex as FooterIndexEntry[] | undefined) ?? [];
      const headerReserve = sectionHeader ? SECTION_HEADER_RESERVE_MM : 0;
      const footerReserve = footerIndex.length > 0 ? footerReserveMm(photoSlots.some((s) => Boolean((s.content as PhotoSlotContent).qr))) : 0;
      const contentHeight = SAFE_BOX_MM - headerReserve - footerReserve;
      const fill = Boolean(sectionHeader);
      const dominantIsFirst = photoSlots[0].content.hero || !photoSlots[1].content.hero;
      const [rectA, rectB] = layoutAnchorPair(
        photoSlots[0].content.assetAspectRatio,
        photoSlots[1].content.assetAspectRatio,
        dominantIsFirst,
        SAFE_BOX_MM,
        contentHeight,
        fill,
      );
      if (rectsIntersect(rectA, rectB)) {
        violations.push({ check: 'geometric-overlap', pageId: page.id, message: `Page ${page.id}: the two photo slots' boxes intersect.` });
      }
      if (rectsIntersect(withMetaReserve(rectA), rectB) || rectsIntersect(withMetaReserve(rectB), rectA)) {
        violations.push({
          check: 'geometric-overlap',
          pageId: page.id,
          message: `Page ${page.id}: a photo's scan-mark/numeral strip overlaps the other photo's box.`,
        });
      }
    } else if (page.templateId === 'flex-grid') {
      const photoSlots = page.slots.filter((s): s is typeof s & { content: PhotoSlotContent } => s.kind === 'photo');
      const textSlots = page.slots.filter((s) => s.kind === 'text');
      if (photoSlots.length < 2) continue;
      const sectionHeader = page.params.sectionHeader ?? null;
      const footerIndex = (page.params.footerIndex as FooterIndexEntry[] | undefined) ?? [];
      const headerReserve = sectionHeader ? SECTION_HEADER_RESERVE_MM : 0;
      const footerReserve = footerIndex.length > 0 || textSlots.length > 0 ? footerReserveMm(photoSlots.some((s) => Boolean((s.content as PhotoSlotContent).qr))) : 0;
      const contentHeight = SAFE_BOX_MM - headerReserve - footerReserve;
      const rects = layoutFlexGrid(
        photoSlots.map((s) => ({ aspect: s.content.targetAspect, hero: s.content.hero })),
        SAFE_BOX_MM,
        contentHeight,
      );
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          if (rectsIntersect(rects[i], rects[j])) {
            violations.push({
              check: 'geometric-overlap',
              pageId: page.id,
              message: `Page ${page.id}: flex-grid cells ${i + 1} and ${j + 1} intersect.`,
            });
          }
        }
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// (d) Blank-page accounting — every blank must carry a recognized
// structural reason (see `BLANK_REASONS` in fitter.ts).
// ---------------------------------------------------------------------------

const RECOGNIZED_BLANK_REASONS: ReadonlySet<string> = new Set(BLANK_REASONS);

function auditBlankAccounting(document: BookDocument): IntegrityViolation[] {
  const violations: IntegrityViolation[] = [];
  for (const page of document.pages) {
    if (page.templateId !== 'blank') continue;
    const reason = page.blankReason;
    if (!reason || !RECOGNIZED_BLANK_REASONS.has(reason)) {
      violations.push({
        check: 'blank-accounting',
        pageId: page.id,
        message: `Blank page ${page.id} has no recognized structural reason (blankReason: ${reason ?? 'none'}).`,
      });
    }
  }
  // Round-9 item 2c (extended Task 1, round-17, for panorama): a
  // `parity:full-bleed` or `parity:panorama-spread` blank is NEVER
  // acceptable anywhere now, section boundary or not — the fitter's
  // demotion fallback (`processGroup` for full-bleed; the panorama unit
  // handler in `buildContentPages`, mirroring it, for panorama) exists
  // precisely so either one's parity need can ALWAYS be resolved without a
  // blank (the reorder pass routes around it, a local swap absorbs it, or,
  // as the true last resort, the page demotes to an ordinary anchor-media
  // solo instead). Unlike the other parity reasons below, these two get NO
  // boundary exemption — a full-bleed or panorama-spread's facing
  // treatment is optional beauty, a blank page is a defect, and demotion
  // means there is never a structural reason left to accept the trade.
  const UNCONDITIONAL_PARITY_BLANK_REASONS: ReadonlySet<string> = new Set(['parity:full-bleed', 'parity:panorama-spread']);
  for (const page of document.pages) {
    if (page.templateId === 'blank' && page.blankReason && UNCONDITIONAL_PARITY_BLANK_REASONS.has(page.blankReason)) {
      const kind = page.blankReason === 'parity:full-bleed' ? 'Full-bleed' : 'Panorama-spread';
      violations.push({
        check: 'blank-accounting',
        pageId: page.id,
        message: `${kind} parity blank ${page.id} should never occur — the fitter's demotion fallback should have rendered this page as anchor-media instead of paying a blank.`,
      });
    }
  }
  // Owner round-7: a parity blank sandwiched between two CONTENT pages of
  // the same section is by definition avoidable — the reorder pass
  // (reorderUnitsForParity + group splitting) exists precisely to solve it
  // by local reordering or by splitting a multi-photo page. Structural
  // blanks (front matter, closing-total) carry non-parity reasons and are
  // exempt; a parity blank at a section boundary (neighbors from different
  // elements) is tolerated as the genuine last resort — EXCEPT
  // `parity:full-bleed`/`parity:panorama-spread`, checked unconditionally above instead.
  for (let i = 1; i < document.pages.length - 1; i++) {
    const page = document.pages[i];
    if (page.templateId !== 'blank' || !page.blankReason?.startsWith('parity:')) continue;
    if (page.blankReason === 'parity:closing-total') continue;
    if (page.blankReason && UNCONDITIONAL_PARITY_BLANK_REASONS.has(page.blankReason)) continue; // handled unconditionally above
    const prev = document.pages[i - 1];
    const next = document.pages[i + 1];
    const isContent = (p: typeof page) => p.templateId !== 'blank';
    if (
      isContent(prev) &&
      isContent(next) &&
      prev.sourceElementId === page.sourceElementId &&
      next.sourceElementId === page.sourceElementId
    ) {
      violations.push({
        check: 'blank-accounting',
        pageId: page.id,
        message: `Avoidable parity blank ${page.id} (${page.blankReason}) sits between two content pages of the same section — the reorder/split pass should have absorbed it.`,
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// (e) Even total page count — Prodigi's layflat binding requirement.
// ---------------------------------------------------------------------------

function auditEvenPageCount(document: BookDocument): IntegrityViolation[] {
  // Only within Prodigi's own printable range — see `PRODIGI_MIN_PAGES`'s
  // doc comment in fitter.ts (the fitter itself only enforces evenness
  // there too, so this stays consistent with what it can actually fix).
  if (document.totalPages < PRODIGI_MIN_PAGES) return [];
  if (document.totalPages % 2 !== 0) {
    return [
      {
        check: 'even-page-count',
        message: `Total interior page count (${document.totalPages}) is odd — Prodigi's layflat binding requires an even count.`,
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// (f) Fill ratio (owner review round 7, item 3a) — a 2-photo anchor-media
// PAIR whose combined photo area covers less than this fraction of its own
// AVAILABLE content box reads as "small images floating in white", the
// exact complaint round-7 items 1a-1c fix at the root. Measured against the
// content box (net of header/footer reserve), not the full undiminished
// safe area — a header page is held to the same fraction of what's
// actually left for it, not penalized for space the header legitimately
// needs (the header itself isn't wasted white space). Scoped to pairs
// only — a SOLO photo is already sized to the maximum its own aspect and
// the available box allow (item 1a: no fraction cap, no crop), so a low
// fill ratio there is an intrinsic property of a narrow-aspect source
// image, not a layout defect there's a better alternative for.
// Recomputes the SAME geometry the template renders (never a DOM
// measurement) — a permanent regression backstop for
// `anchorPairMeetsMinSize`'s own fill-ratio gate.
// ---------------------------------------------------------------------------

function auditFillRatio(document: BookDocument): IntegrityViolation[] {
  const violations: IntegrityViolation[] = [];

  for (const page of document.pages) {
    if (page.templateId !== 'anchor-media') continue;
    const photoSlots = page.slots.filter((s): s is typeof s & { content: PhotoSlotContent } => s.kind === 'photo');
    if (photoSlots.length !== 2) continue;

    const sectionHeader = page.params.sectionHeader ?? null;
    const footerIndex = (page.params.footerIndex as FooterIndexEntry[] | undefined) ?? [];
    const headerReserve = sectionHeader ? SECTION_HEADER_RESERVE_MM : 0;
    const footerReserve = footerIndex.length > 0 ? footerReserveMm(photoSlots.some((s) => Boolean((s.content as PhotoSlotContent).qr))) : 0;
    const contentHeight = SAFE_BOX_MM - headerReserve - footerReserve;
    const fill = Boolean(sectionHeader);

    const dominantIsFirst = photoSlots[0].content.hero || !photoSlots[1].content.hero;
    const rects: AnchorRect[] = layoutAnchorPair(
      photoSlots[0].content.assetAspectRatio,
      photoSlots[1].content.assetAspectRatio,
      dominantIsFirst,
      SAFE_BOX_MM,
      contentHeight,
      fill,
    );

    const photoArea = rects.reduce((sum, r) => sum + r.wMm * r.hMm, 0);
    // Round-11: full undiminished safe box, matching anchorPairMeetsMinSize's
    // corrected basis — how much of the PHYSICAL page the photos cover is
    // what the eye judges, header pages included.
    const ratio = photoArea / (SAFE_BOX_MM * SAFE_BOX_MM);
    if (ratio < MIN_PAIR_FILL_RATIO) {
      violations.push({
        check: 'fill-ratio',
        pageId: page.id,
        message: `Page ${page.id}: photo area covers only ${(ratio * 100).toFixed(1)}% of the safe area — below the ${(
          MIN_PAIR_FILL_RATIO * 100
        ).toFixed(0)}% floor (MIN_PAIR_FILL_RATIO).`,
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// (g) Crop loss (owner review round 7, item 3b) — any rendered full-bleed
// page whose source aspect implies more crop than even a HERO is allowed
// (the loosest of the two round-7 item 2a bars) is a violation — catching
// a scoring-gate regression regardless of whether it came from the hero or
// non-hero full-bleed path.
// ---------------------------------------------------------------------------

function auditFullBleedCropLoss(document: BookDocument): IntegrityViolation[] {
  const violations: IntegrityViolation[] = [];
  for (const page of document.pages) {
    if (page.templateId !== 'full-bleed') continue;
    const photoSlot = page.slots.find((s): s is typeof s & { content: PhotoSlotContent } => s.kind === 'photo');
    if (!photoSlot) continue;
    // Mirrors the fitter's gate: a USER-CHOSEN (swapped-in) photo is exempt from crop-loss
    // policing (`scoreFullBleed`'s `cropGateWaived`, owner decision 2026-09-09) — a parent who
    // picked it can judge the square crop. `editedFromFile` is set only on a substituted asset.
    if (photoSlot.content.editedFromFile) continue;
    const cropLoss = fullBleedCropLoss(photoSlot.content.assetAspectRatio);
    if (cropLoss > FULL_BLEED_HERO_MAX_CROP_LOSS) {
      violations.push({
        check: 'crop-loss',
        pageId: page.id,
        message: `Page ${page.id}: full-bleed source aspect ${photoSlot.content.assetAspectRatio.toFixed(2)} implies ${(
          cropLoss * 100
        ).toFixed(0)}% crop loss — over the ${(FULL_BLEED_HERO_MAX_CROP_LOSS * 100).toFixed(0)}% ceiling.`,
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// (h) Photo count (owner review round 8, item 5b "grids only at 4") — a
// page may hold exactly 1, 2, or 4 photo slots, NEVER 3, never more than 4.
// A 3-photo memory now splits into a 2+1 pair of anchor-media pages instead
// of ever rendering as a 3-photo flex-grid (see `chunkSingleMemoryAssets`/
// `scoreFlexGrid` in fitter.ts) — this is the permanent regression backstop
// for that invariant, checked on every photo-bearing page regardless of
// template (anchor-media itself can never produce 3+ by construction, but
// this stays template-agnostic so it also catches a future template that
// might).
// ---------------------------------------------------------------------------

function auditPhotoCount(document: BookDocument): IntegrityViolation[] {
  const violations: IntegrityViolation[] = [];
  for (const page of document.pages) {
    const photoCount = page.slots.filter((s) => s.kind === 'photo').length;
    if (photoCount === 3 || photoCount > 4) {
      violations.push({
        check: 'photo-count',
        pageId: page.id,
        message: `Page ${page.id}: has ${photoCount} photo slots — a page may only ever hold 1, 2, or 4 (never 3, never more than 4).`,
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// (i) Illustrated-story stack overflow (round-9 item 1e) — the diagnosed
// "folio stamped on the illustration" bug: a single-page illustrated-story's
// text+illustration stack had nothing constraining its TOTAL height to the
// safe box, and a real page measured its bottom edge at 236mm on a 216mm
// page. Illustrated pages previously had ZERO geometric audit coverage —
// this closes that gap. Recomputes the stack's own bottom edge via the SAME
// pure functions (`illustratedStackTopMm`, `illustratedCaptionHeightEstimateMm`,
// `illustratedIlloFitHeightMm`, all from templates/mm.ts) the template
// renders with and the fitter's split decision uses, so this can never
// structurally drift from either — its real value is catching the case
// where a future change stops applying the fitted-height cap somewhere
// (the DOM-measurement spot-check in the verification step covers the
// residual risk that the analytical caption-height ESTIMATE itself is
// wrong, which this pure recompute can't).
// ---------------------------------------------------------------------------

function auditIllustratedStackOverflow(document: BookDocument): IntegrityViolation[] {
  const violations: IntegrityViolation[] = [];
  const EPSILON_MM = 1e-6;

  for (const page of document.pages) {
    if (page.templateId !== 'illustrated-story') continue;
    const mode = (page.params.mode as string | undefined) ?? 'both';
    if (mode !== 'both') continue; // 'text-only'/'illustration-only' halves render no shared stack to overflow

    const illustrationSlot = page.slots.find((s): s is typeof s & { content: IllustrationSlotContent } => s.kind === 'illustration');
    if (!illustrationSlot) continue; // no illustration on this page — nothing for the stack to overflow with

    const textSlot = page.slots.find((s): s is typeof s & { content: TextSlotContent } => s.kind === 'text');
    const captionLen = textSlot?.content.text?.length ?? 0;
    const hasSectionHeader = page.params.sectionHeader != null;
    const stagger = Boolean(page.params.stagger);
    const aspect = illustrationSlot.content.assetAspectRatio;

    const top = illustratedStackTopMm(hasSectionHeader, stagger);
    const captionHeight = illustratedCaptionHeightEstimateMm(captionLen, stagger);
    const illoHeight = illustratedIlloFitHeightMm(captionLen, hasSectionHeader, stagger, aspect);
    const stackBottomMm = top + captionHeight + ILLUSTRATED_STACK_GAP_MM + illoHeight;
    const maxBottomMm = SAFE_BOX_MM - ILLUSTRATED_FOLIO_CLEARANCE_MM;

    if (stackBottomMm > maxBottomMm + EPSILON_MM) {
      violations.push({
        check: 'illustrated-stack-overflow',
        pageId: page.id,
        message: `Page ${page.id}: illustrated-story stack bottom at ${stackBottomMm.toFixed(1)}mm exceeds the ${maxBottomMm.toFixed(
          1,
        )}mm folio-clearance ceiling (safe box ${SAFE_BOX_MM}mm - ${ILLUSTRATED_FOLIO_CLEARANCE_MM}mm clearance).`,
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// (j) Illustrated-digest geometry + even-only structure (Task 1, round-12;
// owner round-12 correction + extension) — the permanent regression
// backstop for `templates/IllustratedDigest.tsx`'s own row geometry AND for
// the structural entry-count rule: a digest composition must NEVER hold an
// odd entry count, a SPREAD must hold exactly 4, a SINGLE page exactly 2
// (the "lonely second row" the owner's screenshots flagged). Geometry is
// recomputed via the SAME pure `digestColumnsForPage`/`layoutDigestColumn`
// functions (`templates/layout/illustratedDigestLayout.ts`) the template
// renders with, for EITHER basis (`page.isSpread` picks it, same signal the
// template reads), so this can never structurally drift from what actually
// renders.
// ---------------------------------------------------------------------------

function auditIllustratedDigest(document: BookDocument): IntegrityViolation[] {
  const violations: IntegrityViolation[] = [];
  const EPSILON_MM = 1e-6;
  const columnWidthMm = SAFE_BOX_MM;
  const columnHeightMm = SAFE_BOX_MM - DIGEST_FOLIO_CLEARANCE_MM;

  for (const page of document.pages) {
    if (page.templateId !== 'illustrated-digest') continue;
    const entries = page.slots
      .filter((s): s is typeof s & { content: DigestEntryContent } => s.kind === 'digest-entry')
      .map((s) => s.content);

    // Even-only structural rule (owner round-12 correction): checked
    // BEFORE geometry — a malformed entry count makes the geometry check
    // below meaningless anyway (it would just measure whatever shape
    // `digestColumnsForPage` happens to produce for a count neither
    // variant expects).
    const n = entries.length;
    if (n % 2 !== 0) {
      violations.push({
        check: 'illustrated-digest',
        pageId: page.id,
        message: `Page ${page.id}: illustrated-digest holds an odd entry count (${n}) — digest compositions must be even-only (never a lonely last row).`,
      });
    } else if (page.isSpread && n !== 4) {
      violations.push({
        check: 'illustrated-digest',
        pageId: page.id,
        message: `Page ${page.id}: illustrated-digest SPREAD holds ${n} entries — a spread must hold exactly 4.`,
      });
    } else if (!page.isSpread && n !== 2) {
      violations.push({
        check: 'illustrated-digest',
        pageId: page.id,
        message: `Page ${page.id}: illustrated-digest SINGLE PAGE holds ${n} entries — a single page must hold exactly 2.`,
      });
    }

    for (const column of digestColumnsForPage(entries, page.isSpread)) {
      if (column.length === 0) continue;
      // The illustration's own width is a fixed shared constant, never
      // data-derived — every entry in this column already renders at
      // EXACTLY `DIGEST_ILLO_WIDTH_MM` by construction (the template never
      // sizes it any other way), so `digestRowMetrics` (used below via
      // `layoutDigestColumn`) computing every row's illustration height
      // from that SAME constant is itself the width-fidelity check.
      const layout = layoutDigestColumn(
        column.map((entry) => ({ text: entry.text, illustrationAspect: entry.illustration.aspectRatio })),
        columnWidthMm,
      );
      if (layout.totalHeightMm > columnHeightMm + EPSILON_MM) {
        violations.push({
          check: 'illustrated-digest',
          pageId: page.id,
          message: `Page ${page.id}: illustrated-digest column (${column.length} entries at ${DIGEST_ILLO_WIDTH_MM}mm wide) totals ${layout.totalHeightMm.toFixed(
            1,
          )}mm, exceeding the ${columnHeightMm.toFixed(1)}mm safe-box-minus-folio-clearance ceiling.`,
        });
      }
      for (let i = 1; i < layout.rows.length; i++) {
        const prev = layout.rows[i - 1];
        const cur = layout.rows[i];
        if (prev.topMm + prev.heightMm > cur.topMm + EPSILON_MM) {
          violations.push({
            check: 'illustrated-digest',
            pageId: page.id,
            message: `Page ${page.id}: illustrated-digest rows ${i} and ${i + 1} in the same column overlap.`,
          });
        }
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// (k) Through-the-years geometry (round-21) — the permanent regression
// backstop for `templates/ThroughTheYears.tsx`'s per-portrait geometry.
// Diagnosed bug: the portrait's meta block (source thumb + age/date labels)
// used to be IN-FLOW flex content nested inside an absolutely-positioned
// item, inside the print path's 426mm cropped-spread tree — Chromium's
// `page.pdf` print pagination (never the screen render, never a print-media-
// emulated screenshot) silently redistributed it, pulling labels up onto
// the portrait. This page printed broken while the OLD audit said 0
// violations (through-the-years had no geometric coverage at all) — closing
// that gap is the whole point of this check. Recomputes the SAME rects
// `ThroughTheYears.tsx` renders with, via the SAME pure
// `throughTheYearsLayout.ts` functions, so the two can never drift apart.
// ---------------------------------------------------------------------------

function auditThroughTheYears(document: BookDocument): IntegrityViolation[] {
  const violations: IntegrityViolation[] = [];
  const EPSILON_MM = 1e-6;
  // The spread's own safe box — SAFE_INSET_MM (bleed + margin) in from
  // every outer edge, on all four sides. Unlike `illustrated-digest`'s
  // per-page columns, through-the-years portraits are positioned freely
  // across the whole 426mm spread canvas (crossing the page-1/page-2
  // gutter by design — see `throughTheYearsLayout.ts`'s outer-position
  // table), so containment is checked against the spread's own outer safe
  // box, not a per-page one.
  const safeXMin = SAFE_INSET_MM;
  const safeXMax = SPREAD_WIDTH_MM - SAFE_INSET_MM;
  const safeYMin = SAFE_INSET_MM;
  const safeYMax = SPREAD_HEIGHT_MM - SAFE_INSET_MM;

  for (const page of document.pages) {
    if (page.templateId !== 'through-the-years') continue;
    const slot = page.slots.find((s): s is typeof s & { content: PortraitStripContent } => s.kind === 'portrait-strip');
    const portraits = slot?.content.portraits ?? [];

    portraits.forEach((p, i) => {
      const outer = ttyOuterLayoutFor(portraits.length, i);
      const itemWidthMm = canvasPxToTrimMm(outer.widthPx);
      const item = layoutTtyItem(itemWidthMm, Boolean(p.sourceFile));
      const itemAbs = ttyItemAbsoluteRect(outer, item.itemHeightMm);

      const checkContained = (label: string, rect: Rect) => {
        const overflowsX = rect.xMm < safeXMin - EPSILON_MM || rect.xMm + rect.wMm > safeXMax + EPSILON_MM;
        const overflowsY = rect.yMm < safeYMin - EPSILON_MM || rect.yMm + rect.hMm > safeYMax + EPSILON_MM;
        if (overflowsX || overflowsY) {
          violations.push({
            check: 'through-the-years',
            pageId: page.id,
            message: `Page ${page.id}: through-the-years portrait ${i}'s ${label} box (x ${rect.xMm.toFixed(1)}-${(rect.xMm + rect.wMm).toFixed(
              1,
            )}mm, y ${rect.yMm.toFixed(1)}-${(rect.yMm + rect.hMm).toFixed(1)}mm) falls outside the spread's safe box (x ${safeXMin.toFixed(
              1,
            )}-${safeXMax.toFixed(1)}mm, y ${safeYMin.toFixed(1)}-${safeYMax.toFixed(1)}mm).`,
          });
        }
      };

      const portraitAbs = ttyChildAbsoluteRect(itemAbs, item.portrait);
      const labelsAbs = ttyChildAbsoluteRect(itemAbs, item.labels);
      checkContained('portrait', portraitAbs);
      checkContained('labels', labelsAbs);
      if (item.thumb) checkContained('source thumb', ttyChildAbsoluteRect(itemAbs, item.thumb));

      if (rectsIntersect(portraitAbs, labelsAbs)) {
        violations.push({
          check: 'through-the-years',
          pageId: page.id,
          message: `Page ${page.id}: through-the-years portrait ${i}'s label block overlaps its own portrait box.`,
        });
      }
    });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Phase 2b (dogfood round 1) — three checks added after real Everything books
// shipped pages where a memory's media silently vanished, a page had slots no
// template could draw, and a title page faced nothing. Run on EVERY book.
// ---------------------------------------------------------------------------

/** Every memory id a page's slots reference (photo, text, illustration, audio-note, quote/digest entries). */
function slotMemoryIds(page: BookPage): string[] {
  const ids: string[] = [];
  for (const slot of page.slots) {
    const memoryId = (slot.content as { memoryId?: string | null }).memoryId;
    if (typeof memoryId === 'string') ids.push(memoryId);
  }
  return ids;
}

/**
 * (j) A memory that carries photo/video assets must show at least one of
 * them as a photo slot somewhere in the book. Diagnosed from Mara p79: a
 * photo memory and a video memory merged onto a `text-page` whose slots are
 * text-only, so both kept their caption and lost their media. Two detections:
 *  - always: the memory prints something (any non-photo slot) yet has no
 *    photo slot anywhere;
 *  - when `omittedMemoryIds` is supplied: a memory that is neither omitted nor
 *    printed at all (e.g. dropped as an un-fittable gap).
 * Chapter mode (Phase 2c photo cap): a memory shows at most 2 of its assets,
 * so "at least one photo slot" is exactly the requirement there too; the
 * hidden remainder is accounted for by `summarizeAssetCoverage`, not flagged.
 */
function auditMediaMemoryWithoutMedia(
  document: BookDocument,
  outline: BookOutline,
  manifest: BookManifest,
  omittedMemoryIds: Iterable<string> | undefined,
): IntegrityViolation[] {
  const omitted = omittedMemoryIds ? new Set(omittedMemoryIds) : null;
  const withPhoto = new Set<string>();
  const printed = new Set<string>();
  for (const page of document.pages) {
    for (const slot of page.slots) {
      const memoryId = (slot.content as { memoryId?: string | null }).memoryId;
      if (typeof memoryId !== 'string') continue;
      printed.add(memoryId);
      if (slot.kind === 'photo') withPhoto.add(memoryId);
    }
  }
  const violations: IntegrityViolation[] = [];
  const seen = new Set<string>();
  for (const element of outline.elements) {
    for (const id of element.memoryIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const memory = manifest.memories[id];
      if (!memory || memory.assets.length === 0) continue;
      if (omitted?.has(id)) continue;
      if (withPhoto.has(id)) continue;
      if (!printed.has(id) && omitted === null) continue; // can't tell "omitted" from "lost" without the omission list
      violations.push({
        check: 'media-memory-without-media',
        elementId: element.id,
        message: `Memory ${id} (${memory.assets.length} asset${memory.assets.length === 1 ? '' : 's'}) ${
          printed.has(id) ? 'prints without any of its media' : 'is neither omitted nor printed'
        }.`,
      });
    }
  }
  return violations;
}

/** Asset accounting for a finished fit (see `summarizeAssetCoverage`). */
export interface AssetCoverage {
  memoriesKept: number;
  mediaMemoriesKept: number;
  mediaMemoriesRendered: number;
  /** Every asset of every kept memory, as the manifest holds them. */
  assetsKept: number;
  /** Assets the book MEANS to show: `assetsKept` minus the chapter-mode photo cap (equal outside chapter mode). */
  assetsShown: number;
  /** Assets deliberately left out by the chapter-mode photo cap (a cap decision, not a loss). */
  hiddenByCap: number;
  /** Photo/video slots actually rendered for kept memories (distinct memory + slot identity). */
  assetsRendered: number;
  /** Shown assets that never rendered: the genuine loss (should be 0). */
  assetsLost: number;
}

/**
 * Kept-memory asset accounting, separating assets hidden by the chapter-mode
 * photo cap from genuine loss. `manifest` must be the EDITED manifest
 * (`applyPreFit` output) when edits apply, so a user-replaced asset is
 * identified the way the slots identify it (`editedFromFile ?? file`).
 * Ids and counts only.
 */
export function summarizeAssetCoverage(
  document: BookDocument,
  outline: BookOutline,
  manifest: BookManifest,
  omittedMemoryIds: Iterable<string> = [],
): AssetCoverage {
  const omitted = new Set(omittedMemoryIds);
  const capped = isChapterMode(outline);
  const kept = new Set<string>();
  for (const element of outline.elements) {
    for (const id of element.memoryIds) if (manifest.memories[id] && !omitted.has(id)) kept.add(id);
  }
  const identity = (memoryId: string, asset: { file: string; editedFromFile?: string }) => `${memoryId}|${asset.editedFromFile ?? asset.file}`;
  const shown = new Set<string>();
  let assetsKept = 0;
  let mediaMemoriesKept = 0;
  for (const id of kept) {
    const assets = manifest.memories[id].assets;
    assetsKept += assets.length;
    if (assets.length > 0) mediaMemoriesKept++;
    for (const asset of capped ? shownAssetsOf(assets) : assets) shown.add(identity(id, asset));
  }
  const rendered = new Set<string>();
  const renderedMemories = new Set<string>();
  for (const page of document.pages) {
    for (const slot of page.slots) {
      if (slot.kind !== 'photo') continue;
      const c = slot.content as PhotoSlotContent;
      if (!c.memoryId || !kept.has(c.memoryId)) continue;
      rendered.add(`${c.memoryId}|${c.editedFromFile ?? c.assetFile}`);
      renderedMemories.add(c.memoryId);
    }
  }
  let assetsLost = 0;
  for (const key of shown) if (!rendered.has(key)) assetsLost++;
  return {
    memoriesKept: kept.size,
    mediaMemoriesKept,
    mediaMemoriesRendered: renderedMemories.size,
    assetsKept,
    assetsShown: shown.size,
    hiddenByCap: assetsKept - shown.size,
    assetsRendered: rendered.size,
    assetsLost,
  };
}

/**
 * Photo slots each template can actually DRAW (derived from the templates'
 * own rendering: AnchorMedia lays out exactly 1 or 2 tiles — 3+ yields no
 * rects at all, so nothing prints; FlexGrid is a 4-photo composition (rule: a
 * page holds 1, 2 or 4); full-bleed / panorama / photo-story render the first
 * photo only; the text-forward and illustration templates render none).
 * A template not listed is not checked.
 */
const PHOTO_SLOT_CAPACITY: Partial<Record<BookPage['templateId'], number>> = {
  'anchor-media': 2,
  'flex-grid': 4,
  'full-bleed': 1,
  'panorama-spread': 1,
  'photo-story': 1,
  'text-page': 0,
  'illustrated-story': 0,
  'audio-note': 0,
  'quote-collection': 0,
  'illustrated-digest': 0,
};

function auditUnrenderableSlots(document: BookDocument): IntegrityViolation[] {
  const violations: IntegrityViolation[] = [];
  for (const page of document.pages) {
    const capacity = PHOTO_SLOT_CAPACITY[page.templateId];
    if (capacity === undefined) continue;
    const photoCount = page.slots.filter((s) => s.kind === 'photo').length;
    if (photoCount > capacity) {
      violations.push({
        check: 'unrenderable-slots',
        pageId: page.id,
        message: `Page ${page.id}: template "${page.templateId}" can draw at most ${capacity} photo slot${capacity === 1 ? '' : 's'} but the page holds ${photoCount} — the extra photos never print.`,
      });
    }
  }
  return violations;
}

/** What a page actually DRAWS from its slots (the audit's own mirror of each template's render rules); a non-slot-driven page counts as content. */
function drawnContentCount(page: BookPage): number {
  const count = (kind: string) => page.slots.filter((s) => s.kind === kind).length;
  switch (page.templateId) {
    case 'blank':
      return 0;
    case 'anchor-media': {
      const photos = count('photo');
      return photos === 1 || photos === 2 ? photos : 0;
    }
    case 'flex-grid':
      return count('photo') + count('text');
    case 'full-bleed':
    case 'panorama-spread':
    case 'photo-story':
      return count('photo') > 0 ? 1 : 0;
    case 'text-page':
      return count('text');
    case 'illustrated-story':
      return count('text') + count('illustration');
    case 'audio-note':
      return count('audio-note') + count('text');
    case 'quote-collection':
    case 'illustrated-digest':
      return page.slots.length;
    default:
      return 1; // spread-title, dedication, closing, through-the-years, cover-wrap, firsts...: self-contained
  }
}

/**
 * (l) A title-only page (chapter / themed / firsts `spread-title`)
 * immediately followed by a page that draws no media and no text — a title
 * facing nothing (Enzo p6 -> p7, where the following page's 5 photo slots
 * were undrawable; also a title facing a parity blank).
 */
function auditTitleThenEmpty(document: BookDocument): IntegrityViolation[] {
  const violations: IntegrityViolation[] = [];
  const pages = document.pages;
  for (let i = 0; i < pages.length - 1; i++) {
    if (pages[i].templateId !== 'spread-title') continue;
    const next = pages[i + 1];
    if (drawnContentCount(next) === 0) {
      violations.push({
        check: 'title-then-empty',
        pageId: pages[i].id,
        message: `Title page ${pages[i].id} is immediately followed by page ${next.id} ("${next.templateId}"), which draws no media and no text.`,
      });
    }
  }
  return violations;
}
