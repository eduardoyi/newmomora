import type { TemplateProps } from './types';
import { PageFrame } from './PageFrame';
import { Folio } from './common/Folio';
import { formatIndexDate } from './common/formatDate';
import { getLanguage } from './furniture';
import { assetUrl } from '../model/loader';
import { mmToPctWidth, mmToPctHeight, ptCqw, DIGEST_ILLO_WIDTH_MM, DIGEST_FOLIO_CLEARANCE_MM, SAFE_BOX_MM } from './mm';
import { digestColumnsForPage, layoutDigestColumn } from './layout/illustratedDigestLayout';
import { PHYSICAL } from '../model/types';
import { colors, lavender } from '../theme';
import type { DigestEntryContent } from '../model/types';
import './IllustratedDigest.css';

/**
 * Illustrated digest spread (round-12: promotes the owner-approved preview
 * demo — see the composition-language notes below, unchanged from that
 * exploration — to a real fitter-emitted composition, the "pressure valve"
 * for a month whose corpus is nearly all short illustrated memories). 3-4
 * SHORT illustrated memories share one double page, every entry KEEPING its
 * own illustration — unlike the text-only quote-collection (round-4
 * excluded illustrated memories from it precisely because it dropped their
 * art).
 *
 * Composition language ("ledger of small moments", tuned per owner
 * round-11 feedback — bigger art, narrower text, no divider):
 *   - two entries per page, each a row of illustration (see
 *     `DIGEST_ILLO_WIDTH_MM` in templates/mm.ts — properly present, well
 *     above the old 62mm floor) + text block on a narrow measure (max 46%
 *     of the column);
 *   - rows ZIGZAG (illustration left, then right, then left …) across the
 *     whole spread so four square illustrations never read as a grid;
 *   - per-entry date in the antetítulo role (small caps, tracked, lavender)
 *     — same treatment as the quote-collection's dates;
 *   - text at 13pt Newsreader — between the footer-caption voice and the
 *     19pt storybook voice: intimate, but clearly denser than a full
 *     illustrated-story page;
 *   - no dividers, no other furniture — the white space and the zigzag do
 *     the composing.
 *
 * Geometry is TOP-ALIGNED and driven entirely by
 * `templates/layout/illustratedDigestLayout.ts`'s pure `layoutDigestColumn`
 * — the SAME function `model/audit.ts`'s illustrated-digest check recomputes
 * to verify containment, so the two can never drift apart (house rule: any
 * new composition ships with a matching geometric audit check consuming the
 * SAME shared functions).
 *
 * Owner round-12 correction + extension: entry counts are EVEN-only now —
 * a SPREAD always holds exactly 4 (2 columns of 2, as before); a SINGLE
 * PAGE (`page.isSpread === false`) holds exactly 2, in ONE column, zigzag
 * (entry 0 illustration-left, entry 1 illustration-right). `page.isSpread`
 * is the ONE signal driving which basis governs every mm->% conversion
 * here — it's already the fitter's own authoritative field (set at
 * construction time, before `pageNumbers` even exists), so both the
 * fitter and the audit can read the exact same thing without needing a
 * separate params flag. A "column" is always ONE page's own safe-box
 * width (`columnWidthMm`) regardless of basis — only the FRAME the column
 * itself is positioned within (the whole spread, 426mm, vs a single page,
 * 216mm) changes, which is exactly what `mmToPctWidth`/`mmToPctHeight`'s
 * own `isSpread` argument encodes.
 */
