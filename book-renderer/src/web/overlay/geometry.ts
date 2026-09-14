import type { BookPage, PhotoSlotContent } from '../../model/types';
import type { FooterIndexEntry } from '../../templates/common/FooterIndex.types';
import { COVER_SLOT_KEY } from '../../model/edits';

/**
 * Pure geometry-MATCHING logic for the inline-editing overlay (polish-round
 * item 3). Everything here is plain data-in/data-out — no DOM, no React —
 * so it's unit-testable without a browser/jsdom dependency. The actual DOM
 * reads (`querySelector`, `getBoundingClientRect`) live in
 * `useOverlayGeometry.ts`, which interprets the plans this module produces.
 *
 * Architectural note (documented deviation from a literal "recompute mm
 * rects from the layout modules" reading of the polish-round brief): a
 * template's own layout module (`layout/flexGridLayout.ts`,
 * `layout/anchorMediaLayout.ts`, ...) only accounts for PART of a
 * template's real geometry — header reserves, safe-box insets, footer
 * strips, and (for text) actual rendered glyph metrics are computed inline
 * in the template component itself, not exposed as data. Re-deriving all of
 * that by hand here would duplicate real layout code with no shared source
 * of truth — exactly the class of drift bug this codebase's own comments
 * repeatedly flag as dangerous (see e.g. `mm.ts`'s "round-8 item 4... %-basis
 * drift bug shipped twice"). Instead, this module identifies each editable
 * region by a STABLE DOM selector (a className the template already renders
 * for an unrelated reason, e.g. `.photo-tile__frame`) or a small amount of
 * structural traversal (e.g. "the title `<h2>`'s previous sibling's first
 * child is the kicker") — never a new prop, class, or markup change on any
 * template component. `useOverlayGeometry` then reads the ACTUAL rendered
 * `getBoundingClientRect()` for that node, which is the real mm-based
 * layout already turned into px by the browser — "mm -> px is a
 * multiplication" the browser itself performs, with zero risk of the
 * overlay's math disagreeing with what actually rendered.
 */

// ---------------------------------------------------------------------------
// Photo regions
// ---------------------------------------------------------------------------

/** CSS selector (relative to one page's own `.page-frame` root) for the DOM node(s) a photo template renders its slot(s) in — in the SAME order `page.slots` (filtered to `kind === 'photo'`) lists them, for every template whose photo-tile-per-slot rendering order matches array order 1:1. */
export const PHOTO_TILE_SELECTOR = '.photo-tile__frame';
/** `full-bleed`/`panorama-spread`/cover-wrap render their one photo directly, not via `PhotoTile` — each gets its own single-node selector instead. */
export const FULL_BLEED_IMG_SELECTOR = '.full-bleed__img';
export const PANORAMA_IMG_SELECTOR = '.panorama__img';
export const COVER_PHOTO_SELECTOR = '.cover-wrap__photo';

const MULTI_SLOT_PHOTO_TEMPLATES = new Set(['flex-grid', 'anchor-media', 'photo-story']);

/** Which selector (and whether it's a single-node or per-slot-in-order template) a page's photo slot(s) render behind. `null` for a template with no editable photo affordance (illustration/portrait/audio-only templates). */
export function photoSelectorPlanForPage(page: BookPage): { selector: string; perSlot: boolean } | null {
  if (MULTI_SLOT_PHOTO_TEMPLATES.has(page.templateId)) return { selector: PHOTO_TILE_SELECTOR, perSlot: true };
  if (page.templateId === 'full-bleed') return { selector: FULL_BLEED_IMG_SELECTOR, perSlot: false };
  if (page.templateId === 'panorama-spread') return { selector: PANORAMA_IMG_SELECTOR, perSlot: false };
  if (page.templateId === 'cover-wrap') return { selector: COVER_PHOTO_SELECTOR, perSlot: false };
  return null;
}

// ---------------------------------------------------------------------------
// Text regions
// ---------------------------------------------------------------------------

