import { PHYSICAL } from '../../model/types';
import { snapToBaseline, MIN_IMAGE_SIDE_MM, MIN_PAIR_FILL_RATIO, modelSectionHeaderTitle, VIDEO_BELOW_SCAN_FOOTER_EXTRA_MM } from '../mm';

/**
 * Solo/pair anchor-media sizing (owner review round 3 items 3/4/6, round 4
 * items 2/6, round 5 item 3/amendment, round 7 item 1): a solo image is
 * large by default at its OWN native aspect (no forced crop-box, no
 * lavender containment — that's a multi-photo-grid-only concept now), and
 * a two-photo pair sizes asymmetrically. Dominance in a pair is ASPECT-
 * AWARE (round 4 item 6): whichever photo is more elongated (wide OR tall)
 * wins the dominant slot and claims its own natural axis in full — a
 * caller-supplied `dominantIsA` hint only breaks a near-tie between two
 * similarly-elongated (or both square-ish) photos. Everything here is
 * clamped to the caller's content box (item 14: a tall/portrait video must
 * never overflow the safe area and cover its own footer/credit).
 *
 * Round-7 item 1a ("fill-the-canvas sizing"): a solo/dominant image now
 * always sizes to the MAXIMUM the aspect + available box allow — never an
 * arbitrary fill FRACTION. The subordinate's own non-shared axis (item 1b)
 * dropped its width-fraction cap too — reserving a FRACTION of the width
 * for it turned out to under-fill the very floor/relative-size reservation
 * made for it on the SHARED axis (a landscape subordinate boxed into a
 * narrow column renders shorter than its own height reservation, wasting
 * it) — it now gets the FULL remaining span on that axis and is
 * height/width-constrained by its own aspect and the shared-axis
 * reservation instead, which also keeps it reading as subordinate (a
 * fraction of the dominant's area) without an arbitrary ceiling. `fill`
 * is kept in both functions' signatures for call-site compatibility (the
 * caller's header/footer reserves are already baked into the width/height
 * arguments) but no longer changes behavior anywhere in this module.
 *
 * Round-8 items 1/2: `layoutAnchorPair`'s wide-dominant branch now falls
 * back from a vertical stack to a side-by-side (WIDTH-axis) arrangement
 * whenever the stack would invert dominance on a squeezed content height
 * (see `layoutAnchorPair`'s own comment), and `anchorPairMeetsMinSize` gates
 * on that same dominance invariant directly. A tall solo on a header page
 * gets its own new arrangement, `layoutTallSoloBesideHeader`.
 *
 * Pure geometry, no DOM — same rules for the browser preview and a future
 * Node print pipeline.
 */

export interface AnchorRect {
  xMm: number;
  yMm: number;
  wMm: number;
  hMm: number;
}

export type Orientation = 'tall' | 'square' | 'wide';

const TALL_MAX_ASPECT = 0.85;
const WIDE_MIN_ASPECT = 1.15;

export function classifyOrientation(aspect: number): Orientation {
  if (aspect < TALL_MAX_ASPECT) return 'tall';
  if (aspect > WIDE_MIN_ASPECT) return 'wide';
  return 'square';
}

/**
 * Round-7 item 1b ("subordinate floor rises"): a subordinate's short side
 * must clear BOTH a flat floor and a fraction of the DOMINANT's own
 * resulting short side — replacing round-5's flat 45mm-or-25%-of-box rule,
 * which could still read as a tiny thumbnail next to a generously
 * maximized dominant (round-7 item 1a). When neither the flat floor nor
 * the relative rule can be satisfied in the available area, the fitter
 * splits the pair onto separate pages instead (`anchorPairMeetsMinSize`
 * below reports this; the split itself is the fitter's own existing rule).
 */
