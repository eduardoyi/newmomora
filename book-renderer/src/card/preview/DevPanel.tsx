import type { CardChoices, CardEdits } from '../edits';
import { GREETING_POSITIONS, type CardData, type GreetingPosition } from '../types';
import type { cardStats } from '../document';

export interface DevState {
  trim: boolean;
  safe: boolean;
  bleed: boolean;
  /** 0 = auto. */
  zoom: number;
}

/** Developer-only controls and readouts (`?dev=1`): not part of the user editor. */
export function DevPanel({
  cards,
  slug,
  onSlug,
  data,
  edits,
  stats,
  state,
  onState,
  zoom,
  onChoices,
  onResetAll,
}: {
  cards: string[];
  slug: string | null;
  onSlug: (s: string) => void;
  data: CardData;
  edits: CardEdits;
  stats: ReturnType<typeof cardStats> | null;
  state: DevState;
  onState: (s: DevState) => void;
  zoom: number;
  onChoices: (patch: Partial<CardChoices>) => void;
  onResetAll: () => void;
}) {
  const c = edits.choices;
  return (
    <aside className="cp-dev">
      <h2>Developer</h2>
      <label>
        Card
        <select value={slug ?? ''} onChange={(e) => onSlug(e.target.value)}>
          {cards.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      <label>
        Orientation
        <select value={c.orientation ?? 'auto'} onChange={(e) => onChoices({ orientation: e.target.value === 'auto' ? null : (e.target.value as 'landscape' | 'portrait') })}>
          <option value="auto">Auto (follows the picture)</option>
          <option value="landscape">Landscape</option>
          <option value="portrait">Portrait</option>
        </select>
      </label>
      <label>
        Greeting position (full-bleed)
        <select value={c.greetingPosition ?? data.photo.greetingPosition ?? 'bottom-left'} onChange={(e) => onChoices({ greetingPosition: e.target.value as GreetingPosition })}>
          {GREETING_POSITIONS.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </label>
      <label className="cp-check">
        <input type="checkbox" checked={c.portraits ?? true} onChange={(e) => onChoices({ portraits: e.target.checked })} /> Family portraits by the signature
      </label>
      <div className="cp-group">
        <span>Guides</span>
        {(['trim', 'safe', 'bleed'] as const).map((k) => (
          <label key={k} className="cp-check">
            <input type="checkbox" checked={state[k]} onChange={(e) => onState({ ...state, [k]: e.target.checked })} />
            {k === 'trim' ? 'Trim (red)' : k === 'safe' ? 'Safe, 8 mm (green)' : 'Bleed edge (dashed)'}
          </label>
        ))}
      </div>
      <label>
        Zoom {zoom.toFixed(1)} px/mm {state.zoom === 0 ? '(auto)' : ''}
        <input type="range" min={1.2} max={5} step={0.1} value={zoom} onChange={(e) => onState({ ...state, zoom: Number(e.target.value) })} />
      </label>
      {state.zoom !== 0 && (
        <button className="cp-link" onClick={() => onState({ ...state, zoom: 0 })}>
          auto zoom
        </button>
      )}
      <button className="cp-link" onClick={onResetAll}>
        Reset all edits
      </button>
      {stats && (
        <dl className="cp-stats">
          <dt>Page</dt>
          <dd>
            {stats.pageMm[0]} × {stats.pageMm[1]} mm (trim {stats.trimMm[0]} × {stats.trimMm[1]})
          </dd>
          <dt>Front</dt>
          <dd>
            {stats.frontLayout}: {stats.frontPixels[0]}×{stats.frontPixels[1]} px → {stats.placedMm[0]}×{stats.placedMm[1]} mm = {stats.frontDpi} dpi, crop {Math.round(stats.frontCrop[0] * 100)}% / {Math.round(stats.frontCrop[1] * 100)}%, picture {Math.round(stats.pictureShareOfTrim * 100)}% of the card
          </dd>
          <dt>Letter</dt>
          <dd>
            {stats.letterPt} pt, {stats.letterLines} lines{stats.letterFits ? '' : ' — DOES NOT FIT'}
          </dd>
          <dt>QR</dt>
          <dd>{stats.qrMm ? `${stats.qrMm} mm` : 'off'}</dd>
          <dt>Portraits</dt>
          <dd>{stats.portraitCount ? `${stats.portraitCount} × ${stats.portraitMm} mm` : 'none'}</dd>
          {stats.warnings.length > 0 && (
            <>
              <dt className="warn">Warnings</dt>
              <dd className="warn">{stats.warnings.join('; ')}</dd>
            </>
          )}
          {stats.safeViolations.length > 0 && (
            <>
              <dt className="warn">Too close to trim</dt>
              <dd className="warn">{stats.safeViolations.map((v) => `${v.name} (${v.minDistanceMm} mm)`).join('; ')}</dd>
            </>
          )}
        </dl>
      )}
    </aside>
  );
}
