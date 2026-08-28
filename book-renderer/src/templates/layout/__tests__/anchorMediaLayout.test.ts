import { describe, expect, it } from 'vitest';
import { tallSoloCanSitBesideHeader,
  classifyOrientation,
  layoutAnchorPair,
  layoutSoloAnchor,
  layoutTallSoloBesideHeader,
  anchorPairMeetsMinSize,
  PHOTO_META_RESERVE_MM,
  tallSoloHeaderWidthCapMm,
  layoutSoloVideoAnchor,
  soloVideoScanPlacement,
  SOLO_VIDEO_SCAN_MIN_SIDE_MM,
} from '../anchorMediaLayout';
import { MIN_IMAGE_SIDE_MM } from '../../mm';

const SAFE_BOX_MM = 190; // matches templates/mm.ts SAFE_BOX_MM

describe('classifyOrientation', () => {
  it('classifies tall, square, and wide correctly', () => {
    expect(classifyOrientation(0.5)).toBe('tall');
    expect(classifyOrientation(0.84)).toBe('tall');
    expect(classifyOrientation(1)).toBe('square');
    expect(classifyOrientation(0.9)).toBe('square');
    expect(classifyOrientation(1.1)).toBe('square');
    expect(classifyOrientation(1.16)).toBe('wide');
    expect(classifyOrientation(2)).toBe('wide');
  });
});

describe('layoutSoloAnchor (owner review round 3, item 3; maximized round 7, item 1a)', () => {
  it('fills the FULL available box on its width for a landscape photo — no fill fraction, no target-size cap', () => {
    const rect = layoutSoloAnchor(1.5, SAFE_BOX_MM, SAFE_BOX_MM);
    // Baseline-grid snapping (5mm) is the only thing that shaves this off
    // full width — not an arbitrary target size or fill fraction.
    expect(rect.wMm).toBeGreaterThan(SAFE_BOX_MM - 5);
    expect(rect.hMm).toBeCloseTo(rect.wMm / 1.5, 5);
  });

  it('fills the FULL available box on its height for a portrait photo', () => {
    const rect = layoutSoloAnchor(0.6, SAFE_BOX_MM, SAFE_BOX_MM);
    expect(rect.hMm).toBeCloseTo(SAFE_BOX_MM, 5);
    expect(rect.wMm).toBeCloseTo(SAFE_BOX_MM * 0.6, 5);
  });

  it('fills more generously than the old ~165mm target when the available box is bigger — the exact round-7 item 1a complaint', () => {
    const rect = layoutSoloAnchor(1, SAFE_BOX_MM, SAFE_BOX_MM);
    expect(rect.wMm).toBeGreaterThan(165);
    expect(rect.hMm).toBeGreaterThan(165);
  });

  it('never overflows the available box (item 14) — an extremely tall video clamps to the content height', () => {
    const tinyHeight = 80; // much smaller than the ~165mm a 9:16 video would naturally want
    const rect = layoutSoloAnchor(9 / 16, SAFE_BOX_MM, tinyHeight);
    expect(rect.hMm).toBeLessThanOrEqual(tinyHeight);
    expect(rect.wMm).toBeLessThanOrEqual(SAFE_BOX_MM);
  });

  it('is centered within the available box', () => {
    const rect = layoutSoloAnchor(1, SAFE_BOX_MM, SAFE_BOX_MM);
    expect(rect.xMm).toBeCloseTo((SAFE_BOX_MM - rect.wMm) / 2, 5);
    expect(rect.yMm).toBeCloseTo((SAFE_BOX_MM - rect.hMm) / 2, 5);
  });
});

