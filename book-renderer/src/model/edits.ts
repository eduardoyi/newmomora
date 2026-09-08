import type {
  BookDocument,
  BookManifest,
  BookOutline,
  ManifestAsset,
  ManifestMemory,
  PhotoSlotContent,
} from './types';
import type { FooterIndexEntry } from '../templates/common/FooterIndex.types';
import type { SectionHeaderParams } from '../templates/common/SectionHeader.types';

/**
 * Applies a family's saved v1 book edits to a book document — Design
 * Decision 7 of the memory-book-5b plan ("Where overrides apply — decided
 * now, not at implementation").
 *
 * This module is PURE and runtime-agnostic: no I/O, no DOM, nothing async.
 * All I/O (resolving a picked photo's media row, measuring its real
 * dimensions, auth/ownership checks) already happened server-side, at save
 * time, in the `memory-book-edits` Edge Function — the edit records this
 * module consumes are trusted, self-contained data (Design Decision 4/5).
 * That is also why this module has no dependency on `fitter.ts`: the two
 * entry points below are meant to sandwich a `fitBook()` call the CALLER
 * makes —
 *
 *   applyPreFit(outline, manifest, edits) -> { outline, manifest }
 *     -> fitBook(outline, manifest) -> { document }
 *       -> applyPostFit(document, edits) -> { document }
 *
 * IMAGE edits (replace + cover) apply PRE-fit, as manifest/outline
 * substitution — reflow is real and honest: if the replacement's measured
 * dimensions fall below a template's trust gate (full-bleed/panorama/cover
 * minimums, all in `fitter.ts`), the real fitter naturally demotes or
 * reroutes the page exactly as it would for any other too-small photo. This
 * module never re-implements those gates — it only substitutes the data
 * they read.
 *
 * TEXT edits (and focal-point edits, which — like text — never affect
 * layout) apply POST-fit, directly on the already-built `BookDocument`, so
 * a caption typo fix (or a reposition-in-crop drag) can never re-paginate
 * the book.
 *
 * Both stages report `skipped` orphans instead of throwing: an edit whose
 * stable key no longer resolves against the current outline/manifest/
 * document (the export regenerated with different memory/asset ids, an
 * outline element was dropped, etc.) is silently dangling data, not a
 * runtime error — the UI surfaces `skipped` quietly (Design Decision 6's
 * "a missing stable key orphans cleanly").
 *
 * Contract note: `MemoryBookEditsShape` and its three record types below
 * are a DELIBERATE, decoupled mirror of the identically-named types in
 * `supabase/functions/memory-book-edits/index.ts` (plan step 2, a separate
 * change) — the row this module ultimately consumes is written there. They
 * can't be a shared import: that function runs under Deno and this package
 * is a browser/Node Vite bundle (the same cross-runtime reason
 * `FooterIndex.types.ts`/`SectionHeader.types.ts` are split out of their
 * `.tsx` files). If that function's shape ever changes, this one must
 * change with it by hand.
 */

// ---------------------------------------------------------------------------
// Edit shapes (Design Decision 6) — the `edits jsonb` column's contract.
// ---------------------------------------------------------------------------

/**
 * The literal key used for the cover photo's own edit slot — never a real
 * `<memoryId>:<assetFile>` pair, so it can never collide with one (Design
 * Decision 6: "the cover photo (its own edit type through cover params)").
 */
export const COVER_SLOT_KEY = 'cover';

/**
 * Stable, non-positional identifier for an ordinary (non-cover) editable
 * photo slot — `<memoryId>:<assetFile>`, built from the two fields already
 * present on a fitted `PhotoSlotContent` (Design Decision 6: "NEVER by
 * array index — a missing stable key orphans cleanly"). Exported so a
 * caller (the web app's edit UI) can build the same key it will later save
 * an edit under.
 */
export function slotKey(memoryId: string, assetFile: string): string {
  return `${memoryId}:${assetFile}`;
}

function parseSlotKey(key: string): { memoryId: string; assetFile: string } | null {
  const separator = key.indexOf(':');
  if (separator <= 0 || separator === key.length - 1) return null;
  return { memoryId: key.slice(0, separator), assetFile: key.slice(separator + 1) };
}

