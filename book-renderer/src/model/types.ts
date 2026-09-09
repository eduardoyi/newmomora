/**
 * Data contract + book document types for the V3 phase-1 renderer.
 *
 * Two input shapes come from outside this package (produced by the
 * curation/export pipeline, see docs/plans/memory-book.md Stage A/B):
 *   - `BookManifest` — per-memory content + assets (book-data/<slug>/manifest.json)
 *   - `BookOutline`  — ordered chapters/spreads with memory refs (book.outline.json)
 *
 * The fitter (`fitBook`) turns those into a `BookDocument`: pages with a
 * template id + params + slots bound to content refs. This is the ONE
 * artifact the preview and (later) print renderer both consume — layout is
 * computed once, deterministically. In practice that computation runs in
 * the browser for both the preview and print entries (`fitBook` is pure TS
 * with no DOM dependency, so it runs identically wherever it's called —
 * see fitter.ts's own header comment); 5b's web app fits in the browser
 * too, applying edits (`model/edits.ts`) around the same `fitBook` call.
 */

// ---------------------------------------------------------------------------
// Manifest (input) — verbatim field names per the Stage C data contract.
// ---------------------------------------------------------------------------

export type AssetKind = 'photo' | 'video-poster';

export interface ManifestAsset {
  file: string;
  width: number;
  height: number;
  aspectRatio: number;
  kind: AssetKind;
  durationMs: number | null;
  /**
   * Source-file dimensions before any preview/export downscaling (export
   * pipeline addition, additive — absent on older manifests). `width`/
   * `height` above may be a downscaled preview; the panorama-candidate trust
   * gate reads these when present so a genuinely wide original photo isn't
   * rejected just because its preview render was shrunk below the print
   * threshold. Orientation checks still use the preview's own aspect ratio,
   * which is preserved by any uniform downscale.
   */
  originalWidth?: number | null;
  originalHeight?: number | null;
  /**
   * The ORIGINAL (not preview) R2 object key (data contract addition,
   * memory-book-5c plan, Design Decision 1) -- print needs full-resolution
   * bytes; `file` above may be a downscaled preview. Absent on a manifest
   * built before this field existed, and on an asset whose `file` already
   * IS the original (no preview existed) -- the producer never duplicates
   * `file`'s own value into this field, so "absent" and "equal to file" are
   * the same fact. Optional (not `| null`, unlike `originalWidth`/
   * `originalHeight`) -- both producers (the manifest builder, and
   * `model/edits.ts`'s `substituteAsset`/`applyCoverImageEdit` copying
   * `ImageEditRecord.originalFile`) always have a real key when they set it
   * at all; nothing ever writes an explicit `null` here.
   */
  originalFile?: string;
  /**
   * The memory's PRISTINE asset file this slot's photo replaced — set ONLY
   * by `model/edits.ts`'s `substituteAsset` when an `imageReplace` edit
   * overwrites `file`, and threaded by the fitter into
   * `PhotoSlotContent.editedFromFile`. This is the slot's IDENTITY: the
   * stable edit key is always `slotKey(memoryId, editedFromFile ?? file)`,
   * which stays correct even when the substituted photo also natively
   * exists elsewhere in the book (owner-hit duplicate-replace bug,
   * 2026-09-09: resolving identity by scanning edit records for a matching
   * rendered FILE collides the moment one photo occupies two slots). Never
   * produced by the manifest builder; absent everywhere except an edited
   * slot within one `applyPreFit` output.
   */
  editedFromFile?: string;
}

/** AI illustration generated for a text memory (data contract addition, landed). */
export interface ManifestIllustration {
  file: string;
  width: number;
  height: number;
  aspectRatio: number;
}

export interface ManifestMilestone {
  id: string;
  name: string;
  detail: string;
}

export interface ManifestTaggedMember {
  name: string;
  isChild: boolean;
}

export type MemoryType = 'text' | 'photo' | 'video' | 'audio' | 'text_illustration' | string;