describe('layoutAnchorPair (owner review round 3, item 6: orientation-driven asymmetry)', () => {
  it('tall+square: the tall photo claims the FULL available column height', () => {
    const [tall, square] = layoutAnchorPair(0.6 /* tall */, 1 /* square */, true, SAFE_BOX_MM, SAFE_BOX_MM);
    expect(tall.hMm).toBeCloseTo(SAFE_BOX_MM, 5);
    // The square partner is visibly smaller — never an equal pair.
    expect(square.hMm).toBeLessThan(tall.hMm);
    expect(square.wMm * square.hMm).toBeLessThan(tall.wMm * tall.hMm);
  });

  it('tall+square is symmetric regardless of input order', () => {
    const [square, tall] = layoutAnchorPair(1 /* square */, 0.6 /* tall */, false, SAFE_BOX_MM, SAFE_BOX_MM);
    expect(tall.hMm).toBeCloseTo(SAFE_BOX_MM, 5);
    expect(square.hMm).toBeLessThan(tall.hMm);
  });

  it('wide+square: the wide photo claims near-FULL width', () => {
    const [wide, square] = layoutAnchorPair(1.8 /* wide */, 1 /* square */, true, SAFE_BOX_MM, SAFE_BOX_MM);
    expect(wide.wMm).toBeCloseTo(SAFE_BOX_MM, 5);
    expect(square.wMm).toBeLessThan(wide.wMm);
  });

  it('never produces an equal-size pair for any orientation combination (falls back to dominant/subordinate)', () => {
    const combos: Array<[number, number]> = [
      [0.6, 0.65], // both tall
      [1.8, 2.2], // both wide
      [1, 1.05], // both square
      [0.6, 1.8], // tall + wide
    ];
    for (const [a, b] of combos) {
      const [rectA, rectB] = layoutAnchorPair(a, b, true, SAFE_BOX_MM, SAFE_BOX_MM);
      const areaA = rectA.wMm * rectA.hMm;
      const areaB = rectB.wMm * rectB.hMm;
      expect(areaA).not.toBeCloseTo(areaB, 0);
    }
  });

  it('never overflows the available box (item 14) — an extreme tall+square pair still clamps to content height', () => {
    const contentHeight = 90; // a header-reserved page, much shorter than a full safe box
    const [tall, square] = layoutAnchorPair(0.5, 1, true, SAFE_BOX_MM, contentHeight);
    expect(tall.hMm).toBeLessThanOrEqual(contentHeight);
    expect(square.hMm).toBeLessThanOrEqual(contentHeight);
    expect(tall.wMm).toBeLessThanOrEqual(SAFE_BOX_MM);
    expect(square.wMm).toBeLessThanOrEqual(SAFE_BOX_MM);
  });

  it('the two boxes never overlap horizontally', () => {
    const [a, b] = layoutAnchorPair(0.6, 1, true, SAFE_BOX_MM, SAFE_BOX_MM);
    expect(a.xMm + a.wMm).toBeLessThanOrEqual(b.xMm + 0.001);
  });
});

describe('layoutAnchorPair — aspect-aware dominance overrides the order/hero hint (owner review round 4, item 6)', () => {
  it('a wide photo wins the dominant slot even when the hero hint points at its squarish partner (the reported screenshot bug)', () => {
    // The exact reported case: a wide video paired with a squarish photo —
    // the squarish one had been rendering large (order/hero-driven) while
    // the wide one shrank. Dominance must now follow aspect (elongation),
    // not the caller's hint, whenever the two are clearly not similarly shaped.
    const wideAspect = 1.8;
    const squareishAspect = 1.05;
    const [wide, square] = layoutAnchorPair(wideAspect, squareishAspect, false /* hint says square is dominant */, SAFE_BOX_MM, SAFE_BOX_MM);
    expect(wide.wMm).toBeCloseTo(SAFE_BOX_MM, 5); // wide claims near-full width regardless of the hint
    expect(square.wMm).toBeLessThan(wide.wMm);
    expect(square.wMm * square.hMm).toBeLessThan(wide.wMm * wide.hMm);
  });

  it('a tall photo wins the dominant slot even when the hero hint points at its squarish partner', () => {
    const tallAspect = 0.55;
    const squareishAspect = 0.95;
    const [tall, square] = layoutAnchorPair(tallAspect, squareishAspect, false /* hint says square is dominant */, SAFE_BOX_MM, SAFE_BOX_MM);
    expect(tall.hMm).toBeCloseTo(SAFE_BOX_MM, 5);
    expect(square.hMm).toBeLessThan(tall.hMm);
  });

  it('falls back to the caller hint only when both photos are similarly elongated (a genuine near-tie)', () => {
    // Both nearly square (elongation scores within DOMINANCE_TIE_TOLERANCE)
    // — aspect alone can't decide, so the hint breaks the tie. Whichever
    // slot the hint points at ends up with the larger area.
    const [aHintTrue, bHintTrue] = layoutAnchorPair(1.0, 1.02, true, SAFE_BOX_MM, SAFE_BOX_MM);
    expect(aHintTrue.wMm * aHintTrue.hMm).toBeGreaterThan(bHintTrue.wMm * bHintTrue.hMm); // hint=true -> A (first) dominant

    const [aHintFalse, bHintFalse] = layoutAnchorPair(1.0, 1.02, false, SAFE_BOX_MM, SAFE_BOX_MM);
    expect(bHintFalse.wMm * bHintFalse.hMm).toBeGreaterThan(aHintFalse.wMm * aHintFalse.hMm); // hint=false -> B (second) dominant
  });
});