export function IllustratedDigest({ page, manifest, bookSlug, showGuides }: TemplateProps) {
  const entries = page.slots
    .filter((s): s is { id: string; kind: 'digest-entry'; content: DigestEntryContent } => s.kind === 'digest-entry')
    .map((s) => s.content);
  const language = getLanguage(manifest);
  const pageNumbers = page.pageNumbers ?? [];
  const isSpread = page.isSpread;

  const bleed = PHYSICAL.bleedMm;
  const trim = PHYSICAL.pageSizeMm;
  const margin = PHYSICAL.safeMarginMm;
  const columnWidthMm = trim - margin * 2; // == SAFE_BOX_MM — one page's own safe-box width, same for either basis
  // Column's own available content height — top-aligned, with the same
  // folio clearance reserved at the bottom the audit checks against
  // (`DIGEST_FOLIO_CLEARANCE_MM`). Also basis-independent (a vertical
  // measurement of one page, not the spread).
  const columnHeightMm = SAFE_BOX_MM - DIGEST_FOLIO_CLEARANCE_MM;
  const leftXPct = mmToPctWidth(bleed + margin, isSpread);
  const colWidthPct = mmToPctWidth(columnWidthMm, isSpread);
  const rightXPct = mmToPctWidth(bleed + trim + margin, isSpread);
  const topPct = mmToPctHeight(bleed + margin, isSpread);
  // Explicit column height, expressed as % of the FRAME (`.illustrated-digest`'s
  // own basis — the spread or the single page, whichever `isSpread` says)
  // — this is what makes the ROW percentages below resolve correctly: a
  // row's `top`/`height` are percentages of the column's own ACTUAL
  // rendered size, and that size must be established explicitly here
  // rather than left to auto-height (which would collapse to 0, since every
  // row inside is itself `position: absolute` and contributes nothing to
  // flow height) — the exact containing-block drift class of bug the house
  // rules warn about, now doubly so with two possible frame bases.
  const columnHeightPct = mmToPctHeight(columnHeightMm, isSpread);

  const columns = digestColumnsForPage(entries, isSpread); // spread: 2 columns of 2; single: ONE column of 2
  const illoWidthPct = (DIGEST_ILLO_WIDTH_MM / columnWidthMm) * 100; // % of the column, so it renders at exactly the shared mm width — basis-independent (nested inside the column's own box)

  return (
    <PageFrame isSpread={isSpread} showGuides={showGuides} className="illustrated-digest-page">
      <div className="illustrated-digest" data-testid="illustrated-digest">
        {columns.map((column, colIndex) => {
          const layout = layoutDigestColumn(
            column.map((entry) => ({ text: entry.text, illustrationAspect: entry.illustration.aspectRatio })),
            columnWidthMm,
          );
          return (
            <div
              key={colIndex}
              className="illustrated-digest__column"
              style={{
                position: 'absolute',
                left: `${isSpread && colIndex === 1 ? rightXPct : leftXPct}%`,
                width: `${colWidthPct}%`,
                top: `${topPct}%`,
                height: `${columnHeightPct}%`,
              }}
            >
              {column.map((entry, entryIndex) => {
                // Single page: one column, so `globalIndex` is just
                // `entryIndex` (0 -> illo-left, 1 -> illo-right) — the SAME
                // formula naturally covers both bases since `colIndex` is
                // always 0 in single-page mode.
                const globalIndex = colIndex * columns[0].length + entryIndex;
                const illoRight = globalIndex % 2 === 1;
                const row = layout.rows[entryIndex];
                // These `top`/`height` percentages resolve against the
                // COLUMN's own actual rendered height (explicitly set above
                // to `columnHeightMm`, not the full frame) — so the basis
                // here must match: percent of `columnHeightMm`, the SAME
                // local mm frame `layoutDigestColumn` computed `row` in.
                return (
                  <div
                    key={entry.memoryId}
                    className={`illustrated-digest__entry${illoRight ? ' illustrated-digest__entry--reverse' : ''}`}
                    style={{
                      position: 'absolute',
                      top: `${(row.topMm / columnHeightMm) * 100}%`,
                      height: `${(row.heightMm / columnHeightMm) * 100}%`,
                      width: '100%',
                    }}
                  >
                    <div
                      className="illustrated-digest__illo"
                      style={{
                        width: `${illoWidthPct}%`,
                        // Fixed square box — cover-crop within the tight eligibility band (see DIGEST_ILLO_WIDTH_MM).
                        aspectRatio: '1',
                        background: colors.surface2,
                      }}
                    >
                      <img src={assetUrl(bookSlug, entry.illustration.file)} alt="" className="illustrated-digest__illo-img" />
                    </div>
                    <div className="illustrated-digest__textcol">
                      <div className="illustrated-digest__date" style={{ fontSize: ptCqw(6.5, isSpread), color: lavender.deep }}>
                        {formatIndexDate(entry.date, language)}
                      </div>
                      <p className="illustrated-digest__text" style={{ fontSize: ptCqw(13, isSpread), color: colors.ink }}>
                        {entry.text}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {isSpread ? (
        <>
          {pageNumbers[0] != null && <Folio pageNumber={pageNumbers[0]} isEvenPage isSpread />}
          {pageNumbers[1] != null && <Folio pageNumber={pageNumbers[1]} isEvenPage={false} isSpread />}
        </>
      ) : (
        pageNumbers[0] != null && <Folio pageNumber={pageNumbers[0]} isEvenPage={page.isEvenPage ?? true} isSpread={false} />
      )}
    </PageFrame>
  );
}
