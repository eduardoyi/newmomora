import type { TemplateProps } from './types';
import { PageFrame } from './PageFrame';
import { assetUrl } from '../model/loader';
import { PHYSICAL } from '../model/types';
import { ptCqwFor, canvasPxToPt } from './mm';
import { colors, lavender } from '../theme';
import './WraparoundCover.css';

/**
 * The full wraparound cover (Momora Book Layout System 2a/2b): back + spine
 * + front on one sheet, in three voices. Photo voice: the image wraps
 * front -> spine -> 34mm into the back with a clean cut; the back is
 * otherwise paper-white + wordmark + colophon. Mixed voice (a vertical or
 * <1.4:1 photo): the image stays on the front only, spine and back go
 * paper-white, and the back recovers an illustrated-portrait stamp. Minimal
 * voice (no photo): a single 0.25pt rule crosses the whole wrap at 60mm
 * from the head, interrupted 4mm on each side of the spine text.
 *
 * Spine tiers: >=12mm name+years (descending, name centered at mid-height,
 * years 14mm from the foot); 8-12mm name only; <8mm blank (no legible type
 * fits under bindery tolerance). Spine width is a parameter (`spineMm`,
 * default 9mm) — the real width comes from Prodigi's per-page-count API in
 * a later stage.
 */