const SUBORDINATE_MIN_SHORT_SIDE_MM = 60;
const SUBORDINATE_RELATIVE_MIN_FRACTION = 0.55;
/**
 * Owner round-11: how decisively a vertical STACK's dominant must beat the
 * subordinate's short side for the stack to be kept — at 1.0 (the old bare
 * `>=`) an exact tie produced two equal small stamps; a stack should read
 * hierarchical or not exist. Below this ratio the pair lays out
 * side-by-side instead.
 */
const STACK_DOMINANCE_MIN_RATIO = 1.15;
/**
 * Round 4 item 6: how close two photos' elongation scores must be (as a
 * fraction of the larger one) before aspect alone can't decide dominance
 * and the caller's own hint (the pairing feature's dominant memory, or an
 * outline highlight) breaks the tie. `elongation()` is 1.0 for a perfect
 * square and grows for either a wide or a tall photo, so two photos this
 * close are both "similarly shaped" (typically both square-ish).
 */
const DOMINANCE_TIE_TOLERANCE = 0.08;
/**
 * Round-5 item 3 (overlap regression): every photo tile renders its own
 * numeral + scan-mark row just PAST its own bottom edge (see PhotoTile.css
 * — the meta strip is `position:absolute; top:100%`, entirely outside the
 * rect this module hands back). Neither branch below previously reserved
 * any room for it, so a generously-sized dominant box could push its own
 * meta strip (or even its own body) into the subordinate's box. This is an
 * approximate reserve at full-page (216mm) scale for that strip — the
 * owner may retune. Exported so the integrity audit can recompute the same
 * padded boxes it checks for overlap.
 */
export const PHOTO_META_RESERVE_MM = 10;

/** How far a photo is from square — 1.0 at a perfect square, growing for either a wide or a tall aspect. Symmetric so "wide" and "tall" compete on equal footing. */
function elongation(aspect: number): number {
  return Math.max(aspect, 1 / aspect);
}

/** The largest box of the given aspect ratio that fits within maxWidth x maxHeight — an "object-fit: contain" sizing, never cropping. */
function fitAspectBox(aspect: number, maxWidthMm: number, maxHeightMm: number): { wMm: number; hMm: number } {
  let wMm = Math.max(0, maxWidthMm);
  let hMm = wMm / aspect;
  if (hMm > maxHeightMm) {
    hMm = Math.max(0, maxHeightMm);
    wMm = hMm * aspect;
  }
  return { wMm, hMm };
}

/**
 * Which of aspectA/aspectB wins the dominant slot — factored out so
 * `layoutAnchorPair` and `anchorPairMeetsMinSize` can never disagree about
 * which rect is which. See the module doc comment for the aspect-aware
 * dominance rule.
 */
function decideDominance(aspectA: number, aspectB: number, dominantIsA: boolean): boolean {
  const elongA = elongation(aspectA);
  const elongB = elongation(aspectB);
  const isTie = Math.abs(elongA - elongB) <= DOMINANCE_TIE_TOLERANCE * Math.max(elongA, elongB);
  return isTie ? dominantIsA : elongA > elongB;
}

/**
 * Round-7 item 1b: the largest share of `availableMm` (already net of
 * `reserveMm` — gutter, meta strip, etc.) the DOMINANT may claim along the
 * axis it shares with the subordinate, such that whatever remains still
 * gives the subordinate at least `SUBORDINATE_MIN_SHORT_SIDE_MM` OR
 * `SUBORDINATE_RELATIVE_MIN_FRACTION` of the dominant's own resulting
 * share — whichever is larger. Solved algebraically rather than searched:
 * if the relative rule would bind (`REL * dom >= FLOOR` at the solution
 * point), `dom + REL*dom = usable`; otherwise the flat floor binds and
 * `dom = usable - FLOOR`. This is what replaces the old arbitrary
 * fill-fraction ceiling (item 1a) — the dominant now claims EVERYTHING not
 * required to keep the subordinate above its floor, never less.
 */
