import type { TemplateProps } from './types';
import { PageFrame } from './PageFrame';
import { SafeArea } from './common/SafeArea';
import { Folio } from './common/Folio';
import { SectionHeader, type SectionHeaderParams } from './common/SectionHeader';
import { formatLongDate } from './common/formatDate';
import { getLanguage } from './furniture';
import { assetUrl } from '../model/loader';
import {
  ptCqw,
  canvasPxToPt,
  SAFE_BOX_MM,
  illustratedIlloFitHeightMm,
  illustratedBodyFontSizePt,
  illustratedStackTopMm,
  ILLUSTRATED_STACK_WIDTH_MM,
  ILLUSTRATED_STACK_GAP_MM,
} from './mm';
import { colors } from '../theme';
import type { IllustrationSlotContent, TextSlotContent } from '../model/types';
import './IllustratedStory.css';

/**
 * `.illustrated-story__stack`'s own rendered width, gap-below-text, and
 * header breathing-gap now live in `mm.ts` (round-9 item 1) — the same
 * caption-height/fit-height estimators that keep the stack from overflowing
 * the safe box need to agree with the template on these EXACT values, so
 * they're the one shared source now rather than a locally-duplicated
 * constant here (the round-8 item-4 %-basis drift bug shipped twice from
 * exactly this kind of duplication).
 */

/**
 * "Cuento ilustrado" (Momora Book Layout System 1b §3): the one page in the
 * book that reads like a storybook page — text ALWAYS above the
 * illustration, set larger than anywhere else (17-19pt over 5 columns).
 * Short entries (<=400 chars) keep the illustration on the same page,
 * staggered vertically between adjacent illustrated pages so a spread never
 * reads symmetrical; longer entries push the illustration to the facing
 * page, bleeding through the outer trim and foot (`mode: 'illustration-only'`).
 *
 * Bug fix (owner review round 3 item 13, "Enzo p41 class"): the text and
 * illustration used to be two INDEPENDENTLY absolutely-positioned boxes,
 * the illustration's `top` a fixed canvas-derived constant. Since the
 * text's actual rendered height varies with its (data-dependent) length,
 * a long-enough "both"-mode caption could push past that fixed illustration
 * position and visually overlap it. They're now one flex column: the
 * illustration is placed in normal document FLOW below the text (a
 * `margin-top` gap, not an absolute `top`), so it always sits below
 * whatever height the text actually rendered at, however long that text is.
 *
 * Month-opener composition (owner review round 4 item 7): when a section
 * header is present, the stack starts right below the header's own
 * reserved height (the SAME `SECTION_HEADER_RESERVE_MM` anchor-media and
 * audio-note use, for a consistent header height across every template
 * that can carry one) rather than the ordinary stagger-driven offset — and
 * the illustration renders smaller (`HEADER_ILLO_SHRINK`) to leave the
 * composition room to breathe, matching the same care a standalone
 * illustrated-story page gets.
 */
