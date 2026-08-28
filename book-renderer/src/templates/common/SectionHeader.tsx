import { ptCqw } from '../mm';
import { colors, lavender } from '../../theme';

/**
 * "Apertura de mes" header (Momora Book Layout System 1b §3): antetítulo
 * kicker (PJS 700 small-caps 6.5pt, +16% tracking) + a Newsreader title,
 * living at the top of the safe box on a backbone (month) segment's first
 * content page — the title does NOT get its own dedicated spread the way a
 * themed spread-title does; it lives inline, on the page, above the first
 * photos. Special (birth-month) titles print at 44pt; ordinary month
 * titles at 34pt. Never Caveat — that voice is reserved for the parent/
 * child's own words.
 */
export interface SectionHeaderParams {
  /** Date-range antetítulo, e.g. "October–November 2024". Absent when the
   *  outline hasn't supplied one yet — never invented. */
  kicker: string | null;
  title: string;
  special: boolean;
}

export function SectionHeader({ kicker, title, special, isSpread }: SectionHeaderParams & { isSpread: boolean }) {
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: '80%' }}>
      {kicker && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6em', marginBottom: '0.9em' }}>
          <span
            style={{
              fontFamily: 'var(--font-sans)',
              fontWeight: 700,
              fontSize: ptCqw(6.5, isSpread),
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: lavender.deep,
              whiteSpace: 'nowrap',
            }}
          >
            {kicker}
          </span>
          <span style={{ flex: 1, height: 1, background: lavender.soft }} />
        </div>
      )}
      <h2
        style={{
          margin: 0,
          fontFamily: 'var(--font-display)',
          fontWeight: 400,
          fontSize: ptCqw(special ? 44 : 34, isSpread),
          lineHeight: 1.02,
          letterSpacing: '-0.028em',
          color: colors.ink,
        }}
      >
        {title}
      </h2>
    </div>
  );
}
