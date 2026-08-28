import type { TemplateProps } from './types';
import { PageFrame } from './PageFrame';
import { Folio } from './common/Folio';
import { formatLongDate } from './common/formatDate';
import { getFurniture, getLanguage } from './furniture';
import { xPct, yPct, wPct, ptCqw, canvasPxToPt } from './mm';
import { colors, lavender } from '../theme';
import './SpreadTitle.css';

/**
 * Themed-spread opener (Momora Book Layout System 1b §3 "Títulos y
 * aperturas"). A SINGLE even page — column 1, optical axis 74mm from the
 * top — the facing odd page already starts the spread's first content page
 * (built separately by the fitter). Quote voice: Caveat 74pt between
 * Latin quotes + Newsreader-italic attribution with date and moment count.
 * Descriptive voice: Newsreader 57pt, no quotes, WITH an antetítulo kicker
 * (never invented — omitted until the outline supplies `kicker`).
 */
export function SpreadTitle({ page, manifest, showGuides }: TemplateProps) {
  const title = String(page.params.title ?? '');
  const subtitle = page.params.subtitle as string | null;
  const kicker = page.params.kicker as string | null;
  const titleMode = page.params.titleMode as 'quote' | 'descriptive';
  const sourceId = page.params.titleSourceMemoryId as string | null;
  const sourceMemory = sourceId ? manifest.memories[sourceId] : null;
  const momentCount = Number(page.params.momentCount ?? 0);
  const pageNumber = page.pageNumbers?.[0];
  const lang = getLanguage(manifest);
  const furniture = getFurniture(lang);

  // Long titles step down a size rather than ever abbreviating (Momora
  // Book Layout System: ">28 chars -> one step down, >60 -> two steps").
  const steps = title.length > 60 ? 2 : title.length > 28 ? 1 : 0;
  const quoteSize = [74, 62, 50][steps];
  const descriptiveSize = [57, 44, 36][steps];

  return (
    <PageFrame isSpread={false} showGuides={showGuides} className="spread-title-page">
      <div className="spread-title" data-testid="spread-title" style={{ position: 'absolute', left: `${xPct(60, false)}%`, top: `${yPct(296)}%`, width: `${wPct(660, false)}%` }}>
        {/* The antetítulo kicker precedes the title in BOTH voices in the
            design canvas's real examples (1a "Ay Dios mío" / "Papi, con
            amor, por favor" both carry one) — never invented when absent. */}
        {kicker && (
          <div className="spread-title__kicker" style={{ fontSize: ptCqw(6.5, false), color: lavender.deep }}>
            {kicker}
          </div>
        )}
        {titleMode === 'quote' ? (
          <>
            <p className="spread-title__quote" style={{ fontSize: ptCqw(quoteSize, false), color: colors.ink }}>
              &laquo;{title}&raquo;
            </p>
            <div className="spread-title__rule" style={{ background: lavender.mid }} />
            {sourceMemory && (
              <p className="spread-title__attribution" style={{ fontSize: ptCqw(canvasPxToPt(17), false), color: colors.ink2 }}>
                {furniture.spreadTitleAttribution(manifest.child.name, formatLongDate(sourceMemory.date, lang), momentCount)}
              </p>
            )}
          </>
        ) : (
          <>
            <h1 className="spread-title__descriptive" style={{ fontSize: ptCqw(descriptiveSize, false), color: colors.ink }}>
              {title}
            </h1>
            <div className="spread-title__rule" style={{ background: lavender.mid }} />
          </>
        )}
        {subtitle && (
          <p className="spread-title__subtitle" style={{ fontSize: ptCqw(canvasPxToPt(10.5), false), color: colors.ink3 }}>
            {subtitle}
          </p>
        )}
      </div>
      {pageNumber != null && <Folio pageNumber={pageNumber} isEvenPage isSpread={false} />}
    </PageFrame>
  );
}
