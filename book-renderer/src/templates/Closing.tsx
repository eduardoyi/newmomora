import type { TemplateProps } from './types';
import { PageFrame } from './PageFrame';
import { getFurniture, getLanguage } from './furniture';
import { extractYearOrdinal } from './ordinals';
import { ptCqw, canvasPxToPt } from './mm';
import { colors } from '../theme';
import './Closing.css';

/**
 * Closing (Momora Book Layout System 1a): odd page, no folio, no image —
 * the ONLY Caveat use in the closing section. The headline ("Hasta el año
 * que viene." / "See you next year.") and the dynamic memory-count line are
 * both furniture (see templates/furniture.ts), verbatim from the design
 * canvas for Spanish — the line parametrizes "tu tercer año" from the
 * manifest's own age-year scope where possible, else a neutral variant.
 *
 * Bug fix (owner review round 3 item 16): this used to also print
 * `outline.editorialNote` verbatim — the AI's own INTERNAL planning/
 * reasoning note (never meant for the reader), which leaked onto Mara's
 * printed closing page. The fitter no longer even passes `editorialNote`
 * into this template's params (see fitter.ts `buildClosingPage`); this
 * component has nothing left that could print it. `memoryCount` (not the
 * outline's own page-budget number) is the real count of distinct memories
 * that made it into the finished book document.
 */
export function Closing({ page, manifest, showGuides }: TemplateProps) {
  const memoryCount = Number(page.params.memoryCount ?? 0);
  const furniture = getFurniture(getLanguage(manifest));
  const yearOrdinal = extractYearOrdinal(manifest.scope);

  return (
    <PageFrame isSpread={false} showGuides={showGuides} className="closing-page">
      <div className="closing" data-testid="closing">
        <div className="closing__headline" style={{ fontSize: ptCqw(canvasPxToPt(56), false), color: colors.ink }}>
          {furniture.closing.headline}
        </div>
        {memoryCount > 0 && (
          <p className="closing__count" style={{ fontSize: ptCqw(canvasPxToPt(10.5), false), color: colors.ink3 }}>
            {furniture.closing.memoryCountLine(memoryCount, manifest.scope.label, yearOrdinal)}
          </p>
        )}
      </div>
      <div className="closing__wordmark" style={{ fontSize: ptCqw(canvasPxToPt(16), false) }}>
        Momora<span style={{ color: colors.wordmarkDot }}>.</span>
      </div>
    </PageFrame>
  );
}
