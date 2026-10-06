import { CARD_STYLE, type FrontDoc } from './document';
import { box } from './CardSheet';
import { cardFontStacks, type CardFontFamilies } from './fonts';
import type { Rect } from './geometry';

/** The front side, from a fitted `FrontDoc` (pure presentational). `fonts` injects the family names (default: the print app's). */
export function CardFront({ doc, fonts }: { doc: FrontDoc; fonts?: CardFontFamilies }) {
  const { serif: SERIF, sans: SANS } = cardFontStacks(fonts);
  const { image, greeting, scrim } = doc;
  const light = greeting.tone === 'light';
  const spacing = `${CARD_STYLE.sublineSpacingEm}em`;
  const rel = (r: Rect, base: Rect): Rect => ({ x: r.x - base.x, y: r.y - base.y, w: r.w, h: r.h });
  const draw = rel(image.draw, image.clip);

  const greetingStyle = {
    height: `${greeting.greetingH}mm`,
    lineHeight: `${greeting.greetingH}mm`,
    fontFamily: SERIF,
    fontStyle: 'italic' as const,
    fontWeight: 400,
    fontSize: `${greeting.fontPt}pt`,
    color: light ? '#ffffff' : CARD_STYLE.accentInk,
  };
  const sublineStyle = {
    fontFamily: SANS,
    fontWeight: 600,
    fontSize: `${greeting.sublinePt}pt`,
    letterSpacing: spacing,
    textTransform: 'uppercase' as const,
    color: light ? 'rgba(255,255,255,0.88)' : CARD_STYLE.accent,
  };

  return (
    <>
      <div className="card-abs" style={{ ...box(image.clip), overflow: 'hidden', borderRadius: `${image.radiusMm}mm` }}>
        <img
          src={image.url}
          alt=""
          decoding="sync"
          style={{ position: 'absolute', left: `${draw.x}mm`, top: `${draw.y}mm`, width: `${draw.w}mm`, height: `${draw.h}mm` }}
          data-card-image="front"
        />
      </div>
      {scrim && (
        <div
          className="card-abs"
          style={{
            left: 0,
            width: '100%',
            height: `${scrim.heightMm}mm`,
            [scrim.edge]: 0,
            background: `linear-gradient(${scrim.edge === 'top' ? 'to bottom' : 'to top'}, rgba(24,20,40,0.36), rgba(24,20,40,0.15) 45%, rgba(24,20,40,0))`,
          }}
        />
      )}
      {greeting.mode === 'stacked' ? (
        <>
          <div className="card-abs card-line" style={{ ...box(greeting.greetingRect), ...greetingStyle }}>
            {greeting.text}
          </div>
          {greeting.sublineRect && (
            <div className="card-abs card-line" style={{ ...box(greeting.sublineRect), lineHeight: `${greeting.sublineRect.h}mm`, ...sublineStyle }}>
              {greeting.subline}
            </div>
          )}
        </>
      ) : (
        <div className="card-abs card-line" style={{ ...box(greeting.rect), display: 'flex', alignItems: 'baseline', gap: `${greeting.gapMm}mm`, whiteSpace: 'pre' }}>
          <span style={greetingStyle}>{greeting.text}</span>
          {greeting.subline.trim() !== '' && <span style={{ ...sublineStyle, lineHeight: 1 }}>{greeting.subline}</span>}
        </div>
      )}
    </>
  );
}
