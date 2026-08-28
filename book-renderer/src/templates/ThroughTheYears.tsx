import type { TemplateProps } from './types';
import { PageFrame } from './PageFrame';
import { assetUrl } from '../model/loader';
import { formatPortraitDate } from './common/formatDate';
import { xPct, yPct, wPct, ptCqw, canvasPxToPt } from './mm';
import { Folio } from './common/Folio';
import { getFurniture, getLanguage } from './furniture';
import { localizedAgeLabel } from './age';
import { colors, lavender } from '../theme';
import type { ManifestPortrait, PortraitStripContent } from '../model/types';
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
  const ageLabelFor = (p: ManifestPortrait) =>
    localizedAgeLabel({ ageLabel: p.ageLabel, date: p.date, dateOfBirth: manifest.child.dateOfBirth }, lang);

  // Staggered left/top/width so no two portrait frames share a top edge —
  // matches the design canvas's 3-portrait example, extended for up to 6.
  const legacyLayouts = [
    { leftPx: 80, topPx: 300, widthPx: 340 },
    { leftPx: 480, topPx: 340, widthPx: 260 },
    { leftPx: 1000, topPx: 280, widthPx: 420 },
    { leftPx: 80, topPx: 640, widthPx: 220 },
    { leftPx: 480, topPx: 660, widthPx: 200 },
    { leftPx: 1180, topPx: 660, widthPx: 220 },
  ];
  /**
   * Bug fix (owner review round 5, item 8): `partitionPortraits` always
   * hands this template a chunk of 1-3 portraits per spread (its own doc
   * comment guarantees the range) — but the OLD lookup above indexed
   * purely by running position, so a 2-portrait chunk landed on
   * `legacyLayouts[0]` AND `legacyLayouts[1]`, both of which sit left of
   * the 840px page-1/page-2 boundary on this 1680px spread canvas — i.e.
   * BOTH portraits rendered on the LEFT page, leaving the right page of the
   * spread empty. Each group size now gets its own table with an explicit
   * left/right-page split: 1 -> right page (balances the kicker/title on
   * the left), 2 -> one per page, 3 -> 2 left + 1 right (unchanged from the
   * original table, which already got this case right).
   */
  const layoutsBySize: Record<number, Array<{ leftPx: number; topPx: number; widthPx: number }>> = {
    1: [{ leftPx: 1020, topPx: 380, widthPx: 420 }],
    2: [
      { leftPx: 80, topPx: 320, widthPx: 340 },
      { leftPx: 1020, topPx: 420, widthPx: 340 },
    ],
    3: [legacyLayouts[0], legacyLayouts[1], legacyLayouts[2]],
  };
  const layoutFor = (count: number, i: number) => {
    const table = layoutsBySize[count];
    if (table) return table[i % table.length];
    return legacyLayouts[i % legacyLayouts.length]; // defensive fallback — partitionPortraits never actually produces >3
  };

  return (
    <PageFrame isSpread showGuides={showGuides} className="through-the-years-page">
      <div className="ttty" data-testid="portrait-strip">
        <div style={{ position: 'absolute', left: `${xPct(60, true)}%`, top: `${yPct(56)}%` }}>
          <div
            style={{
              fontFamily: 'var(--font-sans)',
              fontWeight: 700,
              fontSize: ptCqw(6.5, true),
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: lavender.deep,
              marginBottom: '0.9em',
            }}
          >
            {furniture.throughTheYears.kicker}
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
            {furniture.throughTheYears.titleLines[0]}
            <br />
            {furniture.throughTheYears.titleLines[1]}
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
          const layout = layoutFor(portraits.length, i);
          return (
            <div
              key={p.file}
              className="ttty__item"
              style={{
                position: 'absolute',
                left: `${xPct(layout.leftPx, true)}%`,
                top: `${yPct(layout.topPx)}%`,
                width: `${wPct(layout.widthPx, true)}%`,
              }}
            >
              <div className="ttty__portrait" style={{ background: colors.surface2 }}>
                <img src={assetUrl(bookSlug, p.file)} alt="" className="ttty__portrait-img" />
              </div>
              <div className="ttty__meta">
                {p.sourceFile && (
                  <div className="ttty__source">
                    <img src={assetUrl(bookSlug, p.sourceFile)} alt="" className="ttty__source-img" />
                  </div>
                )}
                <div className="ttty__labels">
                  <div className="ttty__age" style={{ fontSize: ptCqw(canvasPxToPt(19), true) }}>
                    {ageLabelFor(p)}
                  </div>
                  <div className="ttty__date" style={{ fontSize: ptCqw(canvasPxToPt(10), true) }}>
                    {formatPortraitDate(p.date, lang)}
                  </div>
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
