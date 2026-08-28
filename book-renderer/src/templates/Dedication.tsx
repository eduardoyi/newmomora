import type { TemplateProps } from './types';
import { PageFrame } from './PageFrame';
import { Folio } from './common/Folio';
import { xPct, yPct, wPct, ptCqw, canvasPxToPt } from './mm';
import { getFurniture, getLanguage } from './furniture';
import { colors, lavender } from '../theme';
import './Dedication.css';

/**
 * Dedication (Momora Book Layout System 1a "dedicatoria"): the odd page
 * facing the deliberately blank even page (see the `blank` template) — the
 * book breathes before its first image. Text sits at 4-of-6 columns.
 */
export function Dedication({ page, manifest, showGuides }: TemplateProps) {
  const childName = String(page.params.childName ?? '');
  const furniture = getFurniture(getLanguage(manifest));
  // Dedication body copy is AI-written per Stage D (docs/plans/memory-book.md
  // §"Connective text") — `outline.dedication`, when present, replaces the
  // greeting-only placeholder (fitter.ts wires it into `params.body`).
  // Never fabricated here when the outline doesn't have it yet.
  const body = page.params.body as string | undefined;
  const pageNumber = page.pageNumbers?.[0];

  return (
    <PageFrame isSpread={false} showGuides={showGuides} className="dedication-page">
      <div className="dedication" style={{ left: `${xPct(60, false)}%`, top: `${yPct(240)}%`, width: `${wPct(520, false)}%` }}>
        <div className="dedication__greeting" style={{ fontSize: ptCqw(canvasPxToPt(46), false), color: colors.ink }}>
          {furniture.dedication.greeting(childName)}
        </div>
        {body && (
          <p className="dedication__body" style={{ fontSize: ptCqw(canvasPxToPt(19), false), color: colors.ink }}>
            {body}
          </p>
        )}
        <div className="dedication__rule" style={{ background: lavender.mid }} />
        <div className="dedication__signature" style={{ fontSize: ptCqw(canvasPxToPt(10.5), false), color: colors.ink3 }}>
          {furniture.dedication.signature}
        </div>
      </div>
      {pageNumber != null && <Folio pageNumber={pageNumber} isEvenPage={false} isSpread={false} />}
    </PageFrame>
  );
}