function solveDominantShare(availableMm: number, reserveMm: number): number {
  const usable = Math.max(0, availableMm - reserveMm);
  const relativeSolution = usable / (1 + SUBORDINATE_RELATIVE_MIN_FRACTION);
  if (SUBORDINATE_RELATIVE_MIN_FRACTION * relativeSolution >= SUBORDINATE_MIN_SHORT_SIDE_MM) {
    return relativeSolution;
  }
  return Math.max(0, usable - SUBORDINATE_MIN_SHORT_SIDE_MM);
}

/**
 * Solo image (item 3, maximized per round-7 item 1a): large at native
 * aspect, filling the ENTIRE available box (never an arbitrary target size
 * or fill fraction) and clamped so it can never overflow (item 14).
 * Snapping to the baseline grid never pushes the box past the clamp —
 * `Math.min` keeps the raw fitted size as the ceiling. `fill` is accepted
 * for call-site compatibility (the caller's header/footer reserves are
 * already baked into `availableWidthMm`/`availableHeightMm`) but no longer
 * changes behavior — every solo image fills to maximum regardless.
 */
export function layoutSoloAnchor(
  aspect: number,
  availableWidthMm: number,
  availableHeightMm: number,
  _fill = false,
): AnchorRect {
  const { wMm, hMm } = fitAspectBox(aspect, availableWidthMm, availableHeightMm);
  const snappedH = Math.min(hMm, snapToBaseline(hMm));
  const snappedW = Math.min(wMm, snappedH * aspect);
  return {
    wMm: snappedW,
    hMm: snappedH,
    xMm: (availableWidthMm - snappedW) / 2,
    yMm: (availableHeightMm - snappedH) / 2,
  };
}

/**
 * Two-photo pair (round 3 item 6, revised round 4 item 6, overlap fixed
 * round 5 item 3, reworked round 7 items 1a/1b): dominance is decided by
 * ASPECT, not order — whichever photo is more elongated (`elongation()`)
 * wins and claims its own natural axis IN FULL, up to the maximum the
 * subordinate's own floor allows (`solveDominantShare`) — never an
 * arbitrary fill fraction. `dominantIsA` (the pairing feature's own
 * dominant call, or an outline highlight) only breaks a near-tie between
 * two similarly-elongated photos.
 *
 * Bug fix (round-5 item 3, preserved): the subordinate's minimum (now the
 * round-7 floor/relative rule) is reserved BEFORE sizing the dominant —
 * plus `PHOTO_META_RESERVE_MM` for whichever tile's meta strip sits in the
 * shared margin — so the two boxes, and their meta strips, can never
 * intersect, by construction.
 */
/**
 * Tall/square-ish dominant sits LEFT (vertically centered); the subordinate
 * sits bottom-RIGHT. Horizontal separation is solved via `solveDominantShare`
 * (item 1b) — the dominant claims the maximum width the subordinate's
 * floor/relative rule allows — and may still claim the FULL height (owner
 * round-3 item 6's own tested invariant: "the tall photo claims the full
 * available column height"). Its own meta strip, when centered, spills past
 * the canvas bottom into the template's own FOOTER_RESERVE_MM buffer (22mm,
 * comfortably more than PHOTO_META_RESERVE_MM's 10mm) rather than
 * overlapping anything — no separate height cap needed here.
 *
 * Round-8 item 1: also the fallback arrangement for a WIDE dominant when the
 * vertical stack (`layoutWideVerticalStack`) can't keep it dominant — see
 * `layoutAnchorPair`'s own comment.
 */
const shortSideOf = (r: { wMm: number; hMm: number }): number => Math.min(r.wMm, r.hMm);