export function WraparoundCover({ page, bookSlug, showGuides }: TemplateProps) {
  const p = page.params as {
    childName: string;
    yearRangeLabel: string;
    backCoverLine: string | null;
    spineMm: number;
    voice: 'photo' | 'minimal' | 'mixed';
    assetFile: string | null;
    portraitFile: string | null;
  };
  const spineMm = p.spineMm;
  const spineTier = spineMm >= 12 ? 'full' : spineMm >= 8 ? 'name-only' : 'blank';

  const backMm = PHYSICAL.pageSizeMm; // 210 trim
  const wrapWidthMm = PHYSICAL.pageSizeMm * 2 + spineMm; // trim-only, matches canvas convention
  const wrapHeightMm = PHYSICAL.pageSizeMm;
  const bleed = PHYSICAL.bleedMm;
  const totalWidthMm = wrapWidthMm + bleed * 2;
  const totalHeightMm = wrapHeightMm + bleed * 2;

  // mm-from-wrap-left-bleed-edge -> % of the wrap's own rendered width/height.
  const xPct = (mm: number) => (mm / totalWidthMm) * 100;
  const yPct = (mm: number) => (mm / totalHeightMm) * 100;
  const wPct = (mm: number) => (mm / totalWidthMm) * 100;
  // Height percentages must divide by the wrap's total HEIGHT, not its
  // width — the wrap is roughly 2:1, so reusing wPct() for a box's height
  // (as this file briefly did for the portrait stamp) silently stretches a
  // square mm size into a ~2:1 rectangle.
  const hPct = (mm: number) => (mm / totalHeightMm) * 100;

  const spineLeft = bleed + backMm;
  const spineCenter = spineLeft + spineMm / 2;
  const frontLeft = spineLeft + spineMm;
  const hasPhotoOnFront = p.voice === 'photo' || p.voice === 'mixed';
  const photoWrapsSpine = p.voice === 'photo';

  const isDark = hasPhotoOnFront; // simplification: photo cover always uses white/scrim-legible text — see WraparoundCover.css note.
  // Bug fix (owner review round 3 item 17 — "no spine visible"): the spine's
  // OWN background only ever gets covered by the photo when the voice is
  // 'photo' (photoWrapsSpine) — 'mixed' voice keeps the photo on the front
  // panel only, leaving the spine on plain paper-white. Reusing `isDark`
  // (true for BOTH photo AND mixed) for the spine's text color forced white
  // text onto a white spine in mixed voice — invisible. The spine's colors
  // must key off `photoWrapsSpine`, not `isDark`.
  const spineOnPhoto = photoWrapsSpine;

  return (
    <PageFrame isSpread={false} showGuides={showGuides} className="cover-wrap-page" explicitDimsMm={{ widthMm: totalWidthMm, heightMm: totalHeightMm }}>
      <div className="cover-wrap" data-testid="cover-wrap" data-voice={p.voice}>
        {/* ── Photo (voice: photo wraps front+spine+34mm of back; mixed: front only) ── */}
        {hasPhotoOnFront && p.assetFile && (
          <div
            className="cover-wrap__photo"
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: `${xPct(photoWrapsSpine ? spineLeft - 34 : frontLeft)}%`,
              right: 0,
              overflow: 'hidden',
              background: colors.ink,
            }}
          >
            <img src={assetUrl(bookSlug, p.assetFile)} alt="" className="cover-wrap__photo-img" />
            <div className="cover-wrap__scrim" />
          </div>
        )}

        {/* ── Minimal voice: 0.25pt rule at 60mm from head, crossing the whole wrap, interrupted around the spine text ── */}
        {p.voice === 'minimal' && (
          <>
            <div className="cover-wrap__rule" style={{ top: `${yPct(bleed + 60)}%` }} />
            {spineTier !== 'blank' && (
              <div
                className="cover-wrap__rule-gap"
                style={{
                  top: `${yPct(bleed + 60 - 2.5)}%`,
                  height: `${(5 / totalHeightMm) * 100}%`,
                  left: `${xPct(spineLeft - 2)}%`,
                  width: `${wPct(spineMm + 4)}%`,
                }}
              />
            )}
          </>
        )}

        {/* ── Back panel: wordmark (14mm from head) + year range/colophon (14mm from foot) ── */}
        <div
          className="cover-wrap__wordmark"
          style={{ left: `${xPct(bleed + 14)}%`, top: `${yPct(bleed + 14)}%`, fontSize: ptCqwFor(canvasPxToPt(19), totalWidthMm), color: colors.ink }}
        >
          Momora<span style={{ color: colors.wordmarkDot }}>.</span>
        </div>
        <div
          className="cover-wrap__colophon"
          style={{ left: `${xPct(bleed + 14)}%`, bottom: `${yPct(bleed + 14)}%`, width: `${wPct(120)}%` }}
        >
          <div className="cover-wrap__years" style={{ fontSize: ptCqwFor(6.5, totalWidthMm), color: lavender.deep }}>
            {p.yearRangeLabel}
          </div>
          {p.backCoverLine && (
            <p className="cover-wrap__colophon-line" style={{ fontSize: ptCqwFor(canvasPxToPt(19), totalWidthMm), color: colors.ink }}>
              {p.backCoverLine}
            </p>
          )}
        </div>
        {p.voice === 'mixed' && p.portraitFile && (
          <div
            className="cover-wrap__stamp"
            style={{ left: `${xPct(spineLeft - 28 - 14)}%`, top: `${yPct(bleed + 14)}%`, width: `${wPct(28)}%`, height: `${hPct(28)}%` }}
          >
            <img src={assetUrl(bookSlug, p.portraitFile)} alt="" className="cover-wrap__stamp-img" />
          </div>
        )}

        {/* ── Spine panel: a soft tinted band + hairline fold rules so the
            spine reads as its own zone even at a glance/thumbnail scale —
            only drawn when the photo itself doesn't already cover the
            spine (photo voice wraps over it; mixed/minimal voices don't). ── */}
        {!spineOnPhoto && (
          <div
            className="cover-wrap__spine-panel"
            style={{ left: `${xPct(spineLeft)}%`, width: `${wPct(spineMm)}%`, top: 0, bottom: 0 }}
          />
        )}

        {/* ── Spine: descending orientation, tiered by width ── */}
        {spineTier !== 'blank' && (
          <div className="cover-wrap__spine" style={{ left: `${xPct(spineCenter)}%`, top: 0, bottom: 0 }}>
            <div
              className="cover-wrap__spine-name"
              style={{ fontSize: ptCqwFor(10, totalWidthMm), color: spineOnPhoto ? '#fff' : colors.ink }}
            >
              {p.childName}
            </div>
            {spineTier === 'full' && (
              <div
                className="cover-wrap__spine-years"
                style={{ bottom: `${yPct(bleed + 14)}%`, fontSize: ptCqwFor(6.5, totalWidthMm), color: spineOnPhoto ? 'rgba(255,255,255,.82)' : colors.ink3 }}
              >
                {p.yearRangeLabel}
              </div>
            )}
          </div>
        )}

        {/* ── Front panel: title block, 30mm past the spine (the "bisagra" hinge) ── */}
        <div
          className="cover-wrap__title"
          style={{ left: `${xPct(frontLeft + 30)}%`, bottom: `${yPct(bleed + 14)}%` }}
        >
          <div
            className="cover-wrap__name"
            style={{ fontSize: ptCqwFor(68, totalWidthMm), color: isDark ? '#fff' : colors.ink }}
          >
            {p.childName}
            {!isDark && <span style={{ color: colors.primary }}>.</span>}
          </div>
          <div
            className="cover-wrap__scope"
            style={{ fontSize: ptCqwFor(8.5, totalWidthMm), color: isDark ? 'rgba(255,255,255,.78)' : colors.ink3 }}
          >
            {p.yearRangeLabel}
          </div>
        </div>
      </div>
    </PageFrame>
  );
}
