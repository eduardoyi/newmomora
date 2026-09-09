import type {
  AudioNoteContent,
  BookDocument,
  BookManifest,
  BookOutline,
  BookPage,
  BookPageVariant,
  DigestEntryContent,
  FirstsEntryContent,
  FitOptions,
  FitResult,
  IllustrationSlotContent,
  LayoutGap,
  LayoutSlot,
  ManifestAsset,
  ManifestMemory,
  ManifestScope,
  OutlineElement,
  PageCapacityReport,
  PhotoSlotContent,
  QrSlotContent,
  QuoteEntryContent,
  TemplateId,
  TemplateParams,
  TextSlotContent,
} from './types';
import { PHYSICAL } from './types';
// Round-13: these two come from `.types.ts` companions, not the `.tsx`
// component files directly — `fitter.ts` is pure TS with no React/DOM
// dependency (the memory-book outline eval script imports it under Deno;
// see supabase/scripts/eval-memory-book-outline.ts), and a type-only import
// of a `.tsx` file still drags its whole JSX/React import graph into the
// checker. See `FooterIndex.types.ts` / `SectionHeader.types.ts` for the
// full rationale — same types, zero behavior change either side.
import type { FooterIndexEntry } from '../templates/common/FooterIndex.types';
import type { SectionHeaderParams } from '../templates/common/SectionHeader.types';
import { localizeMonthLabel } from '../templates/common/formatDate';
import { getFurniture, getLanguage } from '../templates/furniture';
import { illustratedIlloFitHeightMm, SAFE_BOX_MM, SECTION_HEADER_RESERVE_MM, footerReserveMm, printableCaption } from '../templates/mm';
import { anchorPairMeetsMinSize } from '../templates/layout/anchorMediaLayout';
import { resolveElementMemories } from './loader';

// ---------------------------------------------------------------------------
// Deterministic layout fitter (Stage C: "AI for taste, code for geometry").
//
// This is pure TS with no DOM dependency — it must run identically in Node
// (eval scripts, future print pipeline) and in the browser preview.
// ---------------------------------------------------------------------------

/** A memory's own text at or below this length is a photo-story caption (Momora Book Layout System 1b §3). */
const PHOTO_STORY_MAX = 240;
/** 901-1600 chars: type steps down to 15pt (see TextPage.tsx). Above this: a double text-page spread. */
const TEXT_PAGE_DOUBLE_MIN = 1600;
/**
 * Illustrated 1-vs-2-page threshold (round-5 item 6, tightened from the
 * prior 400): the text stands alone and the illustration moves to the
 * facing page whenever EITHER of two things is true — the text itself runs
 * long enough that the single-page "both" composition gets cramped, OR the
 * single-page illustration would render smaller than
 * `ILLUSTRATED_SPLIT_MIN_ILLO_HEIGHT_MM` (a genuinely tiny drawing isn't a
 * worthwhile use of the shared page — better to give it the whole facing
 * page). See `illustratedStoryNeedsSplit`.
 */
const ILLUSTRATED_SPLIT_MIN_CHARS = 320;
/** See `ILLUSTRATED_SPLIT_MIN_CHARS`'s doc comment — the single-page illustration height floor below which the split is forced regardless of caption length. */
const ILLUSTRATED_SPLIT_MIN_ILLO_HEIGHT_MM = 110;
/**
 * Quote-collection (acceptance-review follow-up, canvas §5 decision table
 * "Solo texto" row: "Tres o más entradas cortas del mismo tema se agrupan
 * en una doble página de citas"): a SHORT text-only or illustrated-light
 * (no real photo/video asset) entry is eligible to join a collection when
 * its own text is at or under this length. The canvas gives no explicit
 * mockup for this composition — the design below is composed from the
 * type-role language elsewhere (antetítulo-style date kickers, the
 * illustrated-story body size), flagged in QuoteCollection.tsx.
 */
const QUOTE_ENTRY_MAX_CHARS = 200;
/** Fewer than this many adjacent eligible entries isn't a "collection" yet — they fall back to individual pages. */
const QUOTE_COLLECTION_MIN = 3;
/** The collection's own page-budget ceiling per spread — a longer run splits into several spreads (see `partitionQuoteRun`). */
const QUOTE_COLLECTION_MAX = 6;
/**
 * Illustrated-story pairing (acceptance-review follow-up): two ADJACENT
 * short illustrated stories share a facing spread with alternating
 * (vertically staggered) frames, per the canvas. Diagnosed root cause of
 * why this never fired: the cross-memory pairing pass (`pairSoloGroups`)
 * only ever recognizes a "solo PHOTO group" (exactly one real photo
 * asset) — an illustrated memory has zero `assets` (its illustration lives
 * in a separate field), so it could never qualify, and `chunkMemories`
 * isolates every illustrated memory into its own group before pairing even
 * runs. This is a SEPARATE, smaller threshold than the quote-collection's
 * (a run of exactly 2 falls here; 3+ is swept into a quote-collection
 * first, since that's the more space-efficient composition for a longer
 * run of short entries).
 */
const ILLUSTRATED_PAIR_MAX_CHARS = 200;
/**
 * Illustrated-digest (round-12: promotes the preview demo composition —
 * `templates/IllustratedDigest.tsx`'s own history — to a real fitter-
 * emitted "pressure valve" for a month whose corpus is nearly all short
 * illustrated memories). Per-memory eligibility: has an illustration AND
 * text, at or under this length. Same 240-char cap the original demo used
 * (`DIGEST_MAX_CHARS` there) — kept as its own named constant since the
 * digest's own composition (13pt body on a narrower measure) can tolerate
 * more text than the pairing/quote thresholds above, which target other
 * compositions entirely.
 */
const DIGEST_ENTRY_MAX_CHARS = 240;
/** "Rows assume square-ish art" — an illustration further from square than this never sweeps into a digest row (see `templates/mm.ts`'s `DIGEST_ILLO_WIDTH_MM` doc comment for why the geometry needs this band). */
const DIGEST_ASPECT_MIN = 0.9;
const DIGEST_ASPECT_MAX = 1.1;
/**
 * Engagement rule (owner round-12 decision): digest sweeping only engages
 * for a SECTION (outline element) once it holds at least this many
 * digest-eligible illustrated memories — a section with only a few
 * illustrated memories never needed a pressure valve in the first place, and
 * sweeping it would just be a worse-looking way to show the same content.
 * Named constant, owner-tunable.
 */
const ILLUSTRATED_DIGEST_ENGAGEMENT_MIN = 6;
/** The section's first N digest-eligible memories, in outline (chronological) order, ALWAYS keep their full illustrated-story composition — never swept into a digest row, however many the section holds. Owner-tunable. */
const ILLUSTRATED_DIGEST_KEEP_FULL = 2;
/** A digest SPREAD holds exactly this many entries (owner round-12 correction: even counts only, never 3 — see `chunkDigestSweep` for the full remainder table, including the SINGLE-page 2-entry variant). */
const ILLUSTRATED_DIGEST_CHUNK_SIZE = 4;
/**
 * Density (owner decision, visual-review round 2, refined by the owner's
 * round-3 "middle path" resolution of the v1/v2 canvas conflict — see item
 * 15 of the visual-review batch): photos from DIFFERENT memories never
 * share a page beyond this many, and 1/page is the expected typical case;
 * at 2 there must be a clear dominant + subordinate hierarchy, never an
 * even pair (anchor-media's own positional hero handles that). Named
 * constant per the owner's request — they want to see how this looks and
 * may retune it.
 */
const CROSS_MEMORY_MAX_PER_PAGE = 2;
/**
 * Single-memory multi-photo exception (owner's round-3 resolution, tightened
 * round-8 item 5b to "grids only at 4" — a page may hold exactly 1, 2, or 4
 * photos, NEVER 3, never more than 4): a memory that itself carries EXACTLY
 * 4 photos of one moment may render as ONE flex-grid unit occupying its own
 * page (canvas flex-grid rules apply within it — baseline snapping,
 * contained holes for odd aspects, >=40mm sides). This is the one case
 * flex-grid still legitimately fires for; a 3-photo remainder always splits
 * to a 2+1 pair of anchor-media pages instead (`chunkSingleMemoryAssets`).
 */
const SINGLE_MEMORY_GRID_MAX = 4;
/** Aesthetic target photo count per flex-grid page, within the single-memory exception above — always exactly met now that flex-grid only ever fires at n=4 (see `scoreFlexGrid`). */
const GRID_TARGET = 4;
/** A photo this wide relative to its height, at minimum pixel width, is panorama-spread material. */
const PANORAMA_ASPECT_THRESHOLD = 1.7;
const PANORAMA_MIN_WIDTH_PX = 3400;
/**
 * Panorama splicing (item 11, visual-review batch): `outline.panoramaCandidates`
 * nominees bypass the face gate entirely (human-reviewed interim — a
 * distinct trusted path, NOT a `FACE_DATA_AVAILABLE` flip) provided the
 * source photo is native landscape and at least this wide. Budget: 1 + 1
 * per ~20 content pages, no hard cap.
 */
const PANORAMA_CANDIDATE_MIN_WIDTH_PX = 3500;
const PANORAMA_QUOTA_BASE = 1;
const PANORAMA_QUOTA_PER_PAGES = 20;
/**
 * Cross-memory pairing aggressiveness ladder (final-fix-round item 1/2): 0
 * pairs nothing (today's behavior — every single-photo memory keeps its own
 * page). Escalating a level is the fitter's first lever for respecting the
 * printer's page cap before it resorts to omitting memories outright.
 *   1 - pair two caption-less single-photo memories.
 *   2 - also pair a caption-less memory with a captioned one.
 *   3 - pair even two captioned memories (last resort).
 * A memory with text keeps its own page whenever a lower level sufficed.
 */
type PairingLevel = 0 | 1 | 2 | 3;
const MAX_PAIRING_LEVEL: PairingLevel = 3;
/** The printer's hard binding limit (see `PHYSICAL.maxPrintablePages`) — the fitter must never emit more pages than this. */
const DEFAULT_MAX_PAGES = PHYSICAL.maxPrintablePages;
/** Crop conservatism: beyond this relative aspect delta, contain rather than crop. */
const CROP_TOLERANCE = 0.2;
/**
 * Density v3 (owner review round 3, item 5): a 3-4 photo grid is only legal
 * when every photo composes at (near) its own native aspect with at most
 * this much relative crop — computed from the aspect SET, reusing the same
 * discrete crop-box table (`nearestStandardAspect`) but at a tighter
 * tolerance than the general `CROP_TOLERANCE` used for a lavender-contained
 * fallback elsewhere. Otherwise the memory's assets split to strict max-2
 * (see `chunkSingleMemoryAssets`) — this is what keeps a vertical video from
 * ever getting forced into a grid built for landscape photos (item 4).
 */
const GRID_ASPECT_CROP_TOLERANCE = 0.1;
/** 300ppi at the full-bleed 216mm trim+bleed edge (216mm / 25.4 * 300). */
const FULL_BLEED_MIN_WIDTH_PX = 2551;
/**
 * Full-bleed trusted path (owner review round 3, item 2; reworked round 7
 * item 2 — validated live case: Mara's Feb full-bleed was a hero at
 * original aspect 1.95, whose square crop lost 49% of its width, cropping
 * faces). A print-safe original width still bypasses the face gate, but
 * orientation is no longer a loose one-sided aspect floor — it's now a
 * real crop-loss budget (see `fullBleedCropLoss`), tighter for a non-hero
 * (round-7 item 2c opens full-bleed to them) than a hero (item 2a — heroes
 * get a looser bar since they're human-reviewed downstream).
 */
const FULL_BLEED_TRUSTED_MIN_WIDTH_PX = 2500;
/**
 * Round-7 item 2a: max fraction of the source image a square full-bleed
 * crop may discard. Round-8 item 5a: raised from 0.2 to 0.25 — a STANDARD
 * 4:3 photo (aspect 1.333, the single most common camera/phone aspect)
 * loses EXACTLY 25% of its width to a square crop (`fullBleedCropLoss(4/3)
 * === 0.25`), so the old 0.2 bar excluded the single most common non-hero
 * source shape from full-bleed entirely — not a deliberate quality gate,
 * just an accidental exclusion. 0.25 lets an ordinary 4:3 photo qualify
 * (the `>` comparison in `scoreFullBleed` means exactly 0.25 passes) while
 * still rejecting anything more aggressively wide/tall than that. The hero
 * cap (`FULL_BLEED_HERO_MAX_CROP_LOSS`, 0.3) is unchanged — heroes are
 * human-reviewed downstream, so they keep their own looser bar.
 */
const FULL_BLEED_MAX_CROP_LOSS = 0.25;
/** Round-7 item 2a: heroes get a looser bar — human-reviewed downstream, so a bit more crop is an acceptable trade for the full-bleed treatment. */
export const FULL_BLEED_HERO_MAX_CROP_LOSS = 0.3;
/** Below this score, the page is reported as a layout gap for the backlog. */
const DEFAULT_SCORE_THRESHOLD = 0.5;
/** Full-bleed book-wide budget (Momora Book Layout System 1b §3 "A sangre") — unchanged by the trusted-path preference. */
const FULL_BLEED_MAX_CONSECUTIVE = 2;
/**
 * Round-7 item 2c: replaces the old flat `FULL_BLEED_MAX_TOTAL` (6) cap —
 * a longer book can reasonably carry more full-bleed moments, so the
 * budget now scales with the book itself (1 + 1 per ~10 content pages),
 * the same shape as the panorama quota. See `fullBleedBudgetCap`.
 */
const FULL_BLEED_BUDGET_BASE = 1;
const FULL_BLEED_BUDGET_PER_PAGES = 10;
/** Audio notes never share a page with more than one sibling. */
const AUDIO_NOTE_MAX_PER_PAGE = 2;
/**
 * Month-preservation floor (round-5 item 2a — root cause of Enzo's Oct/Nov/
 * Dec 2024 disappearing entirely): the page-cap demotion pass used to sort
 * EVERY photo-only memory book-wide by rank and cut from the bottom with no
 * regard for which month it came from — a run of consecutive low-engagement
 * months could get cut down to zero while other months still had plenty to
 * spare. A month's surviving memory count may never drop below this floor
 * while some OTHER month still has more than its own floor to give —
 * omissions must spread fairly across the book (see `tightenToPageCap`).
 */
const MIN_MEMORIES_PER_MONTH = 2;
/**
 * Prodigi's layflat binding valid range (round-5 item 7: "18-122"). The
 * even-page-count enforcement only applies within this printable range —
 * a below-minimum page count is an out-of-range problem in its own right
 * (never expected for a real book; only ever seen from a tiny synthetic
 * outline in a test), and forcing evenness on it would just be test noise
 * rather than a real print-readiness fix.
 */
export const PRODIGI_MIN_PAGES = 18;
/**
 * Round-5 integrity audit check (d) ("blank-page accounting"): every
 * `blank` page the fitter emits carries one of these reasons in
 * `BookPage.blankReason` — anything else (including no reason at all) means
 * a blank was inserted for no accountable structural need, which the audit
 * (`auditBookDocument`) flags as a violation.
 */
export const BLANK_REASONS = [
  /** The deliberate breathing page facing the dedication, right after the cover. */
  'front-matter-verso',
  /** A full-bleed page's credit needs its TRUE facing page (owner review round 3 item 2). */
  'parity:full-bleed',
  /** A panorama-spread must start on an even page — it's a two-page-number opening (round 4 item 8). */
  'parity:panorama-spread',
  /** A quote-collection is a spread too — same even-start requirement. */
  'parity:quote-collection',
  /**
   * An illustrated-digest is a spread too — same even-start requirement.
   * Never expected to actually appear (round-12: a digest spread that can't
   * land even DISSOLVES back into ordinary illustrated pages instead of
   * paying a blank, the same demote-not-blank trade full-bleed already
   * made — see `reorderUnitsForParity`'s digest fallback) — kept in this
   * list only so the reason string is recognized if one somehow slips
   * through, exactly like `parity:full-bleed`'s own unconditional audit
   * check.
   */
  'parity:illustrated-digest',
  /** An illustrated-story pair's "first" frame must land even so "second" lands on the facing page. */
  'parity:illustrated-pair',
  /** A long illustrated-story's text half must land even so its illustration lands on the facing page. */
  'parity:illustrated-split',
  /** Prodigi requires an even interior page count (round-5 item 7) — a trailing blank after the closing page when the natural total is odd. */
  'parity:closing-total',
] as const;
export type BlankReason = (typeof BLANK_REASONS)[number];

/** Standard crop boxes the grid template chooses between (portrait, square, landscape). */
const STANDARD_ASPECTS = [0.8, 1, 1.5];

/**
 * Face-clearance gate for full-bleed / panorama-spread / any composition
 * that crosses or touches the 24mm no-face spine band. The manifest has no
 * per-photo face bounding-box data yet (that's a future `analyze-memory`
 * enrichment — see docs/plans/memory-book.md Stage C "focal-point hints").
 * Per the plan's explicit instruction, this fails CLOSED: without real face
 * data we cannot prove clearance, so these compositions stay infeasible
 * until a real face-detection field exists on `ManifestAsset`. Flip this to
 * a real per-asset check (and remove the early `return false`) once that
 * field lands — the rest of the scoring/accounting machinery below is
 * already wired for it (max-consecutive/max-per-book counters, etc.).
 */
const FACE_DATA_AVAILABLE = false;
function hasFaceClearance(_asset: ManifestAsset): boolean {
  if (!FACE_DATA_AVAILABLE) return false;
  return true;
}

interface ResolvedMemory {
  id: string;
  memory: ManifestMemory;
}

function resolveMemoriesInOrder(
  manifest: BookManifest,
  element: OutlineElement,
  omittedIds: ReadonlySet<string> = EMPTY_ID_SET,
): ResolvedMemory[] {
  const resolved = resolveElementMemories(manifest, element);
  if (omittedIds.size === 0) return resolved;
  // Page-cap overflow demotion (final-fix-round item 2, rebalanced round
  // 13): these ids were dropped by `fitBook`'s Lever 2 after maximum
  // pairing still left the book over the printer's hard limit — a mix of
  // photo, video, and (only when digest-eligible) illustrated memories
  // chosen to keep the three kinds' keep-rates close to parity; a
  // milestone holder or quote-title source is never demoted (see
  // `gatherDemotionCandidates` / `gatherIllustratedDemotionCandidates`).
  return resolved.filter(({ id }) => !omittedIds.has(id));
}

const EMPTY_ID_SET: ReadonlySet<string> = new Set();
const EMPTY_STRING_MAP: ReadonlyMap<string, string> = new Map();

function nearestStandardAspect(aspect: number): number {
  return STANDARD_ASPECTS.reduce((best, candidate) =>
    Math.abs(candidate - aspect) < Math.abs(best - aspect) ? candidate : best,
  );
}

function aspectFitsWithinTolerance(assetAspect: number, targetAspect: number): boolean {
  return Math.abs(targetAspect - assetAspect) / assetAspect <= CROP_TOLERANCE;
}

function isHighlight(element: OutlineElement, outline: BookOutline | null, memoryId: string): boolean {
  if ((element.highlights ?? []).includes(memoryId)) return true;
  return (outline?.heroCandidates ?? []).includes(memoryId);
}

function isVideoAsset(asset: ManifestAsset): boolean {
  return asset.kind === 'video-poster';
}

function isAudioMemory(memory: ManifestMemory): boolean {
  return memory.type === 'audio' && memory.assets.length === 0;
}

function isIllustratedMemory(memory: ManifestMemory): boolean {
  return Boolean(memory.illustration) && Boolean(captionOf(memory));
}

/**
 * Task 2 (round-17): the ONE place `fitter.ts` reads a memory's caption
 * text — every length check, eligibility gate, and rendered-text builder
 * below goes through this instead of `memory.text` directly, so a caption
 * that only clears a threshold BECAUSE of a pasted URL never actually
 * causes a different layout decision than what the printed page will show
 * (the URL is gone there too, via the exact same `printableCaption`
 * templates and the audit both call). A caption that sanitizes to empty is
 * caption-less, same as a memory with no text at all — every truthy/length
 * check below reflects that automatically since `''` is falsy and
 * length-0.
 */
function captionOf(memory: ManifestMemory): string {
  return printableCaption(memory.text ?? '');
}

/**
 * Owner round-6 ("still a ton of random blank pages"): parity-aware unit
 * REORDERING, applied before assembly. `ensureEvenLanding` can only swap
 * with the page immediately before a parity-critical unit, so whenever a
 * spread-title or another non-swappable page precedes an illustrated
 * pair/split, a panorama, or a full-bleed, it fell back to a blank — the
 * ugliest case being a section title facing an empty page. This pass walks
 * a section's units simulating page parity; when a needs-left-start unit
 * would land on a right page, it pulls the NEAREST later movable single-
 * page unit forward (bounded lookahead — the same local-reorder class of
 * move round-4 item 3 already sanctioned) so parity lands naturally and no
 * blank is needed. `ensureEvenLanding` remains as the last-resort fallback
 * for whatever this pass cannot predict.
 */
// Round-7: widened from 4 to effectively the whole section — all-
// illustrated sections keep their movable singles beyond a short window,
// and a bounded-but-large lookahead lets the pass find them (sections are
// at most a few dozen units; locality is preserved by preferring the
// NEAREST movable, which the linear scan already does).
const PARITY_REORDER_LOOKAHEAD = 64;

interface UnitParityMeta {
  /** Pages this unit will occupy (pair partners counted with 'first'). */
  span: number;
  /** Must start on an even (left) page. */
  needsEven: boolean;
  /** A 1-page unit safe to pull forward past neighbors. */
  movableSingle: boolean;
  /** This unit is the 'second' half of an illustrated pair — handled with its 'first'. */
  isPairSecond: boolean;
  /** This unit is the 'first' half — its partner is the next unit. */
  isPairFirst: boolean;
  /** What `predictUnitTemplateId` predicted this unit will render as — carried on the meta so the caller can advance `ReorderSimState` without recomputing it. */
  predictedTemplateId: TemplateId | null;
}

/**
 * Owner round-7: the second fallback before any blank — SPLIT a multi-photo
 * group so its extra page absorbs the parity instead of a blank. Applies to
 * any 2-4 photo group (owner: "2 → 1+1, 3 → 2+1 or 1+2, 4 → 2+2/1+3/3+1"):
 * memory-boundary splits preferred (each part regrouped via `toGroup`);
 * a single-memory multi-photo group splits its assets across two pages
 * (same precedent as the existing 5+-photo same-memory split). Returns null
 * for anything that must stay whole (pairs-in-progress, long-text groups,
 * single-photo groups).
 */
