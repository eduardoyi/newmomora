/**
 * Picks ONE representative R2 object key for a ready book's
 * `memory_books.cover_asset_key` column (memory-book shelf redesign,
 * migration `20260917120000_memory_book_cover_asset.sql`) -- written by
 * `workflow-memory-book-bridge`'s `handlePublish` in the SAME CAS update
 * that flips `status` to `'ready'`, so the picker's shelf tiles never need
 * to ship the whole `book_document` jsonb through the poll loop.
 *
 * 2026-09-17 device-testing finding: an earlier version of this module
 * (assets[0]-of-first-resolving-candidate, plus an unconditional
 * kind==='photo' fallback scan) diverged from the REAL rendered cover, so
 * the shelf tile didn't match the book. This version instead mirrors
 * `book-renderer/src/model/fitter.ts`'s `buildCoverPages` (and its
 * `effectiveCoverWidth`/`pickMiddleOfRangeCoverPhoto` helpers)
 * BYTE-FOR-BYTE in precedence -- see that file for the canonical algorithm
 * this reimplements defensively against untyped jsonb. Re-backfilled for
 * existing `ready` rows by migration
 * `20260917150000_memory_book_cover_asset_refine.sql` (the earlier
 * migration's backfill used the old, wrong precedence and is not edited --
 * already applied to the live DB).
 *
 * Precedence (identical to `buildCoverPages`):
 *   1. Walk `outline.coverCandidates` in order; for each id, the first
 *      asset (in that memory's own `assets` array order) with
 *      `kind === 'photo'` AND `effectiveCoverWidth(asset) >= 2000`. First
 *      id that yields one wins.
 *   2. Legacy fallback: the first asset -- iterating every manifest memory
 *      in `Object.entries(manifest.memories)` order, then that memory's own
 *      `assets` order -- whose memory id is in `outline.heroCandidates` AND
 *      `kind === 'photo'`. NO width floor (kept byte-identical to the
 *      pre-existing behavior the real renderer preserves for already-issued
 *      books).
 *   3. `pickMiddleOfRangeCoverPhoto`: among ALL `kind === 'photo'` assets
 *      (across every memory) with `effectiveCoverWidth(asset) >= 2000`,
 *      the one whose memory date is closest to the midpoint of
 *      `manifest.scope.start`/`.end`; ties broken by widest
 *      `effectiveCoverWidth`, then lowest memory id (string compare).
 *   4. Nothing qualifies -> `null` (the real cover renders 'minimal'/no
 *      photo; the shelf tile shows a placeholder wash -- correct, not a
 *      bug).
 *
 * `effectiveCoverWidth` prefers `asset.originalWidth` (the real
 * SOURCE-pixel width) over `asset.width` (the ~1280px preview-export
 * width) -- see `fitter.ts`'s own comment on why gating on `width` alone
 * silently rejects every real `coverCandidates` nominee in preview-mode
 * manifests.
 *
 * 2026-09-17 owner decision (cover-edit awareness): a saved COVER edit
 * (`memory_book_edits.edits.images.cover`, an `ImageEditRecord`) is now
 * consulted too, via the optional `coverEdit` parameter -- mirroring
 * `book-renderer/src/model/edits.ts`'s `applyCoverImageEdit`, which
 * prepends a synthetic `'__cover-edit__'` memory id to
 * `outline.coverCandidates` (first entry, so it's checked before every AI
 * nominee) built from the edit record via the SAME `applyWidthHeight`
 * derivation. Critically, this is NOT an unconditional override: the
 * synthetic candidate is subject to the identical pass-1 width gate as any
 * AI candidate, and a too-small edit loses to the normal precedence exactly
 * as it would in the real renderer. Only a COVER edit matters here --
 * `imageReplace`/text/focal-point edits never affect cover selection, so
 * `memory-book-edits`' `save_edit` only recomputes this column when the
 * `images.cover` record itself changed (added, changed, or removed).
 * Called with no `coverEdit` (or an omitted one), this function's behavior
 * is unchanged from before this addition -- `workflow-memory-book-bridge`'s
 * `handlePublish` call site stays as-is, since no edit can exist yet at
 * publish time (the edit surface requires `status = 'ready'`).
 *
 * Fully defensive: this runs on the publish path, which must never fail
 * book generation over a malformed `book_document` -- every shape
 * assumption below is guarded rather than asserted, and garbage input of
 * any shape simply resolves to `null`.
 */