describe('layoutAnchorPair — no overlap, even with the meta-strip reserve (owner review round 5, item 3)', () => {
  const FOOTER_RESERVE_MM = 22; // matches templates/mm.ts

  function noOverlap(rectA: { xMm: number; yMm: number; wMm: number; hMm: number }, rectB: typeof rectA): boolean {
    // Pad each rect's own bottom edge by its meta strip (numeral + scan
    // mark render just past it, see PhotoTile.css) and confirm the padded
    // box still never intersects the OTHER rect.
    const padded = (r: typeof rectA) => ({ ...r, hMm: r.hMm + PHOTO_META_RESERVE_MM });
    const intersects = (a: typeof rectA, b: typeof rectA) =>
      a.xMm < b.xMm + b.wMm && a.xMm + a.wMm > b.xMm && a.yMm < b.yMm + b.hMm && a.yMm + a.hMm > b.yMm;
    return !intersects(rectA, rectB) && !intersects(padded(rectA), rectB) && !intersects(padded(rectB), rectA);
  }

  it('never overlaps for a wide+wide pair (the exact screenshot regression: subordinate onto the dominant/its scan block)', () => {
    const contentHeight = SAFE_BOX_MM - FOOTER_RESERVE_MM;
    const [a, b] = layoutAnchorPair(1.5, 1.5, true, SAFE_BOX_MM, contentHeight);
    expect(noOverlap(a, b)).toBe(true);
  });

  it('never overlaps across a spread of representative aspect-ratio combinations, with and without a header', () => {
    const combos: Array<[number, number]> = [
      [1.5, 1.5],
      [0.6, 1.8],
      [1, 1],
      [2.2, 0.7],
      [1.05, 0.95],
    ];
    for (const headerReserveMm of [0, 45]) {
      const contentHeight = SAFE_BOX_MM - headerReserveMm - FOOTER_RESERVE_MM;
      for (const [a, b] of combos) {
        const [rectA, rectB] = layoutAnchorPair(a, b, true, SAFE_BOX_MM, contentHeight, headerReserveMm > 0);
        expect(noOverlap(rectA, rectB)).toBe(true);
      }
    }
  });
});

describe('anchorPairMeetsMinSize (owner review round 5 amendment, "minimum image size")', () => {
  const FOOTER_RESERVE_MM = 22;
  const contentHeight = SAFE_BOX_MM - FOOTER_RESERVE_MM;

  it('an ordinary wide+wide pair (the previous default test fixture shape) still clears the floor — the fix must not make routine pairs split', () => {
    expect(anchorPairMeetsMinSize(1.5, 1.5, true, SAFE_BOX_MM, contentHeight)).toBe(true);
  });

  it('every resulting box in a passing pair is actually at or above MIN_IMAGE_SIDE_MM on its shorter side', () => {
    const [a, b] = layoutAnchorPair(1.5, 1.5, true, SAFE_BOX_MM, contentHeight);
    expect(Math.min(a.wMm, a.hMm)).toBeGreaterThanOrEqual(MIN_IMAGE_SIDE_MM - 1e-6);
    expect(Math.min(b.wMm, b.hMm)).toBeGreaterThanOrEqual(MIN_IMAGE_SIDE_MM - 1e-6);
  });

  it('reports infeasible for a genuinely tight box — this is when the fitter must split instead of shrink', () => {
    // Round-7's dominant-share solve gives the subordinate the FULL
    // remaining width (no fraction cap), which resolved several previously
    // "tight" cases — a truly pathological height (well under any reserve
    // + the 60mm floor) is what now demonstrates real infeasibility.
    const pathologicallyTightHeight = 70;
    expect(anchorPairMeetsMinSize(2.4, 2.4, true, SAFE_BOX_MM, pathologicallyTightHeight, true)).toBe(false);
  });
});

