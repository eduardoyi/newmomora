/**
 * Memory Book v1 edit surface (plans/memory-book-5b-web-preview.md Design
 * Decision 5). Two operations behind one function, mirroring the
 * generate-memory-book/get-media-url shape (JWT auth via
 * `getAuthenticatedNonAnonymousUser`, owner/manager role check via
 * `getCallerFamilyRole`, dependency-injected for tests):
 *
 *   - `save_edit`: merges ONE edit into the book's `memory_book_edits.edits`
 *     jsonb (read-merge-write; single-row last-write-wins for v1, per
 *     Design Decision 4). For an image edit (imageReplace/coverPhoto) this
 *     is the ONLY place `mediaId` is ever trusted: family ownership is
 *     re-resolved server-side (never inferred from client input), and the
 *     ORIGINAL photo's real pixel dimensions are measured server-side via a
 *     short-lived presigned GET + HTTP Range read (Edge Functions have no
 *     R2 binding, unlike `cloudflare/memory-book-worker`'s
 *     `src/dimensions.ts`, whose two-pass bounded-probe semantics this
 *     mirrors exactly -- see `measureOriginalDimensions` below). This is
 *     the trust boundary the migration's header comment and Design
 *     Decision 4 depend on: 5c's service-role print path can consume
 *     `memory_book_edits.edits` without re-validating any key or
 *     dimension in it, because a client can never write this table
 *     directly (RLS: select-only) and can never fabricate what THIS
 *     function resolves.
 *   - `picker_pool`: a paginated, keys-only listing of the book's in-scope
 *     photos (memory id, media id, preview key, date, aspect ratio,
 *     already-in-book flag) for the image-replace picker sheet. The client
 *     presigns any thumbnails it actually renders through the existing
 *     `get-media-url` coalescer -- this function never returns a URL.
 *     Optional `dateStart`/`dateEnd`/`memberId` filters (owner-approved
 *     editing-UX round, item 1) narrow the pool further -- the date range
 *     is always intersected with the book's own scope window (never
 *     widened past it), and the member filter goes through
 *     `memory_family_members`. All three are optional, so older clients
 *     keep working unchanged.
 *
 * Both operations require the book to be `status = 'ready'` (there is no
 * book_document/manifest to edit against otherwise) and the caller to be
 * owner/manager of the book's family -- re-checked in code against the
 * service-role-loaded row, same pattern as `generate-memory-book`.
 *
 * PII rule: only ids, keys, and dates ever reach a `console.log`/
 * `console.error` call in this file -- never memory text/captions (edit
 * VALUES are the one exception a caller controls, and those are
 * deliberately never logged either).
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { getAuthenticatedNonAnonymousUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { getCallerFamilyRole, isManagerRole } from '../_shared/family-access.ts';
import { pickCoverAssetKey } from '../_shared/memory-book-cover.ts';
import { createPresignedGetUrls } from '../_shared/r2.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

// ── Edit shapes (Design Decision 6) ─────────────────────────────────────

export interface TextEditRecord {
  target: string;
  value: string;
}

/** Stored shape for BOTH `imageReplace` and `coverPhoto` -- Decision 5's
 * "`{ slot | 'cover', mediaId, file, originalFile, aspectRatio,
 * originalWidth?, originalHeight? }`": `slot` holds the actual slot key for
 * an `imageReplace` edit, or the literal `'cover'` sentinel for a cover
 * photo edit. `file`/`originalFile`/`aspectRatio`/`originalWidth`/
 * `originalHeight` are ALWAYS server-resolved -- never taken from the
 * request body. */
export interface ImageEditRecord {
  slot: string;
  mediaId: string;
  file: string;
  originalFile: string;
  aspectRatio: number;
  originalWidth?: number;
  originalHeight?: number;
}

export interface FocalPointEditRecord {
  slot: string;
  x: number;
  y: number;
}

/** The `memory_book_edits.edits` jsonb contract. Namespaced by category
 * (not one flat map) because the three categories are keyed from
 * overlapping-looking but semantically distinct domains -- a `focalPoints`
 * slot and an `images` slot are often literally the same string (a focal
 * point adjusts the photo CURRENTLY in a slot, whether or not that slot
 * also has an `images` replacement entry) -- and because `applyBookEdits`
 * (plan step 4, a separate change) applies them at different fit stages
 * (Decision 7: text is post-fit, images are pre-fit; focal points are a
 * pure render-time hint). An absent category key (e.g. a row saved before
 * any focal point existed) is normalized to `{}` by `normalizeEdits`, never
 * treated as an error. */
export interface MemoryBookEditsShape {
  text: Record<string, TextEditRecord>;
  images: Record<string, ImageEditRecord>;
  focalPoints: Record<string, FocalPointEditRecord>;
}