/**
 * How to locate a text edit target's on-page DOM anchor. `approximate:
 * true` means the PRIMARY selector may not be in the DOM at all yet (no
 * value saved to render there today — e.g. an unwritten dedication) and the
 * caller should fall back to `fallbackSelector`, anchoring the popover near
 * where the text WOULD appear rather than exactly where it will once
 * non-empty (documented approximation, see the polish-round report).
 */
export type TextAnchorPlan =
  | { strategy: 'selector'; selector: string; fallbackSelector?: string; approximate: boolean }
  /** The section-header title/kicker have NO className in `SectionHeader.tsx` (inline styles only) — located structurally: the title is the page's own `<h2>` (unique per page — see this module's header comment for why that's safe), and the kicker, when present, is that `<h2>`'s previous sibling's first child. */
  | { strategy: 'section-title' }
  | { strategy: 'section-kicker' }
  /** A footer-index caption: `entryIndex` is the 0-based position of the matching entry within `page.params.footerIndex` — the SAME order `FooterIndex.tsx` renders its (unclassed) entry rows in, so `entryIndex`-th child of the entries container is the right DOM node. A consolidated same-date/same-caption row (`FooterIndex.tsx`'s own "several superscript numerals on one line") anchors to that WHOLE row for whichever memory's caption this target is — editing a different memory sharing that row is now reachable inline (its own hitbox — see `footer-row` handling in `useOverlayGeometry.ts`), not just via a fallback list. */
  | { strategy: 'footer-row'; entryIndex: number }
  /** `ThroughTheYears.tsx`'s title `<h2>` — unclassed, but uniquely findable via the `data-testid="portrait-strip"` wrapper the template already renders for an unrelated reason (test targeting). */
  | { strategy: 'tty-title' }
  /** `ThroughTheYears.tsx`'s kicker `<div>` — NO wrapping row (unlike `SectionHeader.tsx`'s kicker+divider row), so it's simply the title `<h2>`'s own previous sibling. */
  | { strategy: 'tty-kicker' };

const SECTION_TITLE_PREFIX = 'sectionTitle:';
const EYEBROW_PREFIX = 'eyebrow:';
const CAPTION_PREFIX = 'caption:';
const FURNITURE_PREFIX = 'furniture:';

export function resolveTextAnchor(page: BookPage, target: string): TextAnchorPlan | null {
  if (target === 'dedication' && page.templateId === 'dedication') {
    return { strategy: 'selector', selector: '.dedication__body', fallbackSelector: '.dedication__greeting', approximate: true };
  }
  if (target === 'closing' && page.templateId === 'closing') {
    return { strategy: 'selector', selector: '.closing__count', fallbackSelector: '.closing__headline', approximate: true };
  }
  if (target === 'backCover' && page.templateId === 'cover-wrap') {
    return { strategy: 'selector', selector: '.cover-wrap__colophon-line', fallbackSelector: '.cover-wrap__colophon', approximate: true };
  }
  if (target.startsWith(SECTION_TITLE_PREFIX)) {
    const elementId = target.slice(SECTION_TITLE_PREFIX.length);
    if (page.sourceElementId !== elementId) return null;
    if (page.templateId === 'spread-title') {
      return { strategy: 'selector', selector: '.spread-title__descriptive, .spread-title__quote', approximate: false };
    }
    if (page.params.sectionHeader) return { strategy: 'section-title' };
    return null;
  }
  if (target.startsWith(EYEBROW_PREFIX)) {
    const elementId = target.slice(EYEBROW_PREFIX.length);
    if (page.sourceElementId !== elementId) return null;
    if (page.templateId === 'spread-title') {
      // The kicker only renders when present (never invented) — same
      // approximation as the dedication/closing/backCover cases: fall back
      // to the title itself as an anchor so an owner can still click
      // somewhere sensible to ADD an eyebrow that isn't there yet.
      return { strategy: 'selector', selector: '.spread-title__kicker', fallbackSelector: '.spread-title__descriptive, .spread-title__quote', approximate: true };
    }
    if (page.params.sectionHeader) return { strategy: 'section-kicker' };
    return null;
  }
  if (target.startsWith(CAPTION_PREFIX)) {
    const memoryId = target.slice(CAPTION_PREFIX.length);
    const entryIndex = footerEntryIndexForMemory(page, memoryId);
    return entryIndex === null ? null : { strategy: 'footer-row', entryIndex };
  }
  if (target.startsWith(FURNITURE_PREFIX)) {
    return resolveFurnitureTextAnchor(page, target.slice(FURNITURE_PREFIX.length));
  }
  return null;
}