describe('subordinate floor + relative rule (owner review round 7, item 1b)', () => {
  const FOOTER_RESERVE_MM = 22;

  it('the subordinate short side is always at least 60mm in an ordinary (footer-only) pair', () => {
    const contentHeight = SAFE_BOX_MM - FOOTER_RESERVE_MM;
    const [, subordinate] = layoutAnchorPair(1.5, 1.5, true, SAFE_BOX_MM, contentHeight);
    expect(Math.min(subordinate.wMm, subordinate.hMm)).toBeGreaterThanOrEqual(60 - 1e-6);
  });

  it('the RELATIVE rule (55% of the dominant) binds — not just the flat 60mm floor — when the dominant is generously sized', () => {
    // A tall/generous content box (no header reserve) lets the dominant
    // grow past ~109mm, the point where 55% of it already exceeds the
    // flat 60mm floor — this is the relative rule actually doing the work,
    // not the flat floor happening to be enough.
    const [dominant, subordinate] = layoutAnchorPair(1.5, 1.5, true, SAFE_BOX_MM, SAFE_BOX_MM - FOOTER_RESERVE_MM + 22);
    const domShort = Math.min(dominant.wMm, dominant.hMm);
    const subShort = Math.min(subordinate.wMm, subordinate.hMm);
    expect(domShort).toBeGreaterThan(109);
    expect(subShort).toBeGreaterThanOrEqual(0.55 * domShort - 1e-6);
    // Confirms the relative rule genuinely exceeds the flat floor here (not a coincidence).
    expect(0.55 * domShort).toBeGreaterThan(60);
  });

  it('whenever anchorPairMeetsMinSize reports true, the ACTUAL geometry really does clear the 60mm/55%-relative floor — across a spread of aspect combinations', () => {
    // Not every combination is feasible as a pair (e.g. a wide dominant
    // paired with a genuinely tall subordinate is a hard case — that's
    // exactly what should report false and trigger a split) — this test's
    // point is that the CHECKER and the REAL geometry never disagree,
    // whichever way it comes out.
    const contentHeight = SAFE_BOX_MM - FOOTER_RESERVE_MM;
    const combos: Array<[number, number]> = [
      [1.5, 1.5],
      [1.8, 0.6],
      [2.0, 1.0],
      [1.2, 1.3],
    ];
    for (const [a, b] of combos) {
      const meetsFloor = anchorPairMeetsMinSize(a, b, true, SAFE_BOX_MM, contentHeight);
      const [rectA, rectB] = layoutAnchorPair(a, b, true, SAFE_BOX_MM, contentHeight);
      const areaA = rectA.wMm * rectA.hMm;
      const areaB = rectB.wMm * rectB.hMm;
      const [dominant, subordinate] = areaA >= areaB ? [rectA, rectB] : [rectB, rectA];
      const domShort = Math.min(dominant.wMm, dominant.hMm);
      const subShort = Math.min(subordinate.wMm, subordinate.hMm);
      const actuallyMeetsFloor = subShort >= Math.max(60, 0.55 * domShort) - 1e-6;
      expect(meetsFloor).toBe(actuallyMeetsFloor);
    }
  });
});