function trySplitGroupUnit(unit: ContentUnit): [ContentUnit, ContentUnit] | null {
  if (unit.kind !== 'group') return null;
  const group = unit.group;
  if (group.illustratedPairRole) return null;
  if (group.hasLongText) return null;
  if (group.photoAssets.length < 2) return null;
  if (group.memories.length >= 2) {
    const mid = Math.ceil(group.memories.length / 2);
    return [
      { kind: 'group', group: toGroup(group.memories.slice(0, mid)) },
      { kind: 'group', group: toGroup(group.memories.slice(mid)) },
    ];
  }
  // Single memory, 2-4 photos: partition its assets across two pages.
  const mid = Math.ceil(group.photoAssets.length / 2);
  const part = (assets: MemoryGroup['photoAssets']): ContentUnit => ({
    kind: 'group',
    group: { ...group, photoAssets: assets },
  });
  return [part(group.photoAssets.slice(0, mid)), part(group.photoAssets.slice(mid))];
}

/**
 * Task 1's no-blank last resort (owner round-12, the same demote-not-blank
 * trade full-bleed already made): a digest spread that cannot land even
 * after every reorder fallback DISSOLVES back into its own individual
 * memories, each rendered as an ordinary illustrated-story page — never a
 * blank. Preserves chronological order (the items were already contiguous
 * and in order inside the digest unit).
 */
function dissolveDigestUnit(unit: Extract<ContentUnit, { kind: 'illustrated-digest' }>): ContentUnit[] {
  return unit.items.map((item): ContentUnit => ({ kind: 'group', group: toGroup([item]) }));
}

/**
 * Round-9 items 1c and 2a: a running shadow of the SAME fields
 * `ContentPagesState` carries during real assembly (`fitGroup`'s own
 * `previousTemplateId`/budget/pacing inputs, plus whether the section's
 * header has been consumed yet) — mirrored here so the parity-reorder pass
 * can predict, ahead of assembly, which template a unit will actually win
 * (`predictWinningTemplateId`) and therefore (a) whether it needs an even
 * landing (a solo photo predicted to win `full-bleed`) and (b) whether it
 * carries the section's header (changes an illustrated-story's own
 * fitted-height math) — the exact gap that let a full-bleed opening a
 * section, or a non-first unit that actually inherits the header from an
 * earlier non-header-capable unit, land unpredicted and cost a blank.
 */
interface ReorderSimState {
  contentPageCount: number;
  fullBleedBudget: FullBleedBudget;
  lastTemplateId: TemplateId | null;
  /** True until some HEADER_CAPABLE unit's predicted template consumes the section's own pending header. */
  headerPending: boolean;
}

/**
 * Round-9.1 (owner-reported divergence, `topic:toys-building` on
 * enzo-year-three): once a unit's template has been DECIDED — its very
 * first `finalizeUnit` call, whatever the outcome (a natural landing, a
 * successful swap, or a round-9 item 2b demotion) — that decision is
 * PERMANENT, exactly like real assembly's own `processGroup` (called
 * EXACTLY ONCE per unit): a later `ensureEvenLanding` swap only ever
 * RELOCATES an already-built PAGE object to a new position in the page
 * sequence, it never re-scores it. Re-deriving a unit's template via
 * `predictWinningTemplateId` again after it's been relocated (as this
 * pass's own fallback 0/1 do, since they physically reorder `arr`) is
 * self-referential the moment the CURRENT `sim.lastTemplateId` already
 * reflects that very unit's own prior outcome — that self-reference could
 * flip the rhythm-rule tie-break and silently mispredict a genuine
 * `full-bleed` as an ordinary movable single, which is exactly the bug
 * that let a section-opening full-bleed get used as a swap target, still
 * land parity-wrong, and cost a blank anyway. `pinned` is the fix:
 * every unit's template is derived from real scoring AT MOST ONCE, ever,
 * for the whole reorder pass — any later re-derivation attempt (via a
 * relocation) reads the SAME pinned answer instead, so relocating a unit
 * can change WHERE it lands, never WHAT it is.
 */
type PinnedTemplates = Map<ContentUnit, TemplateId | null>;

/** Predicts which template a unit will win — `null`/spread-kind units map directly; a `group` unit defers to `predictWinningTemplateId` (the SAME ranking `fitGroup` itself uses), unless `pinned` already recorded a permanent answer for it (see `PinnedTemplates`'s doc comment). */
function predictUnitTemplateId(
  unit: ContentUnit,
  element: OutlineElement,
  outline: BookOutline,
  sim: ReorderSimState,
  pinned: PinnedTemplates,
): TemplateId | null {
  const existing = pinned.get(unit);
  if (existing !== undefined) return existing;
  if (unit.kind === 'panorama') return 'panorama-spread';
  if (unit.kind === 'quote-collection') return 'quote-collection';
  if (unit.kind === 'illustrated-digest') return 'illustrated-digest';
  return predictWinningTemplateId(unit.group, element, outline, sim.lastTemplateId, sim.fullBleedBudget, sim.contentPageCount);
}

/**
 * Advances `sim` past one FINALIZED unit — mirrors exactly how
 * `buildContentPages` updates the real `ContentPagesState` after committing
 * a page: `contentPageCount` bumps by exactly 1 per unit regardless of how
 * many physical pages it produced (matching `processGroup`'s own single
 * `+= 1`, see its doc comment); the full-bleed budget's `consecutive`
 * counter bumps for panorama/full-bleed and resets for anything else
 * (`total` only bumps for full-bleed); and `headerPending` clears the first
 * time a HEADER_CAPABLE template is predicted.
 */
function advanceReorderSim(sim: ReorderSimState, unit: ContentUnit, predictedTemplateId: TemplateId | null): void {
  if (unit.kind === 'panorama' && predictedTemplateId === 'panorama-spread') {
    sim.fullBleedBudget.consecutive += 1;
    sim.lastTemplateId = 'panorama-spread';
  } else if (unit.kind === 'panorama') {
    // Task 1 (round-17), rung (c): a panorama unit `finalizeUnit`'d with a
    // demoted `predictedTemplateId` (currently only ever `'anchor-media'`,
    // see `unitParityMeta`'s pinned-first check above) advances the sim
    // exactly like any other plain single — same branch an ordinary
    // demoted group takes below, just spelled out here since the `kind`
    // check above would otherwise shadow it.
    sim.fullBleedBudget.consecutive = 0;
    sim.lastTemplateId = predictedTemplateId;
  } else if (unit.kind === 'quote-collection') {
    sim.fullBleedBudget.consecutive = 0;
    sim.lastTemplateId = 'quote-collection';
  } else if (unit.kind === 'illustrated-digest') {
    sim.fullBleedBudget.consecutive = 0;
    sim.lastTemplateId = 'illustrated-digest';
  } else if (predictedTemplateId) {
    if (predictedTemplateId === 'full-bleed') {
      sim.fullBleedBudget.total += 1;
      sim.fullBleedBudget.consecutive += 1;
    } else {
      sim.fullBleedBudget.consecutive = 0;
    }
    sim.lastTemplateId = predictedTemplateId;
  }
  if (sim.headerPending && predictedTemplateId != null && HEADER_CAPABLE.has(predictedTemplateId)) {
    sim.headerPending = false;
  }
  sim.contentPageCount += 1;
}

function unitParityMeta(
  unit: ContentUnit,
  element: OutlineElement,
  outline: BookOutline,
  sim: ReorderSimState,
  pinned: PinnedTemplates,
): UnitParityMeta {
  // Round-9.1 / Task 1 (round-17): the pinned check comes FIRST, before any
  // kind-based branch — a unit's WHOLE disposition is permanent from its
  // first finalize onward, not just its templateId — otherwise a de-split
  // ("both" mode, see the illustrated-story split handling below) or a
  // demoted (`anchor-media`) unit would still re-derive `needsEven`/`span`
  // from scratch on the next lookup (e.g. `illustratedStoryNeedsSplit` is a
  // pure function of caption length that can never itself change, and a
  // demoted panorama's `unit.kind` is still structurally `'panorama'`) and
  // immediately contradict the very decision that was just pinned. Every
  // finalized unit, by definition, already had whatever problem it had
  // resolved — it's stable, plain, single-page content going forward.
  const pinnedTemplateId = pinned.get(unit);
  if (pinnedTemplateId !== undefined) {
    return { span: 1, needsEven: false, movableSingle: true, isPairSecond: false, isPairFirst: false, predictedTemplateId: pinnedTemplateId };
  }
  if (unit.kind === 'panorama') {
    return { span: 2, needsEven: true, movableSingle: false, isPairSecond: false, isPairFirst: false, predictedTemplateId: 'panorama-spread' };
  }
  if (unit.kind === 'quote-collection') {
    return { span: 2, needsEven: true, movableSingle: false, isPairSecond: false, isPairFirst: false, predictedTemplateId: 'quote-collection' };
  }
  if (unit.kind === 'illustrated-digest') {
    // Owner round-12 extension: the SINGLE-page variant is an ordinary
    // 1-page unit for parity purposes — no even-start requirement, and
    // (like any plain single) safe for the reorder pass to use as swap
    // fodder for an unrelated unit's own parity need. The pacing
    // invariant ("never two digest units adjacent") is enforced
    // separately and uniformly for both variants by the final backstop
    // pass in `reorderUnitsForParity`, not by `movableSingle` here.
    return unit.variant === 'single'
      ? { span: 1, needsEven: false, movableSingle: true, isPairSecond: false, isPairFirst: false, predictedTemplateId: 'illustrated-digest' }
      : { span: 2, needsEven: true, movableSingle: false, isPairSecond: false, isPairFirst: false, predictedTemplateId: 'illustrated-digest' };
  }
  const group = unit.group;
  if (group.illustratedPairRole === 'second') {
    return { span: 0, needsEven: false, movableSingle: false, isPairSecond: true, isPairFirst: false, predictedTemplateId: 'illustrated-story' };
  }
  if (group.illustratedPairRole === 'first') {
    return { span: 2, needsEven: true, movableSingle: false, isPairSecond: false, isPairFirst: true, predictedTemplateId: 'illustrated-story' };
  }
  const predictedTemplateId = predictUnitTemplateId(unit, element, outline, sim, pinned);
  if (predictedTemplateId === 'full-bleed') {
    // Round-9 item 2a: a solo photo predicted to win full-bleed needs an
    // even landing too (assembly's own `ensureEvenLanding` call for
    // full-bleed) — predicting it here is what lets the existing
    // movable-single fallbacks below route around it instead of assembly
    // falling back to a blank (or, when nothing can, the item 2b demotion
    // fallback in `processGroup` takes over — see its own doc comment).
    return { span: 1, needsEven: true, movableSingle: false, isPairSecond: false, isPairFirst: false, predictedTemplateId };
  }
  const solo = group.memories.length === 1 ? group.memories[0] : null;
  if (solo && solo.memory.illustration) {
    const hasHeader = sim.headerPending && predictedTemplateId != null && HEADER_CAPABLE.has(predictedTemplateId);
    if (illustratedStoryNeedsSplit(solo.memory, hasHeader, predictIllustratedStagger(solo.id))) {
      return { span: 2, needsEven: true, movableSingle: false, isPairSecond: false, isPairFirst: false, predictedTemplateId: 'illustrated-story' };
    }
  }
  return { span: 1, needsEven: false, movableSingle: true, isPairSecond: false, isPairFirst: false, predictedTemplateId };
}

export function reorderUnitsForParity(
  units: ContentUnit[],
  startsOnEvenPage: boolean,
  element: OutlineElement,
  outline: BookOutline,
  initialSim: Pick<ReorderSimState, 'contentPageCount' | 'fullBleedBudget' | 'lastTemplateId'> & { headerPending: boolean },
): ContentUnit[] {
  const arr = [...units];
  let parityEven = startsOnEvenPage;
  // The reorder pass must never mutate the REAL ContentPagesState fields
  // (assembly reads/advances those itself, independently, right after this
  // returns) — only its own prediction.
  const sim: ReorderSimState = {
    contentPageCount: initialSim.contentPageCount,
    fullBleedBudget: { ...initialSim.fullBleedBudget },
    lastTemplateId: initialSim.lastTemplateId,
    headerPending: initialSim.headerPending,
  };
  // Round-9.1: every unit's template gets derived from real scoring AT
  // MOST ONCE, ever — see `PinnedTemplates`'s doc comment for why (this is
  // what makes it safe for fallback 0/1/2 below to freely RELOCATE a unit
  // as many times as parity needs, the same way real assembly's own
  // reswap chains relocate an already-built PAGE without ever re-scoring
  // it: a demoted-to-anchor-media unit can go on to absorb MULTIPLE later
  // units' parity needs in a row, exactly like the real page it stands in
  // for would).
  const pinned: PinnedTemplates = new Map();
  const metaAt = (unit: ContentUnit) => unitParityMeta(unit, element, outline, sim, pinned);
  const finalizeUnit = (unit: ContentUnit, predictedTemplateId: TemplateId | null): void => {
    if (!pinned.has(unit)) pinned.set(unit, predictedTemplateId);
    advanceReorderSim(sim, unit, predictedTemplateId);
  };
  for (let i = 0; i < arr.length; i++) {
    const meta = metaAt(arr[i]);
    // Structurally, the main loop's own `i` never lands independently on a
    // 'second' half — its 'first' partner always advances `i` past it (see
    // the bottom of this loop) — but this stays as a defensive guard in
    // case a future change ever lets the two drift apart in the array.
    if (meta.isPairSecond) {
      finalizeUnit(arr[i], meta.predictedTemplateId);
      continue; // consumed by its 'first'
    }
    if (meta.needsEven && !parityEven) {
      const searchStart = i + (meta.isPairFirst ? 2 : 1);
      const limit = Math.min(arr.length, searchStart + PARITY_REORDER_LOOKAHEAD);
      // Fallback 0: relocate the immediately PRECEDING movable single to
      // just after this unit — the unit-level equivalent of assembly's old
      // swap, and the gentlest move of all: the needs-even unit shifts one
      // page earlier (fixing parity) and pairs stay intact and facing.
      // `arr[i - 1]`'s own meta is now always safe to read directly — see
      // `PinnedTemplates`'s doc comment: once decided (pinned), a unit's
      // template can never again flip based on WHEN it's asked, so this
      // can never be self-referential the way it used to be.
      if (i > 0) {
        const prevMeta = metaAt(arr[i - 1]);
        if (prevMeta.movableSingle) {
          const [prevUnit] = arr.splice(i - 1, 1);
          const insertAt = i - 1 + (meta.isPairFirst ? 2 : 1);
          arr.splice(insertAt, 0, prevUnit);
          parityEven = !parityEven; // undo the prev single's flip — we start where it did
          i -= 2; // reprocess the current unit at its new index
          continue;
        }
      }
      // Fallback 1: pull the nearest later movable single forward.
      let found = -1;
      for (let j = searchStart; j < limit; j++) {
        const mj = metaAt(arr[j]);
        if (mj.movableSingle) { found = j; break; }
        if (mj.isPairFirst) j += 1; // never split a pair — skip its partner
      }
      if (found >= 0) {
        const [moved] = arr.splice(found, 1);
        arr.splice(i, 0, moved);
        i -= 1; // reprocess from the moved single (flips parity to even)
        continue;
      }
      // Fallback 2 (owner round-7): split a multi-photo group so the extra
      // page absorbs the parity. Prefer the PRECEDING unit (its split adds
      // a page before us — screenshot case: a two-photo page right before
      // a panorama); else split a forward group in the window and pull its
      // first part up like a movable single.
      if (i > 0) {
        const priorParts = trySplitGroupUnit(arr[i - 1]);
        if (priorParts) {
          arr.splice(i - 1, 1, ...priorParts);
          parityEven = true; // the extra page flips odd → even before us
          i += 1; // current unit shifted right by one
          parityEven = meta.span % 2 === 0 ? parityEven : !parityEven;
          if (meta.isPairFirst) i += 1; // skip the pair partner
          continue;
        }
      }
      let splitAt = -1;
      let parts: [ContentUnit, ContentUnit] | null = null;
      for (let j = searchStart; j < limit; j++) {
        const mj = metaAt(arr[j]);
        if (mj.isPairFirst) { j += 1; continue; }
        parts = trySplitGroupUnit(arr[j]);
        if (parts) { splitAt = j; break; }
      }
      if (splitAt >= 0 && parts) {
        arr.splice(splitAt, 1, ...parts); // split in place…
        const [moved] = arr.splice(splitAt, 1); // …then pull part A forward
        arr.splice(i, 0, moved);
        i -= 1; // reprocess from the moved single-page part
        continue;
      }
      // Fallback 3 (owner round-7 follow-up): when the stuck unit is itself
      // an illustrated PAIR and nothing else can absorb the parity, dissolve
      // the pair into two solo story pages — they lose the forced facing +
      // stagger, but two consecutive singles have no parity requirement at
      // all, which beats a blank page every time (all-illustrated sections
      // like "Enzo y Mara" have no other units to trade with).
      if (meta.isPairFirst) {
        const first = arr[i];
        const second = arr[i + 1];
        if (first?.kind === 'group' && second?.kind === 'group') {
          const strip = (g: MemoryGroup): MemoryGroup => {
            const { illustratedPairRole: _drop, ...rest } = g;
            return rest;
          };
          arr[i] = { kind: 'group', group: strip(first.group) };
          arr[i + 1] = { kind: 'group', group: strip(second.group) };
          i -= 1; // reprocess: both are plain movable singles now
          continue;
        }
      }
      // Fallback 3b (Task 1, owner round-12): a digest spread stuck here
      // dissolves back into ordinary illustrated pages — the SAME no-blank
      // trade fallback 3 above makes for a stuck illustrated PAIR. Each
      // dissolved item is a plain 1-page single with no even-landing
      // requirement of its own, so reprocessing from here always resolves
      // parity without ever reaching the blank last resort below.
      if (arr[i].kind === 'illustrated-digest') {
        const dissolved = dissolveDigestUnit(arr[i] as Extract<ContentUnit, { kind: 'illustrated-digest' }>);
        arr.splice(i, 1, ...dissolved);
        i -= 1; // reprocess from the first dissolved item
        continue;
      }
      // Round-9.1: a `full-bleed`-predicted unit's TRUE last resort
      // (fallbacks 0-3 above all failed to land it even) is DEMOTION, not
      // a blank — real assembly's own full-bleed handling
      // (`processGroup`'s round-9 item 2b branch) demotes to an ordinary
      // anchor-media single whenever its own local swap
      // (`ensureEvenLanding`'s `lastSwappablePageIndex` check, the
      // assembly-time equivalent of fallback 0) can't land it even, and
      // NEVER pays a blank for it. Modeling that here — instead of the
      // generic "assembly will insert a blank" assumption below — keeps
      // the sim's own budget/pacing/rhythm state in sync with what
      // assembly will really do: a demoted page renders as a plain
      // anchor-media single with no even-landing requirement of its own,
      // and (via `PinnedTemplates`) that demotion is now PERMANENT — if
      // THIS unit later gets relocated again to rescue a DIFFERENT
      // needs-even unit further along (the real "reswap chain" a demoted
      // page can serve multiple times over, exactly like the page object
      // it stands in for), it's reused as the SAME anchor-media single,
      // never re-scored back toward full-bleed.
      if (meta.predictedTemplateId === 'full-bleed') {
        finalizeUnit(arr[i], 'anchor-media');
        parityEven = !parityEven; // a demoted page is always a plain 1-page single (odd span)
        continue;
      }
      // Round-9.1 (owner-reported divergence, `topic:toys-building` on
      // enzo-year-three): a solo illustrated-story whose SPLIT need is
      // what's driving `needsEven` (span 2, `illustrated-story`, but never
      // an actual pair — `meta.isPairFirst` distinguishes the two, since
      // both share the same predicted templateId) has the SAME kind of
      // true last resort as full-bleed: real assembly's own handling
      // (`processGroup`'s matching round-9.1 condition on the
      // illustrated-split branch) only commits to the split when it can
      // land even without a blank; otherwise it renders "both" mode on
      // ONE page instead (task 1's fitted-height cap keeps that safe).
      // Modeling that here keeps the sim in sync: a de-split render is a
      // plain 1-page single with no even-landing requirement, span 1.
      if (meta.predictedTemplateId === 'illustrated-story' && meta.span === 2 && !meta.isPairFirst) {
        finalizeUnit(arr[i], 'illustrated-story');
        parityEven = !parityEven; // a de-split "both" mode render is always a plain 1-page single (odd span)
        continue;
      }
      // Task 1 (round-17), rung (c) of the panorama ladder: a panorama unit
      // that reaches here found NO movable neighbor anywhere in the
      // lookahead window (fallbacks 0-3 all failed) — the same "nothing
      // left to trade with" condition that drives full-bleed's own
      // demotion above. Real assembly's rung (b) local swap needs a
      // FLEXIBLE_SWAPPABLE_TEMPLATES-rendering immediate predecessor, which
      // is (by construction) exactly what `movableSingle` models here — so
      // if fallback 0 couldn't find one, assembly's swap won't either.
      // Model the demotion here too, so budget/pacing state stays in sync
      // with what assembly will really do (a demoted page is a plain
      // anchor-media single, no even-landing requirement of its own).
      if (arr[i].kind === 'panorama') {
        finalizeUnit(arr[i], 'anchor-media');
        parityEven = !parityEven; // a demoted page is always a plain 1-page single (odd span)
        continue;
      }
      // Last resort: assembly will insert a blank (or swap) to reach even —
      // model that here, or the simulated parity diverges from the real one
      // for the rest of the section.
      parityEven = true;
    }
    parityEven = meta.span % 2 === 0 ? parityEven : !parityEven;
    // Finalize this unit against the sim — `finalizeUnit` (pin the
    // template, then `advanceReorderSim`) matches real assembly's own
    // per-unit state bump exactly (see `advanceReorderSim`'s doc comment).
    // An illustrated pair's 'first' half advances the sim TWICE — once for
    // itself, once for its 'second' partner (skipped by `i += 1` below and
    // never independently visited by this loop) — because real assembly
    // calls `processGroup` (and its own `contentPageCount += 1`) once for
    // EACH half, not once for the pair.
    finalizeUnit(arr[i], meta.predictedTemplateId);
    if (meta.isPairFirst) {
      finalizeUnit(arr[i], meta.predictedTemplateId);
      i += 1; // partner already accounted in span
    }
  }
  // Task 1 pacing backstop (owner round-12): the loop above can relocate a
  // PLAIN movable single that happened to be sitting between two digest
  // chunks (chunkDigestSweep's own promoted separator) in order to fix some
  // OTHER, unrelated unit's even-landing need — the reorder pass has no
  // notion of "this single is reserved as a pacing buffer", only of parity.
  // That can leave two digest spreads adjacent after all, which is a hard
  // requirement ("never two digest spreads in a row"), not merely a
  // preference. Final pass: whenever the SETTLED order still has two
  // 'illustrated-digest' units back to back, dissolve the second one —
  // same no-blank dissolve every other stuck digest uses — so the
  // invariant holds no matter what the parity pass above did to get here.
  for (let i = 1; i < arr.length; i += 1) {
    if (arr[i].kind === 'illustrated-digest' && arr[i - 1].kind === 'illustrated-digest') {
      const dissolved = dissolveDigestUnit(arr[i] as Extract<ContentUnit, { kind: 'illustrated-digest' }>);
      arr.splice(i, 1, ...dissolved);
      // `arr[i]` is now the first dissolved (plain 'group') item, never
      // itself 'illustrated-digest' — the loop's own `i += 1` naturally
      // steps past it without re-triggering, and a THIRD digest unit
      // further along (now adjacent to a plain group instead) is safe.
    }
  }
  return arr;
}