const COVER_SLOT_KEY = 'cover';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Defensive against a row saved by an older/partial shape (or the
 * jsonb column's own `'{}'` default) -- every category always comes back
 * as a real object, never `undefined`, so callers can index into it
 * directly. */
export function normalizeEdits(raw: unknown): MemoryBookEditsShape {
  const obj = isPlainObject(raw) ? raw : {};
  return {
    text: isPlainObject(obj.text) ? (obj.text as Record<string, TextEditRecord>) : {},
    images: isPlainObject(obj.images) ? (obj.images as Record<string, ImageEditRecord>) : {},
    focalPoints: isPlainObject(obj.focalPoints)
      ? (obj.focalPoints as Record<string, FocalPointEditRecord>)
      : {},
  };
}

// ── Request / response contracts ────────────────────────────────────────

export type SaveEditInput =
  | { kind: 'text'; target: unknown; value: unknown }
  | { kind: 'imageReplace'; slot: unknown; mediaId: unknown }
  | { kind: 'coverPhoto'; mediaId: unknown }
  | { kind: 'focalPoint'; slot: unknown; x: unknown; y: unknown }
  /**
   * "Reset to original" (owner-approved follow-up round, item 3) -- removes
   * ONE key from ONE category of the book's saved `edits`, restoring
   * whatever the fitter would otherwise compute for it (furniture default,
   * original photo, centered focal point, ...). Added because `save_edit`
   * previously had no removal path -- only ever merge-writes a key in. A
   * `key` that doesn't exist in `category` is a no-op (idempotent), not an
   * error -- same "orphan cleanly" posture the rest of this module takes.
   */
  | { kind: 'delete'; category: unknown; key: unknown };

export interface MemoryBookEditsRequestBody {
  op: 'save_edit' | 'picker_pool';
  bookId: string;
  edit?: SaveEditInput;
  cursor?: string | null;
  limit?: number;
  /** Item 1 (owner-approved editing-UX round): optional `picker_pool`
   * narrowing filters. `unknown` here, same posture as `cursor`/`limit`
   * above — real validation happens in `handlePickerPool`, never trusted
   * from the wire as already the right shape. */
  dateStart?: unknown;
  dateEnd?: unknown;
  memberId?: unknown;
}

export interface SaveEditResponse {
  success: true;
  edits: MemoryBookEditsShape;
}

export interface PickerPoolItem {
  memoryId: string;
  mediaId: string;
  previewKey: string;
  date: string;
  aspectRatio: number | null;
  alreadyInBook: boolean;
}

export interface PickerPoolResponse {
  items: PickerPoolItem[];
  nextCursor: string | null;
}

// ── Dependencies (test seam) ────────────────────────────────────────────

export interface MemoryBookEditsDependencies {
  getAuthenticatedUser: typeof getAuthenticatedNonAnonymousUser;
  createServiceClient: typeof createServiceClient;
  getCallerFamilyRole: typeof getCallerFamilyRole;
  createPresignedGetUrls: typeof createPresignedGetUrls;
  fetch: typeof fetch;
}

export const DEFAULT_DEPENDENCIES: MemoryBookEditsDependencies = {
  getAuthenticatedUser: getAuthenticatedNonAnonymousUser,
  createServiceClient,
  getCallerFamilyRole,
  createPresignedGetUrls,
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
};

// ── Original-dimension measurement (mirrors
// cloudflare/memory-book-worker/src/dimensions.ts's semantics -- see that
// file's header for the full rationale) ─────────────────────────────────

/** First-pass ranged read -- same budget as the worker's probe: "enough
 * for EXIF-heavy JPEG and HEIC/isobmff" for the overwhelming majority of
 * real photos. */
const DIMENSION_PROBE_RANGE_BYTES = 256 * 1024;
/** Second-pass fallback, only when the first read came back FULL (meaning
 * the real object is larger and the header just didn't fit in 256KB) --
 * still bounded, never the whole multi-MB original. */
const DIMENSION_PROBE_FALLBACK_BYTES = 4 * 1024 * 1024;
/** Short-lived: this presign is read once, server-to-server, inside a
 * single request -- not handed to any client. Matches `_shared/r2.ts`'s
 * own `getObjectBytes`, which presigns at 300s for the identical reason
 * (its default download presign is 3600s, sized for a CLIENT to hold and
 * reuse across a viewing session, which doesn't apply here). */
const DIMENSION_PROBE_URL_EXPIRY_SECONDS = 300;

async function readRangedBytes(
  fetchFn: typeof fetch,
  presignedUrl: string,
  length: number,
): Promise<Uint8Array | null> {
  try {
    const response = await fetchFn(presignedUrl, {
      headers: { Range: `bytes=0-${length - 1}` },
    });
    // R2 always honors Range on GET (206). A 200 (Range ignored) is treated
    // as "ok, just not narrow" rather than a failure -- image-size only
    // reads the leading bytes it needs regardless of how much came back.
    if (!response.ok && response.status !== 206) {
      return null;
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
}

/** `image-size`'s `calculate()` can throw (unsupported/truncated input) or
 * return `{ width: NaN, height: NaN }` (a declared header offset landing
 * past a truncated buffer's end) -- both mean "couldn't read it", exactly
 * as the worker's `parseDimensions` documents. */
function parseImageDimensions(
  bytes: Uint8Array,
  imageSizeFn: (bytes: Uint8Array) => { width?: number; height?: number },
): { width: number; height: number } | null {
  try {
    const { width, height } = imageSizeFn(bytes);
    if (!width || !height) return null;
    return { width, height };
  } catch {
    return null;
  }
}

/**
 * Measures the ORIGINAL image's real pixel dimensions via a presigned GET +
 * HTTP Range header -- the Edge Function equivalent of
 * `cloudflare/memory-book-worker/src/dimensions.ts`'s
 * `measureOriginalDimensions` (which reads via an R2 binding's own ranged
 * `.get()`; Edge Functions have no such binding). Same two-pass bounded
 * probe, same absent-never-fabricated contract: returns `null` -- never
 * throws -- on any failure (missing object, network error, unparseable
 * header even after the larger fallback read). The caller must treat
 * `null` as "never measured" and omit the field, matching
 * `ManifestAsset.originalWidth/Height`'s contract in
 * `_shared/memory-book-manifest.ts`.
 */
export async function measureOriginalDimensions(
  dependencies: Pick<MemoryBookEditsDependencies, 'createPresignedGetUrls' | 'fetch'>,
  objectKey: string,
): Promise<{ width: number; height: number } | null> {
  let presignedUrl: string | undefined;
  try {
    const urls = await dependencies.createPresignedGetUrls(
      [objectKey],
      DIMENSION_PROBE_URL_EXPIRY_SECONDS,
    );
    presignedUrl = urls[objectKey];
  } catch {
    return null;
  }
  if (!presignedUrl) return null;

  const { imageSize } = await import('npm:image-size@1.1.1');

  const probeBytes = await readRangedBytes(
    dependencies.fetch,
    presignedUrl,
    DIMENSION_PROBE_RANGE_BYTES,
  );
  if (!probeBytes) return null;

  const probed = parseImageDimensions(probeBytes, imageSize);
  if (probed) return probed;

  // A short read (R2 never pads a ranged read) means that WAS the whole
  // object -- a header that still didn't parse is genuinely corrupt, not
  // truncated by our own probe. No point re-fetching the identical bytes.
  if (probeBytes.byteLength < DIMENSION_PROBE_RANGE_BYTES) return null;

  const fallbackBytes = await readRangedBytes(
    dependencies.fetch,
    presignedUrl,
    DIMENSION_PROBE_FALLBACK_BYTES,
  );
  if (!fallbackBytes) return null;
  return parseImageDimensions(fallbackBytes, imageSize);
}

// ── Validation ───────────────────────────────────────────────────────────

// Decision 6's five text targets: three fixed names, and two/one
// colon-prefixed families keyed by an outline-assigned element id /
// memory id. `sectionTitle`/`eyebrow` ids come from the AI-curated
// outline, not a DB row, so only a format check is possible (no control
// chars, no embedded colon, bounded length). `caption:<memoryId>` requires
// the suffix to at least look like a uuid; a caption target that names a
// memory outside the book (wrong family, or simply not in this book's
// outline) is not separately rejected here -- Decision 6 explicitly wants
// a mismatched/stale key to "orphan cleanly" for the render-time consumer,
// not fail the save, and a caption VALUE never resolves or exposes
// anything the way an image mediaId does (see resolveImageEditRecord's own
// comment for why THAT lookup is a real trust boundary and this one
// isn't).
//
// `furniture:<key>` (owner-approved follow-up round) is a SIXTH family,
// deliberately NOT a free-form suffix like `sectionTitle`/`eyebrow` above --
// every furniture field is a fixed, known set (book chrome copy the
// templates themselves own -- see `book-renderer/src/templates/furniture.ts`),
// never an outline- or DB-sourced id, so it is validated against the
// `FURNITURE_KEYS` allowlist below, not a format-only regex. Mirrors
// `book-renderer/src/model/edits.ts`'s identically-named constant (same
// decoupled-mirror contract that module's header comment documents for the
// whole edits shape); if this list ever changes, that one must change with
// it by hand. Year range (`yearRangeLabel`) stays derived/non-editable by
// owner decision -- deliberately no key for it.
export const FURNITURE_KEYS = [
  'coverName',
  'coverTagline',
  'dedicationSalutation',
  'dedicationSignoff',
  'ttyKicker',
  'ttyTitle',
  'closingTitle',
  // Print-polish round (owner decision 2026-09-14, item D1) — mirrors
  // book-renderer/src/model/edits.ts's identically-named addition.
  'scanInstruction',
] as const;
export type FurnitureKey = (typeof FURNITURE_KEYS)[number];

export const TEXT_TARGET_PATTERN = new RegExp(
  `^(dedication|closing|backCover|sectionTitle:[^\\x00-\\x1f]{1,128}|eyebrow:[^\\x00-\\x1f]{1,128}|caption:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|furniture:(${FURNITURE_KEYS.join('|')}))$`,
  'i',
);
// ^ element-id suffixes MUST allow colons: real outline element ids are
// colon-namespaced ("backbone:2022-10", "topic:extended-family",
// "people:<uuid>") — caught in wave-1 cross-review before this ever ran.
// The `furniture:(...)` alternative is built FROM `FURNITURE_KEYS` (not a
// hand-duplicated wildcard) so the allowlist has exactly one source of
// truth in this file -- a key added to one and not the other cannot silently
// diverge.
const TEXT_VALUE_MAX_LENGTH = 1000;
// Disallow raw control characters other than newline/tab -- same spirit as
// the gallery-import caption constraint's `!~ '[[:cntrl:]]'`
// (20260809130000_gallery_import_foundation.sql), applied in code here
// since edits never touch a CHECK constraint (service-role writes only).
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

function validateTextEdit(
  edit: Record<string, unknown>,
): { record: TextEditRecord } | { error: string } {
  if (typeof edit.target !== 'string' || !TEXT_TARGET_PATTERN.test(edit.target)) {
    return { error: 'Invalid text edit target' };
  }
  if (
    typeof edit.value !== 'string' ||
    edit.value.length > TEXT_VALUE_MAX_LENGTH ||
    CONTROL_CHAR_PATTERN.test(edit.value)
  ) {
    return { error: 'Invalid text edit value' };
  }
  return { record: { target: edit.target, value: edit.value } };
}

const SLOT_MAX_LENGTH = 200;

/** `slot` is just a storage KEY, not a trust boundary -- book-renderer
 * (plan step 6, out of scope here) determines the actual keying scheme for
 * a rendered slot, which Decision 6 itself notes may be
 * `<memoryId>:<mediaId>` OR `<memoryId>:<assetFileKey>` depending on what
 * the manifest exposes. This function only guards against a malformed/
 * abusive string; the real authorization happens in
 * `resolveImageEditRecord` below, against `mediaId`. */
function isValidSlot(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= SLOT_MAX_LENGTH &&
    !CONTROL_CHAR_PATTERN.test(value)
  );
}

const DELETE_CATEGORIES = new Set<keyof MemoryBookEditsShape>(['text', 'images', 'focalPoints']);

/** Validates a `delete` edit's `category`/`key` pair -- `key` reuses
 * `isValidSlot`'s generic bounded-length/no-control-chars guard rather than
 * `TEXT_TARGET_PATTERN` even for `category: 'text'`, because deleting is
 * inherently idempotent (a key that never matches an existing entry is just
 * a no-op) and doesn't need the same format strictness a WRITE does. */
function validateDeleteEdit(
  edit: Record<string, unknown>,
): { category: keyof MemoryBookEditsShape; key: string } | { error: string } {
  if (typeof edit.category !== 'string' || !DELETE_CATEGORIES.has(edit.category as keyof MemoryBookEditsShape)) {
    return { error: 'Invalid delete category' };
  }
  if (!isValidSlot(edit.key)) {
    return { error: 'Invalid delete key' };
  }
  return { category: edit.category as keyof MemoryBookEditsShape, key: edit.key };
}

function validateFocalPointEdit(
  edit: Record<string, unknown>,
): { record: FocalPointEditRecord } | { error: string } {
  if (!isValidSlot(edit.slot)) {
    return { error: 'Invalid slot' };
  }
  const { x, y } = edit;
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1) {
    return { error: 'Invalid focal point x' };
  }
  if (typeof y !== 'number' || !Number.isFinite(y) || y < 0 || y > 1) {
    return { error: 'Invalid focal point y' };
  }
  return { record: { slot: edit.slot, x, y } };
}

interface ResolveImageEditResult {
  ok: boolean;
  status: number;
  code: string;
  message: string;
  record?: ImageEditRecord;
}

/**
 * The ONE place `mediaId` is trusted (Design Decision 5). Re-resolves the
 * media row's owning memory's family server-side -- NEVER inferred from
 * the caller's claimed `familyId` -- exactly the "authorization re-checked
 * in code" lesson `_shared/family-access.ts`'s
 * `resolveStorageKeyFamilyIds` documents for storage keys, applied here to
 * a `memory_media.id`. Only photo media (`content_type` starting
 * `image/`) is eligible -- Decision 6's eligibility rule excludes AI
 * illustrations/portraits and, implicitly, video/audio assets (no
 * PhotoSlotContent template ever renders one).
 */
async function resolveImageEditRecord(
  dependencies: MemoryBookEditsDependencies,
  supabase: SupabaseClient,
  familyId: string,
  slot: string,
  mediaIdInput: unknown,
): Promise<ResolveImageEditResult> {
  if (typeof mediaIdInput !== 'string' || !mediaIdInput) {
    return { ok: false, status: 400, code: 'validation_error', message: 'mediaId is required' };
  }

  const { data: media, error } = await supabase
    .from('memory_media')
    .select('id, memory_id, object_key, preview_object_key, content_type, aspect_ratio, memories!inner(family_id)')
    .eq('id', mediaIdInput)
    .maybeSingle();

  if (error) {
    console.error('memory-book-edits media lookup failed', error.message);
    return { ok: false, status: 500, code: 'internal_error', message: 'Failed to resolve media' };
  }

  const owningFamilyId = isPlainObject(media?.memories)
    ? (media.memories as { family_id?: string }).family_id ?? null
    : null;

  if (!media || owningFamilyId !== familyId) {
    // Same shape whether the id is unknown or belongs to another family --
    // no oracle for "does this id exist in some other family" (mirrors
    // get-media-url's per-key omission rationale).
    return { ok: false, status: 404, code: 'MEDIA_NOT_FOUND', message: 'Media not found' };
  }

  if (typeof media.content_type !== 'string' || !media.content_type.startsWith('image/')) {
    return {
      ok: false,
      status: 400,
      code: 'MEDIA_NOT_PHOTO',
      message: 'Only photo media can be used for an image edit',
    };
  }

  const file: string = media.preview_object_key ?? media.object_key;
  const originalDimensions = await measureOriginalDimensions(dependencies, media.object_key);
  const aspectRatio =
    typeof media.aspect_ratio === 'number'
      ? media.aspect_ratio
      : originalDimensions && originalDimensions.height > 0
        ? originalDimensions.width / originalDimensions.height
        : 1;

  const record: ImageEditRecord = {
    slot,
    mediaId: media.id,
    file,
    originalFile: media.object_key,
    aspectRatio,
  };
  if (originalDimensions) {
    record.originalWidth = originalDimensions.width;
    record.originalHeight = originalDimensions.height;
  }

  return { ok: true, status: 200, code: '', message: '', record };
}

/**
 * Value-equality for two cover `ImageEditRecord`s (or the absence of one) --
 * used to gate the `cover_asset_key` recompute below on the ONE thing that
 * can actually change it (2026-09-17 owner decision: cover-edit-aware
 * shelf tiles). `slot` is deliberately excluded -- both records are always
 * `COVER_SLOT_KEY` by construction, and comparing it would add nothing.
 * Reference-equal (including both `undefined`, i.e. no cover edit before OR
 * after) short-circuits true without a field-by-field walk -- covers every
 * non-cover edit (text/focalPoint/non-cover imageReplace/delete of a
 * different category), since none of those touch `nextEdits.images.cover`
 * at all, so it's still the SAME object reference as `currentEdits`'s.
 */
function coverRecordsEqual(a: ImageEditRecord | undefined, b: ImageEditRecord | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.file === b.file &&
    a.originalFile === b.originalFile &&
    a.mediaId === b.mediaId &&
    a.aspectRatio === b.aspectRatio &&
    a.originalWidth === b.originalWidth &&
    a.originalHeight === b.originalHeight
  );
}