describe('layoutAnchorPair — round-8 item 1: wide-dominant dominance-inversion fix', () => {
  // The exact diagnosed bug: a section-header page's content height (SAFE_BOX_MM
  // - SECTION_HEADER_RESERVE_MM - FOOTER_RESERVE_MM = 190 - 40 - 22 = 128mm)
  // used to force a WIDE dominant's vertical-stack height cap so low
  // (`solveDominantShare`'s flat-floor branch) it ended up shorter than the
  // subordinate's own floor — dominance inverted, ~22% page fill.
  const HEADER_RESERVE_MM = 40; // matches templates/mm.ts SECTION_HEADER_RESERVE_MM
  const FOOTER_RESERVE_MM = 22;
  const headerPageContentHeight = SAFE_BOX_MM - HEADER_RESERVE_MM - FOOTER_RESERVE_MM;

  it('never inverts dominance for a wide+wide pair on a squeezed header page — the dominant is always >= the subordinate on its short side', () => {
    const [dominant, subordinate] = layoutAnchorPair(1.5, 1.5, true, SAFE_BOX_MM, headerPageContentHeight, true);
    const domShort = Math.min(dominant.wMm, dominant.hMm);
    const subShort = Math.min(subordinate.wMm, subordinate.hMm);
    expect(domShort).toBeGreaterThanOrEqual(subShort - 1e-6);
  });

  it('fills a much bigger share of the header page than the pre-fix vertical-stack-only geometry (owner target: ~0.45+, not ~0.22)', () => {
    const [dominant, subordinate] = layoutAnchorPair(1.5, 1.5, true, SAFE_BOX_MM, headerPageContentHeight, true);
    const fillRatio = (dominant.wMm * dominant.hMm + subordinate.wMm * subordinate.hMm) / (SAFE_BOX_MM * headerPageContentHeight);
    expect(fillRatio).toBeGreaterThan(0.45);
  });

  it('lays the pair out SIDE BY SIDE (sharing the width axis) once it falls back — never overlapping horizontally', () => {
    const [a, b] = layoutAnchorPair(1.5, 1.5, true, SAFE_BOX_MM, headerPageContentHeight, true);
    // Side-by-side means one rect's right edge sits at or before the other's left edge.
    const noHorizontalOverlap = a.xMm + a.wMm <= b.xMm + 1e-6 || b.xMm + b.wMm <= a.xMm + 1e-6;
    expect(noHorizontalOverlap).toBe(true);
  });

  it('an ordinary (unsqueezed) wide+wide pair still uses the vertical stack — the fallback only fires when the stack would actually invert', () => {
    const fullContentHeight = SAFE_BOX_MM - FOOTER_RESERVE_MM; // no header — plenty of height
    const [dominant] = layoutAnchorPair(1.5, 1.5, true, SAFE_BOX_MM, fullContentHeight);
    // The vertical stack's dominant is TOP-aligned (yMm 0) and horizontally
    // CENTERED; the side-by-side fallback instead left-aligns it (xMm 0)
    // and vertically centers it — this distinguishes which arrangement
    // actually rendered regardless of the exact aspect-driven width/height.
    expect(dominant.yMm).toBeCloseTo(0, 5);
  });

  it('once a pair clears anchorPairMeetsMinSize, the dominance invariant genuinely holds in the real geometry — across a spread of aspect combinations at the squeezed header height (an infeasible combo correctly reports false instead of ever rendering inverted)', () => {
    const combos: Array<[number, number]> = [
      [1.5, 1.5],
      [1.8, 1.2],
      [1.3, 1.15],
      [2.0, 1.6],
    ];
    for (const [a, b] of combos) {
      const meetsFloor = anchorPairMeetsMinSize(a, b, true, SAFE_BOX_MM, headerPageContentHeight, true);
      const [dominant, subordinate] = layoutAnchorPair(a, b, true, SAFE_BOX_MM, headerPageContentHeight, true);
      const domShort = Math.min(dominant.wMm, dominant.hMm);
      const subShort = Math.min(subordinate.wMm, subordinate.hMm);
      // The invariant is a GATE, not a guarantee about every possible
      // combo's geometry — some aspect combinations (e.g. a 2.0-wide
      // dominant next to a 1.6-wide subordinate, sharing the width axis on
      // a squeezed header page) genuinely cannot satisfy both the
      // subordinate's absolute floor AND dominance at once, and correctly
      // report false (the fitter splits to solo pages instead) rather than
      // ever rendering inverted — so only a PASSING combo is required to
      // have the real geometry actually be non-inverted.
      if (meetsFloor) {
        expect(domShort).toBeGreaterThanOrEqual(subShort - 1e-6);
      }
    }
  });
});