export interface ManifestMemory {
  date: string; // ISO date
  type: MemoryType;
  text: string | null;
  emotion: string | null;
  topics: string[];
  milestones: ManifestMilestone[];
  engagement: number;
  taggedMembers: ManifestTaggedMember[];
  assets: ManifestAsset[];
  /**
   * AI illustration for this memory, or null. Optional on the type because
   * older manifest exports predate the field — treat absence like null.
   */
  illustration?: ManifestIllustration | null;
  /**
   * Round-19: the active `media_share_tokens.token` this memory's QR/scan
   * mark should encode (`null` for a memory with no QR page — see
   * `PhotoSlotContent.qr` / `AudioNoteContent`). Optional on the type
   * because a manifest exported before this field existed predates tokens
   * entirely — treat absence exactly like `null`: fall back to the static
   * placeholder scan mark (`ScanMark.tsx`), never fabricate a link from the
   * memory id.
   */
  shareToken?: string | null;
}

export interface ManifestPortrait {
  file: string;
  date: string;
  ageLabel: string;
  /** Real source photo the illustrated portrait was generated from (data contract addition, landed). */
  sourceFile?: string;
}

export interface ManifestScope {
  kind: string;
  label: string;
  start: string;
  end: string;
}

export interface BookManifest {
  /** `dateOfBirth` is optional — when present, age labels are computed exactly; see templates/age.ts. */
  child: { id: string; name: string; dateOfBirth?: string | null };
  scope: ManifestScope;
  generatedAt: string;
  outlineRun: string;
  memories: Record<string, ManifestMemory>;
  portraits: ManifestPortrait[];
  /**
   * The family's journal language — book furniture (section labels,
   * signatures, scan-mark microcopy) follows THIS, not the app UI
   * language. `"es" | "en"`; optional, defaults to `"en"` when absent
   * (see `templates/furniture.ts` `getLanguage`).
   */
  language?: 'es' | 'en';
}

// ---------------------------------------------------------------------------
// Outline (input) — matches the real eval output shape at
// supabase/scripts/eval-output/memory-book-outline/.../outline.json
// ---------------------------------------------------------------------------

export type OutlineElementKind =
  | 'cover'
  | 'title'
  | 'through-the-years'
  | 'backbone'
  | 'themed'
  | 'firsts'
  | 'closing';

export type SpreadType = 'topic' | 'people-pair' | 'emotion';
export type TitleMode = 'quote' | 'descriptive';

export interface OutlineElement {
  id: string;
  kind: OutlineElementKind;
  title: string;
  /** Present on some backbone segments (e.g. birth-month date range). */
  subtitle?: string;
  memoryIds: string[];
  rationale: Record<string, string>;
  spreadType?: SpreadType;
  titleMode?: TitleMode;
  titleSourceMemoryId?: string | null;
  /**
   * Per-segment editorial highlight ids (memory ids that should get hero
   * slots / full-bleed eligibility). Data contract addition — not yet
   * present in production outline.json as of 2026-08-26. Optional and
   * defaulted to [] so the fitter degrades gracefully until it lands.
   */
  highlights?: string[];
  /**
   * Thematic antetítulo kicker for a themed spread-title (descriptive voice
   * needs this; quote voice uses its attribution line instead). Data
   * contract addition — not yet present in production outline.json.
   * Optional; when absent the antetítulo line is simply omitted (never
   * invented text).
   */
  kicker?: string;
  /**
   * Per-memory AI-written warm second-person milestone lines for a `firsts`
   * element (owner review round 3: "Firsts renders as a normal themed
   * section... the AI-written `warm_name`... prints near the image with its
   * index numeral"). Data contract addition — not yet present in production
   * outline.json. Optional; when a memory has no matching entry here, its
   * own verbatim memory text is used instead (never fabricated).
   */
  firstsEntries?: OutlineFirstsEntry[];
}