/**
 * Round-8 item 1 correctness fix: solves the WIDTH split for `layoutSideBySide`
 * against the two photos' ACTUAL resulting short sides (via `fitAspectBox`),
 * not a closed-form mm formula on the divided axis. `solveDominantShare`'s
 * algebra (used for the vertical stack, where the divided HEIGHT axis
 * always IS the wide dominant's own short-side axis) implicitly assumes the
 * divided axis and each photo's own short-side axis coincide — true for the
 * width axis only when both photos are tall-or-square (their short side IS
 * their width). A WIDE photo's short side is its HEIGHT instead (scaling as
 * width/aspect), so reserving raw mm of WIDTH for a wide subordinate's
 * "floor" under-delivers its actual (height) floor — the exact mismatch
 * that let a wide+wide pair's side-by-side fallback still fail its own
 * subordinate floor. Binary search sidesteps needing separate closed-form
 * algebra per orientation combination: both resulting short sides are
 * monotonic in the dominant's width share (dominant's non-decreasing,
 * subordinate's non-increasing — even where each briefly plateaus width-
 * vs-height-bound), so the search converges to the same largest feasible
 * dominant share the original closed form found whenever that form was
 * already exact (both tall/square), and to a genuinely correct split when
 * it wasn't.
 */
function solveSideBySideDominantWidth(dominantAspect: number, subordinateAspect: number, widthMm: number, heightMm: number, gutter: number): number {
  const usable = Math.max(0, widthMm - gutter);
  let lo = 0;
  let hi = usable;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const domShort = shortSideOf(fitAspectBox(dominantAspect, mid, heightMm));
    const subShort = shortSideOf(fitAspectBox(subordinateAspect, Math.max(0, usable - mid), heightMm));
    const required = Math.max(SUBORDINATE_MIN_SHORT_SIDE_MM, SUBORDINATE_RELATIVE_MIN_FRACTION * domShort);
    if (subShort >= required) {
      lo = mid; // subordinate still clears its floor — the dominant can claim more
    } else {
      hi = mid;
    }
  }
  return lo;
}

function layoutSideBySide(
  dominantAspect: number,
  subordinateAspect: number,
  widthMm: number,
  heightMm: number,
  gutter: number,
): [AnchorRect, AnchorRect] {
  const domCapW = solveSideBySideDominantWidth(dominantAspect, subordinateAspect, widthMm, heightMm, gutter);
  const domBox = fitAspectBox(dominantAspect, domCapW, heightMm);
  const remainingW = Math.max(0, widthMm - domBox.wMm - gutter);
  const subBox = fitAspectBox(subordinateAspect, remainingW, heightMm);
  const dominantRect: AnchorRect = { wMm: domBox.wMm, hMm: domBox.hMm, xMm: 0, yMm: (heightMm - domBox.hMm) / 2 };
  const subordinateRect: AnchorRect = { wMm: subBox.wMm, hMm: subBox.hMm, xMm: widthMm - subBox.wMm, yMm: heightMm - subBox.hMm };
  return [dominantRect, subordinateRect];
}

/**
 * Wide dominant stacks ABOVE the subordinate — claims the MAXIMUM height the
 * subordinate's floor/relative rule allows (item 1b), reserving the gutter
 * and the dominant's own meta strip first. The subordinate then gets the
 * FULL remaining width — no fraction cap (see the module doc comment) — and
 * is naturally constrained by `remainingH` and its own aspect instead.
 */
function layoutWideVerticalStack(
  dominantAspect: number,
  subordinateAspect: number,
  widthMm: number,
  heightMm: number,
  gutter: number,
): [AnchorRect, AnchorRect] {
  const reserveBelowDominant = gutter + PHOTO_META_RESERVE_MM;
  const domCapH = solveDominantShare(heightMm, reserveBelowDominant);
  const domBox = fitAspectBox(dominantAspect, widthMm, domCapH);
  const remainingH = Math.max(0, heightMm - domBox.hMm - reserveBelowDominant);
  const subBox = fitAspectBox(subordinateAspect, widthMm, remainingH);
  const dominantRect: AnchorRect = { wMm: domBox.wMm, hMm: domBox.hMm, xMm: (widthMm - domBox.wMm) / 2, yMm: 0 };
  const subordinateRect: AnchorRect = { wMm: subBox.wMm, hMm: subBox.hMm, xMm: widthMm - subBox.wMm, yMm: heightMm - subBox.hMm };
  return [dominantRect, subordinateRect];
}

