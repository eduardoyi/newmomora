import { ptCqw } from '../mm';
import { colors, lavender } from '../../theme';
import type { SectionHeaderParams } from './SectionHeader.types';

export type { SectionHeaderParams } from './SectionHeader.types';

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
              lineHeight: 1.2,
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
