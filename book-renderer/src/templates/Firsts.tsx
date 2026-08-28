import type { TemplateProps } from './types';
import { PageFrame } from './PageFrame';
import { SafeArea } from './common/SafeArea';
import { Folio } from './common/Folio';
import { formatIndexDate } from './common/formatDate';
import { getFurniture, getLanguage } from './furniture';
import { getMilestoneName } from './milestones';
import { ptCqw, canvasPxToPt } from './mm';
import { colors, lavender } from '../theme';
import type { FirstsEntryContent } from '../model/types';
import './Firsts.css';

/**
 * "Primeras veces" (Momora Book Layout System 1b): a RULED LIST, never a
 * medal grid. The milestone name comes from the translated catalog (see
 * templates/milestones.ts) — a system fact, not the parent's own words, and
 * always in the book's own journal language (never mixed) — when the
 * memory has its own text, it prints in full beneath the milestone name.
 * Quiet pride, not a scoreboard. Never shrinks type to fit: a list longer
 * than ~6 rows continues quietly on a facing page instead (`continuation`).
 */
export function Firsts({ page, manifest, showGuides }: TemplateProps) {
  const entries = page.slots.filter(
    (s): s is { id: string; kind: 'firsts-entry'; content: FirstsEntryContent } => s.kind === 'firsts-entry',
  );
  const title = String(page.params.title ?? '');
  const continuation = Boolean(page.params.continuation);
  const pageNumber = page.pageNumbers?.[0];
  const isEvenPage = page.isEvenPage ?? true;
  const lang = getLanguage(manifest);
  const furniture = getFurniture(lang);

  return (
    <PageFrame isSpread={false} showGuides={showGuides} className="firsts-page">
      <SafeArea isSpread={false}>
        <div className="firsts" data-testid="firsts">
          {!continuation && (
            <>
              <div className="firsts__kicker" style={{ fontSize: ptCqw(6.5, false), color: lavender.deep }}>
                {furniture.firsts.kicker}
              </div>
              <h2 className="firsts__title" style={{ fontSize: ptCqw(canvasPxToPt(50), false), color: colors.ink }}>
                {title}
              </h2>
            </>
          )}
          <div className="firsts__list">
            {entries.map((entry) => (
              <div key={entry.id} className="firsts__row">
                <div className="firsts__date" style={{ fontSize: ptCqw(canvasPxToPt(9.5), false), color: colors.numeral }}>
                  {formatIndexDate(entry.content.date, lang)}
                </div>
                <div className="firsts__body">
                  <div className="firsts__milestone" style={{ fontSize: ptCqw(17, false), color: colors.ink }}>
                    {getMilestoneName(entry.content.milestoneId, entry.content.detail, lang, entry.content.rawName)}
                  </div>
                  {entry.content.parentText && (
                    <p className="firsts__text" style={{ fontSize: ptCqw(13.5, false), color: colors.ink2 }}>
                      {entry.content.parentText}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </SafeArea>
      {pageNumber != null && <Folio pageNumber={pageNumber} isEvenPage={isEvenPage} isSpread={false} />}
    </PageFrame>
  );
}