export function layoutAnchorPair(
  aspectA: number,
  aspectB: number,
  dominantIsA: boolean,
  widthMm: number,
  heightMm: number,
  _fill = false,
): [AnchorRect, AnchorRect] {
  const gutter = PHYSICAL.gutterMm;
  const aIsDominant = decideDominance(aspectA, aspectB, dominantIsA);

  const dominantAspect = aIsDominant ? aspectA : aspectB;
  const subordinateAspect = aIsDominant ? aspectB : aspectA;

  let dominantRect: AnchorRect;
  let subordinateRect: AnchorRect;

  if (classifyOrientation(dominantAspect) === 'wide') {
    // Round-8 item 1 (dominance-inversion bug fix — owner screenshots,
    // ~22% page fill): the vertical stack is the default composition for a
    // wide dominant, but on a squeezed content height (typically a
    // section-header page — SAFE_BOX_MM 190 - SECTION_HEADER_RESERVE_MM 45
    // - FOOTER_RESERVE_MM 22 = 123mm) `solveDominantShare`'s flat-floor
    // branch can cap the dominant's height so low it ends up SHORTER than
    // the subordinate's own floor — dominance inverts, and the pair reads
    // as tiny images floating in white. Try the vertical stack first (it's
    // the better-looking composition when it works); if it would invert,
    // fall back to laying the two photos SIDE BY SIDE sharing the WIDTH
    // axis instead — a wide photo's natural height is already small
    // relative to its width, so a tight height budget barely constrains it
    // there, and the dominant reliably stays dominant.
    const [stackedDominant, stackedSubordinate] = layoutWideVerticalStack(dominantAspect, subordinateAspect, widthMm, heightMm, gutter);
    const shortSide = (r: AnchorRect) => Math.min(r.wMm, r.hMm);
    // Owner round-11 ("tiny title-page images again"): a bare `>=` here let
    // an exact TIE through — the round-10 reserve retune landed a header
    // page's two 4:3 photos precisely on the flat-floor boundary (dominant
    // 60mm == subordinate's 60mm floor), rendering two equal 80×60 stamps.
    // A stack only reads as a deliberate composition when the dominant is
    // CLEARLY dominant, so it must now beat the subordinate's short side by
    // a real margin or the pair goes side-by-side (where the width axis
    // gives the same photos ~105×79 + 80×60 — the owner-approved look).
    if (shortSide(stackedDominant) >= STACK_DOMINANCE_MIN_RATIO * shortSide(stackedSubordinate)) {
      [dominantRect, subordinateRect] = [stackedDominant, stackedSubordinate];
    } else {
      [dominantRect, subordinateRect] = layoutSideBySide(dominantAspect, subordinateAspect, widthMm, heightMm, gutter);
    }
  } else {
    [dominantRect, subordinateRect] = layoutSideBySide(dominantAspect, subordinateAspect, widthMm, heightMm, gutter);
  }

  return aIsDominant ? [dominantRect, subordinateRect] : [subordinateRect, dominantRect];
}

/**
 * Round-5 amendment, floor raised round-7 item 1b, fill-ratio gate added
 * round-7 item 1a/3a: true only when the dominant clears the general
 * sanity floor (`MIN_IMAGE_SIDE_MM`), the subordinate clears its own
 * combined floor (`SUBORDINATE_MIN_SHORT_SIDE_MM` OR
 * `SUBORDINATE_RELATIVE_MIN_FRACTION` of the dominant's resulting short
 * side, whichever is larger), AND the pair TOGETHER still cover a sane
 * share of the FULL undiminished safe box (`widthMm` squared — the safe box
 * is square) — `MIN_PAIR_FILL_RATIO`, matching that constant's own
 * documented round-7 semantics ("a header-reduced page is still held to
 * the same bar"). Round-8 briefly measured against the header-reduced
 * content box instead, on the theory that penalizing header pages was
 * unfair — three owner reviews of tiny header-page pairs later, the
 * verdict is in: how much of the PHYSICAL PAGE the photos cover is what
 * the eye judges, headers or not. A pair that can't cover ~28% of the
 * page splits to two maximized solos instead. A diagnosed live
 * case had two same-aspect photos each individually clear the first two
 * rules while the whole composition still only covered ~34% of ITS OWN
 * content box (a near-square dominant, height-starved by the
 * subordinate's floor under a section header, couldn't use the width it
 * had). The fitter calls this BEFORE committing to a two-photo
 * anchor-media page — when it comes back false, the pair splits onto two
 * separate solo pages instead (each maximized on its own, per item 1a —
 * almost always a much better fill ratio than a cramped shared page).
 * This function never adjusts the layout itself — it only reports whether
 * the layout `layoutAnchorPair` would otherwise produce is acceptable,
 * keeping "decide" (fitter) and "compute geometry" (this module) cleanly
 * separated.
 */
