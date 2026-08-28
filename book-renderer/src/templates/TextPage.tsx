import type { TemplateProps } from './types';
import { PageFrame } from './PageFrame';
import { Folio } from './common/Folio';
import { SectionHeader, type SectionHeaderParams } from './common/SectionHeader';
import { formatLongDate } from './common/formatDate';
import { getLanguage } from './furniture';
import { xPct, yPct, wPct, ptCqw, canvasPxToPt } from './mm';
import { colors } from '../theme';
import type { TextSlotContent } from '../model/types';
import './TextPage.css';

const COMPANION_MAX = 900;

/**
 * Long-entry / text-forward page (Momora Book Layout System 1b §3 "Relato").
 * 4-column measure (110mm ~= 62 characters), 17pt/1.72 for the common case;
 * drops to 15pt only once a single entry runs past 900 characters. Text is
 * always printed verbatim and in full — never trimmed, never summarized.
 */
export function TextPage({ page, manifest, showGuides }: TemplateProps) {
  const textSlots = page.slots.filter((s): s is { id: string; kind: 'text'; content: TextSlotContent } => s.kind === 'text');
  const sectionHeader = (page.params.sectionHeader ?? null) as SectionHeaderParams | null;
  const pageNumber = page.pageNumbers?.[0];
  const isEvenPage = page.isEvenPage ?? true;
  const longest = Math.max(0, ...textSlots.map((s) => s.content.text.length));
  const bodySize = longest > COMPANION_MAX ? 15 : 17;
  const language = getLanguage(manifest);

  return (
    <PageFrame isSpread={false} showGuides={showGuides} className="text-page">
      {sectionHeader && <SectionHeader {...sectionHeader} isSpread={false} />}
      <div
        className="text-page__inner"
        data-testid="text-page"
        style={{
          position: 'absolute',
          left: `${xPct(100, false)}%`,
          top: `${sectionHeader ? yPct(430) : yPct(180)}%`,
          width: `${wPct(520, false)}%`,
        }}
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
      {pageNumber != null && <Folio pageNumber={pageNumber} isEvenPage={isEvenPage} isSpread={false} />}
    </PageFrame>
  );
}
