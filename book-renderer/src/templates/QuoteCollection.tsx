import type { TemplateProps } from './types';
import { PageFrame } from './PageFrame';
import { Folio } from './common/Folio';
import { SectionHeader, type SectionHeaderParams } from './common/SectionHeader';
import { formatLongDate } from './common/formatDate';
import { fitQuoteColumns } from './common/quoteFit';
import { getFurniture, getLanguage } from './furniture';
import { assetUrl } from '../model/loader';
import { mmToPctWidth, mmToPctHeight, mmCqw, ptCqw, SECTION_HEADER_RESERVE_MM } from './mm';
import { PHYSICAL } from '../model/types';
import { colors, lavender } from '../theme';
import type { QuoteEntryContent } from '../model/types';
import './QuoteCollection.css';

/** Quote measure (mm) and the extra inset an alternating entry takes from the opposite edge. */
const QUOTE_WIDTH_MM = 148;
/** Title-only head room (a furniture/`quotesTitle` title is one 34pt line, no eyebrow). */
const TITLE_RESERVE_MM = 26;
/** Head room for an ordinary (non-special) section header: 6.5pt eyebrow + one 34pt title line. */
const KICKER_TITLE_RESERVE_MM = 30;
/** Kept clear at the foot of the safe box for the folio. */
const FOLIO_RESERVE_MM = 12;
const QUOTE_LINE_HEIGHT = 1.3;
/** Opening-glyph box + date row + their gaps, mm (fit estimate; see quoteFit.ts). */
const ENTRY_CHROME_MM = 15;
const MIN_GAP_MM = 5;
const MIN_PT = 16;

/**
 * "Things you said" — the text-only quote collection, designed as a feature
 * of the book rather than leftover pages (Phase 2d item 2). One entry per
 * band, bands share the page height equally (no dividers);
 * each band is a large Newsreader quote under a big lavender opening mark,
 * with the date as a small tracked kicker (lavender.ink — the old pale
 * numeral grey read too faint in print) behind a short lavender rule.
 * Entries alternate left / right so the eye zig-zags down the page.
 *
 * Layout: 1–3 entries are ONE page (`page.isSpread === false`); 4–6 are a
 * spread, the left page carrying the title so it takes one fewer entry
 * (4 = 2+2, 5 = 2+3, 6 = 3+3). The title is the book's own section-title
 * style (SectionHeader): a real `sectionHeader` param wins (first collection
 * in a section); otherwise `params.quotesTitle`, else the furniture default
 * ("Cosas que dijiste" / "Things you said"). Quote text is printed verbatim
 * (no trimming, no re-quoting; line breaks preserved). Type size per entry
 * steps down with length and then shrinks as one so the stack always fits
 * (common/quoteFit.ts).
 */
export function QuoteCollection({ page, manifest, bookSlug, showGuides }: TemplateProps) {
  const entries = page.slots
    .filter((s): s is { id: string; kind: 'quote-entry'; content: QuoteEntryContent } => s.kind === 'quote-entry')
    .map((s) => s.content);
  const language = getLanguage(manifest);
  const furniture = getFurniture(language);
  const isSpread = page.isSpread;
  const sectionHeader = (page.params.sectionHeader ?? null) as SectionHeaderParams | null;
  const quotesTitle = typeof page.params.quotesTitle === 'string' && page.params.quotesTitle ? page.params.quotesTitle : furniture.quotes.title;
  const header: SectionHeaderParams = sectionHeader ?? { kicker: null, title: quotesTitle, special: false };
  const headerReserveMm = sectionHeader?.special ? SECTION_HEADER_RESERVE_MM : sectionHeader ? KICKER_TITLE_RESERVE_MM : TITLE_RESERVE_MM;
  const pageNumbers = page.pageNumbers ?? [];

  const bleed = PHYSICAL.bleedMm;
  const trim = PHYSICAL.pageSizeMm;
  const margin = PHYSICAL.safeMarginMm;
  const safeMm = trim - margin * 2;
  const leftXPct = mmToPctWidth(bleed + margin, isSpread);
  const rightXPct = mmToPctWidth(bleed + trim + margin, isSpread);
  const widthPct = mmToPctWidth(safeMm, isSpread);
  const topPct = mmToPctHeight(bleed + margin, isSpread);

  // A spread's left page carries the title, so it holds the smaller half.
  const columns: QuoteEntryContent[][] = isSpread ? [entries.slice(0, Math.floor(entries.length / 2)), entries.slice(Math.floor(entries.length / 2))] : [entries];
  const stageHeights = columns.map((_, i) => safeMm - (i === 0 ? headerReserveMm : 0) - FOLIO_RESERVE_MM);
  // One common shrink across the spread keeps both pages' type matched; the
  // tighter (title) column drives it.
  const sizes = fitQuoteColumns(
    columns.map((c) => ({ texts: c.map((e) => e.text) })),
    { widthMm: QUOTE_WIDTH_MM, heightMm: Math.min(...stageHeights), lineHeight: QUOTE_LINE_HEIGHT, chromeMm: ENTRY_CHROME_MM, minGapMm: MIN_GAP_MM, minPt: MIN_PT },
  );

  return (
    <PageFrame isSpread={isSpread} showGuides={showGuides} className="quote-collection-page">
      <div className="quote-collection" data-testid="quote-collection">
        {columns.map((column, colIndex) => (
          <div
            key={colIndex}
            className="quote-collection__column"
            style={{
              position: 'absolute',
              left: `${colIndex === 0 ? leftXPct : rightXPct}%`,
              width: `${widthPct}%`,
              top: `${topPct}%`,
              height: `${mmToPctHeight(safeMm, isSpread)}%`,
            }}
          >
            {colIndex === 0 && <SectionHeader {...header} isSpread={isSpread} />}
            <div
              className="quote-collection__stage"
              style={{ paddingTop: colIndex === 0 ? mmCqw(headerReserveMm, isSpread) : 0, paddingBottom: mmCqw(FOLIO_RESERVE_MM, isSpread) }}
            >
              {column.map((entry, i) => (
                <div key={entry.memoryId} className="quote-collection__band">
                  <div
                    className="quote-collection__entry"
                    data-align={i % 2 === 0 ? 'start' : 'end'}
                    style={{ width: mmCqw(QUOTE_WIDTH_MM, isSpread) }}
                  >
                    <span
                      className="quote-collection__mark"
                      aria-hidden="true"
                      style={{ fontSize: ptCqw(sizes[colIndex][i] * 2.2, isSpread), color: lavender.deep }}
                    >
                      {'“'}
                    </span>
                    <p
                      className="quote-collection__text"
                      style={{ fontSize: ptCqw(sizes[colIndex][i], isSpread), color: colors.ink, lineHeight: QUOTE_LINE_HEIGHT }}
                    >
                      {entry.text}
                    </p>
                    <div className="quote-collection__meta">
                      <span className="quote-collection__rule" style={{ background: lavender.deep }} />
                      <span className="quote-collection__date" style={{ fontSize: ptCqw(7, isSpread), color: lavender.ink }}>
                        {formatLongDate(entry.date, language)}
                      </span>
                    </div>
                    {entry.illustration && (
                      <div
                        className="quote-collection__illo"
                        style={{ aspectRatio: `${entry.illustration.aspectRatio}`, background: colors.surface2 }}
                      >
                        <img src={assetUrl(bookSlug, entry.illustration.file)} alt="" className="quote-collection__illo-img" />
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
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