/** See `OutlineElement.firstsEntries`. */
export interface OutlineFirstsEntry {
  memoryId: string;
  /** Catalog id, when the AI response also carries it — informational only; the renderer keys off `memoryId`. */
  milestoneId?: string;
  /** The AI-written warm second-person line, e.g. "Aprendiste a montar bicicleta sin pedales." */
  warmName: string;
}

export interface OutlineIntegrityReassignment {
  memoryId: string;
  droppedFrom: string[];
  keptIn: string;
}

export interface OutlineIntegrityMoved {
  memoryId: string;
  fromSpread: string;
  toSpread: string;
}

export interface OutlineIntegrityExcluded {
  memoryId: string;
  elementId: string;
  reason: string;
}

export interface OutlineIntegrity {
  violations: unknown[];
  reassignments: OutlineIntegrityReassignment[];
  dissolvedSpreadIds: string[];
  dissolvedBirthdayAges: number[];
  movedToBackbone: OutlineIntegrityMoved[];
  droppedElements: unknown[];
  excludedMemoryIds: OutlineIntegrityExcluded[];
}

export interface BookOutline {
  runId: string;
  child: { id: string; name: string };
  scope: { type: string; ageYear?: number; calendarYear?: number };
  window: { start: string; endExclusive: string; label: string };
  pageEstimate: number;
  pageBudget: number;
  counts: Record<string, number>;
  elements: OutlineElement[];
  editorialNote: string;
  integrity: OutlineIntegrity;
  /**
   * Book-wide full-bleed nominee ids (data contract addition — not yet
   * present in production outline.json). Optional; the fitter's full-bleed
   * eligibility is `memory in segment highlights OR heroCandidates`.
   */
  heroCandidates?: string[];
  /**
   * Ranked (best-first) cover-photo nominee ids (data contract addition —
   * owner review 2026-08-31, following two cover failures traced to the
   * fitter's blind first-photo fallback: a hospital shot and a photo of a
   * child's drawing). Vision-judged by the outline generator against
   * criteria the plain `heroCandidates` list doesn't carry — an actual
   * photograph featuring the child with face visible; not a medical/
   * hospital setting; not a photo of a drawing/document/screen/artwork.
   * Optional; the fitter's cover-photo precedence is `coverCandidates` (own
   * width check) -> legacy `heroCandidates` -> a middle-of-date-range
   * fallback among qualifying photos (see fitter.ts `buildCoverPages`).
   */
  coverCandidates?: string[];
  /**
   * Best-first panorama nominee ids (data contract addition — item 11 of
   * the visual-review batch). Optional; a nominee is spliced out of its
   * backbone/themed grid into its own full panorama-spread at its
   * chronological position, budget-gated (see fitter.ts panorama splicing).
   */
  panoramaCandidates?: string[];
  /**
   * Dedication body text (data contract addition — item 12). Optional;
   * replaces the greeting-only placeholder on the dedication page when
   * present. Never fabricated by the renderer.
   */
  dedication?: string;
  /**
   * Back-cover colophon one-liner (data contract addition — item 12).
   * Optional; printed on the wraparound cover's back panel.
   */
  backCoverLine?: string;
}

// ---------------------------------------------------------------------------
// Physical model (Stage C: 210x210mm square + 3mm bleed, 10mm safe margin)
// ---------------------------------------------------------------------------

export const PHYSICAL = {
  pageSizeMm: 210,
  bleedMm: 3,
  safeMarginMm: 10,
  /** 6 columns / page, 5mm gutters ("calle"), per the Momora Book Layout System grid. */
  columns: 6,
  gutterMm: 5,
  /** Every image height snaps to this baseline grid. */
  baselineMm: 5,
  /** No faces or text may fall within this band centered on the spine. */
  spineNoFaceBandMm: 24,
  /**
   * The layflat printer's hard binding limit (final-fix-round capacity
   * item): the fitter must never emit a document past this page count.
   * The outline's own page budget is calibrated separately (upstream) — this
   * is the renderer's own backstop so a miscalibrated outline still prints.
   */
  maxPrintablePages: 122,
} as const;

