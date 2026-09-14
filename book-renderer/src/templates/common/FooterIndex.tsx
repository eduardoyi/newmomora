import { ptCqw, wPct } from '../mm';
import { formatIndexDate } from './formatDate';
import type { Language } from '../furniture';
import { ScanMark } from './ScanMark';
import { lavender, colors } from '../../theme';
import type { FooterIndexEntry } from './FooterIndex.types';

export type { FooterIndexEntry } from './FooterIndex.types';

/**
 * Numbered footer index (Momora Book Layout System 1b §4, revised by owner
 * review round 3 items 7-9): one hairline rule + a row of "¹ date · context"
 * entries, numbering PER PAGE in reading order. Entries carry whatever
 * exists — date always, the memory's own text in full if present, nothing
 * invented (no places, no filenames, no emotion). This is now the ONLY
 * place a photo/video memory's caption ever prints (item 7 — illustrated
 * memories are the sole remaining on-page-text exception); the scan-to-
 * watch affordance itself moved OFF this strip to sit directly under its
 * own photo instead (item 8 — see common/PhotoTile).
 *
 * Same-date-and-caption entries consolidate onto ONE line with several
 * superscript numerals ("¹ ² ³ 23 oct") rather than repeating the date
 * once per photo (item 9) — see the fitter's `consolidateFooterIndex`.
 * Numerals are true superscripts: kept in the SAME inline text flow as the
 * date/caption (not a separate flex sibling) so the browser's native `sup`
 * baseline-raise actually applies — flex's `align-items:baseline` does NOT
 * honor `vertical-align`, which is what made the numeral previously read
 * as a subscript instead.
 *
 * Positioned at the bottom of whichever `position:relative` box the caller
 * renders it inside (the safe content box, typically) — pass 0/0 to span
 * its full width.
 *
 * Bug fix (owner review round 4, item 4): the folio sits at the OUTER
 * corner — left on an even (verso) page, right on an odd (recto) one (see
 * common/Folio) — but this row always started from the left, colliding
 * with the folio on verso pages. It now mirrors: right-aligned (hugging
 * the right/inner-gutter side) on a verso page, left-aligned (unchanged)
 * on a recto page, so the folio's outer corner is always clear. Entries
 * stay in their normal reading order either way — only the ROW's own
 * anchor flips, never the entries within it.
 *

 * `qr` is a narrow, deliberate exception to "scan-to-watch moved off the
 * footer": a full-bleed/panorama VIDEO carries no on-page photo tile of its
 * own to attach a scan mark under (its whole point is an uninterrupted
 * bled image) — its credit is a synthetic footer-only entry on the FACING
 * page (see fitter.ts `pendingCredit`), so that is the only place its scan
 * affordance can live. Never set on a normal slot-derived entry (whose
 * photo already shows its own scan mark via `common/PhotoTile`) —
 * `footerIndexFor` never sets it; only `pendingCredit` construction does.
 */
export function FooterIndex({
  entries,
  isSpread,
  language,
  isEvenPage = false,
}: {
  entries: FooterIndexEntry[];
  isSpread: boolean;
  language: Language;
  /** Verso (even/left) page — mirrors the row to the right so it never collides with the outer-left folio (item 4). Defaults to recto (left-aligned, unchanged) when omitted. */
  isEvenPage?: boolean;
}) {
  if (entries.length === 0) return null;
  return (
    <div
      className="footer-index"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: `${wPct(9, isSpread)}%`,
      }}
    >
      <div style={{ height: 1, background: colors.border }} />
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: isEvenPage ? 'flex-end' : 'flex-start',
          columnGap: `${wPct(30, isSpread)}%`,
          rowGap: `${wPct(8, isSpread)}%`,
        }}
      >
        {entries.map((entry) => (
          <div key={entry.index} style={{ display: 'flex', alignItems: 'baseline', gap: '0.4em' }}>
            <span
              style={{
                fontFamily: 'var(--font-sans)',
                color: colors.ink2,
                fontSize: ptCqw(7, isSpread),
                lineHeight: 1.5,
              }}
            >
              {entry.indices.map((n, i) => (
                <sup
                  key={n}
                  style={{
                    fontWeight: 700,
                    color: lavender.deep,
                    fontSize: '0.65em',
                    marginRight: i === entry.indices.length - 1 ? '0.35em' : '0.15em',
                  }}
                >
                  {/* Print-polish round (owner decision 2026-09-14, item E):
                      a consolidated multi-photo line used to read as "¹ ²"
                      (numerals separated only by the margin above) — a
                      trailing comma on every numeral but the last renders
                      "¹, ²" instead, matching how a citation list is
                      normally punctuated. */}
                  {n}
                  {i < entry.indices.length - 1 ? ',' : ''}
                </sup>
              ))}
              {formatIndexDate(entry.date, language)}
              {entry.note ? ` · ${entry.note}` : ''}
            </span>
            {/* Print-polish round (owner decision 2026-09-14, item D3): the
                "escanea para verlo"/"scan to watch it" label that used to
                sit next to this credit-line mark is gone — same reasoning
                as PhotoTile.tsx's identical removal. */}
            {entry.qr && (
              <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                <ScanMark size="inline" isSpread={isSpread} />
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