/**
 * Round-5 item 6, re-based round-9 item 1c: decides whether a solo
 * illustrated-story splits across two facing pages (text left, illustration
 * right) instead of sharing one page — see `ILLUSTRATED_SPLIT_MIN_CHARS`'s
 * doc comment. Now checks the FITTED height (`illustratedIlloFitHeightMm` —
 * capped so the stack's own bottom never overflows the safe box, see
 * mm.ts) against the 110mm floor, not the uncapped nominal height, so a
 * page whose fitted illustration would render under 110mm still splits
 * exactly as the threshold intends, even when it's the stack-bottom cap
 * (not the nominal short-caption sizing) doing the shrinking. Reuses the
 * EXACT same math `IllustratedStory.tsx` renders with (shared via
 * `templates/mm.ts`) so the fitter's decision and the template's actual
 * render can never drift apart.
 *
 * `stagger` defaults to `false` (the taller, 19pt body-size estimate — see
 * `illustratedBodyFontSizePt`) when the caller doesn't yet know the final
 * hash-derived stagger value (e.g. the parity-reorder pre-pass, which
 * predicts split-need before any page params are built) — the conservative
 * direction, since a TALLER assumed text block leaves LESS vertical budget
 * for the illustration, only ever making the split MORE likely to fire,
 * never less.
 */
function illustratedStoryNeedsSplit(memory: ManifestMemory, hasSectionHeader: boolean, stagger = false): boolean {
  const len = captionOf(memory).length;
  if (len >= ILLUSTRATED_SPLIT_MIN_CHARS) return true;
  if (!memory.illustration) return false;
  const heightMm = illustratedIlloFitHeightMm(len, hasSectionHeader, stagger, memory.illustration.aspectRatio);
  return heightMm < ILLUSTRATED_SPLIT_MIN_ILLO_HEIGHT_MM;
}

/**
 * Quote-collection eligibility: short text, no real photo/video asset — an
 * illustration (a separate field from `assets`) is allowed, since the
 * collection permits at most one accompanying illustration among its
 * entries (see `buildQuoteCollectionSlots`). Covers both a plain zero-asset
 * text memory and a short "illustrated-light" one in one check.
 */
function isQuoteEligible(memory: ManifestMemory): boolean {
  const len = captionOf(memory).length;
  if (len === 0 || len > QUOTE_ENTRY_MAX_CHARS) return false;
  if (memory.assets.length > 0) return false;
  if (isAudioMemory(memory)) return false; // audio-note owns that composition entirely
  // Bug fix (owner review round 4, item 5): a quote-collection only ever
  // rendered ONE illustration across the whole spread, silently dropping
  // every other entry's — a real illustration loss the owner caught.
  // Illustrated memories are TEXT-ONLY-eligible compositions now excluded
  // entirely; a short illustrated memory always keeps its illustration by
  // pairing two-per-spread instead (see `chunkMemories`'s
  // `pendingIllustratedPairFirst` bookkeeping).
  if (memory.illustration) return false;
  return true;
}

/**
 * Task 1 digest eligibility (round-12): has an illustration AND text at or
 * under `DIGEST_ENTRY_MAX_CHARS`, an illustration aspect within the
 * near-square `[DIGEST_ASPECT_MIN, DIGEST_ASPECT_MAX]` band (rows assume
 * square-ish art — see `templates/mm.ts`'s `DIGEST_ILLO_WIDTH_MM` doc
 * comment), NOT a milestone holder (a book treasure, same protection the
 * page-cap demotion pool already gives a milestone memory — see
 * `gatherDemotionCandidates`), and NOT the element's own quote-title source
 * (`element.titleSourceMemoryId` — that memory's text is quoted verbatim on
 * the section's own title page; sweeping it into a digest row too would be
 * a strange duplication). Shared by the fitter's digest-sweep chunking
 * (Task 1) AND the hybrid cap-pressure demotion pool (Task 2) — the SAME
 * guard, so an illustrated memory can only ever be omitted under the cap if
 * it was ALSO safe to fold into a digest row in the first place.
 */
function isDigestEligibleMemory(memoryId: string, memory: ManifestMemory, element: OutlineElement): boolean {
  if (!memory.illustration) return false;
  const len = captionOf(memory).length;
  if (len === 0 || len > DIGEST_ENTRY_MAX_CHARS) return false;
  const aspect = memory.illustration.aspectRatio;
  if (aspect < DIGEST_ASPECT_MIN || aspect > DIGEST_ASPECT_MAX) return false;
  if ((memory.milestones ?? []).length > 0) return false;
  if (element.titleSourceMemoryId === memoryId) return false;
  return true;
}

function isPanoramicAsset(asset: ManifestAsset): boolean {
  return asset.aspectRatio >= PANORAMA_ASPECT_THRESHOLD && asset.width >= PANORAMA_MIN_WIDTH_PX;
}

/**
 * Native landscape orientation (not just a wide crop) at print-safe width —
 * the panorama-splicing trust gate. Width reads `originalWidth` when the
 * export pipeline has provided it (final-fix-round item 4) so a genuinely
 * wide source photo isn't rejected just because its preview render was
 * downscaled below the threshold; absent that field, `width` alone still
 * gates it exactly as before (fails closed on missing data, never open).
 * Orientation always reads the preview's own width/height — a uniform
 * downscale preserves aspect ratio, so that comparison needs no fallback.
 */
function isTrustedPanoramaCandidate(asset: ManifestAsset): boolean {
  const isNativeLandscape = asset.width > asset.height;
  const trustedWidthPx = asset.originalWidth ?? asset.width;
  return isNativeLandscape && trustedWidthPx >= PANORAMA_CANDIDATE_MIN_WIDTH_PX;
}

/**
 * Round-7 item 2a: the asset's own ORIGINAL aspect ratio when the export
 * pipeline provided full-resolution dimensions, falling back to the
 * (possibly downscaled) preview's aspect — a uniform downscale preserves
 * aspect ratio, so the fallback is exact, not approximate.
 */
function effectiveAspect(asset: ManifestAsset): number {
  if (asset.originalWidth && asset.originalHeight) return asset.originalWidth / asset.originalHeight;
  return asset.aspectRatio;
}

/**
 * Round-7 item 2a (validated live case: Mara's Feb full-bleed cropped
 * faces — a hero at original aspect 1.95 lost 49% of its width to a
 * square crop): the fraction of the source image a square (1:1) full-bleed
 * page's crop would discard. A square/near-square source loses almost
 * nothing; a wide or tall source loses width or height respectively,
 * symmetric either direction — `elongation()`-shaped but expressed as a
 * loss fraction rather than a ratio.
 */
export function fullBleedCropLoss(aspect: number): number {
  return 1 - Math.min(aspect, 1 / aspect);
}

/**
 * Density v3 grid-eligibility check (owner review round 3, item 5): every
 * asset in the set must land within `GRID_ASPECT_CROP_TOLERANCE` of its
 * nearest standard crop box — i.e. the grid can host the whole set without
 * cropping any of them more than ~10%. A single incompatible photo (most
 * commonly a portrait video mixed with landscape photos) fails the whole
 * set, sending it to strict max-2 pairs instead of a forced, badly-cropped
 * grid (see `chunkSingleMemoryAssets`).
 */
function gridAspectsCompatible(assets: ManifestAsset[]): boolean {
  return assets.every((asset) => {
    const nearest = nearestStandardAspect(asset.aspectRatio);
    return Math.abs(nearest - asset.aspectRatio) / asset.aspectRatio <= GRID_ASPECT_CROP_TOLERANCE;
  });
}

let slotCounter = 0;
function nextSlotId(prefix: string): string {
  slotCounter += 1;
  return `${prefix}:slot-${slotCounter}`;
}

function emptyPage(overrides: Partial<BookPage> & Pick<BookPage, 'id' | 'sourceElementId' | 'templateId'>): BookPage {
  return {
    params: {},
    slots: [],
    variants: [{ templateId: overrides.templateId, params: {}, score: 1 }],
    isSpread: false,
    isEvenPage: null,
    pageNumbers: null,
    ...overrides,
  };
}

function buildPhotoSlot(
  memoryId: string,
  memory: ManifestMemory,
  asset: ManifestAsset,
  opts: { hero: boolean; index: number | null; natural?: boolean; cropBand?: 'center' },
): LayoutSlot {
  // Lavender containment is for aspect mismatches INSIDE multi-photo
  // compositions only (owner decision, visual-review round 2) — a solo
  // photo on its own page gets a naturally-sized box at its own aspect
  // ratio, never a standard crop box with letterboxing either side.
  const targetAspect = opts.natural ? asset.aspectRatio : nearestStandardAspect(asset.aspectRatio);
  const looseFit = opts.natural ? false : !aspectFitsWithinTolerance(asset.aspectRatio, targetAspect);
  const content: PhotoSlotContent = {
    kind: 'photo',
    assetFile: asset.file,
    editedFromFile: asset.editedFromFile ?? null,
    assetWidth: asset.width,
    assetHeight: asset.height,
    assetAspectRatio: asset.aspectRatio,
    memoryId,
    date: memory.date,
    caption: captionOf(memory) || null,
    hero: opts.hero,
    qr: isVideoAsset(asset),
    shareToken: memory.shareToken ?? null,
    taggedMembers: memory.taggedMembers,
    milestones: memory.milestones,
    targetAspect,
    looseFit,
    index: opts.index,
    cropBand: opts.cropBand ?? null,
    // Never set by the fitter itself — see `PhotoSlotContent.focalPoint`'s
    // own doc comment; only `model/edits.ts`'s `applyPostFit` sets a real
    // value, from a saved edit, after this document is built.
    focalPoint: null,
  };
  return { id: nextSlotId('photo'), kind: 'photo', content };
}

function buildTextSlot(text: string, memoryId: string | null, date: string | null): LayoutSlot {
  const content: TextSlotContent = { kind: 'text', text, memoryId, date };
  return { id: nextSlotId('text'), kind: 'text', content };
}

function buildQrSlot(memoryId: string, microcopy: string, index: number | null): LayoutSlot {
  const content: QrSlotContent = { kind: 'qr', memoryId, microcopy, index };
  return { id: nextSlotId('qr'), kind: 'qr', content };
}

function buildIllustrationSlot(memoryId: string, memory: ManifestMemory): LayoutSlot | null {
  if (!memory.illustration) return null;
  const content: IllustrationSlotContent = {
    kind: 'illustration',
    assetFile: memory.illustration.file,
    assetWidth: memory.illustration.width,
    assetHeight: memory.illustration.height,
    assetAspectRatio: memory.illustration.aspectRatio,
    memoryId,
  };
  return { id: nextSlotId('illustration'), kind: 'illustration', content };
}

/**
 * Builds a quote-collection spread's entries (acceptance-review follow-up,
 * item 1). At most ONE entry across the whole collection carries an
 * illustration — the first one encountered, in chronological order — even
 * if several of the underlying memories have one; every other entry is
 * text only. This is the composition's own cap, not a data loss: any
 * additional illustration is simply not RENDERED here, the memory's text
 * still prints in full.
 */
function buildQuoteCollectionSlots(items: ResolvedMemory[]): LayoutSlot[] {
  // `isQuoteEligible` (item 5) now excludes any memory with an illustration
  // entirely — every entry here is text-only, so `illustration` is always
  // null. Left on `QuoteEntryContent` for shape stability (a future entry
  // point could set it deliberately) rather than removing the field.
  return items.map(({ id, memory }) => {
    const content: QuoteEntryContent = { kind: 'quote-entry', memoryId: id, date: memory.date, text: captionOf(memory), illustration: null };
    return { id: nextSlotId('quote'), kind: 'quote-entry', content };
  });
}

/**
 * Builds an illustrated-digest spread's entries (round-12). Every entry
 * ALWAYS carries its illustration — unlike a quote-collection, this
 * composition exists precisely so a short illustrated memory keeps its art
 * even when several of them share a spread. Exported so the preview's
 * "Digest demo" toggle (`src/preview/digestDemo.ts`) can build the exact
 * same slot shape from raw manifest memories, sharing one render path with
 * the real fitter (house rule: demo and fitter must never diverge in what
 * they hand the template).
 */
export function buildDigestEntrySlots(items: ResolvedMemory[]): LayoutSlot[] {
  return items.map(({ id, memory }) => {
    const content: DigestEntryContent = {
      kind: 'digest-entry',
      memoryId: id,
      date: memory.date,
      text: captionOf(memory),
      illustration: {
        file: memory.illustration!.file,
        width: memory.illustration!.width,
        height: memory.illustration!.height,
        aspectRatio: memory.illustration!.aspectRatio,
      },
    };
    return { id: nextSlotId('digest'), kind: 'digest-entry', content };
  });
}

/**
 * Splits a very long memory's text into two page-sized halves without ever
 * breaking mid-paragraph or mid-sentence: it looks for the paragraph break
 * (blank line) or sentence break (". ") nearest the midpoint and splits
 * there. Falls back to the nearest word boundary if the text has neither.
 * The text itself is never trimmed or rewritten — only split at a natural
 * seam so each half still reads as whole sentences.
 */
export function splitLongText(text: string): [string, string] {
  const mid = Math.floor(text.length / 2);
  const paragraphBreak = findNearestBreak(text, mid, /\n\s*\n/g);
  const seam = paragraphBreak ?? findNearestBreak(text, mid, /[.!?]\s+/g) ?? findNearestBreak(text, mid, /\s+/g) ?? mid;
  return [text.slice(0, seam).trim(), text.slice(seam).trim()];
}

function findNearestBreak(text: string, mid: number, pattern: RegExp): number | null {
  let best: number | null = null;
  let bestDistance = Infinity;
  for (const match of text.matchAll(pattern)) {
    const pos = (match.index ?? 0) + match[0].length;
    const distance = Math.abs(pos - mid);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = pos;
    }
  }
  return best;
}

/** Fabricates a short, stable placeholder "short code" until phase 2 wires the real momora.co/e/<token> URL. */
function placeholderShortCode(memoryId: string): string {
  return memoryId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase().padEnd(4, 'X');
}

// ---------------------------------------------------------------------------
// Per-group template scoring. Each scorer returns a 0..1 fit quality, or
// `null` if the template is infeasible for this content at all. Evaluated
// top-to-bottom in the Momora Book Layout System 1b §5 decision table; here
// that ordering is expressed as relative scores instead of an if/else chain,
// so the rhythm rule (never repeat the previous page's template when a
// comparable alternative exists) can still pick between near-ties.
// ---------------------------------------------------------------------------

interface MemoryGroup {
  memories: ResolvedMemory[];
  /** Flattened (memoryId, asset) pairs across the group, in memory order. */
  photoAssets: Array<{ memoryId: string; memory: ManifestMemory; asset: ManifestAsset }>;
  hasLongText: boolean;
  totalTextChars: number;
  /**
   * Set only when this group was ASSEMBLED by cross-memory pairing (final-
   * fix-round item 1) from two different single-photo memories — the
   * memoryId that should read as dominant (~2/3 of the anchor-media/
   * flex-grid packer's row, via the same hero mechanism a highlighted
   * memory already gets). Undefined for every other group, where hero
   * assignment keeps using the outline's own highlight list.
   */
  pairedDominantMemoryId?: string;
  /**
   * Set only on a solo illustrated-story group chunking has matched with
   * an ADJACENT short illustrated neighbor (acceptance-review follow-up,
   * item 2): `'first'` must land on an even (left) page — enforced the
   * same way a split illustrated-story's text half does — and gets
   * `stagger: false`; `'second'` immediately follows on the facing odd
   * page with `stagger: true`, so the two frames read as a deliberately
   * alternating pair rather than two independently-hashed coin flips that
   * might coincidentally match.
   */
  illustratedPairRole?: 'first' | 'second';
}

function toGroup(memories: ResolvedMemory[]): MemoryGroup {
  const photoAssets: MemoryGroup['photoAssets'] = [];
  let hasLongText = false;
  let totalTextChars = 0;
  for (const { id, memory } of memories) {
    for (const asset of memory.assets) {
      photoAssets.push({ memoryId: id, memory, asset });
    }
    const len = captionOf(memory).length;
    totalTextChars += len;
    if (len > PHOTO_STORY_MAX) hasLongText = true;
  }
  return { memories, photoAssets, hasLongText, totalTextChars };
}

/** A group the pairing pass may combine with an adjacent one: exactly one memory, exactly one photo. */
function isSoloPhotoGroup(group: MemoryGroup): boolean {
  return group.memories.length === 1 && group.photoAssets.length === 1;
}

/**
 * Round-5 amendment ("minimum image size"): a reliable predictor of "this
 * two-photo group will become an anchor-media pair" WITHOUT actually
 * calling `fitGroup` (which would burn slot-id numbering on a fit whose
 * result we might discard) — every other two-photo-capable scorer either
 * requires exactly one photo (full-bleed, panorama) or scores well below
 * anchor-media's 0.85 when it also applies (text-page's 0.2). True for
 * both a cross-memory PAIRED group and an ordinary single-memory
 * two-asset group.
 */
function isAnchorMediaPairCandidate(group: MemoryGroup): boolean {
  return (
    group.photoAssets.length === 2 &&
    everyMemoryHasAPhoto(group) &&
    !group.hasLongText &&
    !group.memories.some(({ memory }) => isIllustratedMemory(memory) || isAudioMemory(memory))
  );
}

/**
 * Reverts a two-photo anchor-media candidate group back into two separate
 * solo-photo groups, in their original order — used when
 * `anchorPairMeetsMinSize` says the pair can't give both images the
 * `MIN_IMAGE_SIDE_MM` floor. Handles BOTH shapes a two-photo group can
 * take: a cross-memory pair (two different memories) and an ordinary
 * single memory with two of its own assets (each split-off group keeps
 * only ITS ONE asset, via a shallow memory-object override — the same
 * pattern `chunkSingleMemoryAssets` already uses).
 */
function splitAnchorPairToSoloGroups(group: MemoryGroup): [MemoryGroup, MemoryGroup] {
  const [a, b] = group.photoAssets;
  const soloGroup = (item: { memoryId: string; memory: ManifestMemory; asset: ManifestAsset }): MemoryGroup =>
    toGroup([{ id: item.memoryId, memory: { ...item.memory, assets: [item.asset] } }]);
  return [soloGroup(a), soloGroup(b)];
}

function isCaptionless(memory: ManifestMemory): boolean {
  return captionOf(memory).length === 0;
}

/** The memory with a caption leads (its story gets the dominant frame); otherwise reading order leads. */
function pickPairDominant(a: ResolvedMemory, b: ResolvedMemory): string {
  const aHasText = !isCaptionless(a.memory);
  const bHasText = !isCaptionless(b.memory);
  if (aHasText !== bHasText) return aHasText ? a.id : b.id;
  return a.id;
}

/**
 * Cross-memory pairing as a real feature, not just the density ceiling
 * (final-fix-round item 1): merges ADJACENT eligible solo single-photo
 * groups into one dominant+subordinate anchor-media page, escalating what
 * counts as "eligible" by `level` (see `PairingLevel`). Order is never
 * reshuffled to find a better pairing partner — only neighbors in the
 * existing chronological sequence are ever combined — so the book still
 * reads in the order its memories happened.
 */
function pairSoloGroups(groups: MemoryGroup[], level: PairingLevel): MemoryGroup[] {
  if (level === 0) return groups;
  const result: MemoryGroup[] = [];
  let i = 0;
  while (i < groups.length) {
    const cur = groups[i];
    const next = groups[i + 1];
    if (next && isSoloPhotoGroup(cur) && isSoloPhotoGroup(next)) {
      const curCaptionless = isCaptionless(cur.memories[0].memory);
      const nextCaptionless = isCaptionless(next.memories[0].memory);
      const bothCaptionless = curCaptionless && nextCaptionless;
      const oneCaptionless = curCaptionless || nextCaptionless;
      const eligible = level >= 3 || (level >= 2 && oneCaptionless) || (level >= 1 && bothCaptionless);
      if (eligible) {
        result.push({
          ...toGroup([...cur.memories, ...next.memories]),
          pairedDominantMemoryId: pickPairDominant(cur.memories[0], next.memories[0]),
        });
        i += 2;
        continue;
      }
    }
    result.push(cur);
    i += 1;
  }
  return result;
}

function scoreIllustratedStory(group: MemoryGroup): number | null {
  if (group.memories.length !== 1) return null;
  const { memory } = group.memories[0];
  if (!isIllustratedMemory(memory)) return null;
  return 0.99; // Row 1 of the decision table — wins outright when it applies.
}