describe('anchorPairMeetsMinSize — round-8 item 1 DOMINANCE INVARIANT', () => {
  it('rejects a pair whose geometry would leave the subordinate with a LARGER short side than the dominant', () => {
    // A synthetic, deliberately pathological case that defeats the normal
    // dominant/subordinate sizing (an extremely elongated "dominant" next
    // to a much less elongated "subordinate" on a squeezed content box —
    // real geometry: dominant ~35mm short side, subordinate 60mm) — the
    // invariant must catch it even though every OTHER individual check
    // (dominant's own absolute floor, subordinate's absolute floor) passes.
    const heightMm = 128; // header + footer squeeze
    const [dominant, subordinate] = layoutAnchorPair(3.5, 1.05, true, SAFE_BOX_MM, heightMm, true);
    const domShort = Math.min(dominant.wMm, dominant.hMm);
    const subShort = Math.min(subordinate.wMm, subordinate.hMm);
    expect(subShort).toBeGreaterThan(domShort); // confirms the fixture really does invert
    expect(anchorPairMeetsMinSize(3.5, 1.05, true, SAFE_BOX_MM, heightMm, true)).toBe(false);
  });

  it('never disagrees with the real geometry it just computed — passes true only when the dominant short side actually is >= the subordinate\'s', () => {
    const contentHeight = SAFE_BOX_MM - 22;
    const combos: Array<[number, number]> = [
      [1.5, 1.5],
      [1.8, 0.6],
      [2.0, 1.0],
      [1.2, 1.3],
      [1.3, 1 / 1.3],
    ];
    for (const [a, b] of combos) {
      const meetsFloor = anchorPairMeetsMinSize(a, b, true, SAFE_BOX_MM, contentHeight);
      const [rectA, rectB] = layoutAnchorPair(a, b, true, SAFE_BOX_MM, contentHeight);
      const shortSide = (r: { wMm: number; hMm: number }) => Math.min(r.wMm, r.hMm);
      const areaA = rectA.wMm * rectA.hMm;
      const areaB = rectB.wMm * rectB.hMm;
      const [dominant, subordinate] = areaA >= areaB ? [rectA, rectB] : [rectB, rectA];
      if (meetsFloor) {
        expect(shortSide(dominant)).toBeGreaterThanOrEqual(shortSide(subordinate) - 1e-6);
      }
    }
  });
});

describe('layoutTallSoloBesideHeader (owner review round 8, item 2)', () => {
  const FOOTER_RESERVE_MM = 22;
  const availableHeightMm = SAFE_BOX_MM - FOOTER_RESERVE_MM; // unconditional footer reserve — see AnchorMedia.tsx

  it('right-aligns the image within the safe box', () => {
    const rect = layoutTallSoloBesideHeader(0.6, SAFE_BOX_MM, availableHeightMm);
    expect(rect.xMm + rect.wMm).toBeCloseTo(SAFE_BOX_MM, 5);
  });

  it('caps the column width at (at most) half the safe box for a long/wrapping title, so it can never encroach on the header text column (round-9 item 3: the old flat rule, now the long-title fallback)', () => {
    const longTitle = 'A very long themed spread title that comfortably wraps to two full lines';
    const rect = layoutTallSoloBesideHeader(0.9, SAFE_BOX_MM, availableHeightMm, longTitle, false);
    expect(rect.wMm).toBeLessThanOrEqual(SAFE_BOX_MM * 0.5 + 1e-6);
  });

  it('claims nearly the FULL available height for a genuinely tall aspect (much more than the old ~123mm header-reduced cap)', () => {
    const rect = layoutTallSoloBesideHeader(9 / 16, SAFE_BOX_MM, availableHeightMm);
    expect(rect.hMm).toBeGreaterThan(140); // old below-header cap topped out around 123mm
    expect(rect.hMm).toBeLessThanOrEqual(availableHeightMm + 1e-6);
  });

  it('never overflows the available box', () => {
    for (const aspect of [0.4, 0.6, 0.8, 0.849]) {
      const rect = layoutTallSoloBesideHeader(aspect, SAFE_BOX_MM, availableHeightMm);
      expect(rect.xMm).toBeGreaterThanOrEqual(-1e-6);
      expect(rect.yMm).toBeGreaterThanOrEqual(-1e-6);
      expect(rect.xMm + rect.wMm).toBeLessThanOrEqual(SAFE_BOX_MM + 1e-6);
      expect(rect.yMm + rect.hMm).toBeLessThanOrEqual(availableHeightMm + 1e-6);
    }
  });

  it('is vertically centered in the available band', () => {
    const rect = layoutTallSoloBesideHeader(0.7, SAFE_BOX_MM, availableHeightMm);
    expect(rect.yMm).toBeCloseTo((availableHeightMm - rect.hMm) / 2, 5);
  });
});