/**
 * Anchor plans for the six `furniture:<key>` targets (owner-approved
 * follow-up round — see `model/edits.ts`'s `applyFurnitureTextEdit` for the
 * matching apply-side dispatch, which this mirrors key-for-key). Every key
 * here is ALWAYS rendered by its template once its page exists (no
 * conditional like `backCoverLine`'s `{p.backCoverLine && ...}`), so only
 * `coverTagline` (which reuses the pre-existing `backCover` anchor's own
 * "may not exist yet" shape) is `approximate: true`.
 */
function resolveFurnitureTextAnchor(page: BookPage, key: string): TextAnchorPlan | null {
  if (key === 'coverName' && page.templateId === 'cover-wrap') {
    return { strategy: 'selector', selector: '.cover-wrap__name', approximate: false };
  }
  if (key === 'coverTagline' && page.templateId === 'cover-wrap') {
    return { strategy: 'selector', selector: '.cover-wrap__colophon-line', fallbackSelector: '.cover-wrap__colophon', approximate: true };
  }
  if (key === 'dedicationSalutation' && page.templateId === 'dedication') {
    return { strategy: 'selector', selector: '.dedication__greeting', approximate: false };
  }
  if (key === 'dedicationSignoff' && page.templateId === 'dedication') {
    return { strategy: 'selector', selector: '.dedication__signature', approximate: false };
  }
  if (key === 'scanInstruction' && page.templateId === 'dedication') {
    // `approximate: false` is safe here (unlike `coverTagline`/`backCover`'s
    // "may not exist yet" shape): `computeTextFields` only ever offers this
    // field when `params.hasScanMarks` is true, and the template renders
    // the block unconditionally whenever that flag is true — so the anchor
    // always exists by the time this field is offered at all.
    return { strategy: 'selector', selector: '.dedication__scan-instruction-text', approximate: false };
  }
  if (key === 'ttyKicker' && page.templateId === 'through-the-years') {
    return { strategy: 'tty-kicker' };
  }
  if (key === 'ttyTitle' && page.templateId === 'through-the-years') {
    return { strategy: 'tty-title' };
  }
  if (key === 'closingTitle' && page.templateId === 'closing') {
    return { strategy: 'selector', selector: '.closing__headline', approximate: false };
  }
  return null;
}

/** Finds the 0-based position, in `page.params.footerIndex`'s own array order, of the entry that carries this memory's numbered footer caption — `null` when the memory has no numbered slot on this page (matches `computeTextFields`'s own eligibility gate: `content.index === null` never gets a caption field at all). */
export function footerEntryIndexForMemory(page: BookPage, memoryId: string): number | null {
  let numeral: number | null = null;
  for (const slot of page.slots) {
    if (slot.content.kind !== 'photo') continue;
    const content = slot.content as PhotoSlotContent;
    if (content.memoryId === memoryId && content.index != null) {
      numeral = content.index;
      break;
    }
  }
  if (numeral === null) return null;
  const footerIndex = page.params.footerIndex as FooterIndexEntry[] | undefined;
  if (!Array.isArray(footerIndex)) return null;
  const idx = footerIndex.findIndex((entry) => entry.indices.includes(numeral as number));
  return idx === -1 ? null : idx;
}

// ---------------------------------------------------------------------------
// Cover photo slot key re-export (avoids every call site importing both
// `model/edits.ts` and this module just to spell the sentinel the same way).
// ---------------------------------------------------------------------------
export { COVER_SLOT_KEY };