function scoreFlexGrid(group: MemoryGroup): number | null {
  const n = group.photoAssets.length;
  // Density: anchor-media owns every 1-2-photo page (clear hierarchy, never
  // an even grid). Round-8 item 5b ("grids only at 4" — owner rule: a page
  // holds exactly 1, 2, or 4 photos, NEVER 3, never >4): flex-grid now
  // fires ONLY for the single-memory 4-photo exception the chunker isolates
  // below (never a cross-memory grid, never a 3-photo grid — a 3-photo
  // memory splits to a 2+1 pair of anchor-media pages instead, see
  // `chunkSingleMemoryAssets`), and (density v3, item 5) only when the
  // whole set composes cleanly at native aspect — the chunker itself never
  // hands this scorer an incompatible set, but the check is repeated here
  // too so this scorer is correct in isolation.
  if (n !== SINGLE_MEMORY_GRID_MAX) return null;
  if (group.hasLongText) return null; // long entries are routed to text-forward templates instead
  if (!gridAspectsCompatible(group.photoAssets.map(({ asset }) => asset))) return null;
  const capacityScore = 1 - Math.min(1, Math.abs(n - GRID_TARGET) / GRID_TARGET);
  const cropScore =
    group.photoAssets.reduce((sum, { asset }) => {
      const target = nearestStandardAspect(asset.aspectRatio);
      return sum + (aspectFitsWithinTolerance(asset.aspectRatio, target) ? 1 : 0.5);
    }, 0) / n;
  return capacityScore * 0.4 + cropScore * 0.6;
}

function scoreTextPage(group: MemoryGroup): number | null {
  const anyText = group.memories.some(({ memory }) => captionOf(memory).length > 0);
  if (!anyText) return null;
  if (group.memories.some(({ memory }) => isIllustratedMemory(memory))) return null;
  // Best when there is no photo pulling attention away, or when a memory's
  // text is too long for photo-story (text must never be trimmed).
  if (group.photoAssets.length === 0) return 0.9;
  return group.hasLongText ? 0.85 : 0.2;
}

/**
 * True when every memory in the group contributes a photo — i.e. there's no
 * "orphan" zero-asset text memory riding along. Single-photo templates
 * (full-bleed, panorama-spread) only render one photo slot each, so a group
 * with an orphan text memory must be routed to flex-grid/anchor-media/
 * text-page instead, where that memory's caption still gets printed
 * (Stage C: captions/text are never silently dropped).
 */
function everyMemoryHasAPhoto(group: MemoryGroup): boolean {
  return group.memories.every(({ memory }) => memory.assets.length > 0);
}

interface FullBleedBudget {
  total: number;
  consecutive: number;
}

/** Round-7 item 2c: 1 + 1 per ~10 content pages — see `FULL_BLEED_BUDGET_BASE`/`_PER_PAGES`'s doc comment. */
function fullBleedBudgetCap(contentPageCount: number): number {
  return FULL_BLEED_BUDGET_BASE + Math.floor(contentPageCount / FULL_BLEED_BUDGET_PER_PAGES);
}

/**
 * Round-8 item 5a ("paced, not front-loaded"): owner target is roughly one
 * full-bleed every 15-20 content pages, spread THROUGH the book — not
 * `fullBleedBudgetCap`'s slots all spent as soon as they're each available.
 * `contentPageCount` at scoring time is the fitter's own running position
 * (`ContentPagesState.contentPageCount`, threaded through `fitGroup` — the
 * same signal the panorama quota already reads, see its own doc comment),
 * not a pre-computed book total, so this reads as "how far through the book
 * are we RIGHT NOW" rather than "how big will the book end up being" — the
 * cleanest existing position signal, chosen over threading new state
 * through `buildContentPages`/`fitGroup` just for this. A large candidate
 * pool (post re-export, once every photo carries `originalWidth`) could
 * otherwise pass the overall cap's early, still-small ceiling immediately
 * and then sit on a full budget for the rest of a long book with nothing
 * left to spend near the end; this gate gives out AT MOST one more slot per
 * `FULL_BLEED_PACING_PAGES` content pages, on top of (never instead of) the
 * overall cap and the 3-consecutive cap.
 */
const FULL_BLEED_PACING_PAGES = 15;
function fullBleedPacingAllows(budget: FullBleedBudget, contentPageCount: number): boolean {
  return budget.total < Math.floor(contentPageCount / FULL_BLEED_PACING_PAGES) + 1;
}

function scoreFullBleed(
  group: MemoryGroup,
  element: OutlineElement,
  outline: BookOutline,
  budget: FullBleedBudget,
  contentPageCount: number,
): number | null {
  if (group.photoAssets.length !== 1) return null;
  if (!everyMemoryHasAPhoto(group)) return null;
  if (group.hasLongText) return null;
  const { memoryId, asset } = group.photoAssets[0];
  const isHero = isHighlight(element, outline, memoryId);
  const aspect = effectiveAspect(asset);
  // Round-7 item 2b: a wide hero (aspect >= the panorama threshold) is
  // panorama material "by nature" — it either wins panorama placement
  // (see `buildContentUnits`'s wide-hero routing, budget-gated) or falls
  // through to anchor-media's own natural-aspect rendering. It never wins
  // full-bleed — a square crop on something this wide is exactly the
  // "cropped faces" bug this rework fixes (the validated Mara Feb case).
  if (isHero && aspect >= PANORAMA_ASPECT_THRESHOLD) return null;
  if (budget.total >= fullBleedBudgetCap(contentPageCount)) return null;
  if (!fullBleedPacingAllows(budget, contentPageCount)) return null;
  if (budget.consecutive >= FULL_BLEED_MAX_CONSECUTIVE) return null;
  // Round-7 item 2a: crop-loss gating replaces the old one-sided aspect
  // floor (which let an arbitrarily wide photo through as "landscape" and
  // silently cropped away nearly half of it). A hero gets a looser bar —
  // human-reviewed downstream, so a bit more crop is an acceptable trade.
  const maxCropLoss = isHero ? FULL_BLEED_HERO_MAX_CROP_LOSS : FULL_BLEED_MAX_CROP_LOSS;
  if (fullBleedCropLoss(aspect) > maxCropLoss) return null;
  const trustedWidthPx = asset.originalWidth ?? asset.width;
  if (isHero) {
    // Trusted hero path (owner review round 3, item 2): bypasses the face
    // gate as human-reviewed interim, same as panorama's trusted
    // candidates — and is PREFERRED (a higher score than anchor-media's
    // 0.9 and a non-hero's own full-bleed score below), not merely
    // permitted, so a trusted hero actually wins the page.
    if (trustedWidthPx >= FULL_BLEED_TRUSTED_MIN_WIDTH_PX) return 0.97;
    // Untrusted fallback: the original high-resolution + real-face-clearance
    // path, for whenever a genuine per-photo face-detection field lands
    // (currently unreachable — `hasFaceClearance` fails closed with no such
    // field yet; see its own doc comment).
    if (asset.width < FULL_BLEED_MIN_WIDTH_PX) return null;
    if (!hasFaceClearance(asset)) return null;
    return 0.9;
  }
  // Round-7 item 2c: full-bleed opens to non-heroes too — any solo photo
  // with a print-safe original width and a crop loss within the (tighter)
  // non-hero bar may win it, heroes still prioritized first (0.97/0.9
  // above both beat this).
  if (trustedWidthPx < FULL_BLEED_TRUSTED_MIN_WIDTH_PX) return null;
  return 0.91;
}

function scorePanorama(group: MemoryGroup): number | null {
  if (group.photoAssets.length !== 1) return null;
  if (!everyMemoryHasAPhoto(group)) return null;
  const { asset } = group.photoAssets[0];
  if (!isPanoramicAsset(asset)) return null;
  if (!hasFaceClearance(asset)) return null; // fails closed — see hasFaceClearance
  return 0.95;
}

function scoreAudioNote(group: MemoryGroup): number | null {
  if (group.memories.length < 1 || group.memories.length > AUDIO_NOTE_MAX_PER_PAGE) return null;
  if (!group.memories.every(({ memory }) => isAudioMemory(memory))) return null;
  return 0.99;
}

function scoreAnchorMedia(group: MemoryGroup): number | null {
  // The book's workhorse (density rule): 1-2 photos, always rendered with a
  // dominant + subordinate hierarchy by the template itself (positional,
  // not data-driven) — so this scores well regardless of outline highlights.
  const n = group.photoAssets.length;
  if (n < 1 || n > CROSS_MEMORY_MAX_PER_PAGE) return null;
  if (group.hasLongText) return null;
  if (!everyMemoryHasAPhoto(group)) return null;
  return n === 1 ? 0.9 : 0.85;
}

/**
 * `photo-story` is deliberately absent (owner review round 3, item 7):
 * captions for photo/video memories now ALWAYS live in the footer index —
 * `photo-story`'s entire reason for being a distinct template from
 * `anchor-media` was its on-page caption, so it's never selected anymore.
 * See templates/PhotoStory.tsx's own comment.
 */
const GRID_SCORERS: Array<{
  templateId: TemplateId;
  score: (g: MemoryGroup, e: OutlineElement, o: BookOutline, budget: FullBleedBudget, contentPageCount: number) => number | null;
}> = [
  { templateId: 'illustrated-story', score: (g) => scoreIllustratedStory(g) },
  { templateId: 'audio-note', score: (g) => scoreAudioNote(g) },
  { templateId: 'panorama-spread', score: (g) => scorePanorama(g) },
  { templateId: 'full-bleed', score: (g, e, o, b, c) => scoreFullBleed(g, e, o, b, c) },
  { templateId: 'anchor-media', score: (g) => scoreAnchorMedia(g) },
  { templateId: 'flex-grid', score: (g) => scoreFlexGrid(g) },
  { templateId: 'text-page', score: (g) => scoreTextPage(g) },
];

/**
 * `qr` is intentionally never set here — a slot-derived footer entry's
 * photo already shows its own scan-to-watch mark right under itself (see
 * common/PhotoTile, owner review round 3 item 8); only the synthetic
 * `pendingCredit` entry (a full-bleed/panorama video with no on-page tile
 * of its own) ever carries `qr: true` on a footer entry.
 */
function footerIndexFor(slots: LayoutSlot[]): FooterIndexEntry[] {
  const entries: FooterIndexEntry[] = [];
  for (const slot of slots) {
    if (slot.kind !== 'photo') continue;
    const c = slot.content as PhotoSlotContent;
    if (c.index == null) continue;
    entries.push({ index: c.index, indices: [c.index], date: c.date, note: c.caption });
  }
  entries.sort((a, b) => a.index - b.index);
  return entries;
}

/**
 * Footnote consolidation (owner review round 3, item 9): entries sharing
 * the exact same date AND caption merge onto ONE line with several
 * superscript numerals ("¹ ² ³ ⁴ 23 oct") instead of repeating the date
 * once per photo — the common case is a single-memory flex-grid, where
 * every photo naturally shares one memory's date and caption. A synthetic
 * `qr` credit entry never merges with anything (kept structurally distinct,
 * see `FooterIndexEntry`'s own doc comment) nor does an entry with no note
 * ever merge into one WITH a note or vice versa — only true (date, note)
 * duplicates consolidate.
 */
function consolidateFooterIndex(entries: FooterIndexEntry[]): FooterIndexEntry[] {
  const groups = new Map<string, FooterIndexEntry>();
  const order: string[] = [];
  for (const entry of entries) {
    if (entry.qr) {
      // Never merged — see the doc comment above.
      const key = `qr:${entry.index}`;
      groups.set(key, entry);
      order.push(key);
      continue;
    }
    const key = `${entry.date}|${entry.note ?? ''}`;
    const existing = groups.get(key);
    if (existing) {
      existing.indices.push(...entry.indices);
    } else {
      groups.set(key, { ...entry, indices: [...entry.indices] });
      order.push(key);
    }
  }
  return order.map((key) => groups.get(key)!).sort((a, b) => a.index - b.index);
}

function buildSlotsForTemplate(
  templateId: TemplateId,
  group: MemoryGroup,
  element: OutlineElement,
  outline: BookOutline,
): LayoutSlot[] {
  const slots: LayoutSlot[] = [];
  switch (templateId) {
    case 'flex-grid':
    case 'anchor-media': {
      let index = 1;
      // A highlighted memory with several assets (e.g. 3 photos + a video
      // from the same birthday) gets exactly ONE hero tile — its first
      // asset — not every asset it owns. Without this, a 4-asset highlight
      // hands the packer four simultaneous hero-sized (4-col) spans, which
      // can't sit side by side and collapses into one stacked column.
      const heroAssigned = new Set<string>();
      // Native aspect everywhere outside grids (owner review round 3, item
      // 4): anchor-media (1-2 photos) always renders its own true aspect —
      // lavender containment is a multi-photo-grid-only fallback now.
      // flex-grid (the 3-4 same-memory exception) keeps the standard
      // crop-box treatment, though density v3 (item 5) means the chunker
      // only ever hands it an aspect-COMPATIBLE set, so that fallback
      // rarely if ever actually triggers in practice.
      const natural = templateId === 'anchor-media';
      // A cross-memory-paired group (final-fix-round item 1) always uses ITS
      // OWN dominant/subordinate call, regardless of outline highlights —
      // the pairing pass already decided which of the two memories leads.
      for (const { memoryId, memory, asset } of group.photoAssets) {
        let hero = false;
        if (group.pairedDominantMemoryId) {
          hero = memoryId === group.pairedDominantMemoryId && !heroAssigned.has(memoryId);
        } else if (isHighlight(element, outline, memoryId) && !heroAssigned.has(memoryId)) {
          hero = true;
        }
        if (hero) heroAssigned.add(memoryId);
        slots.push(buildPhotoSlot(memoryId, memory, asset, { hero, index, natural }));
        index += 1;
      }
      // Text-only memories bundled into this group (no assets of their own)
      // still get their caption printed verbatim — never silently dropped.
      for (const { id, memory } of group.memories) {
        const caption = captionOf(memory);
        if (memory.assets.length === 0 && caption) {
          slots.push(buildTextSlot(caption, id, memory.date));
        }
      }
      return slots;
    }
    case 'full-bleed':
    case 'panorama-spread': {
      // No footer index / caption on these — spec: full-bleed and panorama
      // never carry text over the image; credit (panorama) accumulates on
      // the NEXT content page's index instead (see fitBook's pendingCredit).
      for (const { memoryId, memory, asset } of group.photoAssets) {
        slots.push(buildPhotoSlot(memoryId, memory, asset, { hero: isHighlight(element, outline, memoryId), index: null }));
      }
      return slots;
    }
    case 'photo-story': {
      const { id, memory } = group.memories[0];
      for (const asset of memory.assets) {
        slots.push(buildPhotoSlot(id, memory, asset, { hero: isHighlight(element, outline, id), index: null, natural: true }));
      }
      slots.push(buildTextSlot(captionOf(memory), id, memory.date));
      return slots;
    }
    case 'illustrated-story': {
      const { id, memory } = group.memories[0];
      const illo = buildIllustrationSlot(id, memory);
      if (illo) slots.push(illo);
      slots.push(buildTextSlot(captionOf(memory), id, memory.date));
      return slots;
    }
    case 'text-page': {
      for (const { id, memory } of group.memories) {
        const caption = captionOf(memory);
        if (caption) slots.push(buildTextSlot(caption, id, memory.date));
      }
      // 241-900 chars with a real photo: small companion — built separately
      // as its own facing page by buildTextPageGroup, not inline here.
      return slots;
    }
    case 'audio-note': {
      for (const { id, memory } of group.memories) {
        const content: AudioNoteContent = {
          kind: 'audio-note',
          memoryId: id,
          date: memory.date,
          shortCode: placeholderShortCode(id),
          shareToken: memory.shareToken ?? null,
        };
        slots.push({ id: nextSlotId('audio'), kind: 'audio-note', content });
        const caption = captionOf(memory);
        if (caption) slots.push(buildTextSlot(caption, id, memory.date));
      }
      return slots;
    }
    default:
      return slots;
  }
}

/** Result of fitting one group of memories to its best-scoring feasible template. */
interface GroupFitResult {
  templateId: TemplateId;
  score: number;
  variants: BookPageVariant[];
}

interface TemplateCandidate {
  templateId: TemplateId;
  score: number;
}

/**
 * Every feasible template for `group`, ranked best-first — the SAME scoring
 * pass `fitGroup` decides real pages with. Factored out (round-9 item 2a)
 * so the parity-reorder pass can predict what a group WILL win, using the
 * exact same scorers/budget/pacing inputs `fitGroup` itself uses, rather
 * than an approximation that could drift from real assembly.
 */
function rankTemplateCandidates(
  group: MemoryGroup,
  element: OutlineElement,
  outline: BookOutline,
  fullBleedBudget: FullBleedBudget,
  contentPageCount: number,
): TemplateCandidate[] {
  return GRID_SCORERS.map(({ templateId, score }) => ({
    templateId,
    score: score(group, element, outline, fullBleedBudget, contentPageCount),
  }))
    .filter((c): c is TemplateCandidate => c.score !== null)
    .sort((a, b) => b.score - a.score);
}

/**
 * Rhythm rule (avoid repeating the immediately previous page's template
 * when a comparably good alternative exists) applied to an already-ranked
 * candidate list — shared by `fitGroup` and the round-9 item 2a reorder
 * predictor below, so the two can never pick a different winner for the
 * same inputs.
 */
function pickRankedWinnerIndex(candidates: TemplateCandidate[], previousTemplateId: TemplateId | null): number {
  if (
    candidates.length > 1 &&
    candidates[0].templateId === previousTemplateId &&
    candidates[1].score >= candidates[0].score * 0.7
  ) {
    return 1;
  }
  return 0;
}

/**
 * Round-9 item 2a: predicts which template a group WOULD win, without
 * building slots — used by the parity-reorder pass to know ahead of time
 * whether a unit will render as `full-bleed` (needs even landing) or
 * consume a section's pending header (changes illustrated-story's own
 * fitted-height math), so the reorder pass's decisions can never diverge
 * from what `fitGroup` actually decides at assembly time. `null` when
 * nothing is feasible (mirrors `fitGroup`'s own `null` return, which
 * becomes a layout gap, never a page).
 */
function predictWinningTemplateId(
  group: MemoryGroup,
  element: OutlineElement,
  outline: BookOutline,
  previousTemplateId: TemplateId | null,
  fullBleedBudget: FullBleedBudget,
  contentPageCount: number,
): TemplateId | null {
  const candidates = rankTemplateCandidates(group, element, outline, fullBleedBudget, contentPageCount);
  if (candidates.length === 0) return null;
  return candidates[pickRankedWinnerIndex(candidates, previousTemplateId)].templateId;
}

function fitGroup(
  group: MemoryGroup,
  element: OutlineElement,
  outline: BookOutline,
  previousTemplateId: TemplateId | null,
  fullBleedBudget: FullBleedBudget,
  contentPageCount: number,
): GroupFitResult | null {
  const candidates = rankTemplateCandidates(group, element, outline, fullBleedBudget, contentPageCount);
  if (candidates.length === 0) return null;

  // Rhythm rule: avoid repeating the immediately previous page's template
  // when a comparably good alternative exists (never force a worse choice
  // just for variety).
  const winnerIndex = pickRankedWinnerIndex(candidates, previousTemplateId);
  const winner = candidates[winnerIndex];
  const ranked = [winner, ...candidates.filter((_, i) => i !== winnerIndex)].slice(0, 3);
  // Each ranked candidate gets its own fully-built slots (not just the
  // winner's) so the preview's variant switcher can render any of them
  // immediately, with no re-fit against the manifest.
  const variants: BookPageVariant[] = ranked.map((c) => ({
    templateId: c.templateId,
    params: {},
    score: c.score,
    slots: buildSlotsForTemplate(c.templateId, group, element, outline),
  }));

  return { templateId: winner.templateId, score: winner.score, variants };
}

// ---------------------------------------------------------------------------
// Chunking: split an element's memories into page-sized groups. Long-text,
// panoramic, illustrated, and audio memories are always isolated to their
// own group — they each own a dedicated composition and must never be
// bundled with unrelated photos.
// ---------------------------------------------------------------------------

/**
 * Density v3 (owner review round 3, item 5; tightened round-8 item 5b
 * "grids only at 4"): chunks ONE memory's own assets into page-sized
 * slices of up to `SINGLE_MEMORY_GRID_MAX` (4) — but a slice only stays
 * together as a single flex-grid page when it's EXACTLY 4 long AND
 * `gridAspectsCompatible` says the whole slice composes cleanly at native
 * aspect; a 3-long slice (or an incompatible 4-long one, or a 5+ remainder)
 * instead splits down to strict pairs (`CROSS_MEMORY_MAX_PER_PAGE`) — 3 ->
 * 2+1, never a 3-photo grid. This is also what keeps, say, one portrait
 * video mixed in with three landscape photos from ever being forced into
 * an incompatible grid (item 4's "vertical-video lavender bar" bug) — that
 * slice just becomes anchor-media pairs instead.
 */
function chunkSingleMemoryAssets(assets: ManifestAsset[]): ManifestAsset[][] {
  const chunks: ManifestAsset[][] = [];
  for (let i = 0; i < assets.length; i += SINGLE_MEMORY_GRID_MAX) {
    const slice = assets.slice(i, i + SINGLE_MEMORY_GRID_MAX);
    if (slice.length === SINGLE_MEMORY_GRID_MAX && gridAspectsCompatible(slice)) {
      chunks.push(slice);
    } else if (slice.length > CROSS_MEMORY_MAX_PER_PAGE) {
      for (let j = 0; j < slice.length; j += CROSS_MEMORY_MAX_PER_PAGE) {
        chunks.push(slice.slice(j, j + CROSS_MEMORY_MAX_PER_PAGE));
      }
    } else {
      chunks.push(slice);
    }
  }
  return chunks;
}