// ── save_edit ────────────────────────────────────────────────────────────

interface BookRow {
  id: string;
  family_id: string;
  status: string;
  scope_kind: 'age_year' | 'calendar_year' | 'everything' | 'custom_range';
  scope_start_date: string | null;
  scope_end_date: string | null;
  book_document: unknown;
}

async function handleSaveEdit(
  dependencies: MemoryBookEditsDependencies,
  supabase: SupabaseClient,
  book: BookRow,
  callerId: string,
  editInput: unknown,
): Promise<Response> {
  if (!isPlainObject(editInput)) {
    return errorResponse('edit is required', 400, 'validation_error');
  }

  let category: keyof MemoryBookEditsShape;
  let key: string;
  // `null` is the `delete` case's marker -- "remove this key" rather than
  // "write this record" (see `SaveEditInput`'s `delete` variant doc comment).
  let record: TextEditRecord | ImageEditRecord | FocalPointEditRecord | null;

  switch (editInput.kind) {
    case 'text': {
      const validated = validateTextEdit(editInput);
      if ('error' in validated) return errorResponse(validated.error, 400, 'validation_error');
      category = 'text';
      key = validated.record.target;
      record = validated.record;
      break;
    }
    case 'imageReplace': {
      if (!isValidSlot(editInput.slot) || editInput.slot === COVER_SLOT_KEY) {
        return errorResponse('Invalid slot', 400, 'validation_error');
      }
      const resolved = await resolveImageEditRecord(
        dependencies,
        supabase,
        book.family_id,
        editInput.slot,
        editInput.mediaId,
      );
      if (!resolved.ok || !resolved.record) {
        return errorResponse(resolved.message, resolved.status, resolved.code);
      }
      category = 'images';
      key = editInput.slot;
      record = resolved.record;
      break;
    }
    case 'coverPhoto': {
      const resolved = await resolveImageEditRecord(
        dependencies,
        supabase,
        book.family_id,
        COVER_SLOT_KEY,
        editInput.mediaId,
      );
      if (!resolved.ok || !resolved.record) {
        return errorResponse(resolved.message, resolved.status, resolved.code);
      }
      category = 'images';
      key = COVER_SLOT_KEY;
      record = resolved.record;
      break;
    }
    case 'focalPoint': {
      const validated = validateFocalPointEdit(editInput);
      if ('error' in validated) return errorResponse(validated.error, 400, 'validation_error');
      category = 'focalPoints';
      key = validated.record.slot;
      record = validated.record;
      break;
    }
    case 'delete': {
      const validated = validateDeleteEdit(editInput);
      if ('error' in validated) return errorResponse(validated.error, 400, 'validation_error');
      category = validated.category;
      key = validated.key;
      record = null;
      break;
    }
    default:
      return errorResponse('Unknown edit kind', 400, 'validation_error');
  }

  // Read-merge-write against the single row for this book (Decision 4:
  // single-row last-write-wins for v1 -- no per-field merge/CAS). `.upsert`
  // covers both "first edit ever made on this book" (no row yet) and every
  // edit after it in one statement.
  const { data: existingRow, error: readError } = await supabase
    .from('memory_book_edits')
    .select('edits')
    .eq('book_id', book.id)
    .maybeSingle();
  if (readError) {
    console.error('memory-book-edits read failed', readError.message);
    return errorResponse('Failed to load existing edits', 500, 'internal_error');
  }

  const currentEdits = normalizeEdits(existingRow?.edits);
  const nextCategory = { ...currentEdits[category] };
  if (record === null) {
    delete nextCategory[key];
  } else {
    nextCategory[key] = record;
  }
  const nextEdits: MemoryBookEditsShape = { ...currentEdits, [category]: nextCategory };

  const { error: upsertError } = await supabase.from('memory_book_edits').upsert(
    {
      book_id: book.id,
      family_id: book.family_id,
      edits: nextEdits,
      updated_by: callerId,
    },
    { onConflict: 'book_id' },
  );
  if (upsertError) {
    console.error('memory-book-edits save failed', upsertError.message);
    return errorResponse('Failed to save edit', 500, 'internal_error');
  }

  // Shelf cover-edit awareness (2026-09-17 owner decision): recompute
  // `memory_books.cover_asset_key` ONLY when the cover slot itself changed
  // (added, changed, or removed) -- every other edit kind is a guaranteed
  // no-op per `coverRecordsEqual`'s own doc comment, so it never touches
  // `memory_books` at all. `pickCoverAssetKey` applies the SAME width gate
  // to a cover edit as any AI candidate (see `_shared/memory-book-cover.ts`)
  // -- this is not an unconditional override, and removing a cover edit
  // (`nextCoverRecord` undefined) correctly recomputes back to the AI pick.
  // Done SYNCHRONOUSLY, before responding -- not fire-and-forget -- so a
  // client that re-reads the book immediately after this response can never
  // race a stale `cover_asset_key`. A recompute failure must never fail the
  // edit save itself (the edit is already durably saved above); only the
  // book id is logged, never PII/memory content (house rule).
  const previousCoverRecord = currentEdits.images[COVER_SLOT_KEY];
  const nextCoverRecord = nextEdits.images[COVER_SLOT_KEY];
  if (!coverRecordsEqual(previousCoverRecord, nextCoverRecord)) {
    try {
      const coverAssetKey = pickCoverAssetKey(book.book_document, nextCoverRecord);
      const { error: coverUpdateError } = await supabase
        .from('memory_books')
        .update({ cover_asset_key: coverAssetKey })
        .eq('id', book.id);
      if (coverUpdateError) {
        console.error('memory-book-edits cover_asset_key recompute failed', book.id);
      }
    } catch {
      console.error('memory-book-edits cover_asset_key recompute failed', book.id);
    }
  }

  return jsonResponse({ success: true, edits: nextEdits } satisfies SaveEditResponse);
}