describe('tallSoloHeaderWidthCapMm (owner review round 9, item 3 — title-aware beside-header width cap)', () => {
  it('grows the cap well past the old flat 50% for a short month title', () => {
    const cap = tallSoloHeaderWidthCapMm(SAFE_BOX_MM, 'julio 2025', false);
    expect(cap).toBeGreaterThan(SAFE_BOX_MM * 0.5);
  });

  it('never grows the cap past the 65% ceiling, however short the title', () => {
    const cap = tallSoloHeaderWidthCapMm(SAFE_BOX_MM, 'x', false);
    expect(cap).toBeLessThanOrEqual(SAFE_BOX_MM * 0.65 + 1e-6);
  });

  it('never shrinks the cap below the old flat 50% floor, even for a long single-line title', () => {
    const cap = tallSoloHeaderWidthCapMm(SAFE_BOX_MM, 'A moderately long but still single-line month title', false);
    expect(cap).toBeGreaterThanOrEqual(SAFE_BOX_MM * 0.5 - 1e-6);
  });

  it('falls back to exactly the old flat 50% cap for a title long enough to wrap to two lines', () => {
    const longTitle = 'A very long themed spread title that comfortably wraps to two full lines';
    const cap = tallSoloHeaderWidthCapMm(SAFE_BOX_MM, longTitle, false);
    expect(cap).toBeCloseTo(SAFE_BOX_MM * 0.5, 5);
  });

  it('is monotonically non-increasing in title length — a longer title never grows the cap more than a shorter one', () => {
    const titles = ['mayo 2025', 'julio 2025', 'octubre 2025', 'noviembre 2025', 'A long themed title spanning quite a few words indeed'];
    let previousCap = Infinity;
    for (const title of titles) {
      const cap = tallSoloHeaderWidthCapMm(SAFE_BOX_MM, title, false);
      expect(cap).toBeLessThanOrEqual(previousCap + 1e-6);
      previousCap = cap;
    }
  });

  it('a special (birth-month, 44pt) title of the same text grows the cap LESS than an ordinary (34pt) title — the larger font renders wider', () => {
    const title = 'agosto 2025';
    const ordinaryCap = tallSoloHeaderWidthCapMm(SAFE_BOX_MM, title, false);
    const specialCap = tallSoloHeaderWidthCapMm(SAFE_BOX_MM, title, true);
    expect(specialCap).toBeLessThanOrEqual(ordinaryCap);
  });

  it('real-book calibration: julio/octubre 2025-style titles clear 110mm — the Mara octubre portrait DOM spot-check floor', () => {
    // Mirrors AnchorMedia.tsx's real call shape for a 3:4 portrait (0.75)
    // beside a short month header.
    const availableHeightMm = SAFE_BOX_MM - 22; // FOOTER_RESERVE_MM
    const octubre = layoutTallSoloBesideHeader(0.75, SAFE_BOX_MM, availableHeightMm, 'octubre 2025', false);
    expect(octubre.wMm).toBeGreaterThan(110);
    const julio = layoutTallSoloBesideHeader(0.75, SAFE_BOX_MM, availableHeightMm, 'julio 2025', false);
    expect(julio.wMm).toBeGreaterThan(110);
  });
});

