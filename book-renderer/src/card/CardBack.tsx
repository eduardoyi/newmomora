import { CARD_STYLE, type BackDoc } from './document';
import { box } from './CardSheet';
import { CardQr } from './CardQr';
import { cardFontStacks, type CardFontFamilies } from './fonts';

/** The back side, from a fitted `BackDoc` (pure presentational). `fonts` injects the family names (default: the print app's). */
export function CardBack({ doc, fonts }: { doc: BackDoc; fonts?: CardFontFamilies }) {
  const { serif: SERIF, sans: SANS, script: SCRIPT } = cardFontStacks(fonts);
  const { heading, rule, letter, signature, portraits, qr, caption, divider, blockRule, wordmark } = doc;
  const fit = letter.fit;
  return (
    <>
      <div
        className="card-abs card-line"
        style={{
          ...box(heading.rect),
          lineHeight: `${heading.rect.h}mm`,
          fontFamily: SERIF,
          fontStyle: 'italic',
          fontWeight: 400,
          fontSize: `${heading.fontPt}pt`,
          color: CARD_STYLE.accentInk,
        }}
      >
        {heading.text}
      </div>
      <div className="card-abs" style={{ ...box(rule), background: CARD_STYLE.accent }} />

      <div className="card-abs" style={{ ...box(letter.rect), fontFamily: SERIF, fontWeight: 400, fontSize: `${fit.fontPt}pt`, color: CARD_STYLE.ink }} data-testid="card-letter" data-letter-pt={fit.fontPt}>
        {fit.paragraphs.map((lines, i) => (
          <div key={i} style={{ marginBottom: i < fit.paragraphs.length - 1 ? `${fit.paragraphGapMm}mm` : 0 }}>
            {lines.map((line, j) => (
              <div key={j} className="card-line" style={{ height: `${fit.lineHeightMm}mm`, lineHeight: `${fit.lineHeightMm}mm` }}>
                {line}
              </div>
            ))}
          </div>
        ))}
      </div>

      {signature && (
        <div className="card-abs" style={{ ...box(signature.rect), fontFamily: SCRIPT, fontWeight: 600, fontSize: `${signature.fontPt}pt`, color: CARD_STYLE.accentInk }}>
          {signature.lines.map((line, i) => (
            <div key={i} className="card-line" style={{ height: `${signature.lineHeightMm}mm`, lineHeight: `${signature.lineHeightMm}mm` }}>
              {line}
            </div>
          ))}
        </div>
      )}

      {portraits.map((p, i) => (
        <div
          key={i}
          className="card-abs"
          data-testid="card-portrait"
          style={{ ...box(p.rect), borderRadius: '50%', overflow: 'hidden', boxShadow: `0 0 0 0.35mm ${CARD_STYLE.hairline}` }}
        >
          <img src={p.url} alt="" decoding="sync" style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: '50% 42%' }} data-card-image="portrait" />
        </div>
      ))}

      {divider && <div className="card-abs" style={{ ...box(divider), background: CARD_STYLE.hairline }} />}
      {blockRule && <div className="card-abs" style={{ ...box(blockRule), background: CARD_STYLE.hairline }} />}

      {qr && (
        <div className="card-abs" style={box(qr.rect)}>
          <CardQr value={qr.url} mm={qr.rect.w} />
        </div>
      )}
      {caption && (
        <div className="card-abs" style={{ ...box(caption.rect), textAlign: caption.align, fontFamily: SANS, fontWeight: 500, fontSize: `${caption.fontPt}pt`, color: CARD_STYLE.ink }} data-testid="card-caption">
          {caption.lines.map((line, i) => (
            <div key={i} className="card-line" style={{ height: `${caption.lineHeightMm}mm`, lineHeight: `${caption.lineHeightMm}mm` }}>
              {line}
            </div>
          ))}
        </div>
      )}

      <div
        className="card-abs card-line"
        data-testid="card-wordmark"
        style={{
          ...box(wordmark.rect),
          lineHeight: `${wordmark.rect.h}mm`,
          fontFamily: SERIF,
          fontStyle: 'normal',
          fontWeight: 500,
          fontSize: `${wordmark.fontPt}pt`,
          letterSpacing: `${CARD_STYLE.wordmarkSpacingEm}em`,
          color: CARD_STYLE.inkSoft,
          textAlign: 'right',
        }}
      >
        Momora<span style={{ color: CARD_STYLE.wordmarkDot }}>.</span>
      </div>
    </>
  );
}