/**
 * Text targets are one of: `'dedication' | 'closing' | 'backCover' |
 * 'sectionTitle:<elementId>' | 'eyebrow:<elementId>' | 'caption:<memoryId>' |
 * 'furniture:<key>'` (`<key>` restricted to `FURNITURE_KEYS` below) — kept
 * as a plain `string` (not a union) so an orphaned/unrecognized target from
 * an older schema version degrades to `skipped` rather than a type error
 * blocking every other edit in the same row. `target` duplicates the map
 * key it's stored under (see `MemoryBookEditsShape`) — this module reads
 * the map key as authoritative and ignores this field, exactly like the
 * Edge Function does when it writes it.
 */
export interface TextEditRecord {
  target: string;
  value: string;
}

/**
 * `furniture:<key>` namespace (owner-approved follow-up round) — a FIXED
 * allowlist, not free-form: every book "furniture" field (chrome copy the
 * templates own — see `templates/furniture.ts`'s header comment) that's
 * editable in v1, one entry per field. Mirrors the identically-named
 * constant in `supabase/functions/memory-book-edits/index.ts` (same
 * decoupled-mirror contract as `MemoryBookEditsShape` — see this module's
 * header comment); if this list ever changes, that one must change with it
 * by hand. `applyFurnitureTextEdit` below is the only place that dispatches
 * on these keys against a document's pages.
 */
export const FURNITURE_KEYS = [
  'coverName',
  'coverTagline',
  'dedicationSalutation',
  'dedicationSignoff',
  'ttyKicker',
  'ttyTitle',
  'closingTitle',
] as const;
export type FurnitureKey = (typeof FURNITURE_KEYS)[number];
const FURNITURE_KEY_SET: ReadonlySet<string> = new Set(FURNITURE_KEYS);
export function isFurnitureKey(value: string): value is FurnitureKey {
  return FURNITURE_KEY_SET.has(value);
}

/**
 * The self-contained image edit record `save_edit` writes (Design Decision
 * 5): every field the Edge Function resolved/measured server-side. `slot`
 * duplicates the map key (`slotKey()` or `COVER_SLOT_KEY`) it's stored
 * under — ignored here, same reasoning as `TextEditRecord.target`. `file`/
 * `originalFile` are R2 object keys (preview / original); `aspectRatio`
 * always comes from the picked media's own row. `originalWidth`/
 * `originalHeight` are the ORIGINAL's real pixel dimensions, measured via a
 * ranged GET the same way the print worker's `dimensions.ts` does — absent
 * (key omitted, never `null`) when that measurement failed, never
 * fabricated (same fail-closed contract as the manifest's own
 * `ManifestAsset.originalWidth/Height`).
 */
export interface ImageEditRecord {
  slot: string;
  mediaId: string;
  file: string;
  originalFile: string;
  aspectRatio: number;
  originalWidth?: number;
  originalHeight?: number;
}

/** A reposition-in-crop edit — 0-1 on each axis, see `PhotoSlotContent.focalPoint`. `slot` duplicates the map key, same as the other two record types. */
export interface FocalPointEditRecord {
  slot: string;
  x: number;
  y: number;
}

/**
 * The `memory_book_edits.edits` jsonb column's shape (Design Decision 4/6),
 * mirroring `supabase/functions/memory-book-edits/index.ts`'s
 * `MemoryBookEditsShape` (see this module's header comment). Every category
 * is `?:` here (not required, unlike the Edge Function's own
 * already-`normalizeEdits`-d version) so a caller can pass a partial object
 * — e.g. `{ text: {...} }` — without first defaulting the other two.
 */
export interface MemoryBookEditsShape {
  text?: Record<string, TextEditRecord>;
  images?: Record<string, ImageEditRecord>;
  focalPoints?: Record<string, FocalPointEditRecord>;
}

