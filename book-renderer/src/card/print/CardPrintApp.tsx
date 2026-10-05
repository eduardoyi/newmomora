import { useEffect, useState } from 'react';
import { CardBack } from '../CardBack';
import { CardFront } from '../CardFront';
import { CardSheet } from '../CardSheet';
import { buildCardDocument, cardStats, type CardDocument } from '../document';
import { emptyEdits, normalizeEdits, setChoices, setFrontImage } from '../edits';
import { cardInputFromData } from '../fromData';
import { createCanvasMeasure, ensureCardFonts } from '../measure';
import { parseCardData, type CardGreetingKey, type CardOrientation, type GreetingPosition } from '../types';

/**
 * The card print entry (docs/plans/holiday-cards.md C3), driven by
 * scripts/lib/renderCardPdf.ts through Puppeteer. Renders the front and back as
 * two stacked full-size sheets (page 1 = front, page 2 = back; exact page size
 * WITH the 4 mm bleed) from the same components the preview shows.
 *
 * Query params: slug, front=full-bleed|bordered|illustrated:<id>, tone, greeting,
 * qr=0|1, orientation=landscape|portrait, position, portraits=0|1,
 * side=both|front|back, allowOverflow=1, edits=0 (ignore edits.json). The saved
 * editor state (edits.json) applies unless an explicit param overrides it.
 *
 * Readiness contract (same as print.html): `[data-print-ready="true"]` once the
 * fonts are loaded and the document is fitted; `[data-print-error]` for any hard
 * failure (missing data, letter that does not fit its readable minimum, text
 * closer to the trim than the safe margin). Fit numbers are exposed as
 * `window.__CARD_STATS__` (counts and millimetres only, never text).
 */

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; doc: CardDocument; side: 'both' | 'front' | 'back' };

declare global {
  interface Window {
    __CARD_STATS__?: ReturnType<typeof cardStats>;
  }
}

export function CardPrintApp() {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const q = new URLSearchParams(window.location.search);
    const slug = q.get('slug');
    (async () => {
      if (!slug) throw new Error('missing required query param: slug');
      const res = await fetch(`/${slug}/card.json`);
      if (!res.ok) throw new Error(`card.json fetch failed: ${res.status}`);
      const data = parseCardData(await res.json());
      await ensureCardFonts();

      // The saved editor state (card-data/<slug>/edits.json), unless edits=0; explicit params win.
      let edits = emptyEdits();
      if (q.get('edits') !== '0') {
        const er = await fetch(`/${slug}/edits.json`);
        if (er.ok) edits = normalizeEdits(await er.json());
      }
      const front = q.get('front');
      if (front?.startsWith('illustrated:')) edits = setFrontImage(edits, `illustration-${front.slice(12)}`);
      else if (front === 'full-bleed' || front === 'bordered') {
        edits = setChoices(edits, { layout: front });
        // An explicit photo layout means a photo front, even if the editor had picked an illustration.
        if (edits.frontImage?.startsWith('illustration-')) edits = setFrontImage(edits, null);
      } else if (front) throw new Error(`unknown front layout: ${front}`);
      const tone = q.get('tone');
      if (tone) edits = setChoices(edits, { tone });
      const greeting = q.get('greeting') as CardGreetingKey | null;
      if (greeting) edits = setChoices(edits, { greeting });
      if (q.get('qr') !== null) edits = setChoices(edits, { qr: q.get('qr') === '1' });
      const orientation = q.get('orientation') as CardOrientation | null;
      if (orientation) edits = setChoices(edits, { orientation });
      const position = q.get('position') as GreetingPosition | null;
      if (position) edits = setChoices(edits, { greetingPosition: position });
      if (q.get('portraits') !== null) edits = setChoices(edits, { portraits: q.get('portraits') === '1' });
      const doc = buildCardDocument(cardInputFromData(data, edits, (file) => `/${slug}/${file}`), createCanvasMeasure());

      // Hard failures: never print a letter below the readable minimum or text inside the safe margin.
      if (!doc.back.letter.fit.fits && q.get('allowOverflow') !== '1') {
        throw new Error(`letter does not fit at its ${doc.back.letter.fit.fontPt} pt readable minimum`);
      }
      if (doc.safeViolations.length > 0) {
        throw new Error(`too close to the trim: ${doc.safeViolations.map((v) => `${v.name} ${v.minDistanceMm} mm`).join(', ')}`);
      }
      window.__CARD_STATS__ = cardStats(doc);
      const side = (q.get('side') as 'both' | 'front' | 'back' | null) ?? 'both';
      if (!cancelled) setState({ status: 'ready', doc, side });
    })().catch((e: unknown) => {
      if (!cancelled) setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // @page + html/body box once the exact size is known.
  useEffect(() => {
    if (state.status !== 'ready') return;
    const { pageW, pageH } = state.doc.geometry;
    const style = document.createElement('style');
    style.textContent = `
      @page { size: ${pageW}mm ${pageH}mm; margin: 0; }
      html, body { margin: 0; padding: 0; width: ${pageW}mm; background: #fff; }
      .card-print-page { width: ${pageW}mm; height: ${pageH}mm; overflow: hidden; break-inside: avoid; }
      .card-print-page + .card-print-page { break-before: page; }
    `;
    document.head.appendChild(style);
    return () => {
      document.head.removeChild(style);
    };
  }, [state]);

  if (state.status === 'error') return <div data-print-error={state.message}>{state.message}</div>;
  if (state.status === 'loading') return <div data-print-loading="true" />;

  const { doc, side } = state;
  return (
    <div data-print-ready="true" data-print-orientation={doc.geometry.orientation}>
      {side !== 'back' && (
        <div className="card-print-page">
          <CardSheet geometry={doc.geometry} background={doc.front.paper} testId="sheet-front">
            <CardFront doc={doc.front} />
          </CardSheet>
        </div>
      )}
      {side !== 'front' && (
        <div className="card-print-page">
          <CardSheet geometry={doc.geometry} background={doc.back.paper} testId="sheet-back">
            <CardBack doc={doc.back} />
          </CardSheet>
        </div>
      )}
    </div>
  );
}
