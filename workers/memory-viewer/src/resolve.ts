/**
 * Pure routing + token-to-media resolution logic for the QR memory
 * viewer. No I/O here on purpose -- kept separate from src/supabase.ts and
 * src/index.ts so it's unit-testable without Miniflare, R2, or a Supabase
 * mock server.
 */

/**
 * Share-token shape (Round-19, revocable QR links -- see
 * `supabase/scripts/eval-memory-book-assets.ts`'s `generateShareToken`,
 * which currently emits exactly 22 base62 characters). Deliberately looser
 * than an exact 22-char base62 match: this worker doesn't own token
 * generation (the export pipeline does, in a different repo/runtime), so it
 * validates the SHAPE a URL-safe opaque token must have -- no slashes, no
 * query-string leakage, a sane length bound -- rather than hardcoding the
 * exact current alphabet/length, the same "copy the contract loosely, don't
 * couple to the exact implementation" stance this file already takes for
 * content-type allow-lists (see README "Why key conventions are copied, not
 * imported"). Case-sensitive: unlike the old UUID path, a share token is
 * base62 (mixed-case letters carry distinct meaning) -- never lowercase it.
 */
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Extract a share token from a `/m/<token>`, `/media/<token>`, or
 * `/poster/<token>` request
 * path. Rejects anything that isn't exactly `prefix + one path segment`
 * matching `SHARE_TOKEN_PATTERN` (no trailing slash, no extra segments, no
 * query-string leakage -- the caller already stripped that via
 * `new URL(...).pathname`). Returned verbatim, case preserved.
 */
export function parseShareToken(pathname: string, prefix: '/m/' | '/media/' | '/poster/'): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  if (rest.length === 0 || rest.includes('/')) return null;
  return SHARE_TOKEN_PATTERN.test(rest) ? rest : null;
}

/** Row shape from `media_share_tokens` (SELECT memory_id,revoked_at WHERE
 * token = eq.<token>). `null` (no row at all) means the token was never
 * minted -- distinct from a row whose `revoked_at` is set (was minted,
 * since revoked) -- see `classifyShareToken`. */
export interface ShareTokenRow {
  memory_id: string;
  revoked_at: string | null;
}

/**
 * Classifies a `media_share_tokens` lookup into exactly the three outcomes
 * `src/index.ts` needs to pick a response: no row at all (`not_found`,
 * generic 404 -- indistinguishable from a malformed/mistyped link), a row
 * whose `revoked_at` is set (`revoked`, the distinct "link no longer
 * active" page -- the owner deliberately turned this QR page off), or an
 * active row (`active`, carries the `memory_id` to resolve next exactly
 * like the pre-Round-19 flow did).
 */
export type ShareTokenResolution =
  | { status: 'not_found' }
  | { status: 'revoked' }
  | { status: 'active'; memoryId: string };

export function classifyShareToken(row: ShareTokenRow | null): ShareTokenResolution {
  if (!row) return { status: 'not_found' };
  if (row.revoked_at) return { status: 'revoked' };
  return { status: 'active', memoryId: row.memory_id };
}

export type ViewerKind = 'image' | 'video' | 'audio';

/** Row shape from `memories` (SELECT id,memory_type,memory_date,content,emotion). */
export interface MemoryHeaderRow {
  id: string;
  memory_type: string;
  memory_date: string | null;
  /** Optional caption for media/audio memories (schema comment on
   * `memories.content`); null/empty for memories captured without one. */
  content: string | null;
  /** Optional emotion label, used only to match the public viewer's visual
   * treatment to the in-app memory card. */
  emotion: string | null;
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
  emotion: string | null;
  durationMs: number | null;
  /** The persisted JPEG preview/poster key, if capture generated one. The
   * actual viewer may stream a different key (for example a video original),
   * so retain this separately for Open Graph poster resolution. */
  previewObjectKey: string | null;
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

// These are the image formats the public viewer can safely advertise to
// social crawlers when no generated JPEG preview exists. HEIC/HEIF remain
// renderable on some devices, but are deliberately excluded: WhatsApp and
// other Open Graph consumers cannot be relied on to decode them.
const OPEN_GRAPH_IMAGE_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export type ResolvedOpenGraphPoster =
  | {
      kind: 'media';
      objectKey: string;
      contentType: string;
    }
  | {
      kind: 'brand';
      contentType: 'image/jpeg';
    };

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
      emotion: memory.emotion,
      durationMs: asset.duration_ms,
      previewObjectKey: asset.preview_object_key,
    };
  }

  if (VIDEO_CONTENT_TYPES.has(contentType)) {
    return {
      kind: 'video',
      objectKey: asset.object_key,
      contentType: asset.content_type,
      memoryDate: memory.memory_date,
      caption: memory.content,
      emotion: memory.emotion,
      durationMs: asset.duration_ms,
      previewObjectKey: asset.preview_object_key,
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
        emotion: memory.emotion,
        durationMs: null,
        previewObjectKey: asset.preview_object_key,
      };
    }
    return {
      kind: 'image',
      objectKey: asset.object_key,
      contentType: asset.content_type,
      memoryDate: memory.memory_date,
      caption: memory.content,
      emotion: memory.emotion,
      durationMs: null,
      previewObjectKey: asset.preview_object_key,
    };
  }

  return null;
}

/**
 * Resolve the image that may be advertised in Open Graph metadata for the
 * same asset the QR viewer chose. This deliberately does not perform I/O:
 * page rendering must not add an R2 HEAD just to decide whether to emit an
 * `og:image`. If a selected real poster object is later absent from R2,
 * `/poster/:token` serves the neutral brand JPEG instead.
 *
 * Video can only use its capture-generated JPEG poster. For image memories,
 * `resolveViewerMedia` already substituted a JPEG preview when available;
 * otherwise we only advertise an original that common social crawlers can
 * decode. Audio, legacy HEIC/HEIF, and assets with no usable real image get a
 * deterministic Momora brand card. That gives an intentionally shared URL a
 * useful preview without putting a caption, date, member, or any other PII
 * into an external preview cache.
 */
export function resolveOpenGraphPoster(media: ResolvedMedia): ResolvedOpenGraphPoster | null {
  if (media.kind === 'video' && media.previewObjectKey) {
    return {
      kind: 'media',
      objectKey: media.previewObjectKey,
      // `preview_object_key` is the generated JPEG poster/preview contract.
      contentType: 'image/jpeg',
    };
  }

  if (media.kind === 'image' && OPEN_GRAPH_IMAGE_CONTENT_TYPES.has(media.contentType.toLowerCase())) {
    return {
      kind: 'media',
      objectKey: media.objectKey,
      contentType: media.contentType,
    };
  }

  if (media.kind === 'audio' || media.kind === 'video' || media.kind === 'image') {
    return { kind: 'brand', contentType: 'image/jpeg' };
  }

  return null;
}
