import type { TemplateProps } from './types';
import { PageFrame } from './PageFrame';
import { assetUrl } from '../model/loader';
import { formatPortraitDate } from './common/formatDate';
import { xPct, yPct, wPct, ptCqw, canvasPxToPt, canvasPxToTrimMm, mmToPctHeight } from './mm';
import { Folio } from './common/Folio';
import { getFurniture, getLanguage } from './furniture';
import { localizedAgeLabel } from './age';
import { colors, lavender } from '../theme';
import type { ManifestPortrait, PortraitStripContent } from '../model/types';
import { layoutTtyItem, ttyOuterLayoutFor } from './layout/throughTheYearsLayout';
import './ThroughTheYears.css';

/**
 * "Un año en retratos" — the book's silent overture (Momora Book Layout
 * System 1a). The illustrated portrait leads at 90-110mm; the real source
 * photo it was generated from sits small and unframed beneath it; heights
 * are staggered so no two frames share a top edge, and a hairline timeline
 * crosses the whole spread without touching any face.
 */
export function ThroughTheYears({ page, manifest, bookSlug, showGuides }: TemplateProps) {
  const slot = page.slots.find((s): s is { id: string; kind: 'portrait-strip'; content: PortraitStripContent } => s.kind === 'portrait-strip');
  const portraits = slot?.content.portraits ?? [];
  const pageNumbers = page.pageNumbers ?? [];
  const lang = getLanguage(manifest);
  const furniture = getFurniture(lang);
  // `furniture:ttyKicker`/`furniture:ttyTitle` edits (owner-approved
  // follow-up round) — otherwise-fixed furniture copy, same optional
  // params-override-with-fallback shape as the dedication fields above.
  // `titleLines` is a fixed 2-line tuple in the furniture table; an edited
  // title is stored as one string (`TextEditPopover`'s plain `<textarea>`)
  // and split on `\n` here, capped to the same two lines the layout
  // reserves space for — extra lines beyond the second are dropped rather
  // than silently overflowing the header block.
  const kicker = typeof page.params.ttyKicker === 'string' ? page.params.ttyKicker : furniture.throughTheYears.kicker;
  const ttyTitleOverride = typeof page.params.ttyTitle === 'string' ? page.params.ttyTitle : null;
  const titleLines: [string, string] = ttyTitleOverride !== null ? splitTitleLines(ttyTitleOverride) : furniture.throughTheYears.titleLines;
  const ageLabelFor = (p: ManifestPortrait) =>
    localizedAgeLabel({ ageLabel: p.ageLabel, date: p.date, dateOfBirth: manifest.child.dateOfBirth }, lang);

  return (
    <PageFrame isSpread showGuides={showGuides} className="through-the-years-page">
      <div className="ttty" data-testid="portrait-strip">
        <div style={{ position: 'absolute', left: `${xPct(60, true)}%`, top: `${yPct(56)}%` }}>
          <div
            style={{
              fontFamily: 'var(--font-sans)',
              fontWeight: 700,
              fontSize: ptCqw(6.5, true),
              lineHeight: 1.2,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: lavender.deep,
              marginBottom: '0.9em',
            }}
          >
            {kicker}
          </div>
          <h2
            style={{
              margin: 0,
              fontFamily: 'var(--font-display)',
              fontWeight: 400,
              fontSize: ptCqw(canvasPxToPt(44), true),
              lineHeight: 1.05,
              letterSpacing: '-0.02em',
              color: colors.ink,
            }}
          >
            {titleLines[0]}
            <br />
            {titleLines[1]}
          </h2>
        </div>
        <div
          className="ttty__timeline"
          style={{
            position: 'absolute',
            left: `${xPct(60, true)}%`,
            right: `${100 - xPct(1620, true)}%`,
            top: `${yPct(252)}%`,
            background: colors.border,
          }}
        />
        {portraits.map((p, i) => {
          // Round-21 print-safety fix: every rect below is deterministic,
          // driven by `throughTheYearsLayout.ts`'s pure `layoutTtyItem` —
          // see that module's doc comment for the diagnosed print-
          // pagination bug this replaces (`.ttty__meta` used to be in-flow
          // flex content, which `page.pdf` alone — never the screen render
          // — silently redistributed). Every box below is `position:
          // absolute`; `.ttty__item` gets an explicit height so they have a
          // real containing block to resolve their % against, and every
          // child % is computed against the ITEM's own width/height (its
          // ACTUAL containing block), never the spread's — the same
          // containing-block-basis rule `mm.ts`'s comments warn about.
          const outer = ttyOuterLayoutFor(portraits.length, i);
          const itemWidthMm = canvasPxToTrimMm(outer.widthPx);
          const item = layoutTtyItem(itemWidthMm, Boolean(p.sourceFile));
          const pctW = (mm: number) => (mm / itemWidthMm) * 100;
          const pctH = (mm: number) => (mm / item.itemHeightMm) * 100;
          return (
            <div
              key={p.file}
              className="ttty__item"
              style={{
                position: 'absolute',
                left: `${xPct(outer.leftPx, true)}%`,
                top: `${yPct(outer.topPx)}%`,
                width: `${wPct(outer.widthPx, true)}%`,
                height: `${mmToPctHeight(item.itemHeightMm, true)}%`,
              }}
            >
              <div
                className="ttty__portrait"
                style={{
                  position: 'absolute',
                  left: `${pctW(item.portrait.leftMm)}%`,
                  top: `${pctH(item.portrait.topMm)}%`,
                  width: `${pctW(item.portrait.widthMm)}%`,
                  height: `${pctH(item.portrait.heightMm)}%`,
                  background: colors.surface2,
                }}
              >
                <img src={assetUrl(bookSlug, p.file)} alt="" className="ttty__portrait-img" />
              </div>
              {item.thumb && p.sourceFile && (
                <div
                  className="ttty__source"
                  style={{
                    position: 'absolute',
                    left: `${pctW(item.thumb.leftMm)}%`,
                    top: `${pctH(item.thumb.topMm)}%`,
                    width: `${pctW(item.thumb.widthMm)}%`,
                    height: `${pctH(item.thumb.heightMm)}%`,
                  }}
                >
                  <img src={assetUrl(bookSlug, p.sourceFile)} alt="" className="ttty__source-img" />
                </div>
              )}
              <div
                className="ttty__labels"
                style={{
                  position: 'absolute',
                  left: `${pctW(item.labels.leftMm)}%`,
                  top: `${pctH(item.labels.topMm)}%`,
                  width: `${pctW(item.labels.widthMm)}%`,
                  // Explicit height (never auto) — an absolutely-positioned
                  // box with auto height, even a leaf one with no further
                  // absolutely-positioned descendants, still collapses/
                  // redistributes its own in-flow children (the age/date
                  // stack below) under Chromium's print pagination inside
                  // this cropped-spread tree; same failure class `.ttty__item`
                  // itself needed fixing for, just one level deeper. Verified
                  // live: this was the one box still missing an explicit
                  // height, and it was still visibly broken in the real
                  // page.pdf output (age/date text rendering on top of each
                  // other) until this was added.
                  height: `${pctH(item.labels.heightMm)}%`,
                }}
              >
                <div className="ttty__age" style={{ fontSize: ptCqw(canvasPxToPt(19), true) }}>
                  {ageLabelFor(p)}
                </div>
                <div className="ttty__date" style={{ fontSize: ptCqw(canvasPxToPt(10), true) }}>
                  {formatPortraitDate(p.date, lang)}
                </div>
              </div>
            </div>
          );
        })}
        {portraits.length === 0 && <p className="ttty__empty">No portrait history yet.</p>}
      </div>
      {pageNumbers[0] != null && <Folio pageNumber={pageNumbers[0]} isEvenPage isSpread />}
      {pageNumbers[1] != null && <Folio pageNumber={pageNumbers[1]} isEvenPage={false} isSpread />}
    </PageFrame>
  );
}

/** Splits a `furniture:ttyTitle` edit's single-string value into the
 * fixed 2-line tuple the header layout reserves space for — a missing
 * second line renders blank (never re-uses the first line), matching a
 * deliberate one-line title being just that. */
function splitTitleLines(value: string): [string, string] {
  const [line1 = '', line2 = ''] = value.split('\n');
  return [line1, line2];
}