// ---------------------------------------------------------------------------
// Book document (output) — pure data, no DOM/React involved.
// ---------------------------------------------------------------------------

export type SlotKind =
  | 'photo'
  | 'text'
  | 'caption'
  | 'qr'
  | 'portrait-strip'
  | 'illustration'
  | 'firsts-entry'
  | 'audio-note'
  | 'quote-entry'
  | 'digest-entry';

export interface PhotoSlotContent {
  kind: 'photo';
  assetFile: string;
  /** `ManifestAsset.editedFromFile` threaded through verbatim (see that
   * field's doc comment) — the slot's pristine identity when an edit has
   * substituted `assetFile`; null/absent on an unedited slot (optional so
   * hand-built test fixtures stay minimal, mirroring the manifest field). */
  editedFromFile?: string | null;
  assetWidth: number;
  assetHeight: number;
  assetAspectRatio: number;
  memoryId: string;
  date: string;
  /** Caption text is the memory's own text, verbatim and in full — never trimmed. */
  caption: string | null;
  hero: boolean;
  /** Video memories get photo-style placement plus an inline scan-mark affordance. */
  qr: boolean;
  /**
   * Round-19: the memory's `media_share_tokens.token` to encode when `qr` is
   * true — `null` when the memory has no active token (predates Round-19,
   * or `qr` is false and this is simply unused). `ScanMark.tsx` falls back
   * to the static placeholder mark whenever this is `null`, never
   * fabricating a link from `memoryId`.
   */
  shareToken: string | null;
  taggedMembers: ManifestTaggedMember[];
  /** Structured milestone facts (Firsts spread badges) — empty outside that context. */
  milestones: ManifestMilestone[];
  /**
   * The crop box aspect ratio the fitter chose for this slot (nearest of the
   * standard portrait/square/landscape boxes to the photo's own aspect).
   * Templates should render the slot at THIS aspect ratio — not guess their
   * own — so the `looseFit` verdict below stays consistent with what's
   * actually on screen (Stage C crop conservatism).
   */
  targetAspect: number;
  /**
   * Photo doesn't fit any standard crop box within tolerance (Stage C crop
   * conservatism rule) — the template must render with a contain/letterbox
   * treatment on pale lavender rather than crop beyond +/-20%.
   */
  looseFit: boolean;
  /**
   * 1-based footer-index number for this slot on its page, or null when the
   * template doesn't use a numbered index (photo-story, full-bleed,
   * panorama, illustrated-story).
   */
  index: number | null;
  /**
   * Panorama-spread crop-position control (item 11, visual-review batch):
   * the 2:1 crop window's vertical anchor. Only meaningful on a
   * panorama-spread slot; `null` elsewhere. Always `'center'` for now — a
   * real crop-position editor is a V5 item — but the field exists so that
   * control can be wired in later without a data-shape change.
   */
  cropBand: 'center' | null;
  /**
   * Reposition-in-crop override (Design Decision 9, memory-book-5b plan):
   * where within the crop box the "kept" band of the image should sit,
   * 0-1 on each axis (0,0 = top-left, 1,1 = bottom-right; 0.5,0.5 = the
   * default browser-native center). The fitter itself never sets this — it
   * is always `null` coming out of `fitBook`, exactly like `cropBand` was
   * before item 11 wired that one in. Only `model/edits.ts`'s
   * `applyPostFit` ever sets a real value, from a saved `focalPoint` edit
   * (never fabricated; absent = untouched default centering). Wired into
   * `objectPosition` by PhotoTile/FullBleed/PanoramaSpread only — the other
   * photo-ish templates render illustrations/portraits through different
   * slot-content types, out of scope (round-2 review of Decision 9).
   */
  focalPoint: { x: number; y: number } | null;
}

export interface TextSlotContent {
  kind: 'text';
  text: string;
  memoryId: string | null;
  date: string | null;
}

export interface IllustrationSlotContent {
  kind: 'illustration';
  assetFile: string;
  assetWidth: number;
  assetHeight: number;
  assetAspectRatio: number;
  memoryId: string;
}