function chunkMemories(memories: ResolvedMemory[], pairingLevel: PairingLevel = 0): MemoryGroup[] {
  const groups: MemoryGroup[] = [];
  let pendingAudio: ResolvedMemory[] = [];
  // Acceptance-review follow-up, item 2: the most recently pushed group, IF
  // it was a short illustrated memory still waiting for an adjacent partner
  // — reset the instant anything else intervenes, so only a truly adjacent
  // pair of short illustrated stories ever qualifies.
  let pendingIllustratedPairFirst: MemoryGroup | null = null;

  const flushAudio = () => {
    if (pendingAudio.length > 0) {
      groups.push(toGroup(pendingAudio));
      pendingIllustratedPairFirst = null;
    }
    pendingAudio = [];
  };

  for (const item of memories) {
    const { id, memory } = item;

    if (isAudioMemory(memory)) {
      pendingAudio.push(item);
      if (pendingAudio.length >= AUDIO_NOTE_MAX_PER_PAGE) flushAudio();
      continue;
    }
    flushAudio();

    // Illustrated memories always get their own page — but a SHORT one
    // (<= ILLUSTRATED_PAIR_MAX_CHARS) adjacent to another short illustrated
    // memory pairs with it onto a facing spread (a run of 3+ is instead
    // swept into a quote-collection upstream in `buildContentUnits`, before
    // this function even sees it — this only ever fires for a lone pair).
    if (isIllustratedMemory(memory)) {
      const group = toGroup([item]);
      const isShort = captionOf(memory).length <= ILLUSTRATED_PAIR_MAX_CHARS;
      if (isShort && pendingIllustratedPairFirst) {
        pendingIllustratedPairFirst.illustratedPairRole = 'first';
        group.illustratedPairRole = 'second';
        pendingIllustratedPairFirst = null;
      } else if (isShort) {
        pendingIllustratedPairFirst = group;
      } else {
        pendingIllustratedPairFirst = null;
      }
      groups.push(group);
      continue;
    }
    pendingIllustratedPairFirst = null;

    const textLen = captionOf(memory).length;
    const soloPanorama = memory.assets.length === 1 && isPanoramicAsset(memory.assets[0]);

    if (memory.assets.length === 0) {
      // A zero-asset memory with text gets its own text-forward page (never
      // bundled with a neighboring photo's page) — its caption is never
      // dropped, it just gets a small page of its own rather than riding
      // along in someone else's footer index (density rule: every page
      // reads as one clear thing, not a grid of unrelated fragments). A
      // memory whose text sanitizes to empty (Task 2) has neither a photo
      // nor a caption left to print — dropped, same as one with no text at
      // all.
      if (textLen > 0) groups.push(toGroup([item]));
      continue;
    }

    // Long-text and panoramic memories always get their own page/spread —
    // never bundled with other memories' photos.
    if (textLen > PHOTO_STORY_MAX || soloPanorama) {
      groups.push(toGroup([item]));
      continue;
    }

    // Density v3 (owner review round 3, item 5): <=2 assets -> one
    // hierarchy page (anchor-media). 3+ assets from this SAME memory ->
    // chunked via `chunkSingleMemoryAssets`, which only keeps a 3-4-photo
    // chunk together as a flex-grid page when it composes cleanly at
    // native aspect — otherwise (and always for 5+) it splits down to
    // strict max-2 pairs. Never more than one memory's assets on a page
    // either way.
    if (memory.assets.length <= CROSS_MEMORY_MAX_PER_PAGE) {
      groups.push(toGroup([{ id, memory }]));
    } else {
      for (const sliceAssets of chunkSingleMemoryAssets(memory.assets)) {
        const sliceMemory: ManifestMemory = { ...memory, assets: sliceAssets };
        groups.push(toGroup([{ id, memory: sliceMemory }]));
      }
    }
  }
  flushAudio();
  return pairSoloGroups(groups, pairingLevel);
}

// ---------------------------------------------------------------------------
// Structural (non-content) pages: cover, blank+dedication, through-the-years,
// closing, and themed spread-title openers.
// ---------------------------------------------------------------------------

const DEFAULT_SPINE_MM = 9;
/** `buildCoverPages`'s photo-suitability floor — an asset narrower than this
 * (in px) is never trusted as a cover photo, hero-candidate legacy path
 * excepted (see the precedence comment there). Compared against
 * `effectiveCoverWidth`, never `asset.width` directly. */
const COVER_PHOTO_MIN_WIDTH_PX = 2000;

/**
 * Bug fix (live finding, 2026-08-31): `asset.width` is the EXPORTED
 * (preview) file's width — preview-mode exports downscale every photo to
 * ~1280px regardless of the source's real resolution — so gating on it
 * alone rejected every `coverCandidates` nominee in every preview-mode
 * manifest, silently falling through to the legacy `heroCandidates` path.
 * `asset.originalWidth` (export pipeline addition, "owner round-8" —
 * measured from the ORIGINAL photo bytes for every photo asset,
 * unconditionally, in both preview and print export modes; see
 * `eval-memory-book-assets.ts`'s `ManifestAsset.originalWidth` doc comment)
 * is the real source-pixel width and is what the cover gate must check.
 * Falls back to `asset.width` when `originalWidth` is absent (a manifest
 * exported before that field existed) — same behavior as before this fix
 * for such a manifest.
 */
function effectiveCoverWidth(asset: ManifestAsset): number {
  return asset.originalWidth ?? asset.width;
}

function formatYearRange(start: string, end: string): string {
  const startYear = new Date(start).getUTCFullYear();
  const endYear = new Date(end).getUTCFullYear();
  return Number.isNaN(startYear) || Number.isNaN(endYear)
    ? ''
    : startYear === endYear
      ? String(startYear)
      : `${startYear} – ${endYear}`;
}

type CoverCandidate = { memoryId: string; memory: ManifestMemory; asset: ManifestAsset };

/**
 * Owner review (three validation books, 2026-08-31): the OLD fallback —
 * "first photo >=2000px wide in manifest order" — is chronological-first,
 * which twice produced a bad cover (a hospital/medical shot, and a photo
 * OF a child's drawing rather than the child). Picks, among qualifying
 * photos, the one whose memory date sits closest to the MIDDLE of the
 * book's date range (`manifest.scope.start`/`end`) — never
 * chronological-first. Ties: widest photo wins, then lowest memory id
 * (stable, deterministic). Returns undefined when no photo qualifies.
 */