export function anchorPairMeetsMinSize(
  aspectA: number,
  aspectB: number,
  dominantIsA: boolean,
  widthMm: number,
  heightMm: number,
  fill = false,
): boolean {
  const [rectA, rectB] = layoutAnchorPair(aspectA, aspectB, dominantIsA, widthMm, heightMm, fill);
  const aIsDominant = decideDominance(aspectA, aspectB, dominantIsA);
  const dominantRect = aIsDominant ? rectA : rectB;
  const subordinateRect = aIsDominant ? rectB : rectA;
  const shortSide = (r: AnchorRect) => Math.min(r.wMm, r.hMm);
  const domShort = shortSide(dominantRect);
  const subShort = shortSide(subordinateRect);
  const requiredSubShort = Math.max(SUBORDINATE_MIN_SHORT_SIDE_MM, SUBORDINATE_RELATIVE_MIN_FRACTION * domShort);
  const fillRatio = (dominantRect.wMm * dominantRect.hMm + subordinateRect.wMm * subordinateRect.hMm) / (widthMm * widthMm);
  // A tiny epsilon absorbs float-precision noise at the exact boundary
  // (the reservation above can land a box AT the floor, not just above it).
  const EPSILON_MM = 1e-6;
  const EPSILON_RATIO = 1e-9;
  // Round-8 item 1 DOMINANCE INVARIANT: the dominant's short side must never
  // end up SMALLER than the subordinate's — the exact inversion bug
  // `layoutAnchorPair`'s wide-dominant side-by-side fallback exists to
  // avoid. Kept here too (not just as a self-check inside `layoutAnchorPair`)
  // as the general backstop for EVERY arrangement this module can produce —
  // when it or the floors above can't be met, the fitter's existing
  // split-to-solo path fires instead of ever rendering an inverted pair.
  const dominanceHolds = domShort >= subShort - EPSILON_MM;
  return (
    domShort >= MIN_IMAGE_SIDE_MM - EPSILON_MM &&
    subShort >= requiredSubShort - EPSILON_MM &&
    fillRatio >= MIN_PAIR_FILL_RATIO - EPSILON_RATIO &&
    dominanceHolds
  );
}

// ---------------------------------------------------------------------------
// Round-8 item 2: tall solo beside a section header.
// ---------------------------------------------------------------------------

/**
 * A TALL solo image (`classifyOrientation` === 'tall' — a portrait photo or
 * video still) on a section-header page used to sit BELOW the header,
 * capped to whatever sliver of height the header reserve left it (~123mm on
 * a header+footer page) — badly under-using a tall image's own natural
 * shape. It now claims a right-hand column at nearly the FULL available
 * height instead (the caller passes `availableHeightMm` net of only the
 * FOOTER reserve, not the header reserve — see `AnchorMedia.tsx` /
 * `audit.ts`), with the header's own kicker+title occupying the top-left as
 * before.
 *
 * The column's WIDTH cap (round-9 item 3, replacing the old flat
 * `TALL_SOLO_HEADER_MAX_WIDTH_FRACTION`-always rule) is a function of the
 * header's own title — see `tallSoloHeaderWidthCapMm`.
 */
