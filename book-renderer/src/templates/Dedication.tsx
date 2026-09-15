import type { TemplateProps } from './types';
import { PageFrame } from './PageFrame';
import { Folio } from './common/Folio';
import { QrCode } from './common/QrCode';
import { xPct, yPct, wPct, ptCqw, canvasPxToPt, getSafeInsetPct, DEDICATION_SAMPLE_MARK_SIZE_MM } from './mm';
import { getFurniture, getLanguage } from './furniture';
import { colors, lavender } from '../theme';
import './Dedication.css';

/** Stable, decorative sample-mark target (print-polish round, item D1) — never a real share link; the dedication footnote exists to teach the GESTURE, not to scan to anything in particular. */
const SAMPLE_SCAN_URL = 'https://usemomora.com';

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
  // Print-polish round (owner decision 2026-09-14, item D1): only rendered
  // when the fitted document actually has at least one scan mark to explain
  // (`fitter.ts`'s `documentHasScanMarks`, computed AFTER page-cap demotion
  // so it can never claim a mark that didn't survive fitting) — a book with
  // no video/audio memories keeps a pristine dedication page.
  const hasScanMarks = Boolean(page.params.hasScanMarks);
  const scanInstruction =
    typeof page.params.scanInstruction === 'string' ? page.params.scanInstruction : furniture.dedication.scanInstruction;
  const safeInset = getSafeInsetPct(false);

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
      {hasScanMarks && (
        <div
          className="dedication__scan-instruction"
          style={{ right: `${safeInset.x}%`, bottom: `${safeInset.y}%` }}
        >
          <QrCode value={SAMPLE_SCAN_URL} mm={DEDICATION_SAMPLE_MARK_SIZE_MM} isSpread={false} badge="play" />
          <p
            className="dedication__scan-instruction-text"
            style={{ fontSize: ptCqw(canvasPxToPt(10.2), false), color: colors.ink2 }}
          >
            {scanInstruction}
          </p>
        </div>
      )}
      {pageNumber != null && <Folio pageNumber={pageNumber} isEvenPage={false} isSpread={false} />}
    </PageFrame>
  );
}
