/**
 * Pure routing + memory-to-media resolution logic for the QR memory
 * viewer. No I/O here on purpose -- kept separate from src/supabase.ts and
 * src/index.ts so it's unit-testable without Miniflare, R2, or a Supabase
 * mock server.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Extract a memory id from a `/m/<uuid>` or `/media/<uuid>` request path.
 * Rejects anything that isn't exactly `prefix + a v1-5 UUID` (no trailing
 * slash, no extra segments, no query-string leakage -- the caller already
 * stripped that via `new URL(...).pathname`).
 */
export function parseMemoryId(pathname: string, prefix: '/m/' | '/media/'): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  if (rest.length === 0 || rest.includes('/')) return null;
  return UUID_PATTERN.test(rest) ? rest.toLowerCase() : null;
}

export type ViewerKind = 'image' | 'video' | 'audio';

/** Row shape from `memories` (SELECT id,memory_type,memory_date,content). */
export interface MemoryHeaderRow {
  id: string;
  memory_type: string;
  memory_date: string | null;
  /** Optional caption for media/audio memories (schema comment on
   * `memories.content`); null/empty for memories captured without one. */
  content: string | null;
}

/** Row shape from `memory_media`, position 0 (the book QR page's "primary"
 * asset -- see README "Multi-asset memories" for the one-per-memory
 * simplification this worker makes). */
export interface MemoryMediaAssetRow {
  object_key: string;
  content_type: string;
  duration_ms: number | null;
  preview_object_key: string | null;
}

export interface ResolvedMedia {
  kind: ViewerKind;
  /** R2 object key to actually stream -- may be `preview_object_key`
   * rather than the original, see the image branch below. */
  objectKey: string;
  /** Content-Type to serve `objectKey` as -- kept in lockstep with
   * whichever key was chosen (original vs. preview). */
  contentType: string;
  memoryDate: string | null;
  caption: string | null;
  durationMs: number | null;
}

// Mirrors supabase/functions/_shared/storage-keys.ts's
// MEMORY_MEDIA_CONTENT_TYPES allow-list (copied, not imported -- see this
// worker's README "Why key conventions are copied, not imported").
const IMAGE_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
]);
const VIDEO_CONTENT_TYPES = new Set(['video/mp4', 'video/quicktime']);
const AUDIO_CONTENT_TYPES = new Set(['audio/mp4', 'audio/m4a', 'audio/x-m4a']);

/**
 * Resolve a (memories row, first memory_media asset row) pair into what the
 * viewer should render. Returns null whenever this worker should show the
 * friendly 404 instead of a page:
 *
 *  - no memory row (bad/expired/revoked id)
 *  - no media asset row (data integrity issue, or a race with deletion)
 *  - memory_type is `text_illustration` or `text_only` -- those memories
 *    have no QR page in the book pipeline (docs/plans/memory-book.md §7
 *    scopes QR pages to video/audio/photo); resolving one anyway would be
 *    guessing, not resolving.
 *  - an unrecognized media content_type (defense in depth; the DB's CHECK
 *    constraint should already prevent this)
 */
export function resolveViewerMedia(
  memory: MemoryHeaderRow | null,
  asset: MemoryMediaAssetRow | null,
): ResolvedMedia | null {
  if (!memory || !asset) return null;
  if (memory.memory_type !== 'media' && memory.memory_type !== 'audio') return null;

  const contentType = asset.content_type.toLowerCase();

  if (AUDIO_CONTENT_TYPES.has(contentType)) {
    return {
      kind: 'audio',
      objectKey: asset.object_key,
      contentType: asset.content_type,
      memoryDate: memory.memory_date,
      caption: memory.content,
      durationMs: asset.duration_ms,
    };
  }

  if (VIDEO_CONTENT_TYPES.has(contentType)) {
    return {
      kind: 'video',
      objectKey: asset.object_key,
      contentType: asset.content_type,
      memoryDate: memory.memory_date,
      caption: memory.content,
      durationMs: asset.duration_ms,
    };
  }

  if (IMAGE_CONTENT_TYPES.has(contentType)) {
    // Prefer the already-generated JPEG preview when present: it's
    // guaranteed browser-renderable (<=1280px longest edge JPEG -- see
    // memory_media.preview_object_key's schema comment), where the
    // original can be a HEIC/HEIF straight off an iPhone that most
    // non-Apple/non-Safari browsers can't decode inline. See README
    // "What's stubbed" for the residual case (no preview row -- legacy
    // asset, or preview generation failed at capture time, fail-open per
    // that column's existing convention).
    if (asset.preview_object_key) {
      return {
        kind: 'image',
        objectKey: asset.preview_object_key,
        contentType: 'image/jpeg',
        memoryDate: memory.memory_date,
        caption: memory.content,
        durationMs: null,
      };
    }
    return {
      kind: 'image',
      objectKey: asset.object_key,
      contentType: asset.content_type,
      memoryDate: memory.memory_date,
      caption: memory.content,
      durationMs: null,
    };
  }

  return null;
}