export interface PortraitStripContent {
  kind: 'portrait-strip';
  portraits: ManifestPortrait[];
}

export interface QrSlotContent {
  kind: 'qr';
  memoryId: string;
  /** Phase 2 wires the real short URL; phase 1 renders a neutral short-code placeholder. */
  microcopy: string;
  /** 1-based footer-index number this scan mark is attached to, or null. */
  index: number | null;
}

export interface FirstsEntryContent {
  kind: 'firsts-entry';
  memoryId: string;
  date: string;
  /** Catalog id (see templates/milestones.ts) — the template resolves the localized display name from this. */
  milestoneId: string;
  /** Structured detail (e.g. "2" for a birthday's age-turned) — folded into the display name for some ids. */
  detail: string | null;
  /** The manifest's own raw (always-English) catalog name — a last-resort fallback only for an id milestones.ts doesn't recognize. */
  rawName: string;
  /** Full parent text, verbatim, only when the memory has any — never summarized. */
  parentText: string | null;
}

export interface AudioNoteContent {
  kind: 'audio-note';
  memoryId: string;
  date: string;
  /** Phase 2 wires the real short URL; phase 1 renders a neutral short-code placeholder. */
  shortCode: string;
  /** Round-19: see `PhotoSlotContent.shareToken` — the scan mark IS the
   * page for an audio-note, so this is `null` only for a memory that
   * predates tokens (falls back to the static placeholder mark). */
  shareToken: string | null;
}

/**
 * One entry in a `quote-collection` spread (canvas §5 decision table, "Solo
 * texto" row: "Tres o más entradas cortas del mismo tema se agrupan en una
 * doble página de citas" — three-plus short entries of the same theme group
 * into a two-page spread of quotes). At most ONE entry across the whole
 * collection may carry an illustration (the composition's own cap, applied
 * by the fitter before this slot is built) — every other entry is text
 * only, however many of the underlying memories actually have one.
 */
export interface QuoteEntryContent {
  kind: 'quote-entry';
  memoryId: string;
  date: string;
  /** The memory's own text, verbatim — never invented, never trimmed. */
  text: string;
  illustration: { file: string; width: number; height: number; aspectRatio: number } | null;
}

/**
 * One entry in an `illustrated-digest` spread (round-12: promotes the
 * preview demo composition — see `templates/IllustratedDigest.tsx`'s own
 * history — to a real fitter-emitted one). Unlike a quote-collection entry,
 * every digest entry ALWAYS carries its own illustration — the whole point
 * of this composition is that a short illustrated memory keeps its art even
 * when several of them share a spread (see the fitter's eligibility guard,
 * `isDigestEligibleMemory`).
 */
export interface DigestEntryContent {
  kind: 'digest-entry';
  memoryId: string;
  date: string;
  /** The memory's own text, verbatim — never invented, never trimmed. */
  text: string;
  illustration: { file: string; width: number; height: number; aspectRatio: number };
}

export type SlotContent =
  | PhotoSlotContent
  | TextSlotContent
  | PortraitStripContent
  | QrSlotContent
  | IllustrationSlotContent
  | FirstsEntryContent
  | AudioNoteContent
  | QuoteEntryContent
  | DigestEntryContent;

export interface LayoutSlot {
  id: string;
  kind: SlotKind;
  content: SlotContent;
}

export type TemplateId =
  | 'flex-grid'
  | 'photo-story'
  | 'illustrated-story'
  | 'text-page'
  | 'full-bleed'
  | 'panorama-spread'
  | 'through-the-years'
  | 'spread-title'
  | 'anchor-media'
  | 'audio-note'
  | 'firsts'
  | 'cover-wrap'
  | 'dedication'
  | 'blank'
  | 'closing'
  | 'quote-collection'
  | 'illustrated-digest';

export interface TemplateParams {
  [key: string]: unknown;
}