describe('soloVideoScanPlacement / layoutSoloVideoAnchor (owner review round 9, item 4 — solo-video scan-group placement)', () => {
  const FOOTER_RESERVE_MM = 22;
  const availableHeightMm = SAFE_BOX_MM - FOOTER_RESERVE_MM;

  it('places the group at the free LEFT side of a beside-header (right-aligned) image when there is enough room', () => {
    // A narrow, tall column (small max width) leaves plenty of clear space
    // to its own left within the safe box.
    const rect = layoutTallSoloBesideHeader(0.4, SAFE_BOX_MM, availableHeightMm, 'may 2025', false);
    expect(rect.xMm).toBeGreaterThanOrEqual(SOLO_VIDEO_SCAN_MIN_SIDE_MM);
    expect(soloVideoScanPlacement(rect, SAFE_BOX_MM, true)).toBe('left');
  });

  it('places the group at the free RIGHT side of a centered image when there is enough room', () => {
    const rect = layoutSoloAnchor(0.4, SAFE_BOX_MM, availableHeightMm);
    const freeRight = SAFE_BOX_MM - (rect.xMm + rect.wMm);
    expect(freeRight).toBeGreaterThanOrEqual(SOLO_VIDEO_SCAN_MIN_SIDE_MM);
    expect(soloVideoScanPlacement(rect, SAFE_BOX_MM, false)).toBe('right');
  });

  it('falls back to below when a wide CENTERED image leaves no side room', () => {
    // A solo video's centered arrangement can be any aspect (unlike
    // besideHeader, which only ever applies to a TALL image in practice —
    // see AnchorMedia.tsx's own `isTallSoloBesideHeader` gate) — a wide
    // video fills most of the safe box's width, leaving neither side clear.
    const wideCentered = layoutSoloAnchor(1.9, SAFE_BOX_MM, availableHeightMm);
    expect(SAFE_BOX_MM - (wideCentered.xMm + wideCentered.wMm)).toBeLessThan(SOLO_VIDEO_SCAN_MIN_SIDE_MM);
    expect(soloVideoScanPlacement(wideCentered, SAFE_BOX_MM, false)).toBe('below');
  });

  it('the placement threshold is exact: exactly at SOLO_VIDEO_SCAN_MIN_SIDE_MM free space still qualifies for the side; just under it falls back to below', () => {
    const rectAt: import('../anchorMediaLayout').AnchorRect = { xMm: 0, yMm: 0, wMm: SAFE_BOX_MM - SOLO_VIDEO_SCAN_MIN_SIDE_MM, hMm: 100 };
    expect(soloVideoScanPlacement(rectAt, SAFE_BOX_MM, false)).toBe('right');
    const rectUnder: import('../anchorMediaLayout').AnchorRect = { xMm: 0, yMm: 0, wMm: SAFE_BOX_MM - SOLO_VIDEO_SCAN_MIN_SIDE_MM + 1, hMm: 100 };
    expect(soloVideoScanPlacement(rectUnder, SAFE_BOX_MM, false)).toBe('below');
  });

  it('layoutSoloVideoAnchor never overflows the available box in any placement', () => {
    for (const aspect of [0.4, 0.56, 0.75, 1, 1.5, 1.78, 2.4]) {
      for (const besideHeader of [true, false]) {
        const { rect } = layoutSoloVideoAnchor(aspect, SAFE_BOX_MM, availableHeightMm, besideHeader, 'julio 2025', false);
        expect(rect.xMm).toBeGreaterThanOrEqual(-1e-6);
        expect(rect.yMm).toBeGreaterThanOrEqual(-1e-6);
        expect(rect.xMm + rect.wMm).toBeLessThanOrEqual(SAFE_BOX_MM + 1e-6);
        expect(rect.yMm + rect.hMm).toBeLessThanOrEqual(availableHeightMm + 1e-6);
      }
    }
  });

  it('when the placement falls back to below, the image height leaves the PHOTO_META_RESERVE_MM strip clear (matches the pre-round-9 below-strip behavior)', () => {
    const { rect, placement } = layoutSoloVideoAnchor(1.9, SAFE_BOX_MM, availableHeightMm, false);
    expect(placement).toBe('below');
    expect(rect.hMm + PHOTO_META_RESERVE_MM).toBeLessThanOrEqual(availableHeightMm + 1e-6);
  });

  it('a side placement lets the image grow past what the below-fallback would allow (the reserve is genuinely freed)', () => {
    const { rect: sideRect, placement } = layoutSoloVideoAnchor(0.56, SAFE_BOX_MM, availableHeightMm, false);
    expect(placement).not.toBe('below');
    // The below-fallback path, forced by passing a wide aspect that can
    // never clear the side threshold, for the SAME height budget.
    const belowHeightBudget = availableHeightMm - PHOTO_META_RESERVE_MM;
    const belowOnlyRect = layoutSoloAnchor(0.56, SAFE_BOX_MM, belowHeightBudget);
    expect(sideRect.hMm).toBeGreaterThanOrEqual(belowOnlyRect.hMm);
  });
});


describe('tallSoloCanSitBesideHeader (round-16 follow-up: wrapping titles force the below-header layout)', () => {
  it('allows beside-header placement for a short single-line month title', () => {
    expect(tallSoloCanSitBesideHeader(190, 'mayo 2025', false)).toBe(true);
  });

  it('refuses beside-header placement when the title wraps (long special birth-month title) — the audit caught a real regenerated page where even the 50% floor cap started left of the modeled title edge', () => {
    expect(tallSoloCanSitBesideHeader(190, 'El mes en que llegaste a casa', true)).toBe(false);
  });
});