/** Mirrors `fitter.ts`'s own `COVER_PHOTO_MIN_WIDTH_PX`. */
export const COVER_PHOTO_MIN_WIDTH_PX = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

interface CoverAssetCandidate {
  memoryId: string;
  file: string;
  kind: unknown;
  /** Mirrors `effectiveCoverWidth`: `originalWidth` if a finite number,
   * else `width` if a finite number, else `null` (malformed/missing --
   * never qualifies for a width-gated pass, and never wins a width
   * tie-break). */
  effectiveWidth: number | null;
  memoryDate: string | null;
}

/** Flattened `{memoryId, memory, asset}` list, in the SAME order
 * `buildCoverPages` builds `candidates`: `Object.entries(manifest.memories)`
 * order, then each memory's own `assets` array order. */
function buildCandidates(memories: Record<string, unknown>): CoverAssetCandidate[] {
  const candidates: CoverAssetCandidate[] = [];
  for (const [memoryId, memoryRaw] of Object.entries(memories)) {
    if (!isRecord(memoryRaw)) continue;
    const memoryDate = typeof memoryRaw.date === 'string' ? memoryRaw.date : null;
    const assets = memoryRaw.assets;
    if (!Array.isArray(assets)) continue;
    for (const assetRaw of assets) {
      if (!isRecord(assetRaw) || typeof assetRaw.file !== 'string') continue;
      candidates.push({
        memoryId,
        file: assetRaw.file,
        kind: assetRaw.kind,
        effectiveWidth: toFiniteNumber(assetRaw.originalWidth) ?? toFiniteNumber(assetRaw.width),
        memoryDate,
      });
    }
  }
  return candidates;
}

type QualifyingPhotoCandidate = CoverAssetCandidate & { effectiveWidth: number };

function isQualifyingPhoto(candidate: CoverAssetCandidate): candidate is QualifyingPhotoCandidate {
  return candidate.kind === 'photo' && candidate.effectiveWidth !== null && candidate.effectiveWidth >= COVER_PHOTO_MIN_WIDTH_PX;
}

/** Mirrors `pickMiddleOfRangeCoverPhoto` exactly, including both tie-break
 * rules and the NaN-safe "unparseable date -> infinite distance" fallback. */