export interface SkippedEdit {
  kind: 'text' | 'image' | 'focalPoint';
  key: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Plain-JSON deep clone — every type this module touches (manifest, outline,
 * document) is plain JSON-shaped data with no Date/function/undefined-only
 * fields, so this is cheaper and more portable across runtimes (browser,
 * Node, Deno — see this module's own "runtime-agnostic" contract above)
 * than depending on `structuredClone`'s availability.
 */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------------------
// applyPreFit — image edits (replace + cover), manifest/outline substitution
// ---------------------------------------------------------------------------

export interface PreFitResult {
  outline: BookOutline;
  manifest: BookManifest;
  skipped: SkippedEdit[];
}

/**
 * Synthetic memory id `applyCoverImageEdit` injects into the manifest so the
 * fitter's own `buildCoverPages` (unmodified — see this module's header
 * comment) picks up a user-chosen cover photo through its REAL, honest
 * `coverCandidates` precedence and `effectiveCoverWidth` trust gate, rather
 * than this module reimplementing that gate. Prefixed/suffixed with double
 * underscores so it can never collide with a real memory id (every real one
 * is a UUID).
 */
const COVER_EDIT_MEMORY_ID = '__cover-edit__';

export function applyPreFit(outline: BookOutline, manifest: BookManifest, edits: MemoryBookEditsShape): PreFitResult {
  const nextOutline = deepClone(outline);
  const nextManifest = deepClone(manifest);
  const skipped: SkippedEdit[] = [];

  for (const [key, value] of Object.entries(edits.images ?? {})) {
    if (key === COVER_SLOT_KEY) {
      applyCoverImageEdit(nextOutline, nextManifest, value);
      continue;
    }
    const parsed = parseSlotKey(key);
    if (!parsed) {
      skipped.push({ kind: 'image', key, reason: 'malformed slot key' });
      continue;
    }
    const memory = nextManifest.memories[parsed.memoryId];
    if (!memory) {
      skipped.push({ kind: 'image', key, reason: 'memory no longer in the manifest (orphaned after regeneration)' });
      continue;
    }
    const asset = memory.assets.find((a) => a.file === parsed.assetFile);
    if (!asset) {
      skipped.push({ kind: 'image', key, reason: 'asset no longer on that memory (orphaned after regeneration)' });
      continue;
    }
    // Video slots are locked in v1 (owner-approved follow-up round, item 4):
    // no PhotoSlotContent template ever offers a Replace affordance on a
    // video-poster slot (see `editableFields.ts`'s `EditablePhotoSlot.
    // isVideoPoster`, driven by the same `content.qr` signal `fitter.ts`'s
    // `isVideoAsset` sets). This is the matching apply-time enforcement: an
    // `imageReplace` edit saved BEFORE that UI restriction existed (or one
    // crafted directly against the Edge Function) is treated as an orphan
    // rather than silently substituted — self-healing any such stale
    // "chimera" edit on next render instead of leaving a photo file
    // substituted under a still-`video-poster`-kinded asset entry
    // (`substituteAsset` deliberately never touches `asset.kind`).
    if (asset.kind === 'video-poster') {
      skipped.push({ kind: 'image', key, reason: 'target slot is a video, not an editable photo' });
      continue;
    }
    substituteAsset(asset, value);
  }

  return { outline: nextOutline, manifest: nextManifest, skipped };
}

/**
 * Overwrites an existing `ManifestAsset` in place with a replacement
 * photo's resolved data. `kind`/`durationMs` are left untouched — a v1
 * replace is always photo-for-photo (Design Decision 6 eligibility), so
 * whatever asset kind already lived at this slot stays correct.
 */
function substituteAsset(asset: ManifestAsset, value: ImageEditRecord): void {
  asset.file = value.file;
  asset.aspectRatio = value.aspectRatio;
  asset.originalWidth = value.originalWidth ?? null;
  asset.originalHeight = value.originalHeight ?? null;
  // CRITICAL (memory-book-5c plan round-2 review): without this, every
  // EDITED photo -- exactly the slots a customer touched -- would print at
  // preview resolution, since the record already carries the original key
  // (`ImageEditRecord.originalFile`, resolved server-side at save time) but
  // this function previously dropped it on the floor.
  asset.originalFile = value.originalFile;
  applyWidthHeight(asset, value);
}

/**
 * `width`/`height` are contractually the EXPORTED-preview file's own pixel
 * dimensions (see `ManifestAsset`'s doc comment) — this module never
 * re-measures the replacement preview file, only the original (that's all
 * `save_edit` measures). When the original's real dimensions ARE known,
 * using them here is an honest stand-in: a downscaled preview keeps the
 * same aspect ratio, and every trust gate that reads `.width` as a
 * fallback (`asset.originalWidth ?? asset.width`) is comparing it against a
 * px-count floor the original's own size answers correctly either way.
 * When they're NOT known (the original ranged-GET measurement failed —
 * same fail-closed case the print worker's `dimensions.ts` has), this
 * never fabricates a plausible pixel count: a tiny sentinel at the correct
 * aspect ratio guarantees every width-based trust gate (full-bleed/
 * panorama/cover) fails closed, the same honest demotion as a genuinely
 * too-small photo.
 */
function applyWidthHeight(asset: ManifestAsset, value: ImageEditRecord): void {
  if (value.originalWidth != null && value.originalHeight != null) {
    asset.width = value.originalWidth;
    asset.height = value.originalHeight;
  } else {
    asset.width = Math.round(100 * value.aspectRatio);
    asset.height = 100;
  }
}

function applyCoverImageEdit(outline: BookOutline, manifest: BookManifest, value: ImageEditRecord): void {
  const asset: ManifestAsset = {
    file: value.file,
    aspectRatio: value.aspectRatio,
    kind: 'photo',
    durationMs: null,
    originalWidth: value.originalWidth ?? null,
    originalHeight: value.originalHeight ?? null,
    // Same CRITICAL fix as substituteAsset above — a cover-photo edit is
    // just as printable as any other edited slot.
    originalFile: value.originalFile,
    width: 0,
    height: 0,
  };
  applyWidthHeight(asset, value);

  const syntheticMemory: ManifestMemory = {
    date: manifest.memories[COVER_EDIT_MEMORY_ID]?.date ?? manifest.scope.start,
    type: 'photo',
    text: null,
    emotion: null,
    topics: [],
    milestones: [],
    engagement: 0,
    taggedMembers: [],
    assets: [asset],
    illustration: null,
    shareToken: null,
  };
  manifest.memories[COVER_EDIT_MEMORY_ID] = syntheticMemory;

  // Wins `buildCoverPages`'s own `coverCandidates` precedence (first entry,
  // real `effectiveCoverWidth` gate applied same as any AI nominee) — kept
  // idempotent by de-duplicating before prepending, so applying the same
  // edit twice doesn't grow this array.
  const existingCandidates = (outline.coverCandidates ?? []).filter((id) => id !== COVER_EDIT_MEMORY_ID);
  outline.coverCandidates = [COVER_EDIT_MEMORY_ID, ...existingCandidates];
}

// ---------------------------------------------------------------------------
// applyPostFit — text + focal-point edits, applied directly to the document
// ---------------------------------------------------------------------------

export interface PostFitResult {
  document: BookDocument;
  skipped: SkippedEdit[];
}

export function applyPostFit(document: BookDocument, edits: MemoryBookEditsShape): PostFitResult {
  const next = deepClone(document);
  const skipped: SkippedEdit[] = [];

  for (const [target, record] of Object.entries(edits.text ?? {})) {
    if (!applyTextEdit(next, target, record.value)) {
      skipped.push({ kind: 'text', key: target, reason: 'no matching page/field found (orphaned after regeneration)' });
    }
  }

  for (const [key, value] of Object.entries(edits.focalPoints ?? {})) {
    if (!applyFocalPointEdit(next, key, value)) {
      skipped.push({ kind: 'focalPoint', key, reason: 'no matching photo slot found (orphaned after regeneration)' });
    }
  }

  return { document: next, skipped };
}

const SECTION_TITLE_PREFIX = 'sectionTitle:';
const EYEBROW_PREFIX = 'eyebrow:';
const CAPTION_PREFIX = 'caption:';
const FURNITURE_PREFIX = 'furniture:';

function applyTextEdit(document: BookDocument, target: string, value: string): boolean {
  switch (target) {
    case 'dedication':
      return setOnPages(document, (p) => p.templateId === 'dedication', (params) => {
        params.body = value;
      });
    case 'backCover':
      return setOnPages(document, (p) => p.templateId === 'cover-wrap', (params) => {
        params.backCoverLine = value;
      });
    case 'closing':
      // Closing.tsx renders a fixed, localized furniture line today (see
      // its own doc comment) and does not yet read a param override — this
      // is forward-compatible plumbing for when it does (out of this
      // step's scope, which is edits.ts + focal-point template wiring
      // only). The value still round-trips correctly through save/reload.
      return setOnPages(document, (p) => p.templateId === 'closing', (params) => {
        params.closingLine = value;
      });
    default:
      break;
  }
  if (target.startsWith(SECTION_TITLE_PREFIX)) {
    return applySectionHeaderField(document, target.slice(SECTION_TITLE_PREFIX.length), 'title', value);
  }
  if (target.startsWith(EYEBROW_PREFIX)) {
    // "Eyebrow" (Design Decision 6's UI-facing name) is `SectionHeaderParams.kicker` in this data model.
    return applySectionHeaderField(document, target.slice(EYEBROW_PREFIX.length), 'kicker', value);
  }
  if (target.startsWith(CAPTION_PREFIX)) {
    return applyCaptionEdit(document, target.slice(CAPTION_PREFIX.length), value);
  }
  if (target.startsWith(FURNITURE_PREFIX)) {
    const key = target.slice(FURNITURE_PREFIX.length);
    return isFurnitureKey(key) ? applyFurnitureTextEdit(document, key, value) : false;
  }
  return false;
}

/**
 * `furniture:<key>` dispatch (owner-approved follow-up round, Design
 * Decision "furniture namespace"). Year range (`yearRangeLabel`) stays
 * derived/non-editable by owner decision — deliberately no key for it here.
 *
 *   - `coverName` overrides the child-name display on BOTH the front-cover
 *     title AND the spine — `WraparoundCover.tsx` already reads a single
 *     `params.childName` for both (see its own JSX: `.cover-wrap__name` and
 *     `.cover-wrap__spine-name` both render `{p.childName}`), so setting it
 *     once here updates both by construction, with no separate spine field
 *     needed.
 *   - `coverTagline` is the back-cover tagline — the SAME
 *     `params.backCoverLine` field the legacy flat `'backCover'` target
 *     already writes (kept working unchanged, additive not replaced); this
 *     just gives it a furniture-namespaced alias for the overlay's cover
 *     region grouping.
 *   - `dedicationSalutation`/`dedicationSignoff` override the dedication
 *     page's greeting line and signature line — both fixed furniture copy
 *     today (`furniture.dedication.greeting(childName)` /
 *     `.signature`), never previously present in `params` at all.
 *     `Dedication.tsx` falls back to the furniture default when absent.
 *   - `ttyKicker`/`ttyTitle` override the through-the-years page's kicker
 *     and (up to two-line, `\n`-joined) title — same "previously fixed
 *     furniture copy, now an optional params override" shape.
 */
function applyFurnitureTextEdit(document: BookDocument, key: FurnitureKey, value: string): boolean {
  switch (key) {
    case 'coverName':
      return setOnPages(document, (p) => p.templateId === 'cover-wrap', (params) => {
        params.childName = value;
      });
    case 'coverTagline':
      return setOnPages(document, (p) => p.templateId === 'cover-wrap', (params) => {
        params.backCoverLine = value;
      });
    case 'dedicationSalutation':
      return setOnPages(document, (p) => p.templateId === 'dedication', (params) => {
        params.greeting = value;
      });
    case 'dedicationSignoff':
      return setOnPages(document, (p) => p.templateId === 'dedication', (params) => {
        params.signature = value;
      });
    case 'ttyKicker':
      return setOnPages(document, (p) => p.templateId === 'through-the-years', (params) => {
        params.ttyKicker = value;
      });
    case 'ttyTitle':
      return setOnPages(document, (p) => p.templateId === 'through-the-years', (params) => {
        params.ttyTitle = value;
      });
    case 'closingTitle':
      // Overrides Closing.tsx's fixed script headline ("Hasta el año que
      // viene." / "See you next year.") — same optional-param-with-
      // furniture-default pattern that template already has for
      // `closingLine` (the count line below it), see that component's own
      // doc comment.
      return setOnPages(document, (p) => p.templateId === 'closing', (params) => {
        params.closingTitle = value;
      });
  }
}

function setOnPages(
  document: BookDocument,
  matches: (page: BookDocument['pages'][number]) => boolean,
  mutate: (params: BookDocument['pages'][number]['params']) => void,
): boolean {
  let applied = false;
  for (const page of document.pages) {
    if (!matches(page)) continue;
    mutate(page.params);
    applied = true;
  }
  return applied;
}

/**
 * `sectionTitle:<elementId>` / `eyebrow:<elementId>` land on whichever
 * page(s) actually carry that element's title/kicker in the fitted
 * document — a themed element's own `spread-title` opener page (`title`/
 * `kicker` directly in `params`), and/or the first header-capable content
 * page in the section (`params.sectionHeader.title`/`.kicker`). Both are
 * updated when both exist so they can never drift out of sync; an element
 * whose pages carry neither shape (or that no longer exists) is an orphan.
 */
function applySectionHeaderField(document: BookDocument, elementId: string, field: 'title' | 'kicker', value: string): boolean {
  let applied = false;
  for (const page of document.pages) {
    if (page.sourceElementId !== elementId) continue;
    if (page.templateId === 'spread-title') {
      page.params[field] = value;
      applied = true;
    }
    const header = page.params.sectionHeader as SectionHeaderParams | null | undefined;
    if (header) {
      header[field] = value;
      applied = true;
    }
  }
  return applied;
}

/**
 * `caption:<memoryId>` updates every on-slot `PhotoSlotContent.caption` for
 * that memory, AND the matching `footerIndex` line(s) on the same page —
 * captions render exclusively in the footer index (see `PhotoSlotContent`'s
 * own doc comment), keyed there by numeral, not memory id, so this looks up
 * the slot's own page-local `index` to find its footer entry.
 */
function applyCaptionEdit(document: BookDocument, memoryId: string, value: string): boolean {
  let applied = false;
  for (const page of document.pages) {
    const matchedIndices = new Set<number>();
    for (const slot of page.slots) {
      if (slot.content.kind !== 'photo') continue;
      const content = slot.content as PhotoSlotContent;
      if (content.memoryId !== memoryId) continue;
      content.caption = value;
      applied = true;
      if (content.index != null) matchedIndices.add(content.index);
    }
    if (matchedIndices.size === 0) continue;
    const footerIndex = page.params.footerIndex as FooterIndexEntry[] | undefined;
    if (!Array.isArray(footerIndex)) continue;
    for (const entry of footerIndex) {
      if (entry.indices.some((i) => matchedIndices.has(i))) {
        entry.note = value;
      }
    }
  }
  return applied;
}

function applyFocalPointEdit(document: BookDocument, key: string, value: FocalPointEditRecord): boolean {
  if (key === COVER_SLOT_KEY) {
    let applied = false;
    for (const page of document.pages) {
      if (page.templateId !== 'cover-wrap') continue;
      page.params.assetFocalPoint = { x: value.x, y: value.y };
      applied = true;
    }
    return applied;
  }

  const parsed = parseSlotKey(key);
  if (!parsed) return false;
  let applied = false;
  for (const page of document.pages) {
    for (const slot of page.slots) {
      if (slot.content.kind !== 'photo') continue;
      const content = slot.content as PhotoSlotContent;
      if (content.memoryId !== parsed.memoryId || content.assetFile !== parsed.assetFile) continue;
      content.focalPoint = { x: value.x, y: value.y };
      applied = true;
    }
  }
  return applied;
}
