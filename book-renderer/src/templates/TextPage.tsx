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
/** A single entry this short is set as a pull quote instead of a body paragraph. */
const PULL_QUOTE_MAX = 120;
/** Pull-quote size (pt) — Newsreader, tuned for a 210mm page. */
const PULL_QUOTE_PT = 28;
/** Pull-quote measure (mm), centred on the page. */
const PULL_QUOTE_WIDTH_MM = 140;
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
 *   - exactly ONE entry of <= 120 chars -> pull quote: centred, Newsreader
 *     28pt, a lavender opening quote glyph, the date as a small tracked
 *     kicker above;
 *   - anything longer / multi-entry -> today's body typography (4-column
 *     measure, 17pt/1.72, 15pt once a single entry runs past 900 chars).
 */
export function TextPage({ page, manifest, showGuides }: TemplateProps) {
  const textSlots = page.slots.filter((s): s is { id: string; kind: 'text'; content: TextSlotContent } => s.kind === 'text');
  const sectionHeader = (page.params.sectionHeader ?? null) as SectionHeaderParams | null;
  const pageNumber = page.pageNumbers?.[0];
  const isEvenPage = page.isEvenPage ?? true;
  const longest = Math.max(0, ...textSlots.map((s) => s.content.text.length));
  const bodySize = longest > COMPANION_MAX ? 15 : 17;
  const language = getLanguage(manifest);
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
                  {slot.content.date && (
                    <span className="text-page__date" style={{ fontSize: ptCqw(canvasPxToPt(9.5), false), color: colors.numeral }}>
                      {formatLongDate(slot.content.date, language)}
                    </span>
                  )}
                  <span
                    className="text-page__quote-mark"
                    aria-hidden="true"
                    style={{ fontSize: ptCqw(80, false), color: lavender.deep }}
                  >
                    {'\u201C'}
                  </span>
                  <p className="text-page__quote" style={{ fontSize: ptCqw(PULL_QUOTE_PT, false), color: colors.ink }}>
                    {slot.content.text}
                  </p>
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
                      <div className="text-page__rule" style={{ background: colors.borderStrong }} />
                      <span className="text-page__date" style={{ fontSize: ptCqw(canvasPxToPt(9.5), false), color: colors.numeral }}>
                        {formatLongDate(slot.content.date, language)}
                      </span>
                    </>
                  )}
                  <p className="text-page__body" style={{ fontSize: ptCqw(bodySize, false), color: colors.ink }}>
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