function pickMiddleOfRangeCoverPhoto(candidates: CoverCandidate[], scope: ManifestScope): CoverCandidate | undefined {
  const photos = candidates.filter(({ asset }) => asset.kind === 'photo' && effectiveCoverWidth(asset) >= COVER_PHOTO_MIN_WIDTH_PX);
  if (photos.length === 0) return undefined;

  const startMs = Date.parse(scope.start);
  const endMs = Date.parse(scope.end);
  const midMs = Number.isNaN(startMs) || Number.isNaN(endMs) ? NaN : (startMs + endMs) / 2;
  const distanceFromMid = (candidate: CoverCandidate): number => {
    const dateMs = Date.parse(candidate.memory.date);
    return Number.isNaN(midMs) || Number.isNaN(dateMs) ? Number.POSITIVE_INFINITY : Math.abs(dateMs - midMs);
  };

  let best = photos[0];
  let bestDistance = distanceFromMid(best);
  for (const candidate of photos.slice(1)) {
    const distance = distanceFromMid(candidate);
    const closer = distance < bestDistance;
    const tieWider = distance === bestDistance && effectiveCoverWidth(candidate.asset) > effectiveCoverWidth(best.asset);
    const tieSameWidthLowerId =
      distance === bestDistance &&
      effectiveCoverWidth(candidate.asset) === effectiveCoverWidth(best.asset) &&
      candidate.memoryId < best.memoryId;
    if (closer || tieWider || tieSameWidthLowerId) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The full wraparound cover (item 13, visual-review batch; voice pared down
 * per owner review 2026-08-31 after enzo-year-one/enzo-year-two — full-bleed
 * 'photo' voice is gone, only 'mixed' (contained front photo, light spine,
 * wordmark/colophon back) and 'minimal' (no photo) remain).
 *
 * Cover-photo selection precedence:
 *   1. The first `outline.coverCandidates` entry that resolves to a
 *      qualifying (>=2000px wide, per `effectiveCoverWidth` — the real
 *      SOURCE-pixel width, not the ~1280px preview export width) photo
 *      asset — the outline's own vision-judged nominees (child's face
 *      visible, no medical/hospital setting, no photo-of-a-drawing),
 *      best-first. Optional field; skipped entirely while empty/absent.
 *   2. Legacy: the first `outline.heroCandidates` entry that resolves to
 *      ANY photo asset (no width floor) — kept byte-identical to the
 *      pre-existing behavior so already-ordered books (enzo-year-three,
 *      mara-year-one) keep the exact cover they shipped with.
 *   3. Improved fallback (never chronological-first — see
 *      `pickMiddleOfRangeCoverPhoto`).
 */
function buildCoverPages(element: OutlineElement, manifest: BookManifest, outline: BookOutline, options: FitOptions): BookPage[] {
  const candidates: CoverCandidate[] = Object.entries(manifest.memories).flatMap(([memoryId, memory]) =>
    memory.assets.map((asset) => ({ memoryId, memory, asset })),
  );

  const coverCandidateIds = outline.coverCandidates ?? [];
  const fromCoverCandidates = coverCandidateIds
    .map((id) => candidates.find(({ memoryId, asset }) => memoryId === id && asset.kind === 'photo' && effectiveCoverWidth(asset) >= COVER_PHOTO_MIN_WIDTH_PX))
    .find((c): c is CoverCandidate => c !== undefined);

  const candidatePhoto =
    fromCoverCandidates ??
    candidates.find(({ memoryId, asset }) => (outline.heroCandidates ?? []).includes(memoryId) && asset.kind === 'photo') ??
    pickMiddleOfRangeCoverPhoto(candidates, manifest.scope);

  const voice: 'minimal' | 'mixed' = candidatePhoto ? 'mixed' : 'minimal';

  const params: TemplateParams = {
    childName: manifest.child.name,
    yearRangeLabel: formatYearRange(manifest.scope.start, manifest.scope.end),
    backCoverLine: outline.backCoverLine ?? null,
    spineMm: options.spineMm ?? DEFAULT_SPINE_MM,
    voice,
    assetFile: candidatePhoto?.asset.file ?? null,
    portraitFile: voice === 'mixed' ? (manifest.portraits[manifest.portraits.length - 1]?.file ?? null) : null,
    // Reposition-in-crop for the cover photo (Design Decision 9's "+ the
    // cover photo via its params path") — same never-set-by-the-fitter
    // convention as `PhotoSlotContent.focalPoint`; only `model/edits.ts`
    // sets a real value, post-fit, from a saved edit.
    assetFocalPoint: null,
  };

  return [emptyPage({ id: element.id, sourceElementId: element.id, templateId: 'cover-wrap', params })];
}

/**
 * Title/dedication element -> TWO physical pages: a deliberately blank even
 * page (the book breathes before its first image), then the dedication text
 * on the facing odd page, 4-of-6 columns (Momora Book Layout System 1a
 * "dedicatoria").
 */
function buildDedicationPages(element: OutlineElement, manifest: BookManifest, outline: BookOutline): BookPage[] {
  const blank = emptyPage({
    id: `${element.id}:blank`,
    sourceElementId: element.id,
    templateId: 'blank',
    blankReason: 'front-matter-verso',
  });
  const dedication = emptyPage({
    id: element.id,
    sourceElementId: element.id,
    templateId: 'dedication',
    params: { title: element.title, childName: manifest.child.name, body: outline.dedication ?? undefined },
  });
  return [blank, dedication];
}

/**
 * Balanced partition of N portraits into 2-3-per-spread groups (owner
 * decision, visual-review round 2 — "parametrize to 2-3 portrait pairs per
 * spread, chunk into as many spreads as needed"): fewest groups using a max
 * size of 3, sizes then spread as evenly as possible rather than front-
 * loading remainder into the first groups only — 7 -> [3,2,2], 6 -> [3,3],
 * 4 -> [2,2], matching the owner's own worked examples exactly.
 */
export function partitionPortraits(n: number): number[] {
  if (n <= 0) return [];
  const numGroups = Math.ceil(n / 3);
  const base = Math.floor(n / numGroups);
  const remainder = n % numGroups;
  return Array.from({ length: numGroups }, (_, i) => base + (i < remainder ? 1 : 0));
}

/**
 * Balanced partition of N quote-eligible entries into 3-6-per-spread
 * groups (same shape as `partitionPortraits`, sized for
 * `QUOTE_COLLECTION_MAX` instead of 3) — only ever called on a run already
 * known to be >= `QUOTE_COLLECTION_MIN`, so every resulting group size
 * lands in [3, 6]: 7 -> [4,3], 13 -> [5,4,4], 17 -> [6,6,5].
 */
export function partitionQuoteRun(n: number): number[] {
  if (n <= 0) return [];
  const numGroups = Math.ceil(n / QUOTE_COLLECTION_MAX);
  const base = Math.floor(n / numGroups);
  const remainder = n % numGroups;
  return Array.from({ length: numGroups }, (_, i) => base + (i < remainder ? 1 : 0));
}

function buildThroughTheYearsPage(element: OutlineElement, manifest: BookManifest): BookPage[] {
  const sizes = partitionPortraits(manifest.portraits.length);
  const pages: BookPage[] = [];
  let offset = 0;
  sizes.forEach((size, i) => {
    const slice = manifest.portraits.slice(offset, offset + size);
    offset += size;
    pages.push(
      emptyPage({
        id: sizes.length > 1 ? `${element.id}:${i}` : element.id,
        sourceElementId: element.id,
        templateId: 'through-the-years',
        params: { childName: manifest.child.name },
        slots: [{ id: nextSlotId('portraits'), kind: 'portrait-strip', content: { kind: 'portrait-strip', portraits: slice } }],
        isSpread: true,
      }),
    );
  });
  // No portraits at all: still show one empty spread rather than silently
  // dropping the section (ThroughTheYears already renders an empty state).
  if (pages.length === 0) {
    pages.push(
      emptyPage({
        id: element.id,
        sourceElementId: element.id,
        templateId: 'through-the-years',
        params: { childName: manifest.child.name },
        slots: [{ id: nextSlotId('portraits'), kind: 'portrait-strip', content: { kind: 'portrait-strip', portraits: [] } }],
        isSpread: true,
      }),
    );
  }
  return pages;
}

/**
 * Distinct memories actually printed in the finished book — the closing
 * line's own count (owner review round 3, item 16: "recoge [X]
 * recuerdos...", deliberately the memory count, not the page count).
 * Scans every slot kind that ever carries a `memoryId` so a memory counts
 * once no matter how many photos/pages it spans.
 */
function countDistinctMemories(pages: readonly BookPage[]): number {
  const ids = new Set<string>();
  for (const page of pages) {
    for (const slot of page.slots) {
      switch (slot.content.kind) {
        case 'photo':
        case 'illustration':
        case 'firsts-entry':
        case 'audio-note':
        case 'quote-entry':
        case 'digest-entry':
          ids.add(slot.content.memoryId);
          break;
        case 'text':
          if (slot.content.memoryId) ids.add(slot.content.memoryId);
          break;
        default:
          break;
      }
    }
  }
  return ids.size;
}

/**
 * Bug fix (owner review round 3, item 16): this used to take `outline`
 * and print `outline.editorialNote` verbatim — the AI's own INTERNAL
 * planning note, never meant for the reader, which leaked onto Mara's
 * printed closing page. It no longer even receives `outline`, so there is
 * nothing left in this function that could reprint it.
 */
function buildClosingPage(element: OutlineElement, childName: string, memoryCount: number): BookPage[] {
  return [
    emptyPage({
      id: element.id,
      sourceElementId: element.id,
      templateId: 'closing',
      params: { title: element.title, childName, memoryCount },
    }),
  ];
}

/**
 * Themed-spread title opener. Per the design canvas, this lives on a SINGLE
 * even page (column 1, optical axis 74mm from the top) — the facing odd
 * page already starts the spread's first content page, it is not a blank
 * dedicated two-page spread.
 */
function buildSpreadTitlePage(element: OutlineElement): BookPage {
  return emptyPage({
    id: `${element.id}:title`,
    sourceElementId: element.id,
    templateId: 'spread-title',
    params: {
      title: element.title,
      subtitle: element.subtitle ?? null,
      kicker: element.kicker ?? null,
      titleMode: element.titleMode ?? 'descriptive',
      titleSourceMemoryId: element.titleSourceMemoryId ?? null,
      spreadType: element.spreadType ?? null,
      momentCount: element.memoryIds.length,
    },
  });
}

// ---------------------------------------------------------------------------
// Content pages: backbone/themed/firsts memory groups fit to a template.
// ---------------------------------------------------------------------------

/**
 * Templates that can visually show a section header. `illustrated-story`
 * and `audio-note` joined this set as a diagnosed fix (owner review round
 * 3 — "month headers vanished after p34 in Enzo"): a segment made up
 * ENTIRELY of illustrated or audio memories previously had no capable page
 * to attach its header to at all, since neither template ever rendered
 * `sectionHeader`. `photo-story` stays listed even though the fitter never
 * selects it anymore (item 7) — harmless, and avoids a false assumption
 * elsewhere that this set exactly mirrors "templates the fitter can pick".
 */
const HEADER_CAPABLE: ReadonlySet<TemplateId> = new Set([
  'flex-grid',
  'anchor-media',
  'text-page',
  'photo-story',
  'illustrated-story',
  'audio-note',
  'quote-collection',
]);

interface ContentPagesState {
  lastTemplateId: TemplateId | null;
  fullBleedBudget: FullBleedBudget;
  /** Panorama/full-bleed credit deferred to the next page's footer index (never printed on the image itself). */
  pendingCredit: FooterIndexEntry | null;
  /** Book-wide panorama-candidate placements used so far (item 11, visual-review batch). */
  panoramaBudgetUsed: number;
  /** Approximate running count of content pages built so far, for the panorama quota ("1 + 1 per ~20 content pages"). */
  contentPageCount: number;
}

type ContentUnit =
  | { kind: 'group'; group: MemoryGroup }
  | { kind: 'panorama'; item: ResolvedMemory }
  | { kind: 'quote-collection'; items: ResolvedMemory[] }
  /**
   * `variant: 'spread'` — exactly 4 entries, 2-page spread, even-start
   * required (same as before). `variant: 'single'` — exactly 2 entries,
   * ONE ordinary page, no even-start requirement (owner round-12
   * extension). Both variants render via the same `illustrated-digest`
   * template; `BookPage.isSpread` is what the template/audit read to know
   * which basis (spread vs single full-page) governs the mm->% math.
   */
  | { kind: 'illustrated-digest'; items: ResolvedMemory[]; variant: 'spread' | 'single' };

/**
 * Splits an ordered run of memories into alternating 'quote' (a maximal
 * adjacent run of `isQuoteEligible` entries, length >= `QUOTE_COLLECTION_MIN`)
 * and 'normal' segments, preserving chronological order. A run shorter than
 * the minimum falls back into the surrounding 'normal' flow rather than
 * forming its own (too-thin) collection.
 */
function spliceQuoteCollections(
  memories: ResolvedMemory[],
): Array<{ kind: 'quote' | 'normal'; items: ResolvedMemory[] }> {
  const segments: Array<{ kind: 'quote' | 'normal'; items: ResolvedMemory[] }> = [];
  let run: ResolvedMemory[] = [];
  let normalBuffer: ResolvedMemory[] = [];

  const flushNormal = () => {
    if (normalBuffer.length > 0) segments.push({ kind: 'normal', items: normalBuffer });
    normalBuffer = [];
  };
  const flushRun = () => {
    if (run.length >= QUOTE_COLLECTION_MIN) {
      flushNormal(); // preserve order: whatever preceded this run goes first
      segments.push({ kind: 'quote', items: run });
    } else if (run.length > 0) {
      normalBuffer.push(...run);
    }
    run = [];
  };

  for (const item of memories) {
    if (isQuoteEligible(item.memory)) {
      run.push(item);
    } else {
      flushRun();
      normalBuffer.push(item);
    }
  }
  flushRun();
  flushNormal();
  return segments;
}

/** One `chunkDigestSweep` output segment — a digest SPREAD (exactly 4 entries), a digest SINGLE PAGE (exactly 2 entries), or an ordinary ('normal') stretch that flows through `chunkMemories` like any other content. */
type DigestSweepSegment =
  | { kind: 'digest-spread'; items: ResolvedMemory[] }
  | { kind: 'digest-single'; items: ResolvedMemory[] }
  | { kind: 'normal'; items: ResolvedMemory[] };

/**
 * Task 1 pacing (owner round-12 correction: EVEN entry counts only — the
 * odd 3-entry spread the owner flagged in review is gone for good; owner
 * round-12 extension: a digest may now also render as a SINGLE PAGE of
 * exactly 2 entries, an ordinary 1-page unit with no even-start
 * requirement): chunks a maximal run of digest-eligible memories still
 * sweepable after the element's own `ILLUSTRATED_DIGEST_KEEP_FULL` budget
 * into `ILLUSTRATED_DIGEST_CHUNK_SIZE`-sized (4) digest SPREADS, as many as
 * the pool allows. Whatever's left over:
 *   - remainder 2 -> one digest SINGLE PAGE (both entries);
 *   - remainder 3 -> a digest SINGLE PAGE (the first 2) + the 3rd stays an
 *     ordinary full illustrated page (never a lonely 3rd row — that's
 *     exactly what the owner's screenshots caught);
 *   - remainder 1 -> stays an ordinary full illustrated page.
 * NEVER placing two digest units (spread OR single — the pacing rule
 * applies to both uniformly) back to back: whenever the pool remaining
 * after a unit would itself form ANOTHER digest unit (2 or more left),
 * the very next memory is pulled out and promoted back to an ordinary
 * ('normal') full illustrated page as the separator. Chronological order
 * is preserved throughout — this only ever CONSUMES from the front of
 * `pool`, never reorders it.
 */
function chunkDigestSweep(pool: ResolvedMemory[]): DigestSweepSegment[] {
  const out: DigestSweepSegment[] = [];
  let i = 0;
  while (i < pool.length) {
    const remaining = pool.length - i;
    if (remaining === 1) {
      out.push({ kind: 'normal', items: [pool[i]] });
      i += 1;
      continue;
    }
    if (remaining === 2) {
      out.push({ kind: 'digest-single', items: pool.slice(i, i + 2) });
      i += 2;
      continue;
    }
    if (remaining === 3) {
      // The lonely-third-row case the owner's screenshots flagged: the
      // first 2 form a single-page digest, the 3rd stays ordinary — never
      // a 3-entry spread.
      out.push({ kind: 'digest-single', items: pool.slice(i, i + 2) });
      out.push({ kind: 'normal', items: [pool[i + 2]] });
      i += 3;
      continue;
    }
    // remaining >= 4: a full spread.
    out.push({ kind: 'digest-spread', items: pool.slice(i, i + ILLUSTRATED_DIGEST_CHUNK_SIZE) });
    i += ILLUSTRATED_DIGEST_CHUNK_SIZE;
    const afterRemaining = pool.length - i;
    if (afterRemaining >= 2) {
      // Pacing: what's left (2, 3, or 4+) would otherwise form ANOTHER
      // digest unit (single or spread) immediately following this one —
      // promote its first memory back to a full page instead, so the two
      // never touch. A remainder of exactly 1 needs no separator — it's
      // already ordinary, not a digest unit, by construction above.
      out.push({ kind: 'normal', items: [pool[i]] });
      i += 1;
    }
  }
  return out;
}

/**
 * Task 1 digest engagement: splices a section's ALREADY-quote-filtered
 * 'normal' flow into maximal adjacent runs of `isDigestEligibleMemory`
 * entries, consuming `budget.remaining` (the element-wide "first N always
 * keep full composition" allowance, shared across every run in the section
 * — mutated in place so a later run's own budget reflects everything an
 * earlier run already spent) off the FRONT of each run before sweeping the
 * rest via `chunkDigestSweep`. A run entirely consumed by the keep-full
 * budget never sweeps at all. Preserves chronological order: 'normal'
 * segments (kept-full items, chunk separators, and non-eligible content)
 * interleave with 'digest' segments in the exact order they occur.
 */
function spliceDigestRuns(
  items: ResolvedMemory[],
  element: OutlineElement,
  budget: { remaining: number },
): DigestSweepSegment[] {
  const segments: DigestSweepSegment[] = [];
  let run: ResolvedMemory[] = [];
  let normalBuffer: ResolvedMemory[] = [];

  const flushNormal = () => {
    if (normalBuffer.length > 0) segments.push({ kind: 'normal', items: normalBuffer });
    normalBuffer = [];
  };
  const flushRun = () => {
    if (run.length === 0) return;
    const keep = Math.min(budget.remaining, run.length);
    budget.remaining -= keep;
    if (keep > 0) normalBuffer.push(...run.slice(0, keep));
    const sweepable = run.slice(keep);
    if (sweepable.length > 0) {
      flushNormal(); // preserve order: any kept-full items precede the sweep
      segments.push(...chunkDigestSweep(sweepable));
    }
    run = [];
  };

  for (const item of items) {
    if (isDigestEligibleMemory(item.id, item.memory, element)) {
      run.push(item);
    } else {
      flushRun();
      normalBuffer.push(item);
    }
  }
  flushRun();
  flushNormal();
  return segments;
}

/**
 * Chunks one ordered run of memories (already known to contain no
 * outline.panoramaCandidates picks) into content units: quote-collection
 * spreads for maximal 3+ runs of short text-only/illustrated-light entries
 * (acceptance-review follow-up, item 1 — canvas §5 "Solo texto": "Tres o
 * más entradas cortas del mismo tema se agrupan en una doble página de
 * citas"), a long collection split into several via `partitionQuoteRun`,
 * illustrated-digest spreads (Task 1, round-12) for a section whose digest
 * sweep is engaged, and the normal `chunkMemories` grouping for everything
 * else.
 */
function unitsForRun(
  items: ResolvedMemory[],
  pairingLevel: PairingLevel,
  digest: { element: OutlineElement; budget: { remaining: number } } | null,
): ContentUnit[] {
  const units: ContentUnit[] = [];
  for (const segment of spliceQuoteCollections(items)) {
    if (segment.kind === 'quote') {
      let offset = 0;
      for (const size of partitionQuoteRun(segment.items.length)) {
        units.push({ kind: 'quote-collection', items: segment.items.slice(offset, offset + size) });
        offset += size;
      }
      continue;
    }
    if (digest) {
      for (const sub of spliceDigestRuns(segment.items, digest.element, digest.budget)) {
        if (sub.kind === 'digest-spread') {
          units.push({ kind: 'illustrated-digest', items: sub.items, variant: 'spread' });
        } else if (sub.kind === 'digest-single') {
          units.push({ kind: 'illustrated-digest', items: sub.items, variant: 'single' });
        } else {
          for (const group of chunkMemories(sub.items, pairingLevel)) units.push({ kind: 'group', group });
        }
      }
      continue;
    }
    for (const group of chunkMemories(segment.items, pairingLevel)) units.push({ kind: 'group', group });
  }
  return units;
}

/**
 * Splices `outline.panoramaCandidates` nominees — and, as of round-7 item
 * 2b, any WIDE HERO (an outline/segment highlight whose aspect clears the
 * panorama threshold) even without an explicit outline nomination — out of
 * the normal photo chunker into their own panorama placements, preserving
 * chronological order (item 11, visual-review batch: "PROMOTED out of its
 * backbone grid/themed spread into its own full spread at its chronological
 * position within its section — single placement moves, not duplicates").
 * A wide hero is panorama material "by nature": it never belongs square-
 * cropped onto a full-bleed page (see `scoreFullBleed`'s matching
 * exclusion), so this is its only route to the special treatment its
 * width and orientation actually call for — still gated by the same
 * trust/quota rules as an explicit nomination, never a free pass. Everything
 * else still flows through `unitsForRun` (quote-collections, then the
 * normal `chunkMemories`).
 */
function buildContentUnits(
  memories: ResolvedMemory[],
  element: OutlineElement,
  outline: BookOutline,
  state: ContentPagesState,
  pairingLevel: PairingLevel,
): ContentUnit[] {
  const candidateIds = new Set(outline.panoramaCandidates ?? []);
  const units: ContentUnit[] = [];

  // Task 1 engagement rule: computed ONCE across the WHOLE section (not
  // per run-buffer flush — a panorama splicing the flow into several runs
  // must never reset or duplicate the section's own budget/threshold). The
  // budget object is shared (and mutated) across every `unitsForRun` call
  // below so the element's first `ILLUSTRATED_DIGEST_KEEP_FULL` eligible
  // memories, in true outline order, stay first-2 no matter which run they
  // land in.
  const totalDigestEligible = memories.filter(({ id, memory }) => isDigestEligibleMemory(id, memory, element)).length;
  const digestEngaged = totalDigestEligible >= ILLUSTRATED_DIGEST_ENGAGEMENT_MIN;
  const digestBudget = { remaining: ILLUSTRATED_DIGEST_KEEP_FULL };
  const digest = digestEngaged ? { element, budget: digestBudget } : null;

  let runBuffer: ResolvedMemory[] = [];
  const flushRun = () => {
    if (runBuffer.length === 0) return;
    units.push(...unitsForRun(runBuffer, pairingLevel, digest));
    runBuffer = [];
  };

  for (const item of memories) {
    // Bug fix: this used to require the memory have EXACTLY one asset,
    // silently disqualifying any candidate memory that also carries, say,
    // a second photo or a video alongside its panorama shot — the render
    // path below already only ever uses `memory.assets[0]`, so the gate
    // now checks that same first asset instead of demanding a lone one.
    const asset = item.memory.assets[0] ?? null;
    const quota = PANORAMA_QUOTA_BASE + Math.floor(state.contentPageCount / PANORAMA_QUOTA_PER_PAGES);
    const isExplicitCandidate = candidateIds.has(item.id);
    const isWideHero =
      asset !== null && effectiveAspect(asset) >= PANORAMA_ASPECT_THRESHOLD && isHighlight(element, outline, item.id);
    const qualifies =
      (isExplicitCandidate || isWideHero) && asset !== null && isTrustedPanoramaCandidate(asset) && state.panoramaBudgetUsed < quota;
    if (qualifies) {
      flushRun();
      units.push({ kind: 'panorama', item });
      state.panoramaBudgetUsed += 1;
    } else {
      runBuffer.push(item);
    }
  }
  flushRun();
  return units;
}

/**
 * What printed page number the NEXT page pushed would land on, given every
 * page built so far in the whole document (mirrors `numberPages`'s own
 * counting rules exactly, without mutating anything) — used to force
 * parity for compositions that need a guaranteed facing page (owner review
 * round 3 items 2 and 11: a full-bleed/panorama video's credit must land on
 * its TRUE facing page, and a split illustrated-story's text must land on
 * the LEFT with its illustration on the facing right page).
 */
function currentPageParity(allPagesSoFar: readonly BookPage[]): 'even' | 'odd' {
  let n = 2;
  for (const p of allPagesSoFar) {
    if (p.templateId === 'cover-wrap') continue;
    n += p.isSpread ? 2 : 1;
  }
  return n % 2 === 0 ? 'even' : 'odd';
}

function buildContentPages(
  element: OutlineElement,
  manifest: BookManifest,
  outline: BookOutline,
  gaps: LayoutGap[],
  state: ContentPagesState,
  scoreThreshold: number,
  sectionHeader: SectionHeaderParams | null,
  pairingLevel: PairingLevel = 0,
  omittedIds: ReadonlySet<string> = EMPTY_ID_SET,
  outerPages: readonly BookPage[] = [],
  /**
   * Per-memory caption override (owner review round 3, item 15): a firsts
   * memory with an AI-written `warm_name` uses it wherever the memory's own
   * `text` would otherwise print — its footer caption — instead of its raw
   * text, so the milestone reads as a warm second-person line rather than
   * whatever the parent originally wrote. Absent for every other section.
   */
  captionOverrides: ReadonlyMap<string, string> = EMPTY_STRING_MAP,
): BookPage[] {
  const resolvedMemories = resolveMemoriesInOrder(manifest, element, omittedIds);
  const memories: ResolvedMemory[] =
    captionOverrides.size === 0
      ? resolvedMemories
      : resolvedMemories.map(({ id, memory }) => {
          const warmName = captionOverrides.get(id);
          return warmName ? { id, memory: { ...memory, text: warmName } } : { id, memory };
        });
  if (memories.length === 0) return [];

  const builtUnits = buildContentUnits(memories, element, outline, state, pairingLevel);
  // Owner round-6: reorder units so parity lands naturally (see
  // `reorderUnitsForParity`) — computed against the REAL parity at this
  // section's first content page, i.e. everything already in the document.
  // Round-9 items 1c/2a: the reorder pass now predicts, unit by unit, both
  // which template a group will win (so it knows ahead of time whether a
  // solo photo will become `full-bleed`, needing an even landing) and
  // whether it carries this section's header (a HEADER_CAPABLE template is
  // the first to consume `headerPending` — NOT necessarily the section's
  // literal first unit, e.g. when a full-bleed opens the section: full-bleed
  // isn't HEADER_CAPABLE, so the header actually lands on whichever unit
  // follows it, which the old `isFirstUnit`-only heuristic mispredicted).
  // Seeded from the REAL running `state` at this exact point in assembly —
  // see `ReorderSimState`'s own doc comment for why this can never drift.
  const units = reorderUnitsForParity(builtUnits, currentPageParity(outerPages) === 'even', element, outline, {
    contentPageCount: state.contentPageCount,
    fullBleedBudget: state.fullBleedBudget,
    lastTemplateId: state.lastTemplateId,
    headerPending: sectionHeader != null,
  });
  const pages: BookPage[] = [];
  let headerPending = sectionHeader;
  // Round-4 item 3 ("empty pages littering the flow"): before falling back
  // to a wasted blank filler to fix parity, try REFLOWING first — swap the
  // parity-requiring page with the immediately preceding page, when that
  // preceding page is an ordinary flexible single with no adjacency
  // requirements of its own (never a spread, a split-half, a paired
  // illustrated-story frame, or a blank). Tracks the local `pages` index
  // of the most-recently-pushed swappable page; reset to `null` the
  // instant anything non-swappable gets pushed, so a swap only ever trades
  // with the page IMMEDIATELY before the parity-critical one, within this
  // same section.
  let lastSwappablePageIndex: number | null = null;
  const FLEXIBLE_SWAPPABLE_TEMPLATES: ReadonlySet<TemplateId> = new Set([
    'anchor-media',
    'text-page',
    'flex-grid',
    'audio-note',
    // Round-7: a SOLO illustrated-story page is as flexible as any single —
    // the !illustratedPairRole guard at the marking site keeps pair frames
    // out, and split halves never pass through that site at all. Without
    // this, a full-bleed following illustrated singles could only blank
    // (owner screenshot: blank between stories and a full-bleed).
    'illustrated-story',
  ]);
  /**
   * Round-4 item 3 follow-up (visual-review round 5 finding): an
   * illustrated-pair's "first" frame originally never swapped at all — a
   * swap's reswapped page would have landed BETWEEN "first" and its
   * "second" partner (pushed by the very next unit), breaking their facing
   * adjacency. Instead of giving up on the swap entirely, the reswapped
   * page is held here and only actually re-inserted once "second" has also
   * been pushed — so the pair's adjacency is preserved AND the swap still
   * saves the page a blank would have cost.
   */
  let pendingIllustratedReswap: BookPage | null = null;

  /**
   * Ensures the NEXT page pushed lands on an even (left) page. Reflows
   * with the preceding swappable page when one is available (pops it and
   * returns it — the caller pushes its own critical page(s) first, then
   * pushes this back right after, so the two trade slots); falls back to
   * a blank filler (and returns null) only when no swap exists.
   *
   * `allowSwap: false` (panorama-spread and quote-collection use this)
   * disables the swap and always falls back to a blank when parity is
   * wrong — both of those compositions carry their own explicit, stronger
   * promise to land "at their chronological position" (panorama-splicing's
   * own documented contract), and swapping would mean showing an adjacent
   * memory's page before or after where it actually happened. Full-bleed
   * and a paired illustrated-story's first frame carry no such promise —
   * a local reorder with an immediate neighbor is an accepted trade-off
   * for them (round-4 item 3's whole point). The illustrated-pair case
   * defers the actual reinsertion until its "second" frame has also been
   * pushed (`pendingIllustratedReswap`, above) so the pair's own facing
   * adjacency is never split by the reswapped page landing in between.
   */
  function ensureEvenLanding(unitIndex: number, reason: BlankReason, allowSwap = true): BookPage | null {
    if (currentPageParity([...outerPages, ...pages]) === 'even') return null;
    if (allowSwap && lastSwappablePageIndex === pages.length - 1) {
      const swapped = pages.pop()!;
      lastSwappablePageIndex = null;
      return swapped;
    }
    pages.push(
      emptyPage({
        id: `${element.id}:${unitIndex}:parity-blank`,
        sourceElementId: element.id,
        templateId: 'blank',
        blankReason: reason,
      }),
    );
    lastSwappablePageIndex = null;
    return null;
  }

  units.forEach((unit, index) => {
    if (unit.kind === 'panorama') {
      // Round-4 item 8 (root cause of the spread-pager bug): nothing
      // previously forced a panorama-spread to START on an even page —
      // since it spans two page NUMBERS as one continuous image, starting
      // on an odd number would straddle two different book OPENINGS
      // (never a valid two-page spread in binding terms), and would throw
      // off every facing-pair computation after it in the preview.
      //
      // Task 1 (round-17, owner-approved ladder — the same demote-not-blank
      // trade full-bleed made in round 9, and digest in round 12): rung (a)
      // is `reorderUnitsForParity` above, which pre-arranges a movable
      // neighbor so this unit lands even without ever touching a blank —
      // but that pass predicts page counts with a pure simulation
      // (`unitParityMeta`/`predictWinningTemplateId`) that can drift from
      // what a neighboring group *actually* renders as (e.g. an
      // anchor-media pair that fails the min-image-size floor and splits
      // into two solo pages, one page more than the sim assumed). When
      // that drift still lands this unit odd here, rung (b) is a REAL
      // local swap with the immediately preceding flexible page —
      // `ensureEvenLanding`'s own swap, reads the ACTUAL current page
      // parity so it's immune to any sim drift. This relaxes round-4's
      // "never swaps" promise exactly this far: a one-page reflow with an
      // adjacent page is a nudge, not a chronology break, and the owner
      // has signed off on the same trade full-bleed already makes. Rung
      // (c), when even that swap isn't available (the immediately
      // preceding page isn't a flexible template), DEMOTES the panorama to
      // an ordinary anchor-media solo — its photo renders at native aspect
      // as a plain large image, never a blank — and returns its spot in
      // the book's panorama budget so a later candidate elsewhere isn't
      // blocked by this one's now-unused quota.
      const { id, memory } = unit.item;
      const asset = memory.assets[0];
      if (currentPageParity([...outerPages, ...pages]) !== 'even' && lastSwappablePageIndex !== pages.length - 1) {
        const demoteGroup = toGroup([unit.item]);
        const demotedSlots = buildSlotsForTemplate('anchor-media', demoteGroup, element, outline);
        const demotedParams = buildParamsForTemplate('anchor-media', demoteGroup, demotedSlots, state, headerPending);
        if (headerPending) headerPending = null; // anchor-media is HEADER_CAPABLE
        pages.push(
          emptyPage({
            id: `${element.id}:${index}:panorama:demoted`,
            sourceElementId: element.id,
            templateId: 'anchor-media',
            params: demotedParams,
            slots: demotedSlots,
          }),
        );
        lastSwappablePageIndex = pages.length - 1;
        state.fullBleedBudget.consecutive = 0;
        state.pendingCredit = null;
        state.lastTemplateId = 'anchor-media';
        state.contentPageCount += 1;
        state.panoramaBudgetUsed -= 1;
        return;
      }
      const reswap = ensureEvenLanding(index, 'parity:panorama-spread', true);
      const slot = buildPhotoSlot(id, memory, asset, { hero: false, index: null, cropBand: 'center' });
      pages.push(
        emptyPage({
          id: `${element.id}:${index}:panorama`,
          sourceElementId: element.id,
          templateId: 'panorama-spread',
          slots: [slot],
          isSpread: true,
        }),
      );
      if (reswap) {
        pages.push(reswap);
        lastSwappablePageIndex = pages.length - 1;
      } else {
        lastSwappablePageIndex = null;
      }
      // Counts toward the max-2-consecutive bleed rhythm (item 11); no
      // folio/footer index on the spread itself — its credit accumulates
      // on the next index-bearing page, same as any other panorama.
      state.fullBleedBudget.consecutive += 1;
      state.pendingCredit = {
        index: -1,
        indices: [-1],
        date: memory.date,
        note: captionOf(memory) || null,
        qr: isVideoAsset(asset),
      };
      state.lastTemplateId = 'panorama-spread';
      state.contentPageCount += 1;
      return;
    }

    if (unit.kind === 'quote-collection') {
      // Acceptance-review follow-up, item 1: a two-page spread of 3-6
      // short text-only entries — see templates/QuoteCollection.tsx for
      // the composition itself. Parity-forced the same way panorama is
      // (item 8) — it's a spread too, and never swaps for the same reason
      // (its entries' chronological position must stay exact).
      const reswap = ensureEvenLanding(index, 'parity:quote-collection', false);
      const pageParams: TemplateParams = {};
      if (headerPending) {
        pageParams.sectionHeader = headerPending;
        headerPending = null;
      }
      pages.push(
        emptyPage({
          id: `${element.id}:${index}:quotes`,
          sourceElementId: element.id,
          templateId: 'quote-collection',
          params: pageParams,
          slots: buildQuoteCollectionSlots(unit.items),
          isSpread: true,
        }),
      );
      if (reswap) {
        pages.push(reswap);
        lastSwappablePageIndex = pages.length - 1;
      } else {
        lastSwappablePageIndex = null;
      }
      state.fullBleedBudget.consecutive = 0;
      state.lastTemplateId = 'quote-collection';
      state.contentPageCount += 1;
      return;
    }

    if (unit.kind === 'illustrated-digest') {
      if (unit.variant === 'single') {
        // Owner round-12 extension: an ordinary 1-page unit — no
        // even-start requirement, no parity dance at all. It's a genuine
        // "movable single" for the reorder pass (see `unitParityMeta`),
        // so it's marked swappable here too, the same way every other
        // `FLEXIBLE_SWAPPABLE_TEMPLATES` single is at the bottom of this
        // function — sim/assembly must agree on that.
        pages.push(
          emptyPage({
            id: `${element.id}:${index}:digest-single`,
            sourceElementId: element.id,
            templateId: 'illustrated-digest',
            slots: buildDigestEntrySlots(unit.items),
            isSpread: false,
          }),
        );
        lastSwappablePageIndex = pages.length - 1;
        state.fullBleedBudget.consecutive = 0;
        state.lastTemplateId = 'illustrated-digest';
        state.contentPageCount += 1;
        return;
      }
      // 'spread' variant — Task 1's no-blank last resort (owner round-12):
      // unlike quote-collection/panorama, a digest spread never pays a
      // blank for parity — the reorder pass above already dissolved any
      // digest unit it predicted couldn't land even (see
      // `reorderUnitsForParity`'s own digest fallback), so by construction
      // this should always land even here. This check is the same
      // defensive double-check real assembly already makes for
      // full-bleed's own demotion (`processGroup`'s round-9 item 2b
      // branch) — a safety net against sim/assembly drift, never itself
      // the primary mechanism.
      if (currentPageParity([...outerPages, ...pages]) !== 'even') {
        dissolveDigestUnit(unit).forEach((dissolvedUnit, i) => {
          if (dissolvedUnit.kind === 'group') processGroup(index, dissolvedUnit.group, `:dissolved:${i}`);
        });
        return;
      }
      pages.push(
        emptyPage({
          id: `${element.id}:${index}:digest`,
          sourceElementId: element.id,
          templateId: 'illustrated-digest',
          slots: buildDigestEntrySlots(unit.items),
          isSpread: true,
        }),
      );
      lastSwappablePageIndex = null;
      state.fullBleedBudget.consecutive = 0;
      state.lastTemplateId = 'illustrated-digest';
      state.contentPageCount += 1;
      return;
    }

    processGroup(index, unit.group);
  });

  /**
   * Fits and pushes ONE group's page(s). Extracted (round-5 "minimum image
   * size" amendment) so a two-photo anchor-media group that can't clear
   * `MIN_IMAGE_SIDE_MM` can recurse into two solo-group calls instead of
   * ever rendering a shrunk pair — `idSuffix` keeps the resulting pages'
   * ids distinct from each other and from the un-split case (which passes
   * `idSuffix: ''`, producing byte-identical ids to before this
   * refactor).
   */
  function processGroup(index: number, group: MemoryGroup, idSuffix = ''): void {
    const pageId = (suffix = ''): string => `${element.id}:${index}${idSuffix}${suffix}`;
    const fit = fitGroup(group, element, outline, state.lastTemplateId, state.fullBleedBudget, state.contentPageCount);
    if (!fit) {
      gaps.push({
        elementId: element.id,
        reason: describeGapReason(group),
        memoryIds: group.memories.map((m) => m.id),
      });
      return;
    }
    if (fit.score < scoreThreshold) {
      gaps.push({
        elementId: element.id,
        reason: `${describeGapReason(group)} (best fit ${fit.templateId} scored ${fit.score.toFixed(2)})`,
        memoryIds: group.memories.map((m) => m.id),
      });
    }

    // Round-5 amendment ("minimum image size" — owner screenshots showed
    // pair subordinates at ~25-35mm): verify BEFORE committing to a
    // two-photo anchor-media page that both images would clear
    // `MIN_IMAGE_SIDE_MM` — if not, split into two solo pages instead of
    // ever rendering a shrunk image. Mirrors the exact content-box math
    // AnchorMedia.tsx itself uses (a genuine pair always keeps its footer
    // index — item 4 — so the footer reserve here is unconditional).
    if (fit.templateId === 'anchor-media' && isAnchorMediaPairCandidate(group)) {
      const headerReserve = headerPending ? SECTION_HEADER_RESERVE_MM : 0;
      // Owner round-10: a pair holding a video renders that video's scan
      // strip below its tile, so the pair's content box must use the
      // video-aware footer reserve — the SAME rule AnchorMedia.tsx and the
      // audit apply, or the fitter's split-vs-pair decision drifts from
      // what actually renders.
      const pairHasVideo = group.photoAssets.slice(0, 2).some((p) => p.asset.kind === 'video-poster');
      const contentHeight = SAFE_BOX_MM - headerReserve - footerReserveMm(pairHasVideo);
      const [first, second] = group.photoAssets;
      // Round-17 fix (owner-reported drift, `backbone:2023-03` on
      // enzo-year-one): derive dominance the SAME way AnchorMedia.tsx and
      // the audit's own fill-ratio recheck both do (`hero[0] ||
      // !hero[1]`), reading the ACTUAL hero flags `fit.variants[0].slots`
      // already carries — not an independent `isHighlight()` re-derivation.
      // The two disagree exactly when NEITHER photo is a highlight:
      // `isHighlight(first)` reports false (so this gate checked the pair
      // with SECOND treated as dominant), while the render's own
      // OR-fallback still treats FIRST as dominant when neither has `hero`
      // — silently passing a pair through whose actual rendered layout has
      // LESS combined photo area than this gate verified.
      const winningPhotoSlots = (fit.variants[0]?.slots ?? []).filter((s): s is typeof s & { content: PhotoSlotContent } => s.kind === 'photo');
      const dominantIsFirst =
        winningPhotoSlots.length === 2
          ? Boolean(winningPhotoSlots[0].content.hero) || !winningPhotoSlots[1].content.hero
          : group.pairedDominantMemoryId
            ? first.memoryId === group.pairedDominantMemoryId
            : isHighlight(element, outline, first.memoryId);
      const fitsFloor = anchorPairMeetsMinSize(
        first.asset.aspectRatio,
        second.asset.aspectRatio,
        dominantIsFirst,
        SAFE_BOX_MM,
        contentHeight,
        Boolean(headerPending),
      );
      if (!fitsFloor) {
        const [soloA, soloB] = splitAnchorPairToSoloGroups(group);
        processGroup(index, soloA, `${idSuffix}:minsize-a`);
        processGroup(index, soloB, `${idSuffix}:minsize-b`);
        return;
      }
    }

    // fit.variants[0] is always the winner (see fitGroup) and already
    // carries its fully-built slots — reuse them rather than rebuild.
    const slots = fit.variants[0]?.slots ?? [];
    const params: TemplateParams = buildParamsForTemplate(fit.templateId, group, slots, state, headerPending);
    if (HEADER_CAPABLE.has(fit.templateId) && headerPending) headerPending = null;

    // > 1600 chars: a double text-page spread, one paragraph-safe half per
    // page — the paragraph itself is never split across the gutter.
    const soloMemory = group.memories.length === 1 ? group.memories[0].memory : null;
    if (fit.templateId === 'text-page' && soloMemory && captionOf(soloMemory).length > TEXT_PAGE_DOUBLE_MIN) {
      const { id, memory } = group.memories[0];
      const [first, second] = splitLongText(captionOf(memory));
      pages.push(
        emptyPage({
          id: pageId(':a'),
          sourceElementId: element.id,
          templateId: 'text-page',
          params,
          slots: [buildTextSlot(first, id, memory.date)],
        }),
        emptyPage({
          id: pageId(':b'),
          sourceElementId: element.id,
          templateId: 'text-page',
          params: {},
          slots: [buildTextSlot(second, id, null)],
        }),
      );
      lastSwappablePageIndex = null; // both halves are tightly bound to each other
    } else if (
      fit.templateId === 'illustrated-story' &&
      soloMemory &&
      !group.illustratedPairRole &&
      illustratedStoryNeedsSplit(soloMemory, Boolean(params.sectionHeader), Boolean(params.stagger)) &&
      // Round-9.1 (owner-reported divergence, `topic:toys-building` on
      // enzo-year-three): only actually COMMIT to the split when it can
      // land even without paying a blank for it — own parity already
      // fine, or a local swap is available (the same check
      // `ensureEvenLanding` itself makes). Some section shapes are
      // provably unable to give a split its even landing no matter how
      // the reorder pass rearranges the section's OTHER units (e.g. a
      // trailing split immediately preceded by an intrinsically
      // non-swappable full-bleed or illustrated-pair-second, with nothing
      // else in the section left to trade with) — when that's the case,
      // fall through to the ordinary "both" mode render below instead of
      // forcing the split. Round-9 item 1's own fitted-height cap already
      // guarantees that render stays safely within the safe box (just
      // possibly a smaller illustration than the split would have given)
      // — the SAME "a smaller/plainer composition is an acceptable trade,
      // a blank page is not" principle round-9 item 2b already established
      // for full-bleed.
      (currentPageParity([...outerPages, ...pages]) === 'even' || lastSwappablePageIndex === pages.length - 1)
    ) {
      // Round-5 item 6: text stands alone; the illustration moves to the
      // facing page, bleeding through the outer trim and foot — either the
      // text itself is long (>= ILLUSTRATED_SPLIT_MIN_CHARS) or the
      // single-page illustration would render too small
      // (< ILLUSTRATED_SPLIT_MIN_ILLO_HEIGHT_MM). Never forced for a paired
      // story (`illustratedPairRole` set) — pairing is its own composition
      // with its own, deliberately smaller, illustration size. Parity-aware
      // (owner review round 3 item 11): the text page must land on the LEFT
      // (even/verso) so the illustration lands on the facing RIGHT page —
      // the reader sees story + drawing together, never split across a
      // page turn. Reflow-first (item 3), blank only as a last resort.
      const reswap = ensureEvenLanding(index, 'parity:illustrated-split');
      pages.push(
        emptyPage({
          id: pageId(':text'),
          sourceElementId: element.id,
          templateId: 'illustrated-story',
          params: { ...params, mode: 'text-only' },
          slots: slots.filter((s) => s.kind === 'text'),
        }),
        emptyPage({
          id: pageId(':illustration'),
          sourceElementId: element.id,
          templateId: 'illustrated-story',
          params: { mode: 'illustration-only' },
          slots: slots.filter((s) => s.kind === 'illustration'),
        }),
      );
      if (reswap) pages.push(reswap);
      lastSwappablePageIndex = reswap ? pages.length - 1 : null;
    } else if (
      fit.templateId === 'full-bleed' &&
      currentPageParity([...outerPages, ...pages]) !== 'even' &&
      lastSwappablePageIndex !== pages.length - 1
    ) {
      // Round-9 item 2b (owner-approved trade, the TRUE last resort after
      // the parity-reorder pass — see `unitParityMeta`'s full-bleed
      // prediction — and the local reflow swap above have both already
      // failed to land this page even): DEMOTE to an ordinary anchor-media
      // solo instead of paying a blank page for it. A full-bleed's facing
      // treatment is optional beauty; a blank page is a defect — the owner
      // has confirmed this trade explicitly. A demoted page carries its own
      // caption in its own footer, so it has no even-landing requirement of
      // its own, and never counts toward the full-bleed budget/pacing (it
      // was never placed as one).
      const demotedSlots = buildSlotsForTemplate('anchor-media', group, element, outline);
      const demotedParams = buildParamsForTemplate('anchor-media', group, demotedSlots, state, headerPending);
      if (headerPending) headerPending = null; // anchor-media is HEADER_CAPABLE
      pages.push(
        emptyPage({
          id: pageId(':demoted'),
          sourceElementId: element.id,
          templateId: 'anchor-media',
          params: demotedParams,
          slots: demotedSlots,
        }),
      );
      lastSwappablePageIndex = pages.length - 1;
      state.fullBleedBudget.consecutive = 0;
      state.pendingCredit = null;
      state.lastTemplateId = 'anchor-media';
      state.contentPageCount += 1;
      return;
    } else {
      let reswap: BookPage | null = null;
      if (fit.templateId === 'full-bleed' || fit.templateId === 'panorama-spread') {
        // Owner review round 3 item 2 / round 4 item 8: a full-bleed or
        // (the general, currently-unreachable-until-real-face-data)
        // panorama-spread page's credit always defers to "whatever page
        // comes next" (`pendingCredit`) — that's only its TRUE facing page
        // when it lands on an even (left) page itself. Reflow-first
        // (item 3): swap with the preceding flexible page before wasting
        // a blank on it — and for full-bleed specifically, parity was
        // already confirmed fixable here (the demotion branch above only
        // fires when it ISN'T), so this call always finds its swap and
        // never itself falls through to a blank.
        reswap = ensureEvenLanding(index, fit.templateId === 'full-bleed' ? 'parity:full-bleed' : 'parity:panorama-spread');
      }
      let deferReswapPastPair = false;
      if (fit.templateId === 'illustrated-story' && group.illustratedPairRole === 'first') {
        // Round-4 item 3 follow-up: force the pair's first frame onto an
        // even (left) page so its partner (pushed on the very next unit)
        // lands on the facing right page. A swap IS allowed here, but the
        // reswapped page can't be reinserted immediately — that would land
        // it BETWEEN "first" and "second", breaking their facing adjacency
        // — so it's deferred (`pendingIllustratedReswap`) until "second"
        // has been pushed too (see below).
        reswap = ensureEvenLanding(index, 'parity:illustrated-pair');
        deferReswapPastPair = true;
      }
      if (fit.templateId === 'illustrated-story' && group.illustratedPairRole) {
        // Deterministic alternating stagger (item 2's "vertically staggered
        // frames") — overrides the hash-based default so the pair reads as
        // a deliberate high/low alternation, never a coincidental match.
        params.stagger = group.illustratedPairRole === 'second';
      }
      pages.push(
        emptyPage({
          id: pageId(),
          sourceElementId: element.id,
          templateId: fit.templateId,
          params,
          slots,
          variants: fit.variants,
          isSpread: fit.templateId === 'panorama-spread',
        }),
      );
      if (deferReswapPastPair) {
        // "first": stash the reswap (if any) rather than pushing it now —
        // "second" pushes right after in the very next unit, and only then
        // is it safe to reinsert without splitting the pair.
        pendingIllustratedReswap = reswap;
        lastSwappablePageIndex = null;
      } else if (fit.templateId === 'illustrated-story' && group.illustratedPairRole === 'second') {
        // "second": the pair is now complete and facing-adjacent — reinsert
        // whatever "first" deferred, immediately after "second".
        if (pendingIllustratedReswap) {
          pages.push(pendingIllustratedReswap);
          lastSwappablePageIndex = pages.length - 1;
        } else {
          lastSwappablePageIndex = null;
        }
        pendingIllustratedReswap = null;
      } else if (reswap) {
        pages.push(reswap);
        lastSwappablePageIndex = pages.length - 1;
      } else {
        lastSwappablePageIndex =
          FLEXIBLE_SWAPPABLE_TEMPLATES.has(fit.templateId) && !group.illustratedPairRole ? pages.length - 1 : null;
      }
    }

    if (fit.templateId === 'full-bleed') {
      state.fullBleedBudget.total += 1;
      state.fullBleedBudget.consecutive += 1;
    } else {
      state.fullBleedBudget.consecutive = 0;
    }
    if (fit.templateId === 'panorama-spread' || fit.templateId === 'full-bleed') {
      const solo = group.photoAssets[0];
      if (solo) {
        state.pendingCredit = {
          index: -1,
          indices: [-1],
          date: solo.memory.date,
          note: captionOf(solo.memory) || null,
          qr: isVideoAsset(solo.asset),
        };
      }
    } else {
      state.pendingCredit = null;
    }

    state.lastTemplateId = fit.templateId;
    state.contentPageCount += 1;
  }

  // Any text-page memory (>240 chars) that also has a real photo gets a
  // small companion page on the facing side (Momora Book Layout System:
  // "la foto se maqueta como acompañante de 80-120mm") — regardless of
  // which text-size tier it lands in. A photo is never silently dropped
  // just because its memory's text was long enough to go text-forward.
  units.forEach((unit, index) => {
    if (unit.kind !== 'group') return;
    const group = unit.group;
    if (group.memories.length !== 1) return;
    const { id, memory } = group.memories[0];
    const len = captionOf(memory).length;
    if (len <= PHOTO_STORY_MAX) return;
    if (memory.assets.length === 0) return;
    // The >1600-char case split this group into two pages (`:a` / `:b`,
    // see above) — the companion follows the second half.
    const insertAt = pages.findIndex((p) => p.id === `${element.id}:${index}` || p.id === `${element.id}:${index}:b`);
    if (insertAt === -1) return;
    // Companion photos stay small (80-120mm, per the system board) even
    // when the memory itself has several — cap at 2/page here rather than
    // invoking the single-memory flex-grid exception, which is for a full
    // page's own moment, not a facing-page companion. Always native aspect
    // (item 4) — this is an anchor-media page like any other.
    const companionPages: BookPage[] = [];
    for (let i = 0; i < memory.assets.length; i += CROSS_MEMORY_MAX_PER_PAGE) {
      const sliceAssets = memory.assets.slice(i, i + CROSS_MEMORY_MAX_PER_PAGE);
      const natural = true;
      // Round-5 amendment ("minimum image size"): a companion page has no
      // hero/dominance of its own (every companion tile is `hero: false`,
      // matching AnchorMedia.tsx's own `dominantIsFirst` fallback of
      // "first slot wins when neither is a hero"), no section header, and
      // no footer index — so its content box is the full safe box. If a
      // 2-asset slice can't give both companions the floor, split it into
      // two solo companion pages instead of shrinking either below it.
      if (
        sliceAssets.length === 2 &&
        !anchorPairMeetsMinSize(sliceAssets[0].aspectRatio, sliceAssets[1].aspectRatio, true, SAFE_BOX_MM, SAFE_BOX_MM, false)
      ) {
        sliceAssets.forEach((asset, j) => {
          companionPages.push(
            emptyPage({
              id: `${element.id}:${index}:companion:${i}:minsize-${j}`,
              sourceElementId: element.id,
              templateId: 'anchor-media',
              params: {},
              slots: [buildPhotoSlot(id, memory, asset, { hero: false, index: null, natural })],
            }),
          );
        });
        continue;
      }
      companionPages.push(
        emptyPage({
          id: `${element.id}:${index}:companion:${i}`,
          sourceElementId: element.id,
          templateId: 'anchor-media',
          params: {},
          slots: sliceAssets.map((asset) => buildPhotoSlot(id, memory, asset, { hero: false, index: null, natural })),
        }),
      );
    }
    pages.splice(insertAt + 1, 0, ...companionPages);
  });

  // Defensive fallback (owner review round 3 — "the renderer must be
  // robust to photo-thin segments regardless"): every HEADER_CAPABLE
  // template now renders `sectionHeader`, so in practice this should never
  // fire — but if a segment somehow produced no capable page at all (e.g.
  // entirely full-bleed/panorama, which structurally can't show one), the
  // header attaches to the first page that's SOMETHING rather than
  // vanishing silently.
  if (headerPending) {
    const firstCapable = pages.find((p) => HEADER_CAPABLE.has(p.templateId));
    if (firstCapable) firstCapable.params = { ...firstCapable.params, sectionHeader: headerPending };
  }

  return pages;
}

function buildParamsForTemplate(
  templateId: TemplateId,
  group: MemoryGroup,
  slots: LayoutSlot[],
  state: ContentPagesState,
  sectionHeader: SectionHeaderParams | null,
): TemplateParams {
  const params: TemplateParams = {};
  if (templateId === 'flex-grid' || templateId === 'anchor-media') {
    let footerIndex = footerIndexFor(slots);
    const hadPendingCredit = state.pendingCredit != null;
    if (state.pendingCredit) {
      // A preceding panorama/full-bleed page carries no on-image credit of
      // its own — it lands here as index 1, and every photo already on
      // this page is renumbered to make room ahead of it.
      footerIndex = [
        { ...state.pendingCredit, index: 1, indices: [1] },
        ...footerIndex.map((e) => ({ ...e, index: e.index + 1, indices: e.indices.map((n) => n + 1) })),
      ];
      state.pendingCredit = null;
    }
    // Applied AFTER any pendingCredit is folded in (owner review round 3
    // item 9): same-date/caption entries merge onto one superscript line.
    params.footerIndex = consolidateFooterIndex(footerIndex);
    // Round-5 item 4: a single image has nothing to disambiguate — the
    // index numeral (and its footer superscript) exists purely to tie a
    // photo tile to its footer-index line when there's more than one on the
    // page. Counted by PHOTO SLOTS (not the post-consolidation footer-line
    // count — several same-memory photos that consolidate onto one footer
    // line still need their numerals to show which images that line
    // covers) plus a facing-page credit, which is a genuine second thing to
    // disambiguate even on an otherwise-solo photo page.
    const photoSlotCount = slots.filter((s) => s.kind === 'photo').length;
    if (photoSlotCount + (hadPendingCredit ? 1 : 0) <= 1) {
      for (const slot of slots) {
        if (slot.kind === 'photo') (slot.content as PhotoSlotContent).index = null;
      }
      params.footerIndex = (params.footerIndex as FooterIndexEntry[]).map((e) => ({ ...e, indices: [] }));
    }
    if (HEADER_CAPABLE.has(templateId) && sectionHeader) params.sectionHeader = sectionHeader;
  }
  if (templateId === 'text-page' && sectionHeader) params.sectionHeader = sectionHeader;
  if (templateId === 'illustrated-story') {
    params.stagger = group.memories[0]?.id ? predictIllustratedStagger(group.memories[0].id) : false;
    // Diagnosed fix (owner review round 3 — "month headers vanished after
    // p34 in Enzo"): illustrated-story never carried `sectionHeader` before,
    // so a segment made entirely of illustrated memories silently dropped
    // its header (see IllustratedStory.tsx for the matching render fix).
    if (sectionHeader) params.sectionHeader = sectionHeader;
  }
  if (templateId === 'audio-note' && sectionHeader) params.sectionHeader = sectionHeader; // same fix, audio-only segments
  return params;
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * Round-9 item 1c (sim/assembly fidelity): the SAME deterministic hash-based
 * stagger call `buildParamsForTemplate` makes for a real page's
 * `params.stagger`, pulled out so the parity-reorder pre-pass's split
 * predictor (`illustratedStoryNeedsSplit`, called before any page params
 * exist) can predict the EXACT same stagger value assembly will later use
 * — rather than falling back to a conservative default that could
 * mispredict split-need in either direction and let the reorder pass and
 * real assembly diverge (the recurring "sim != assembly" bug class here).
 */
function predictIllustratedStagger(memoryId: string): boolean {
  return Math.abs(hashCode(memoryId)) % 2 === 0;
}

function describeGapReason(group: MemoryGroup): string {
  const n = group.photoAssets.length;
  const textNote = group.hasLongText ? ' + long text' : '';
  return `${n} asset${n === 1 ? '' : 's'}${textNote}: no feasible template`;
}

// ---------------------------------------------------------------------------
// Firsts (closes the book): owner review round 3 item 15 — renders as a
// normal themed section now (no bespoke ruled index-list; see
// templates/Firsts.tsx and FirstsEntryContent, both retired from the
// fitter's own output the same way `photo-story` was — kept as dead code
// only so an older saved `firsts`-tagged BookPage still renders something).
// ---------------------------------------------------------------------------

/**
 * The firsts section's own title page — structurally identical to
 * `buildSpreadTitlePage`, except its kicker is fixed furniture ("primeras
 * veces" / "firsts", localized) rather than outline-authored, since firsts
 * is the one themed-style section whose eyebrow is chrome, not AI copy.
 */
function buildFirstsTitlePage(element: OutlineElement, manifest: BookManifest): BookPage {
  const furniture = getFurniture(getLanguage(manifest));
  return emptyPage({
    id: `${element.id}:title`,
    sourceElementId: element.id,
    templateId: 'spread-title',
    params: {
      title: element.title,
      subtitle: null,
      kicker: furniture.firsts.kicker,
      titleMode: 'descriptive',
      titleSourceMemoryId: null,
      spreadType: null,
      momentCount: element.memoryIds.length,
    },
  });
}

// ---------------------------------------------------------------------------
// Final pass: assign printed page numbers + even/odd side. The cover is
// uncounted (bookbinding convention — matches the design canvas, whose
// numbering sequence starts at 2 on the blank page facing the dedication).
// ---------------------------------------------------------------------------

function numberPages(pages: BookPage[]): number {
  // Round-22 renumbering: printed folios must match the PHYSICAL Prodigi
  // book. Their system adds the inside-front-cover blank itself and our
  // front-matter-verso blank is dropped from the interior PDF entirely
  // (render-pdf.mts), so the first content page after the cover IS physical
  // page 1 — a right-hand recto, odd, exactly as the old scheme's "page 3"
  // was (the -2 shift preserves every page's parity). The cover and the
  // never-printed front-matter-verso blank carry no number.
  let n = 1;
  for (const page of pages) {
    if (
      page.templateId === 'cover-wrap' ||
      (page.templateId === 'blank' && page.blankReason === 'front-matter-verso')
    ) {
      page.pageNumbers = null;
      page.isEvenPage = null;
      continue;
    }
    const span = page.isSpread ? 2 : 1;
    const start = n;
    page.pageNumbers = span === 2 ? [start, start + 1] : [start];
    page.isEvenPage = span === 2 ? null : start % 2 === 0;
    n += span;
  }
  return n - 1;
}

// ---------------------------------------------------------------------------
// Page-cap enforcement (final-fix-round item 2, rebalanced round 13): the
// fitter must never hand back more pages than the layflat printer can
// physically bind. `fitBook` runs the deterministic fit below once; if it
// comes back over the cap, it re-runs at escalating pairing aggressiveness,
// and if even maximum pairing isn't enough, demotes memories one at a time
// until the book fits or there is nothing left that's safe to cut.
//
// Round-13 owner decision: the demotion ladder used to be strictly
// photo/video-first, reaching a digest-eligible illustrated memory only as
// the very last resort ("text is sacred"). Measured on Enzo that produced
// ~75% keep-rate for text/illustrated memories vs ~40% for photo/video — too
// skewed. The new policy classifies every candidate into one of THREE kinds
// — `photo`, `video`, `illustrated` (text + illustration) — and at each
// demotion step cuts from whichever kind CURRENTLY has the highest keep-rate
// among kinds that still have a demotable candidate, so the three kinds'
// keep-rates converge toward parity as the squeeze proceeds. All existing
// protections are unchanged: the month floor still binds first (a kind's
// candidate is only "available" for the keep-rate comparison once the floor
// has nothing better to offer any kind), milestone holders and quote-title
// sources are never candidates, and an illustrated memory is only ever a
// candidate when it is also digest-eligible (`isDigestEligibleMemory` —
// "text is sacred" survives as that guard plus the tie-break below, not as
// an absolute). Ties in keep-rate prefer photo/video over illustrated (the
// owner is REBALANCING an existing preference, not inverting it) — see
// `KIND_TIEBREAK_ORDER`.
// ---------------------------------------------------------------------------

/** The three page-cap demotion kinds (round-13 rebalance). */
type DemotionKind = 'photo' | 'video' | 'illustrated';

/**
 * Preference order when two or more kinds are tied on keep-rate: photo and
 * video before illustrated (owner: rebalancing the old photo/video-first
 * ladder, not inverting it into an illustrated-first one).
 */
const KIND_TIEBREAK_ORDER: readonly DemotionKind[] = ['photo', 'video', 'illustrated'];

/** True for a memory with no narrative value beyond its image — a `photo` or `video` demotion candidate. A caption that sanitizes to empty (Task 2) counts as no text, same as having none at all. */
function isPhotoOnlyMemory(memory: ManifestMemory): boolean {
  return !captionOf(memory) && !memory.illustration && memory.assets.length > 0;
}

/** `photo` vs `video` split of `isPhotoOnlyMemory` — a video-poster asset makes it a `video` candidate. */
function photoOnlyKind(memory: ManifestMemory): 'photo' | 'video' {
  return memory.assets.some(isVideoAsset) ? 'video' : 'photo';
}

/**
 * Classifies ANY backbone/themed memory into a demotion kind for keep-rate
 * accounting — including memories that are protected from demotion (a
 * milestone holder, a quote-title source, a non-digest-eligible illustrated
 * memory). Those still count toward their kind's fixed total (the
 * denominator of its keep-rate) since they were "selected" by the outline;
 * they just never leave the numerator, which is exactly what SHOULD make a
 * heavily-protected kind's keep-rate stay high and get selected for further
 * cuts less often as the squeeze proceeds. Returns null for anything that
 * isn't one of the three kinds (e.g. an illustration-less text memory, an
 * audio note).
 */
function classifyMemoryKind(memory: ManifestMemory): DemotionKind | null {
  if (memory.illustration && captionOf(memory)) return 'illustrated';
  if (isPhotoOnlyMemory(memory)) return photoOnlyKind(memory);
  return null;
}

interface DemotionCandidate {
  id: string;
  elementId: string;
  kind: DemotionKind;
  /** Calendar month (YYYY-MM) of the memory — the month-preservation floor
   * applies per CALENDAR month, not per (possibly merged) backbone segment:
   * a merged "2024-10_2024-11" segment previously counted as ONE month
   * bucket, letting October be hollowed out while the shared floor read
   * "still 2 left" off November's memories (owner round 6, Enzo's empty
   * October). */
  month: string;
  /** Ascending — lowest rank is demoted first WITHIN its kind. Engagement is the primary signal; a book highlight is protected as a tie-breaker, never outright immune. */
  rank: number;
}

/**
 * The full pool of memories eligible for page-cap demotion, gathered ONCE
 * from the untouched outline/manifest (independent of any prior omission) —
 * `fitBook` then removes from this list one at a time. Scoped to
 * backbone/themed content only: firsts entries are a curated, bounded list
 * and are never silently cut for page budget (see `buildFirstsPages`).
 *
 * Bug fix (live finding, round 5): `panoramaCandidates` and `heroCandidates`
 * nominees were being treated as ordinary photo memories here — a
 * lowest-engagement panorama/hero nominee could get silently demoted before
 * the panorama/full-bleed splice ever saw it, so a book could end up with
 * zero panoramas even though a qualifying candidate existed. Both lists are
 * now excluded from the demotion pool entirely, the same protection firsts
 * entries already have — a curated nomination is never an ordinary cuttable
 * photo.
 */
/**
 * Round-5 item 2a: how many memories currently remain (after `omittedIds`)
 * in each backbone (calendar-month) element — the month-preservation floor
 * needs this recomputed after every single omission, since taking from one
 * month can be exactly what lets an even-thinner month stay protected.
 */
function backboneRemainingCounts(outline: BookOutline, manifest: BookManifest, omittedIds: ReadonlySet<string>): Map<string, number> {
  // Keyed by CALENDAR month (YYYY-MM), not element id — merged segments
  // cover several months and each deserves its own floor (owner round 6).
  const counts = new Map<string, number>();
  for (const element of outline.elements) {
    if (element.kind !== 'backbone') continue;
    for (const { memory } of resolveMemoriesInOrder(manifest, element, omittedIds)) {
      const month = memory.date.slice(0, 7);
      counts.set(month, (counts.get(month) ?? 0) + 1);
    }
  }
  return counts;
}

function gatherDemotionCandidates(outline: BookOutline, manifest: BookManifest): DemotionCandidate[] {
  const protectedIds = new Set<string>([...(outline.panoramaCandidates ?? []), ...(outline.heroCandidates ?? [])]);
  const candidates: DemotionCandidate[] = [];
  for (const element of outline.elements) {
    if (element.kind !== 'backbone' && element.kind !== 'themed') continue;
    for (const { id, memory } of resolveMemoriesInOrder(manifest, element)) {
      if (protectedIds.has(id)) continue;
      if (!isPhotoOnlyMemory(memory)) continue;
      // A memory carrying ANY milestone row is a book treasure (birthday
      // rows included — Enzo's birthday photo was demoted in round 6) and
      // never enters the demotion pool.
      if ((memory.milestones ?? []).length > 0) continue;
      const highlighted = isHighlight(element, outline, id);
      candidates.push({
        id,
        elementId: element.id,
        kind: photoOnlyKind(memory),
        month: memory.date.slice(0, 7),
        rank: memory.engagement * 10 + (highlighted ? 5 : 0),
      });
    }
  }
  return candidates;
}

/**
 * Round-13 rebalance (formerly the "Task 2 hybrid" pool, reached only once
 * `gatherDemotionCandidates` was exhausted — now one of three co-equal
 * pools compared by keep-rate, see the file-header comment above): the
 * `illustrated` demotion pool, gathered from digest-ELIGIBLE memories only
 * — the exact same guard Task 1's digest sweep uses (`isDigestEligibleMemory`
 * — never a milestone holder, never an element's own quote-title source
 * memory). "Text is sacred" survives as this guard: a memory with text but
 * NO illustration (an ordinary text-page/quote entry) is never in this pool
 * — only a SHORT, already digest-worthy illustrated memory is ever
 * cuttable.
 */
function gatherIllustratedDemotionCandidates(outline: BookOutline, manifest: BookManifest): DemotionCandidate[] {
  const candidates: DemotionCandidate[] = [];
  for (const element of outline.elements) {
    if (element.kind !== 'backbone' && element.kind !== 'themed') continue;
    for (const { id, memory } of resolveMemoriesInOrder(manifest, element)) {
      if (!isDigestEligibleMemory(id, memory, element)) continue;
      const highlighted = isHighlight(element, outline, id);
      candidates.push({
        id,
        elementId: element.id,
        kind: 'illustrated',
        month: memory.date.slice(0, 7),
        rank: memory.engagement * 10 + (highlighted ? 5 : 0),
      });
    }
  }
  return candidates;
}

/**
 * Fixed per-kind totals (the keep-rate denominators), computed ONCE from the
 * untouched outline/manifest — every backbone/themed memory that classifies
 * into one of the three kinds counts, whether or not it's actually a
 * demotion candidate (a milestone holder or quote-title source is "selected
 * but permanently kept", which is exactly what should make its kind's
 * keep-rate decline more slowly). Firsts memories are excluded — same scope
 * as the demotion pools themselves (see `gatherDemotionCandidates`); a
 * firsts entry is never a demotion candidate, so counting it would dilute
 * the ratio without ever being able to move it.
 */
function backboneThemedKindTotals(outline: BookOutline, manifest: BookManifest): Record<DemotionKind, number> {
  const totals: Record<DemotionKind, number> = { photo: 0, video: 0, illustrated: 0 };
  for (const element of outline.elements) {
    if (element.kind !== 'backbone' && element.kind !== 'themed') continue;
    for (const { memory } of resolveMemoriesInOrder(manifest, element)) {
      const kind = classifyMemoryKind(memory);
      if (kind) totals[kind]++;
    }
  }
  return totals;
}

/**
 * Highest keep-rate among `kinds` wins; ties resolve via `KIND_TIEBREAK_ORDER`
 * (photo/video preferred over illustrated). `totals`/`omittedCountByKind`
 * give the current kept-fraction for each kind — see the file-header
 * comment for why the comparison converges the three kinds' keep-rates
 * toward parity.
 */
function pickHighestKeepRateKind(
  kinds: readonly DemotionKind[],
  totals: Record<DemotionKind, number>,
  omittedCountByKind: Record<DemotionKind, number>,
): DemotionKind {
  let best: DemotionKind | null = null;
  let bestRate = -Infinity;
  for (const kind of KIND_TIEBREAK_ORDER) {
    if (!kinds.includes(kind)) continue;
    const total = totals[kind];
    const rate = total > 0 ? (total - omittedCountByKind[kind]) / total : -Infinity;
    if (rate > bestRate) {
      bestRate = rate;
      best = kind;
    }
  }
  // `kinds` is always non-empty when called below, so `best` is always set;
  // the fallback only guards the type (a kind with a candidate always has
  // total > 0, since candidates are a subset of the totals count).
  return best ?? kinds[0];
}

/** Distinct gap-reason text per kind (round-13: the preview's gaps panel must show the kind mix, not just "omitted"). */
function demotionGapReason(kind: DemotionKind, cap: number, rank: number): string {
  switch (kind) {
    case 'photo':
      return `Omitted (photo) to respect the ${cap}-page cap (rank ${rank}, lowest-engagement photo-only memory remaining, chosen to keep photo/video/illustrated keep-rates close to parity).`;
    case 'video':
      return `Omitted (video) to respect the ${cap}-page cap (rank ${rank}, lowest-engagement video-only memory remaining, chosen to keep photo/video/illustrated keep-rates close to parity).`;
    case 'illustrated':
      return `Omitted (illustrated) to respect the ${cap}-page cap (rank ${rank}, lowest-rank digest-eligible illustrated memory remaining, chosen to keep photo/video/illustrated keep-rates close to parity).`;
  }
}

/** One full deterministic fit at a given pairing level / omission set — no cap awareness of its own. */
function runFit(
  outline: BookOutline,
  manifest: BookManifest,
  options: FitOptions,
  pairingLevel: PairingLevel,
  omittedIds: ReadonlySet<string>,
): { document: BookDocument; gaps: LayoutGap[] } {
  slotCounter = 0; // deterministic ids across repeated fits in tests/preview refits
  const scoreThreshold = options.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
  const gaps: LayoutGap[] = [];
  const pages: BookPage[] = [];
  const state: ContentPagesState = {
    lastTemplateId: null,
    fullBleedBudget: { total: 0, consecutive: 0 },
    pendingCredit: null,
    panoramaBudgetUsed: 0,
    contentPageCount: 0,
  };

  for (const element of outline.elements) {
    switch (element.kind) {
      case 'cover':
        pages.push(...buildCoverPages(element, manifest, outline, options));
        continue;
      case 'title':
        pages.push(...buildDedicationPages(element, manifest, outline));
        state.lastTemplateId = 'dedication';
        continue;
      case 'through-the-years':
        pages.push(...buildThroughTheYearsPage(element, manifest));
        state.lastTemplateId = 'through-the-years';
        continue;
      case 'closing':
        // Deferred until the loop finishes so the dynamic page-count line
        // can read the real total (see below).
        continue;
      case 'themed': {
        // Round-5 item 2b (root cause of Mara's "Retratos con Mirian"
        // rendering with zero member pages): every member of a themed
        // section can end up omitted/reassigned (page-cap demotion,
        // outline-integrity reassignment) — the title page must never
        // stand alone with nothing behind it. Build content FIRST (against
        // a hypothetical `outerPages` that already includes the title
        // page, so its own parity math is correct either way), then only
        // commit the title if there's real content to follow. See also
        // `auditBookDocument` check (b), a permanent regression backstop.
        const titlePage = buildSpreadTitlePage(element);
        const priorLastTemplateId = state.lastTemplateId;
        state.lastTemplateId = titlePage.templateId;
        const contentPages = buildContentPages(
          element,
          manifest,
          outline,
          gaps,
          state,
          scoreThreshold,
          null,
          pairingLevel,
          omittedIds,
          [...pages, titlePage],
        );
        if (contentPages.length === 0) {
          state.lastTemplateId = priorLastTemplateId; // the title never actually happened
          continue;
        }
        pages.push(titlePage, ...contentPages);
        continue;
      }
      case 'backbone': {
        // The outline's own date-range formatter always emits these in
        // English regardless of `manifest.language` (element.subtitle, e.g.
        // "October–November 2024", and — for an ordinary month with no
        // special editorial title of its own — element.title too, e.g.
        // "December 2024"). Route both through the same localizer; it's a
        // no-op for a real editorial title/kicker that doesn't match the
        // "Month[–Month] YYYY" shape.
        //
        // Month headers must render for EVERY segment, including a
        // photo-thin/illustrated-only one (diagnosed: `buildContentPages`
        // only clears `headerPending` for HEADER_CAPABLE templates —
        // illustrated-story/text-page/audio-note pages never carried it, so
        // a segment made up ENTIRELY of those silently dropped its header
        // with nothing to show it on). `header` itself is unconditional
        // here already; see `buildContentPages`'s own trailing fallback for
        // the rest of the fix.
        const lang = getLanguage(manifest);
        const header: SectionHeaderParams = {
          kicker: element.subtitle ? localizeMonthLabel(element.subtitle, lang) : null,
          title: localizeMonthLabel(element.title, lang),
          special: Boolean(element.subtitle),
        };
        const contentPages = buildContentPages(element, manifest, outline, gaps, state, scoreThreshold, header, pairingLevel, omittedIds, pages);
        pages.push(...contentPages);
        continue;
      }
      case 'firsts': {
        // Firsts renders as a normal themed section now (owner review
        // round 3, item 15): eyebrow + title on their own page, then its
        // memories flow through the SAME content-page machinery as any
        // other section — no bespoke ruled index-list, no repeated
        // caption. The one twist: a memory with an AI-written `warm_name`
        // (outline.json `firstsEntries`, still arriving) uses that as its
        // footer caption instead of its own raw text (see
        // `buildFirstsTitlePage` and the caption-override map below).
        // Round-5 item 2b: same dissolve-if-empty guard as 'themed' above —
        // firsts memories are never demoted (see the comment on
        // `EMPTY_ID_SET` below), but an upstream outline-integrity
        // reassignment could still leave this section with nothing.
        const titlePage = buildFirstsTitlePage(element, manifest);
        const priorLastTemplateId = state.lastTemplateId;
        state.lastTemplateId = titlePage.templateId;
        const warmNames = new Map((element.firstsEntries ?? []).map((e) => [e.memoryId, e.warmName]));
        const contentPages = buildContentPages(
          element,
          manifest,
          outline,
          gaps,
          state,
          scoreThreshold,
          null,
          pairingLevel,
          // Firsts memories are never page-cap demotion candidates — see
          // `gatherDemotionCandidates`, which only scans backbone/themed.
          EMPTY_ID_SET,
          [...pages, titlePage],
          warmNames,
        );
        if (contentPages.length === 0) {
          state.lastTemplateId = priorLastTemplateId;
          continue;
        }
        pages.push(titlePage, ...contentPages);
        continue;
      }
      default:
        continue;
    }
  }

  // Closing is built last so its memory count reflects everything actually printed.
  const closingElement = outline.elements.find((e) => e.kind === 'closing');
  if (closingElement) {
    const closingPages = buildClosingPage(closingElement, manifest.child.name, countDistinctMemories(pages));
    pages.push(...closingPages);
  }
  let totalPages = numberPages(pages);

  // Round-5 item 7: Prodigi's layflat binding requires an EVEN interior
  // page count. The closing page is a normal single page with no parity
  // enforcement of its own, so the natural total can land either way — a
  // trailing blank after it is the natural fix (closing already reads as
  // the book's own final beat; a blank facing it, rather than one shoved
  // in earlier and disturbing some other page's parity, is the least
  // disruptive place to absorb the one-page correction). Only enforced
  // within Prodigi's own printable range (see `PRODIGI_MIN_PAGES`) — a
  // book this thin is already out of range for a different reason.
  if (totalPages % 2 !== 0 && totalPages >= PRODIGI_MIN_PAGES) {
    pages.push(
      emptyPage({
        id: `${closingElement?.id ?? 'closing'}:even-page-blank`,
        sourceElementId: closingElement?.id ?? 'closing',
        templateId: 'blank',
        blankReason: 'parity:closing-total',
      }),
    );
    totalPages = numberPages(pages);
  }

  const document: BookDocument = {
    childName: manifest.child.name,
    scopeLabel: manifest.scope.label,
    pages,
    totalPages,
  };

  return { document, gaps };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function fitBook(outline: BookOutline, manifest: BookManifest, options: FitOptions = {}): FitResult {
  const cap = options.maxPages ?? DEFAULT_MAX_PAGES;

  let pairingLevel: PairingLevel = 0;
  let result = runFit(outline, manifest, options, pairingLevel, EMPTY_ID_SET);

  // Lever 1: increase pairing aggressiveness. Each level is a full re-fit —
  // this dataset is small enough (a few hundred memories) that re-running
  // the whole deterministic pass a handful of times costs nothing worth
  // optimizing away, and it keeps every level's output independently
  // verifiable rather than trying to patch a previous result in place.
  while (result.document.totalPages > cap && pairingLevel < MAX_PAIRING_LEVEL) {
    pairingLevel = (pairingLevel + 1) as PairingLevel;
    result = runFit(outline, manifest, options, pairingLevel, EMPTY_ID_SET);
  }

  // Lever 2 (round-13 rebalance): demote memories one at a time until the
  // book fits, choosing EACH step from whichever of the three kinds (photo,
  // video, illustrated) currently has the highest keep-rate among kinds
  // that still have a demotable candidate — see the file-header comment
  // above `DemotionKind` for the full policy and the owner rationale.
  //
  // The month floor still comes first, exactly as before round-13: a
  // candidate is only compared for the keep-rate pick once it's confirmed
  // "available" — `MIN_MEMORIES_PER_MONTH` protects a backbone
  // (calendar-month) element's remaining count while some OTHER month still
  // has more than its own floor to give (round-5 item 2a, the root cause of
  // Enzo's Oct/Nov/Dec 2024 vanishing entirely); once every month is down to
  // the floor, it yields rather than leave an unprintable book (see
  // `auditBookDocument` check (a), a permanent regression backstop for
  // month continuity).
  const omittedIds = new Set<string>();
  const omittedGaps: LayoutGap[] = [];
  if (result.document.totalPages > cap) {
    const pools: Record<DemotionKind, DemotionCandidate[]> = { photo: [], video: [], illustrated: [] };
    for (const c of gatherDemotionCandidates(outline, manifest)) pools[c.kind].push(c);
    for (const c of gatherIllustratedDemotionCandidates(outline, manifest)) pools.illustrated.push(c);
    for (const kind of KIND_TIEBREAK_ORDER) pools[kind].sort((a, b) => a.rank - b.rank);

    const totals = backboneThemedKindTotals(outline, manifest);
    const omittedCountByKind: Record<DemotionKind, number> = { photo: 0, video: 0, illustrated: 0 };

    while (result.document.totalPages > cap) {
      const remaining: Partial<Record<DemotionKind, DemotionCandidate[]>> = {};
      for (const kind of KIND_TIEBREAK_ORDER) {
        const list = pools[kind].filter((c) => !omittedIds.has(c.id));
        if (list.length > 0) remaining[kind] = list;
      }
      const activeKinds = Object.keys(remaining) as DemotionKind[];
      if (activeKinds.length === 0) break; // nothing left anywhere — terminate

      const counts = backboneRemainingCounts(outline, manifest, omittedIds);
      const isAboveFloor = (c: DemotionCandidate) => (counts.get(c.month) ?? Infinity) > MIN_MEMORIES_PER_MONTH;

      // Tier A: every kind's own lowest-rank candidate that's still above
      // its month's floor — the floor protection, unchanged from before
      // round-13. Compared by keep-rate among whichever kinds can offer one.
      const aboveFloorPickByKind: Partial<Record<DemotionKind, DemotionCandidate>> = {};
      for (const kind of activeKinds) {
        const pick = remaining[kind]!.find(isAboveFloor);
        if (pick) aboveFloorPickByKind[kind] = pick;
      }
      const tierAKinds = Object.keys(aboveFloorPickByKind) as DemotionKind[];

      let chosenKind: DemotionKind;
      let chosen: DemotionCandidate;
      if (tierAKinds.length > 0) {
        chosenKind = pickHighestKeepRateKind(tierAKinds, totals, omittedCountByKind);
        chosen = aboveFloorPickByKind[chosenKind]!;
      } else {
        // Tier B: every remaining candidate, in every active kind, is at or
        // below its month's floor — the floor yields (same trade the
        // pre-round-13 code already made) rather than leave an unprintable
        // book; still compared by keep-rate, lowest-rank-per-kind first.
        chosenKind = pickHighestKeepRateKind(activeKinds, totals, omittedCountByKind);
        chosen = remaining[chosenKind]![0];
      }

      omittedIds.add(chosen.id);
      omittedCountByKind[chosenKind]++;
      result = runFit(outline, manifest, options, pairingLevel, omittedIds);
      omittedGaps.push({
        elementId: chosen.elementId,
        reason: demotionGapReason(chosenKind, cap, chosen.rank),
        memoryIds: [chosen.id],
      });
    }
  }

  const capacity: PageCapacityReport = {
    cap,
    totalPages: result.document.totalPages,
    overCap: result.document.totalPages > cap,
    pairingLevelUsed: pairingLevel,
    omittedMemoryIds: Array.from(omittedIds),
  };

  return { document: result.document, gaps: [...result.gaps, ...omittedGaps], capacity };
}