const TALL_SOLO_HEADER_MAX_WIDTH_FRACTION = 0.5;
/** Round-9 item 3: the image column may grow past the old flat cap up to this ceiling, however short the title is — never further. */
const TALL_SOLO_HEADER_MAX_WIDTH_FRACTION_GROWN = 0.65;
/** Clearance kept between the image column's left edge and the title's own modeled right edge. */
const TALL_SOLO_TITLE_CLEARANCE_MM = 10;

/**
 * Round-9 item 3: the max width the tall-solo column may claim, given the
 * header's own title (or none — a headed page always has SOME title text,
 * but the signature stays defensive). A long/two-line title (per
 * `modelSectionHeaderTitle`'s `wraps` flag) keeps the OLD flat 50% cap —
 * this module is pure/no-DOM, so it can't measure a wrapped title's actual
 * widest rendered line, and the 50% floor was already the safe bound for
 * that case. A short, comfortably single-line title instead grows the
 * column until only `TALL_SOLO_TITLE_CLEARANCE_MM` separates it from the
 * title's own modeled right edge, capped at `TALL_SOLO_HEADER_MAX_WIDTH_FRACTION_GROWN`
 * — and never below the old 50% floor either, so this can only grow the
 * column relative to the pre-round-9 behavior, never shrink it.
 */
export function tallSoloHeaderWidthCapMm(safeBoxWidthMm: number, title: string | null, special: boolean): number {
  const floorMm = safeBoxWidthMm * TALL_SOLO_HEADER_MAX_WIDTH_FRACTION;
  const model = modelSectionHeaderTitle(safeBoxWidthMm, title, special);
  if (model.wraps) return floorMm;
  const clearanceCapMm = safeBoxWidthMm - model.widthMm - TALL_SOLO_TITLE_CLEARANCE_MM;
  const ceilingMm = safeBoxWidthMm * TALL_SOLO_HEADER_MAX_WIDTH_FRACTION_GROWN;
  return Math.max(floorMm, Math.min(clearanceCapMm, ceilingMm));
}

export function layoutTallSoloBesideHeader(
  aspect: number,
  safeBoxWidthMm: number,
  availableHeightMm: number,
  title: string | null = null,
  special = false,
): AnchorRect {
  const maxWidthMm = tallSoloHeaderWidthCapMm(safeBoxWidthMm, title, special);
  const { wMm, hMm } = fitAspectBox(aspect, maxWidthMm, availableHeightMm);
  const snappedH = Math.min(hMm, snapToBaseline(hMm));
  const snappedW = Math.min(wMm, snappedH * aspect);
  return {
    wMm: snappedW,
    hMm: snappedH,
    xMm: safeBoxWidthMm - snappedW, // right-aligned
    yMm: (availableHeightMm - snappedH) / 2, // vertically centered in the header-to-footer band
  };
}

// ---------------------------------------------------------------------------
// Round-9 item 4: solo-video scan-group placement.
// ---------------------------------------------------------------------------

export type SoloVideoScanPlacement = 'left' | 'right' | 'below';

/**
 * Minimum clear width the scan-to-watch text+QR group needs when placed
 * BESIDE (rather than below) a solo video's image — a generous bound on
 * the group's own real footprint (`QR_SIZE_MM` = 13mm plus the
 * "scan to watch" text at its own small size plus their internal gap,
 * comfortably under half this — see PhotoTile.css `.photo-tile__scan`).
 * Shared by the layout function, the template (`AnchorMedia.tsx`, which
 * decides which CSS variant to render), and the audit (which recomputes
 * the same side/below decision) so none of the three can ever disagree
 * about which side — or whether — a given image's scan group fits beside
 * it. Owner-tunable.
 *
 * Owner round-10: lowered from 46 to 25 — the scan group now stacks
 * VERTICALLY in the side placements (text above QR, ~19mm wide vs the old
 * ~33mm row), and the owner wants side placement PREFERRED so the image
 * can grow: 25mm = the stacked group's width + its 0.6em edge margin + a
 * little breathing room.
 */