export interface BookPageVariant {
  templateId: TemplateId;
  params: TemplateParams;
  score: number;
  /**
   * Fully-built slots for this variant, so the preview's variant switcher
   * can render it immediately with no re-fit. Omitted for structural pages
   * (cover/title/through-the-years/spread-title/closing) whose single
   * template reads only `params` and doesn't vary its slot shape.
   */
  slots?: LayoutSlot[];
}

export interface BookPage {
  id: string;
  /** The outline element this page was fit from (traceability for gaps/QA). */
  sourceElementId: string;
  templateId: TemplateId;
  params: TemplateParams;
  slots: LayoutSlot[];
  /** Rank 2-3 alternates the preview's variant switcher can flip between. */
  variants: BookPageVariant[];
  /** True for spread-shaped templates (occupy two facing pages as one canvas). */
  isSpread: boolean;
  /**
   * Round-5 integrity audit, check (d) ("blank-page accounting"): why a
   * `blank` page exists. Every blank the fitter emits must set this to a
   * recognized reason (see `BLANK_REASONS` in fitter.ts) — a blank with no
   * reason (or an unrecognized one) is a genuine layout bug, not a
   * structural necessity, and the audit flags it as such. `null`/undefined
   * for every non-blank page.
   */
  blankReason?: string | null;
  /**
   * True for the LEFT (even) page of a spread, false for the right (odd)
   * page, null for structural/cover pages outside the pagination flow.
   * Drives folio corner + spine-band awareness for single-page templates.
   */
  isEvenPage: boolean | null;
  /** 1-based printed page number(s) this entry occupies (2 for a spread). */
  pageNumbers: number[] | null;
}

export interface BookDocument {
  childName: string;
  scopeLabel: string;
  pages: BookPage[];
  /** Total physical page count (sum of 1, or 2 for spreads) — for the closing page's dynamic line. */
  totalPages: number;
}

export interface LayoutGap {
  elementId: string;
  reason: string;
  memoryIds: string[];
}

export interface FitOptions {
  /** Any page-candidate scoring below this is reported as a layout gap. */
  scoreThreshold?: number;
  /**
   * The wraparound cover's spine width in mm (item 13, visual-review
   * batch) — parameterized because the real width comes from Prodigi's
   * per-page-count API in a later stage; defaults to 9mm for now.
   */
  spineMm?: number;
  /** Overrides `PHYSICAL.maxPrintablePages` — mainly for tests. */
  maxPages?: number;
}

/**
 * How the fitter reconciled its natural page count against the printer's
 * hard cap (final-fix-round capacity item): the outline's own budget is
 * calibrated separately upstream, but the renderer must never hand back an
 * unprintable document, so this reports whatever tightening it had to do.
 */
export interface PageCapacityReport {
  cap: number;
  /** The document's final page count, AFTER any tightening below. */
  totalPages: number;
  /** True if `totalPages` still exceeds `cap` (should only happen if every tightening lever is exhausted). */
  overCap: boolean;
  /**
   * Cross-memory pairing aggressiveness actually used to fit within the cap:
   * 0 = none needed, 1 = paired caption-less photo memories only, 2 = also
   * paired a caption-less memory with a captioned one, 3 = paired even two
   * captioned memories (last resort — a memory with text keeps its own page
   * whenever any lower level sufficed).
   */
  pairingLevelUsed: 0 | 1 | 2 | 3;
  /**
   * Memories dropped from the backbone/themed flow after maximum pairing
   * still left the book over the cap (round-13 rebalance): a mix of photo,
   * video, and — only when digest-eligible (has an illustration, short
   * enough text, near-square art, not a milestone holder or the section's
   * own quote-title source) — illustrated memories, chosen kind-by-kind to
   * keep the three kinds' keep-rates close to parity rather than draining
   * photo/video first. An ordinary text-only-with-no-illustration memory,
   * a milestone holder, or a quote-title source is never in this list.
   */
  omittedMemoryIds: string[];
}

export interface FitResult {
  document: BookDocument;
  gaps: LayoutGap[];
  capacity: PageCapacityReport;
}