// ── picker_pool ──────────────────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 50;
// No memory can ever match a window before/at its own start (a strict
// gte/lt pair) -- same sentinel `workflow-memory-book-bridge` uses so an
// 'everything' family with zero memories yields an empty result via the
// SAME query path, rather than a malformed date reaching Postgres.
const EMPTY_WINDOW_SENTINEL = '0001-01-01';

function addDaysToDateOnly(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const utcMs = Date.UTC(year, month - 1, day) + days * 24 * 60 * 60 * 1000;
  const dt = new Date(utcMs);
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  return `${pad(dt.getUTCFullYear(), 4)}-${pad(dt.getUTCMonth() + 1, 2)}-${pad(dt.getUTCDate(), 2)}`;
}

/** Same scope-window resolution as
 * `workflow-memory-book-bridge/index.ts`'s `handleLoadGenerationContext`
 * (frozen `scope_start_date`/`scope_end_date` for every kind but
 * `everything`, which resolves to the family's live min/max `memory_date`
 * instead) -- the picker's pool must cover exactly the memories the book
 * itself was/would be curated from, not a different window. */
export async function resolveScopeWindow(
  supabase: SupabaseClient,
  book: Pick<BookRow, 'family_id' | 'scope_kind' | 'scope_start_date' | 'scope_end_date'>,
): Promise<{ start: string; endExclusive: string }> {
  if (book.scope_kind === 'everything') {
    const [{ data: earliest }, { data: latest }] = await Promise.all([
      supabase
        .from('memories')
        .select('memory_date')
        .eq('family_id', book.family_id)
        .order('memory_date', { ascending: true })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('memories')
        .select('memory_date')
        .eq('family_id', book.family_id)
        .order('memory_date', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    return {
      start: earliest?.memory_date ?? EMPTY_WINDOW_SENTINEL,
      endExclusive: latest?.memory_date ? addDaysToDateOnly(latest.memory_date, 1) : EMPTY_WINDOW_SENTINEL,
    };
  }
  return {
    start: book.scope_start_date ?? EMPTY_WINDOW_SENTINEL,
    endExclusive: book.scope_end_date
      ? addDaysToDateOnly(book.scope_end_date, 1)
      : EMPTY_WINDOW_SENTINEL,
  };
}

// ── picker_pool filters (item 1, owner-approved editing-UX round) ────────

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Rejects a syntactically-shaped but calendrically bogus date (e.g.
 * `2026-02-30`) -- `Date.UTC` silently rolls those over into the NEXT
 * month, which would otherwise smuggle a slightly-wrong window past the
 * regex alone. */
function isValidDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_ONLY_PATTERN.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const MEMBER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidMemberId(value: unknown): value is string {
  return typeof value === 'string' && MEMBER_ID_PATTERN.test(value);
}

/**
 * Item 1: narrows a resolved scope window by an optional caller-supplied
 * `dateStart`/`dateEnd` pair -- NEVER widens past it. The window itself is
 * already the book's own curation boundary (Decision 5's `picker_pool`
 * scoping); letting a caller-supplied `dateEnd` reach past it would leak
 * photos the book was never scoped to. `dateEnd` is inclusive on input (a
 * calendar day picked in a `<input type="date">`), converted here to the
 * same exclusive-end convention `resolveScopeWindow` itself returns.
 * Exported for direct unit coverage (see this file's "Direct unit coverage
 * of exported helpers" test section) -- the fake-client test harness can't
 * meaningfully assert actual date FILTERING through the filter-blind
 * `memory_media` stub, so this pure intersection logic is tested on its
 * own instead.
 */
export function intersectDateWindow(
  window: { start: string; endExclusive: string },
  dateStart: string | undefined,
  dateEnd: string | undefined,
): { start: string; endExclusive: string } {
  const start = dateStart && dateStart > window.start ? dateStart : window.start;
  const dateEndExclusive = dateEnd ? addDaysToDateOnly(dateEnd, 1) : null;
  const endExclusive =
    dateEndExclusive && dateEndExclusive < window.endExclusive ? dateEndExclusive : window.endExclusive;
  return { start, endExclusive };
}

/** Every `file` referenced by the book's PUBLISHED manifest (assets only --
 * illustrations/portraits are never photo-replace candidates, per Decision
 * 6's eligibility rule, so they're deliberately not collected here). Used
 * only to compute the picker's `alreadyInBook` hint -- never authorization. */
export function collectManifestAssetFiles(bookDocument: unknown): Set<string> {
  const files = new Set<string>();
  if (!isPlainObject(bookDocument)) return files;
  const manifest = bookDocument.manifest;
  if (!isPlainObject(manifest)) return files;
  const memories = manifest.memories;
  if (!isPlainObject(memories)) return files;

  for (const memory of Object.values(memories)) {
    if (!isPlainObject(memory) || !Array.isArray(memory.assets)) continue;
    for (const asset of memory.assets) {
      if (isPlainObject(asset) && typeof asset.file === 'string') {
        files.add(asset.file);
      }
    }
  }
  return files;
}

/** mediaIds already claimed by a saved `imageReplace`/`coverPhoto` edit --
 * these count as "already in book" even before the next render cycle
 * re-publishes a manifest that would otherwise show them. */
function collectImageEditMediaIds(edits: unknown): Set<string> {
  const ids = new Set<string>();
  for (const record of Object.values(normalizeEdits(edits).images)) {
    if (record?.mediaId) ids.add(record.mediaId);
  }
  return ids;
}

function encodeCursor(offset: number): string {
  return btoa(String(offset));
}

/** Opaque offset-based cursor (not a true date-keyset cursor -- see this
 * function's own doc comment on `handlePickerPool` for why). Returns
 * `null` for anything that doesn't decode to a non-negative integer,
 * which the caller treats as a 400, never as "start from zero". */
function decodeCursor(cursor: string): number | null {
  try {
    const decoded = atob(cursor);
    if (!/^\d+$/.test(decoded)) return null;
    const value = Number(decoded);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

interface MediaPoolRow {
  id: string;
  memory_id: string;
  preview_object_key: string | null;
  object_key: string;
  aspect_ratio: number | null;
  content_type: string;
  memories: { memory_date: string } | { memory_date: string }[] | null;
}

function memoryDateOf(row: MediaPoolRow): string {
  const memories = row.memories;
  if (Array.isArray(memories)) return memories[0]?.memory_date ?? '';
  return memories?.memory_date ?? '';
}

/**
 * Paginated, keys-only in-scope photo pool for the image-replace picker
 * (Decision 5). Ordered by `memory_date` ascending (then `memory_media.id`
 * for a stable tiebreak) to satisfy "cursor by date" -- implemented as an
 * OPAQUE OFFSET cursor rather than a true compound keyset cursor: a
 * keyset comparison across a joined table's column
 * (`memories.memory_date`) combined with this table's own `id` isn't
 * expressible through supabase-js's embedded-resource filter builder
 * without a raw SQL view/RPC, which is out of this change's scope. The
 * trade-off is the well-known one for offset pagination (a page boundary
 * can shift if memories are added/removed between calls) -- acceptable
 * here because this is a browse-only UI helper with no correctness
 * dependency on exactly-once delivery (unlike, say, a billing cursor);
 * `everything`-scope boundedness (the actual risk Decision 5 calls out)
 * is still fully enforced by the `limit`/`range` cap regardless of cursor
 * style.
 */
async function handlePickerPool(
  supabase: SupabaseClient,
  book: BookRow,
  cursorInput: unknown,
  limitInput: unknown,
  dateStartInput: unknown,
  dateEndInput: unknown,
  memberIdInput: unknown,
): Promise<Response> {
  const limit =
    typeof limitInput === 'number' && Number.isInteger(limitInput) && limitInput > 0
      ? Math.min(limitInput, MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;

  let offset = 0;
  if (typeof cursorInput === 'string' && cursorInput.length > 0) {
    const decoded = decodeCursor(cursorInput);
    if (decoded === null) {
      return errorResponse('Invalid cursor', 400, 'validation_error');
    }
    offset = decoded;
  }

  let dateStart: string | undefined;
  if (dateStartInput !== undefined && dateStartInput !== null) {
    if (!isValidDateOnly(dateStartInput)) return errorResponse('Invalid dateStart', 400, 'validation_error');
    dateStart = dateStartInput;
  }
  let dateEnd: string | undefined;
  if (dateEndInput !== undefined && dateEndInput !== null) {
    if (!isValidDateOnly(dateEndInput)) return errorResponse('Invalid dateEnd', 400, 'validation_error');
    dateEnd = dateEndInput;
  }
  let memberId: string | undefined;
  if (memberIdInput !== undefined && memberIdInput !== null) {
    if (!isValidMemberId(memberIdInput)) return errorResponse('Invalid memberId', 400, 'validation_error');
    memberId = memberIdInput;
  }

  const scopeWindow = await resolveScopeWindow(supabase, book);
  const window = intersectDateWindow(scopeWindow, dateStart, dateEnd);

  // Item 1: the person filter goes through `memory_family_members` (the
  // memory<->family_member tag join, migration 20260524201500) -- resolve
  // the tagged memory ids FIRST, then narrow the media query by them. A
  // member tagged on zero memories short-circuits to an empty, exhausted
  // page rather than sending an empty `.in()` filter through to
  // PostgREST (some versions treat `in.()` as "no filter" rather than
  // "match nothing" -- not worth relying on either way).
  let memberMemoryIds: string[] | null = null;
  if (memberId) {
    const { data: tagRows, error: tagError } = await supabase
      .from('memory_family_members')
      .select('memory_id')
      .eq('family_member_id', memberId);
    if (tagError) {
      console.error('memory-book-edits picker_pool member-tag lookup failed', tagError.message);
      return errorResponse('Failed to load photo pool', 500, 'internal_error');
    }
    memberMemoryIds = ((tagRows ?? []) as { memory_id: string }[]).map((row) => row.memory_id);
    if (memberMemoryIds.length === 0) {
      return jsonResponse({ items: [], nextCursor: null } satisfies PickerPoolResponse);
    }
  }

  // `.in()` (a FILTER) must be chained before `.order()`/`.range()`
  // (TRANSFORMS) -- supabase-js's builder narrows to a type without filter
  // methods once a transform is applied, so this can't be tacked on after
  // the fact the way it's applied conditionally here.
  let filterQuery = supabase
    .from('memory_media')
    .select(
      'id, memory_id, preview_object_key, object_key, aspect_ratio, content_type, memories!inner(memory_date, family_id)',
    )
    .eq('memories.family_id', book.family_id)
    .gte('memories.memory_date', window.start)
    .lt('memories.memory_date', window.endExclusive)
    .like('content_type', 'image/%');
  if (memberMemoryIds) {
    filterQuery = filterQuery.in('memory_id', memberMemoryIds);
  }
  const { data: rows, error } = await filterQuery
    // Chronological pool (owner-reported live, 2026-09-09): ordering by an
    // embedded column via `referencedTable` orders the EMBEDDED rows within
    // each parent — NOT the top-level `memory_media` list, which came back
    // in effectively random (uuid) order and looked scrambled the moment
    // the picker started showing dates. PostgREST v12's
    // `order=memories(memory_date)` syntax orders the PARENT list by the
    // to-one embed's column (verified against the live project before this
    // change); `id` stays as the deterministic tiebreak for stable
    // offset pagination within a same-date run.
    .order('memories(memory_date)', { ascending: true })
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error('memory-book-edits picker_pool query failed', error.message);
    return errorResponse('Failed to load photo pool', 500, 'internal_error');
  }

  const referencedFiles = collectManifestAssetFiles(book.book_document);

  const { data: editsRow, error: editsError } = await supabase
    .from('memory_book_edits')
    .select('edits')
    .eq('book_id', book.id)
    .maybeSingle();
  if (editsError) {
    console.error('memory-book-edits picker_pool edits lookup failed', editsError.message);
    return errorResponse('Failed to load photo pool', 500, 'internal_error');
  }
  const alreadyEditedMediaIds = collectImageEditMediaIds(editsRow?.edits);

  const typedRows = (rows ?? []) as unknown as MediaPoolRow[];
  const items: PickerPoolItem[] = typedRows.map((row) => {
    const previewKey = row.preview_object_key ?? row.object_key;
    const alreadyInBook =
      alreadyEditedMediaIds.has(row.id) ||
      referencedFiles.has(previewKey) ||
      referencedFiles.has(row.object_key);

    return {
      memoryId: row.memory_id,
      mediaId: row.id,
      previewKey,
      date: memoryDateOf(row),
      aspectRatio: row.aspect_ratio,
      alreadyInBook,
    };
  });

  const nextCursor = items.length === limit ? encodeCursor(offset + limit) : null;

  return jsonResponse({ items, nextCursor } satisfies PickerPoolResponse);
}

// ── Entry point ──────────────────────────────────────────────────────────

export async function handleMemoryBookEdits(
  req: Request,
  dependencyOverrides: Partial<MemoryBookEditsDependencies> = {},
): Promise<Response> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'method_not_allowed');

  const user = await dependencies.getAuthenticatedUser(req);
  if (!user) return errorResponse('Unauthorized', 401, 'unauthorized');

  let body: MemoryBookEditsRequestBody;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }

  if (!isPlainObject(body) || (body.op !== 'save_edit' && body.op !== 'picker_pool')) {
    return errorResponse('op must be "save_edit" or "picker_pool"', 400, 'validation_error');
  }
  if (typeof body.bookId !== 'string' || !body.bookId) {
    return errorResponse('bookId is required', 400, 'validation_error');
  }

  const supabase = dependencies.createServiceClient();
  const { data: book, error: bookError } = await supabase
    .from('memory_books')
    .select('id, family_id, status, scope_kind, scope_start_date, scope_end_date, book_document')
    .eq('id', body.bookId)
    .maybeSingle<BookRow>();
  if (bookError) {
    console.error('memory-book-edits book lookup failed', bookError.message);
    return errorResponse('Failed to load memory book', 500, 'internal_error');
  }
  if (!book) return errorResponse('Memory book not found', 404, 'BOOK_NOT_FOUND');

  const callerRole = await dependencies.getCallerFamilyRole(supabase, book.family_id, user.id);
  if (!isManagerRole(callerRole)) {
    return errorResponse('Not authorized for this memory book', 403, 'forbidden');
  }

  // Both ops require a rendered book: save_edit's image-replace path needs
  // SOMETHING to eventually apply against, and picker_pool's
  // `alreadyInBook` hint needs a manifest to compare against. A book that
  // hasn't finished generating has neither.
  if (book.status !== 'ready') {
    return errorResponse('Memory book is not ready to edit', 409, 'BOOK_NOT_READY');
  }

  if (body.op === 'save_edit') {
    return handleSaveEdit(dependencies, supabase, book, user.id, body.edit);
  }
  return handlePickerPool(supabase, book, body.cursor, body.limit, body.dateStart, body.dateEnd, body.memberId);
}

if (import.meta.main) {
  Deno.serve((request) => handleMemoryBookEdits(request));
}