export const SOLO_VIDEO_SCAN_MIN_SIDE_MM = 25;

/**
 * Which side (or the `'below'` fallback) the scan-to-watch group renders
 * on for a SOLO video's image, given the image's own already-computed rect
 * (from `layoutSoloAnchor`/`layoutTallSoloBesideHeader`, BEFORE any
 * meta-reserve adjustment — see `layoutSoloVideoAnchor`). A `besideHeader`
 * image is right-aligned, so its free space is to the LEFT; a centered
 * image's free space is symmetric, so the group defaults to its RIGHT (the
 * side away from a header's own text column, kept consistent whether or
 * not this particular page happens to carry a header).
 */
export function soloVideoScanPlacement(imageRect: AnchorRect, safeBoxWidthMm: number, besideHeader: boolean): SoloVideoScanPlacement {
  if (besideHeader) {
    const freeLeftMm = imageRect.xMm;
    return freeLeftMm >= SOLO_VIDEO_SCAN_MIN_SIDE_MM ? 'left' : 'below';
  }
  const freeRightMm = safeBoxWidthMm - (imageRect.xMm + imageRect.wMm);
  return freeRightMm >= SOLO_VIDEO_SCAN_MIN_SIDE_MM ? 'right' : 'below';
}

export interface SoloVideoLayoutResult {
  rect: AnchorRect;
  placement: SoloVideoScanPlacement;
}

/**
 * Round-9 item 4: a SOLO video's image normally reserves
 * `PHOTO_META_RESERVE_MM` of vertical room below it for its own
 * scan-to-watch group (the `.photo-tile__meta` strip, `top:100%` in
 * PhotoTile.css) — freed here whenever there's enough width on the image's
 * free side to anchor the group there instead (`soloVideoScanPlacement`),
 * letting the image grow slightly taller. Computes the candidate rect
 * WITHOUT the reserve first (needed to know if there's side room in the
 * first place — the reserve only ever affects the image's HEIGHT, never
 * its horizontal position, so this is safe); only re-applies the reserve,
 * and re-fits, when the side placement doesn't have room and the caller
 * falls back to `'below'`. `AnchorMedia.tsx` and `audit.ts` both call this
 * SAME function (never `layoutSoloAnchor`/`layoutTallSoloBesideHeader`
 * directly) for a solo video tile, so the two can never disagree about
 * when the reserve applies.
 */
export function layoutSoloVideoAnchor(
  aspect: number,
  safeBoxWidthMm: number,
  availableHeightMm: number,
  besideHeader: boolean,
  title: string | null = null,
  special = false,
): SoloVideoLayoutResult {
  const base = besideHeader
    ? layoutTallSoloBesideHeader(aspect, safeBoxWidthMm, availableHeightMm, title, special)
    : layoutSoloAnchor(aspect, safeBoxWidthMm, availableHeightMm);
  const placement = soloVideoScanPlacement(base, safeBoxWidthMm, besideHeader);
  if (placement !== 'below') return { rect: base, placement };
  // Owner round-10: the caller's `availableHeightMm` is computed with the
  // base (strip-less) footer reserve — the below-strip fallback must ALSO
  // make room for the extra footer allowance a below-scan video needs
  // (`VIDEO_BELOW_SCAN_FOOTER_EXTRA_MM`), or the strip lands on the footer
  // rule (owner screenshot, round-10).
  const reservedHeightMm = Math.max(0, availableHeightMm - PHOTO_META_RESERVE_MM - VIDEO_BELOW_SCAN_FOOTER_EXTRA_MM);
  const rect = besideHeader
    ? layoutTallSoloBesideHeader(aspect, safeBoxWidthMm, reservedHeightMm, title, special)
    : layoutSoloAnchor(aspect, safeBoxWidthMm, reservedHeightMm);
  return { rect, placement };
}
