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
  // `furniture:dedicationSalutation`/`furniture:dedicationSignoff` edits
  // (owner-approved follow-up round) — both are otherwise-fixed furniture
  // copy (`getFurniture`'s `dedication.greeting`/`.signature`); an optional
  // params override, same "fall back to the furniture default when absent"
  // shape as every other furniture-namespaced field.
  const greeting = typeof page.params.greeting === 'string' ? page.params.greeting : furniture.dedication.greeting(childName);
  const signature = typeof page.params.signature === 'string' ? page.params.signature : furniture.dedication.signature;
  const pageNumber = page.pageNumbers?.[0];

  return (
    <PageFrame isSpread={false} showGuides={showGuides} className="dedication-page">
      <div className="dedication" style={{ left: `${xPct(60, false)}%`, top: `${yPct(240)}%`, width: `${wPct(520, false)}%` }}>
        <div className="dedication__greeting" style={{ fontSize: ptCqw(canvasPxToPt(46), false), color: colors.ink }}>
          {greeting}
        </div>
        {body && (
          <p className="dedication__body" style={{ fontSize: ptCqw(canvasPxToPt(19), false), color: colors.ink }}>
            {body}
          </p>
        )}
        <div className="dedication__rule" style={{ background: lavender.mid }} />
        <div className="dedication__signature" style={{ fontSize: ptCqw(canvasPxToPt(10.5), false), color: colors.ink3 }}>
          {signature}
        </div>
      </div>
      {pageNumber != null && <Folio pageNumber={pageNumber} isEvenPage={false} isSpread={false} />}
    </PageFrame>
  );
}