function pickMiddleOfRangeCoverPhoto(candidates: CoverAssetCandidate[], scope: unknown): CoverAssetCandidate | null {
  const photos = candidates.filter(isQualifyingPhoto);
  if (photos.length === 0) return null;

  const scopeRecord = isRecord(scope) ? scope : {};
  const startMs = typeof scopeRecord.start === 'string' ? Date.parse(scopeRecord.start) : NaN;
  const endMs = typeof scopeRecord.end === 'string' ? Date.parse(scopeRecord.end) : NaN;
  const midMs = Number.isNaN(startMs) || Number.isNaN(endMs) ? NaN : (startMs + endMs) / 2;

  const distanceFromMid = (candidate: CoverAssetCandidate): number => {
    const dateMs = candidate.memoryDate ? Date.parse(candidate.memoryDate) : NaN;
    return Number.isNaN(midMs) || Number.isNaN(dateMs) ? Number.POSITIVE_INFINITY : Math.abs(dateMs - midMs);
  };

  let best = photos[0];
  let bestDistance = distanceFromMid(best);
  for (const candidate of photos.slice(1)) {
    const distance = distanceFromMid(candidate);
    const closer = distance < bestDistance;
    const tieWider = distance === bestDistance && candidate.effectiveWidth > best.effectiveWidth;
    const tieSameWidthLowerId =
      distance === bestDistance &&
      candidate.effectiveWidth === best.effectiveWidth &&
      candidate.memoryId < best.memoryId;
    if (closer || tieWider || tieSameWidthLowerId) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** Literal sentinel memory id `applyCoverImageEdit` synthesizes a cover
 * edit's memory under (`book-renderer/src/model/edits.ts`'s
 * `COVER_EDIT_MEMORY_ID`) -- duplicated here rather than imported, same
 * decoupled-mirror contract as `COVER_SLOT_KEY` between that module and
 * `memory-book-edits/index.ts` (cross-runtime: Deno vs. the browser/Node
 * book-renderer bundle). Only used as this candidate's own `memoryId` tag;
 * never compared against anything else. */
const COVER_EDIT_MEMORY_ID = '__cover-edit__';

/**
 * Mirrors `applyCoverImageEdit` + `applyWidthHeight`'s synthetic-asset
 * construction, for the one field this module needs
 * (`effectiveCoverWidth`, to apply the same pass-1 gate) plus `file` (to
 * return on a qualifying hit). Returns `null` for anything that isn't a
 * usable `ImageEditRecord`-shaped object -- `file` must be a non-empty
 * string, and `aspectRatio` (a REQUIRED field on the real record, used by
 * the sentinel-width fallback below) must be present as a finite number;
 * either failing means "no cover edit to consider", not a thrown error.
 *
 * Faithfully reproduces one real quirk rather than "fixing" it: the real
 * `applyCoverImageEdit` sets `asset.originalWidth = value.originalWidth ??
 * null` INDEPENDENTLY of `originalHeight` (only `applyWidthHeight`'s
 * width/height PAIR requires both to be present), and `effectiveCoverWidth`
 * reads `asset.originalWidth ?? asset.width` -- so a `coverEdit` carrying
 * `originalWidth` but missing `originalHeight` still gates on
 * `originalWidth` alone, never falling to the aspect-ratio sentinel; this
 * mirrors that by keying `effectiveWidth` off `originalWidth` alone too.
 */
function buildCoverEditCandidate(coverEdit: unknown): CoverAssetCandidate | null {
  if (!isRecord(coverEdit)) return null;
  const file = coverEdit.file;
  if (typeof file !== 'string' || file.length === 0) return null;
  const aspectRatio = toFiniteNumber(coverEdit.aspectRatio);
  if (aspectRatio === null) return null;

  const originalWidth = toFiniteNumber(coverEdit.originalWidth);
  // applyWidthHeight's fallback when the original wasn't (or couldn't be)
  // measured server-side: a tiny sentinel at the correct aspect ratio, so
  // every width-based gate fails closed rather than fabricating a
  // plausible pixel count.
  const sentinelWidth = Math.round(100 * aspectRatio);

  return {
    memoryId: COVER_EDIT_MEMORY_ID,
    file,
    kind: 'photo',
    effectiveWidth: originalWidth ?? sentinelWidth,
    memoryDate: null,
  };
}

export function pickCoverAssetKey(bookDocument: unknown, coverEdit?: unknown): string | null {
  if (!isRecord(bookDocument)) return null;

  const manifest = bookDocument.manifest;
  if (!isRecord(manifest)) return null;
  const memories = manifest.memories;
  if (!isRecord(memories)) return null;

  // A saved cover edit is checked FIRST -- exactly as `applyCoverImageEdit`
  // prepends the synthetic '__cover-edit__' id as coverCandidates[0] -- but
  // it must clear the SAME width gate as any AI candidate; a too-small edit
  // is silently skipped, falling through to the unmodified precedence below
  // (which, per the real renderer, it would ALSO fail at every other pass --
  // pass 2 never sees it since heroCandidates is untouched by the edit, and
  // pass 3's gate is identical to pass 1's).
  const editCandidate = buildCoverEditCandidate(coverEdit);
  if (editCandidate && isQualifyingPhoto(editCandidate)) {
    return editCandidate.file;
  }

  const candidates = buildCandidates(memories);

  const outline = bookDocument.outline;
  const coverCandidateIds = isRecord(outline) ? toStringArray(outline.coverCandidates) : [];
  const heroCandidateIds = isRecord(outline) ? toStringArray(outline.heroCandidates) : [];

  // Pass 1: outline.coverCandidates, best-first, width-gated.
  for (const id of coverCandidateIds) {
    const hit = candidates.find((candidate) => candidate.memoryId === id && isQualifyingPhoto(candidate));
    if (hit) return hit.file;
  }

  // Pass 2: legacy heroCandidates fallback, NO width floor.
  const heroHit = candidates.find(
    (candidate) => heroCandidateIds.includes(candidate.memoryId) && candidate.kind === 'photo',
  );
  if (heroHit) return heroHit.file;

  // Pass 3: width-gated, closest to the scope midpoint.
  const middle = pickMiddleOfRangeCoverPhoto(candidates, manifest.scope);
  return middle ? middle.file : null;
}
