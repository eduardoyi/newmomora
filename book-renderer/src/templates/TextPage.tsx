import type { TemplateProps } from './types';
import { PageFrame } from './PageFrame';
import { Folio } from './common/Folio';
import { SafeArea } from './common/SafeArea';
import { SectionHeader, type SectionHeaderParams } from './common/SectionHeader';
import { formatLongDate } from './common/formatDate';
import { getLanguage } from './furniture';
import { mmCqw, ptCqw, canvasPxToPt, SECTION_HEADER_RESERVE_MM } from './mm';
import { colors, lavender } from '../theme';
import type { TextSlotContent } from '../model/types';
import './TextPage.css';

const COMPANION_MAX = 900;
/** A lone entry at least this long (and not a pull quote) opens with a drop cap. */
const DROP_CAP_MIN = 200;
/** A single entry this short is set as a pull quote instead of a body paragraph. */
const PULL_QUOTE_MAX = 120;
/** Pull-quote size (pt) by length — Newsreader, the big editorial size for a short line, stepping down for longer ones. */
function pullQuotePt(length: number): number {
  if (length <= 40) return 46;
  if (length <= 70) return 40;
  if (length <= 95) return 36;
  return 32;
}
/** Pull-quote opening-mark size (pt) — a large lavender glyph, the same one the quote-collection uses. */
const PULL_QUOTE_MARK_PT = 120;
/** Pull-quote measure (mm), centred on the page. */
const PULL_QUOTE_WIDTH_MM = 150;
/** Body measure (mm) and left indent (mm from the safe edge) — unchanged from the original canvas placement (130mm column starting 25mm inside trim). */
const BODY_WIDTH_MM = 130;
const BODY_INDENT_MM = 15;
/** Space kept clear at the foot of the safe box for the folio. */
const FOLIO_RESERVE_MM = 12;

/**
 * Long-entry / text-forward page (Momora Book Layout System 1b §3 "Relato").
 * Text is always printed verbatim and in full — never trimmed, never
 * summarized. Two compositions, both vertically centred in the free area
 * (below the section header, above the folio) instead of pinned high:
 *   - exactly ONE entry of <= 120 chars -> pull quote (Phase 2d): centred,
 *     Newsreader 32-46pt by length, a large lavender opening quote glyph, a
 *     short lavender rule and the date as a small tracked kicker below — the
 *     same language as the "things you said" quote-collection (so they read
 *     as one family);
 *   - anything longer / multi-entry -> today's body typography (4-column
 *     measure, 17pt/1.72, 15pt once a single entry runs past 900 chars);
 *     a lone entry of 200+ chars opens with a lavender drop cap and every
 *     entry's date is a darker lavender kicker (the old pale numeral grey
 *     read too faint in print).
 */
export function TextPage({ page, manifest, showGuides }: TemplateProps) {
  const textSlots = page.slots.filter((s): s is { id: string; kind: 'text'; content: TextSlotContent } => s.kind === 'text');
  const sectionHeader = (page.params.sectionHeader ?? null) as SectionHeaderParams | null;
  const pageNumber = page.pageNumbers?.[0];
  const isEvenPage = page.isEvenPage ?? true;
  const longest = Math.max(0, ...textSlots.map((s) => s.content.text.length));
  const bodySize = longest > COMPANION_MAX ? 15 : 17;
  const language = getLanguage(manifest);
  // A lone long story opens with a lavender drop cap — only when it starts on
  // a letter (a leading dash/quote/emoji must never be swallowed into one).
  const dropCap = textSlots.length === 1 && longest >= DROP_CAP_MIN && /^\p{L}/u.test(textSlots[0].content.text);
  const isPullQuote = textSlots.length === 1 && longest > 0 && longest <= PULL_QUOTE_MAX;

  return (
    <PageFrame isSpread={false} showGuides={showGuides} className="text-page">
      <SafeArea isSpread={false}>
        {sectionHeader && (
          // Inside the safe zone like every other header-capable template —
          // SectionHeader is absolute top:0/left:0, so bare in the frame it sat
          // at the bleed origin and the trim cut its eyebrow line off.
          <SectionHeader {...sectionHeader} isSpread={false} />
        )}
        <div
          className="text-page__stage"
          style={{
            paddingTop: sectionHeader ? mmCqw(SECTION_HEADER_RESERVE_MM, false) : 0,
            paddingBottom: mmCqw(FOLIO_RESERVE_MM, false),
          }}
        >
          {isPullQuote ? (
            <div
              className="text-page__inner text-page__inner--quote"
              data-testid="text-page"
              style={{ width: mmCqw(PULL_QUOTE_WIDTH_MM, false) }}
            >
              {textSlots.map((slot) => (
                <div key={slot.id} className="text-page__entry text-page__entry--quote">
                  <span
                    className="text-page__quote-mark"
                    aria-hidden="true"
                    style={{ fontSize: ptCqw(PULL_QUOTE_MARK_PT, false), color: lavender.deep }}
                  >
                    {'\u201C'}
                  </span>
                  <p className="text-page__quote" style={{ fontSize: ptCqw(pullQuotePt(slot.content.text.length), false), color: colors.ink }}>
                    {slot.content.text}
                  </p>
                  {slot.content.date && (
                    <div className="text-page__quote-meta">
                      <span className="text-page__quote-rule" style={{ background: lavender.deep }} />
                      <span className="text-page__date" style={{ fontSize: ptCqw(7.5, false), color: lavender.ink }}>
                        {formatLongDate(slot.content.date, language)}
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div
              className="text-page__inner"
              data-testid="text-page"
              style={{ width: mmCqw(BODY_WIDTH_MM, false), marginLeft: mmCqw(BODY_INDENT_MM, false) }}
            >
              {textSlots.map((slot) => (
                <div key={slot.id} className="text-page__entry">
                  {slot.content.date && (
                    <>
                      <div className="text-page__rule" style={{ background: lavender.deep }} />
                      <span className="text-page__date" style={{ fontSize: ptCqw(canvasPxToPt(9.5), false), color: lavender.ink }}>
                        {formatLongDate(slot.content.date, language)}
                      </span>
                    </>
                  )}
                  <p
                    className={`text-page__body${dropCap ? ' text-page__body--dropcap' : ''}`}
                    style={{ fontSize: ptCqw(bodySize, false), color: colors.ink }}
                  >
                    {slot.content.text}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </SafeArea>
      {pageNumber != null && <Folio pageNumber={pageNumber} isEvenPage={isEvenPage} isSpread={false} />}
    </PageFrame>
  );
}
