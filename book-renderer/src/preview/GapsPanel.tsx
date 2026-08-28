import type { LayoutGap, PageCapacityReport } from '../model/types';
import type { IntegrityViolation } from '../model/audit';

/** Surfaces the fitter's layout-gaps report — the missing-layout backlog (Stage C) — plus the page-cap tightening report (final-fix-round item 2) and the round-5 content-integrity audit. */
export function GapsPanel({
  gaps,
  capacity,
  violations,
}: {
  gaps: LayoutGap[];
  capacity?: PageCapacityReport;
  violations?: IntegrityViolation[];
}) {
  return (
    <div className="gaps-panel">
      {capacity && (
        <div
          className={`gaps-panel__capacity${capacity.overCap ? ' gaps-panel__capacity--over' : ''}`}
        >
          {capacity.totalPages} / {capacity.cap} pages
          {capacity.pairingLevelUsed > 0 && ` · pairing level ${capacity.pairingLevelUsed}`}
          {capacity.omittedMemoryIds.length > 0 &&
            ` · ${capacity.omittedMemoryIds.length} memor${capacity.omittedMemoryIds.length === 1 ? 'y' : 'ies'} omitted for overflow`}
          {capacity.overCap && ' · STILL OVER CAP'}
        </div>
      )}
      {violations && (
        <div className={`gaps-panel__integrity${violations.length > 0 ? ' gaps-panel__integrity--fail' : ''}`}>
          {violations.length === 0 ? (
            <div className="gaps-panel gaps-panel--empty">Integrity — 0 violations.</div>
          ) : (
            <>
              <h3 className="gaps-panel__title">Integrity ({violations.length})</h3>
              <ul className="gaps-panel__list">
                {violations.map((v, i) => (
                  <li key={i} className="gaps-panel__item">
                    <span className="gaps-panel__element">{v.check}</span>
                    <span className="gaps-panel__reason">{v.message}</span>
                    {(v.elementId || v.pageId) && (
                      <span className="gaps-panel__memories">{v.elementId ?? v.pageId}</span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {gaps.length === 0 ? (
        <div className="gaps-panel gaps-panel--empty">No layout gaps — every element fit cleanly.</div>
      ) : (
        <>
          <h3 className="gaps-panel__title">Layout gaps ({gaps.length})</h3>
          <ul className="gaps-panel__list">
            {gaps.map((gap, i) => (
              <li key={i} className="gaps-panel__item">
                <span className="gaps-panel__element">{gap.elementId}</span>
                <span className="gaps-panel__reason">{gap.reason}</span>
                <span className="gaps-panel__memories">{gap.memoryIds.length} memor{gap.memoryIds.length === 1 ? 'y' : 'ies'}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
