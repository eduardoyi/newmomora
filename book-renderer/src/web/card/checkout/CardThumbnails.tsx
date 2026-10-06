import { useEffect, useMemo, useRef } from 'react';
import { CardBack } from '../../../card/CardBack';
import { CardFront } from '../../../card/CardFront';
import { CardSheet } from '../../../card/CardSheet';
import { buildCardDocument } from '../../../card/document';
import type { CardEdits } from '../../../card/edits';
import { cardInputFromData } from '../../../card/fromData';
import { createCanvasMeasure } from '../../../card/measure';
import { SHOP_CARD_FONTS } from '../cardFonts';
import type { HolidayCardView } from '../cardTypes';
import { useElementWidth } from '../useCardHooks';
import { buildThumbnailInput } from './thumbnailInput';

const MM_PX = 96 / 25.4;
const GAP_PX = 12;

/**
 * The front and back of the card exactly as it will print, from the edits the
 * buyer confirmed (pinned at one version), drawn with the SAME card components
 * and font aliases the editor uses. Read-only; small on purpose (a last visual
 * check next to the price, not a proofreading surface).
 */
export function CardThumbnails({
  view,
  edits,
  fontsReady,
  onImageError,
}: {
  view: HolidayCardView;
  edits: CardEdits;
  fontsReady: boolean;
  /** An image failed to load (an expired signed URL): ask for fresh ones. */
  onImageError: () => void;
}) {
  const [gridRef, gridWidth] = useElementWidth<HTMLDivElement>();
  const input = useMemo(() => buildThumbnailInput(view, edits), [view, edits]);
  const measure = useMemo(() => (fontsReady ? createCanvasMeasure(SHOP_CARD_FONTS) : null), [fontsReady]);
  const result = useMemo(() => {
    if (!input || !measure) return null;
    try {
      return { doc: buildCardDocument(cardInputFromData(input.cardData, input.edits, input.assetUrl), measure), error: null as string | null };
    } catch (e) {
      return { doc: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [input, measure]);

  // A picture failed to load (expired signed URL): refetch for fresh ones.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const on = (e: Event) => {
      if (e.target instanceof HTMLImageElement) onImageError();
    };
    el.addEventListener('error', on, true);
    return () => el.removeEventListener('error', on, true);
  }, [onImageError]);

  const doc = result?.doc ?? null;
  const colW = Math.max(120, (gridWidth - GAP_PX) / 2);
  const zoom = doc ? colW / doc.geometry.pageW : 1;

  return (
    <div className="cc-thumbs" ref={wrapRef}>
      <div className="cc-thumbs__grid" ref={gridRef}>
        {doc ? (
          (['front', 'back'] as const).map((side) => (
            <figure key={side} className="cc-thumb">
              <div
                className="cc-thumb__frame"
                style={{ width: doc.geometry.pageW * zoom, height: doc.geometry.pageH * zoom }}
                data-testid={`thumb-${side}`}
              >
                <div
                  style={{
                    transform: `scale(${zoom / MM_PX})`,
                    transformOrigin: 'top left',
                    width: doc.geometry.pageW * MM_PX,
                    height: doc.geometry.pageH * MM_PX,
                  }}
                >
                  <CardSheet geometry={doc.geometry} background={side === 'front' ? doc.front.paper : doc.back.paper}>
                    {side === 'front' ? <CardFront doc={doc.front} fonts={SHOP_CARD_FONTS} /> : <CardBack doc={doc.back} fonts={SHOP_CARD_FONTS} />}
                  </CardSheet>
                </div>
              </div>
              <figcaption className="cc-thumb__caption">{side === 'front' ? 'Front' : 'Back'}</figcaption>
            </figure>
          ))
        ) : (
          <p className="cc-thumbs__note">{result?.error ? 'We could not draw a preview of your card here, but it will print as you saw it in the editor.' : fontsReady ? 'Preparing your preview…' : 'Loading fonts…'}</p>
        )}
      </div>
    </div>
  );
}
