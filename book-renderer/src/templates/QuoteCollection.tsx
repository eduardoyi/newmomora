import type { TemplateProps } from './types';
import { PageFrame } from './PageFrame';
import { Folio } from './common/Folio';
import { SectionHeader, type SectionHeaderParams } from './common/SectionHeader';
import { formatIndexDate } from './common/formatDate';
import { getLanguage } from './furniture';
import { assetUrl } from '../model/loader';
import { mmToPctWidth, mmToPctHeight, ptCqw } from './mm';
import { PHYSICAL } from '../model/types';
import { colors, lavender } from '../theme';
import type { QuoteEntryContent } from '../model/types';
import './QuoteCollection.css';

/**
 * Quote-collection spread (acceptance-review follow-up, item 1 — canvas §5
 * decision table, "Solo texto" row: "Tres o más entradas cortas del mismo
 * tema se agrupan en una doble página de citas"). The canvas has no
 * explicit mockup for this composition, so it's composed here from the
 * type-role language used elsewhere in the system, flagged as design
 * choices the owner may retune:
 *   - each entry's date reads in the antetítulo role (small, uppercase,
 *     tracked-out, lavender) — the same treatment a month-opener kicker or
 *     a spread-title antetítulo gets elsewhere, repurposed as a per-entry
 *     marker rather than a section-wide label;
 *   - the quote text itself sits at the illustrated-story body size
 *     (Newsreader, ~19pt) — this is already the book's "read like a
 *     storybook page" voice, which fits a short first-person/quoted line
 *     better than the smaller footer-caption size;
 *   - entries flow in two baseline-aligned columns (one per page of the
 *     spread), generously spaced, so 3-6 short lines never look cramped
 *     into a dense list — the opposite of the "monotonous one-entry-per-
 *     page" problem this composition exists to fix;
 *   - at most one entry may carry a small accompanying illustration (the
 *     fitter's own cap — see `buildQuoteCollectionSlots`), sized modestly
 *     so it never dominates the page the way a real illustrated-story does.
 */
export function QuoteCollection({ page, manifest, bookSlug, showGuides }: TemplateProps) {
  const entries = page.slots
    .filter((s): s is { id: string; kind: 'quote-entry'; content: QuoteEntryContent } => s.kind === 'quote-entry')
    .map((s) => s.content);
  const language = getLanguage(manifest);
  const sectionHeader = (page.params.sectionHeader ?? null) as SectionHeaderParams | null;
  const pageNumbers = page.pageNumbers ?? [];

  const bleed = PHYSICAL.bleedMm;
  const trim = PHYSICAL.pageSizeMm;
  const margin = PHYSICAL.safeMarginMm;
  const leftXPct = mmToPctWidth(bleed + margin, true);
  const leftWidthPct = mmToPctWidth(trim - margin * 2, true);
  const rightXPct = mmToPctWidth(bleed + trim + margin, true);
  const rightWidthPct = leftWidthPct;
  const topPct = mmToPctHeight(bleed + margin + (sectionHeader ? 34 : 0), true);
  const bottomPct = mmToPctHeight(bleed + margin, true);

  const half = Math.ceil(entries.length / 2);
  const columns = [entries.slice(0, half), entries.slice(half)];

  return (
    <PageFrame isSpread showGuides={showGuides} className="quote-collection-page">
      {sectionHeader && (
        <div style={{ position: 'absolute', left: `${leftXPct}%`, top: `${mmToPctHeight(bleed + margin, true)}%`, width: `${leftWidthPct}%` }}>
          <SectionHeader {...sectionHeader} isSpread />
        </div>
      )}
      <div className="quote-collection" data-testid="quote-collection">
        {columns.map((column, colIndex) => (
          <div
            key={colIndex}
            className="quote-collection__column"
            style={{
              position: 'absolute',
              left: `${colIndex === 0 ? leftXPct : rightXPct}%`,
              width: `${colIndex === 0 ? leftWidthPct : rightWidthPct}%`,
              top: `${topPct}%`,
              bottom: `${bottomPct}%`,
            }}
          >
            {column.map((entry) => (
              <div key={entry.memoryId} className="quote-collection__entry">
                <div
                  className="quote-collection__date"
                  style={{ fontSize: ptCqw(6.5, true), color: lavender.deep }}
                >
                  {formatIndexDate(entry.date, language)}
                </div>
                <p className="quote-collection__text" style={{ fontSize: ptCqw(19, true), color: colors.ink }}>
                  {entry.text}
                </p>
                {entry.illustration && (
                  <div
                    className="quote-collection__illo"
                    style={{ aspectRatio: `${entry.illustration.aspectRatio}`, background: colors.surface2 }}
                  >
                    <img src={assetUrl(bookSlug, entry.illustration.file)} alt="" className="quote-collection__illo-img" />
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
      {pageNumbers[0] != null && <Folio pageNumber={pageNumbers[0]} isEvenPage isSpread />}
      {pageNumbers[1] != null && <Folio pageNumber={pageNumbers[1]} isEvenPage={false} isSpread />}
    </PageFrame>
  );
}