export function IllustratedStory({ page, manifest, bookSlug, showGuides }: TemplateProps) {
  const textSlot = page.slots.find((s): s is { id: string; kind: 'text'; content: TextSlotContent } => s.kind === 'text');
  const illustrationSlot = page.slots.find(
    (s): s is { id: string; kind: 'illustration'; content: IllustrationSlotContent } => s.kind === 'illustration',
  );
  const language = getLanguage(manifest);
  const mode = (page.params.mode as string | undefined) ?? 'both';
  const stagger = Boolean(page.params.stagger);
  const pageNumber = page.pageNumbers?.[0];
  const isEvenPage = page.isEvenPage ?? true;
  // A month segment made up ENTIRELY of illustrated-story pages otherwise
  // has nowhere to show its month header (owner review round 3 — "headers
  // vanished after p34 in Enzo" diagnosis: illustrated-story/audio-note
  // never rendered `sectionHeader` at all, so the fitter's own header-
  // pending logic had no capable page to attach it to for a photo-thin
  // section). Never shown in `illustration-only` mode — there's no text
  // area for it to sit in there.
  const sectionHeader = (page.params.sectionHeader ?? null) as SectionHeaderParams | null;

  if (mode === 'illustration-only') {
    return (
      <PageFrame isSpread={false} showGuides={showGuides} className="illustrated-story-page">
        {illustrationSlot && (
          <img src={assetUrl(bookSlug, illustrationSlot.content.assetFile)} alt="" className="illustrated-story__bleed" />
        )}
        {pageNumber != null && <Folio pageNumber={pageNumber} isEvenPage={isEvenPage} isSpread={false} />}
      </PageFrame>
    );
  }

  const captionLen = textSlot?.content.text?.length ?? 0;
  const bothModeStagger = mode === 'both' && stagger;
  // Round-8 item 4 bug fix (still applies): a size meant to render at an
  // EXACT mm value must be expressed as a percentage of the element's own
  // ACTUAL containing block, never a distant ancestor's. `pctOfStack`
  // converts an intended mm size into a percentage of the STACK's own
  // actual rendered width; `pctOfSafe` converts one into a percentage of
  // the SAFE box the stack itself lives inside (see the round-8 comment
  // history in mm.ts for the two drift instances this fixed).
  const pctOfStack = (mm: number): number => (mm / ILLUSTRATED_STACK_WIDTH_MM) * 100;
  const pctOfSafe = (mm: number): number => (mm / SAFE_BOX_MM) * 100;
  // Round-9 item 1: the illustration's FINAL height is capped so the whole
  // stack (top offset + text + gap + illustration) never pushes past the
  // safe box's bottom edge, where the folio lives (`illustratedIlloFitHeightMm`
  // — the exact function `illustratedStoryNeedsSplit` in fitter.ts and the
  // audit's stack-bottom check also use, so this can never drift from
  // either). Width follows from the fitted height at the image's own aspect
  // ratio — never stretched.
  const illoAspectRatio = illustrationSlot?.content.assetAspectRatio ?? 1;
  const fittedIlloHeightMm = illustratedIlloFitHeightMm(captionLen, Boolean(sectionHeader), stagger, illoAspectRatio);
  const fittedIlloWidthMm = fittedIlloHeightMm * illoAspectRatio;
  const illoWidthPct = pctOfStack(fittedIlloWidthMm);
  const stackTopPct = pctOfSafe(illustratedStackTopMm(Boolean(sectionHeader), stagger));

  return (
    <PageFrame isSpread={false} showGuides={showGuides} className="illustrated-story-page">
      <SafeArea isSpread={false}>
        <div className="illustrated-story" data-testid="illustrated-story">
          {sectionHeader && <SectionHeader {...sectionHeader} isSpread={false} />}
          <div
            className="illustrated-story__stack"
            style={{
              top: `${stackTopPct}%`,
              left: 0,
              width: `${pctOfSafe(ILLUSTRATED_STACK_WIDTH_MM)}%`,
            }}
          >
            <div className="illustrated-story__text">
              {textSlot?.content.date && (
                <span className="illustrated-story__date" style={{ fontSize: ptCqw(canvasPxToPt(9.5), false), color: colors.numeral }}>
                  {formatLongDate(textSlot.content.date, language)}
                </span>
              )}
              <p className="illustrated-story__body" style={{ fontSize: ptCqw(illustratedBodyFontSizePt(bothModeStagger), false), color: colors.ink }}>
                {textSlot?.content.text}
              </p>
            </div>
            {illustrationSlot && mode === 'both' && (
              <div
                className="illustrated-story__illo"
                style={{
                  marginTop: `${pctOfStack(ILLUSTRATED_STACK_GAP_MM)}%`,
                  alignSelf: stagger ? 'flex-start' : 'flex-end',
                  width: `${illoWidthPct}%`,
                  aspectRatio: `${illoAspectRatio}`,
                  background: colors.surface2,
                }}
              >
                <img src={assetUrl(bookSlug, illustrationSlot.content.assetFile)} alt="" className="illustrated-story__illo-img" />
              </div>
            )}
          </div>
        </div>
      </SafeArea>
      {pageNumber != null && <Folio pageNumber={pageNumber} isEvenPage={isEvenPage} isSpread={false} />}
    </PageFrame>
  );
}
