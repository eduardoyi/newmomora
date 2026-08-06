// Edge Function: compose-share-card (plan: docs/plans/offline-awareness-and-share-cards.md,
// Workstream S, step S3). Composes a shareable PNG memory card server-side
// (satori SVG layout + @resvg/resvg-wasm PNG raster -- see render.ts) and
// streams it back. Never writes to R2 -- this function is intentionally kept
// out of the storage-authorization/deletion machinery.
//
// AGENTS.md logging-discipline rule (Child & family PII / high-risk areas):
// never log memory content. The raw caption flows through satori, whose
// internal layout errors can embed text-node content in `error.message` --
// every catch block in this file that could observe such an error logs
// `memoryId` + a status/code ONLY, never `error.message`, on any path that
// touches layout/render. DB-layer errors (Supabase client errors) are safe
// to log by message since they never contain memory content.
import { Image as RasterImage } from 'https://deno.land/x/imagescript@1.3.0/mod.ts';
// Type-only import -- erased at runtime (no module-graph/boot cost), so the
// JS module itself is never pulled in unless loadWebpModule's dynamic
// import() below actually runs. See that function for the runtime load.
import type { init as initWebpDecoderType, default as decodeWebpType } from 'npm:@jsquash/webp@1.4.0/decode.js';
type InitWebpDecoderFn = typeof initWebpDecoderType;
type DecodeWebpFn = typeof decodeWebpType;

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { getAuthenticatedNonAnonymousUser } from '../_shared/auth.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { errorResponse } from '../_shared/errors.ts';
import type { FamilyRole } from '../_shared/family-access.ts';
import { capImageMaxEdge, capImageMaxEdgeAsJpeg, computeResizedDimensions } from '../_shared/image-bytes.ts';
import { REFERENCE_IMAGE_JPEG_QUALITY } from '../_shared/image-limits.ts';
import { encodeBytesToBase64 } from '../_shared/openai.ts';
import { deleteObject, getObjectBytes, getObjectBytesBatch, putObjectBytes, type ObjectBytesBatchEntry } from '../_shared/r2.ts';
import { buildShareCardKey } from '../_shared/storage-keys.ts';
import { createServiceClient, createUserClient } from '../_shared/supabase-admin.ts';
import {
  buildTwemojiObjectKey,
  extractDistinctEmojiGraphemes,
  MAX_EMOJI_GRAPHEME_MEMO_ENTRIES,
  resolveGraphemeImages,
} from './emoji.ts';
import { composeShareCardPng as composeShareCardPngImpl } from './render.ts';
import { formatShareCardDateLabel, MAX_VISIBLE_MEMBERS, type ShareCardData, type ShareCardMemberPortrait } from './layout.ts';
import { loadShareCardAssets as loadShareCardAssetsImpl, ShareCardAssetsUnavailableError } from './assets-loader.ts';
// NOTE: @jsquash/webp (npm module, JS glue code) is intentionally NOT
// statically imported here -- see the "Real-WebP decode" section below
// (loadWebpModule) for why: a static import puts the module in EVERY
// isolate's boot-time module graph eval regardless of whether a given
// compose ever touches a real webp source. Dynamic `import()` inside
// loadWebpModule defers module resolution until a request actually sniffs
// webp bytes. (The wasm BYTES it compiles come from assets-loader.ts, R2,
// not from a module -- see this file's header comment.)

// ── Instrumentation (perf-audit fix, this package's implementation report) ─
// Server-Timing header + a single structured per-request log line, added to
// measure where the WORKER_RESOURCE_LIMIT (546) budget actually goes.
// Every field logged below is an id or a number (memoryId, ms timings, byte
// counts, a scale label) -- NEVER memory content (AGENTS.md logging
// discipline; same rule this file already enforces on its error paths).
//
// ROUND 4 (this package's implementation report): a control experiment (a
// trivial hello-world function on the SAME project, hammered the same way:
// 15/15 success -- proving the platform itself was healthy) isolated the
// cause of ~48% bodyless 546 failures (bodyless: no Server-Timing header at
// all -- proof they died before this handler ever ran) as this function's
// own ~7.5MB eszip bundle: ~4.8MB of base64 asset text V8 had to PARSE as
// part of this module's own graph evaluation on every cold boot (S0: no
// warm isolate ever observed). Fixed by evicting every binary asset from
// the module graph entirely -- they're now fetched from R2 at request time
// (assets-loader.ts) instead of base64-embedded in this module or
// render.ts. This module now imports NO binary asset, static or dynamic;
// MODULE_EVAL_TIME below should be capturing a near-trivial module-eval
// cost, not megabytes of string-literal parsing.
const MODULE_EVAL_TIME = performance.now();

export interface ComposeShareCardRequest {
  memoryId: string;
  mediaAssetId?: string;
  /** Store-through cache warm mode (docs/plans/share-card-store-through.md,
   * W2): composes (if needed) + stores, responds 204 with no body, never
   * streams. Same auth/role/validation as a normal share -- see
   * handleComposeShareCard's rate-limit and cache-check sections for how
   * `warm` branches off. */
  warm?: boolean;
}

interface MemoryMediaRow {
  id: string;
  memory_id: string;
  object_key: string;
  preview_object_key: string | null;
  content_type: string;
  aspect_ratio: number | null;
  /** Store-through cache (W2): the per-ASSET stored card key, or null if
   * this asset has never been shared successfully (or was invalidated --
   * see the migration's staleness notes). */
  share_card_key: string | null;
}

interface FamilyMemberRow {
  id: string;
  name: string;
  illustrated_profile_key: string | null;
  illustrated_profile_status: string;
  profile_picture_key: string | null;
}

// ── Single nested query (perf-audit round 3, this package's implementation
// report) ────────────────────────────────────────────────────────────────
// Round 2's Server-Timing measurement overturned round 1's boot-overhead
// hypothesis: successful requests showed `fetch` at ~850-1010ms of which
// the (already-batched, round 2) image fetch was only ~250ms -- the
// remainder (~600-750ms) was DB/auth round trips surviving as ~6 sequential
// hops (edge->Stockholm ~100ms each): the memory row select, then
// authorizeShareCardAccess's OWN two-to-three sequential queries
// (getCallerFamilyRoles does `families` THEN `family_memberships`,
// sequentially -- not parallel with each other, only the round-2 fix
// parallelized authorizeShareCardAccess AS A WHOLE against
// resolveShareCardSource; the sequential chain INSIDE
// authorizeShareCardAccess was invisible to that fix -- plus a THIRD query
// for a viewer's `viewer_sharing_enabled` check), resolveShareCardSource's
// `memory_media` select, and fetchTaggedMembers' `memory_family_members`
// select.
//
// Fixed by folding every one of those reads into ONE PostgREST nested
// select on `memories`, run with the USER-scoped client so existing RLS
// policies (`is_family_member(family_id)` on every table below) enforce
// membership implicitly -- a returned row already proves the caller is a
// family member, exactly as the pre-restructure code's own comment noted
// ("RLS scopes this query to the caller's families"). Verified against the
// REAL schema+RLS with a real user session (this package's implementation
// report) before wiring in: single round trip, ~150-200ms, all four nested
// relations (`families`+`family_memberships`, `memory_media`,
// `memory_family_members`+`family_members`) came back correctly shaped.
//
// `memory_media` and `memory_family_members` are fetched WITHOUT a
// row-level filter (no `!inner` + dot-path filter on the embedded
// resource) -- deliberately: `mediaAssetId` is only present for `media`
// memories, and an inner-join filter would incorrectly exclude
// text_only/text_illustration memories (which have zero memory_media
// rows) from matching at all. Instead every row for the memory is fetched
// (typically a handful of small metadata rows -- ids/keys, not bytes) and
// the specific asset / tagged-member list is picked out in JS afterward,
// mirroring how fetchTaggedMembers already worked pre-restructure.
// `user_id` (W2, store-through cache): the memory's CREATOR, selected so a
// stored card's key can be built under the creator's prefix regardless of
// which family member actually triggers the compose -- see
// resolveShareCardCacheTarget/buildShareCardKey below and the storage
// migration's own key-prefix rationale. Never logged (an id, but keeping
// the same discipline as every other identifier in this file).
// `share_card_key` (both top-level, for text/illustrated memories, and on
// the embedded `memory_media` rows, for per-asset media cards) is the
// stored-cache column pair added by
// 20260805130000_share_card_storage_columns.sql -- see that migration and
// resolveShareCardCacheTarget for how the two map to a single card slot.
export const SHARE_CARD_MEMORY_SELECT = `
  id, family_id, user_id, content, memory_type, memory_date, illustration_key, illustration_status, emotion, share_card_key,
  families ( id, viewer_sharing_enabled, family_memberships ( user_id, role ) ),
  memory_media ( id, memory_id, object_key, preview_object_key, content_type, aspect_ratio, share_card_key ),
  memory_family_members ( family_member_id, family_members ( id, name, illustrated_profile_key, illustrated_profile_status, profile_picture_key ) )
`;

export interface ShareCardMemoryQueryRow {
  id: string;
  family_id: string;
  // Store-through cache (W2): the memory's creator. Nullable in the schema
  // (src/types/database.ts), though every real row is expected to have one
  // -- resolveOwnerUserIdForCache below fails closed (skips caching, still
  // streams) on the defensive null case rather than assume it's always
  // present.
  user_id: string | null;
  content: string | null;
  memory_type: string;
  memory_date: string;
  illustration_key: string | null;
  illustration_status: string;
  // Store-through cache (W2): the per-MEMORY stored card key (text_only /
  // text_illustration cards). See resolveShareCardCacheTarget.
  share_card_key: string | null;
  /** Only used by the quote (text_only) card's accent strip + quote-glyph
   * color (see layout.ts's shareCardEmotionColors) -- never logged
   * (AGENTS.md logging discipline; enum-like label, fine to select/hold in
   * memory, just not to console.*). */
  emotion: string | null;
  // Single object (many-to-one from `memories`), null only if the FK is
  // somehow dangling (never expected in practice -- `families` rows are
  // never hard-deleted while memories reference them).
  families: {
    id: string;
    // `viewer_sharing_enabled` ships in S1's migration
    // (docs/plans/offline-awareness-and-share-cards.md S1). Selecting the
    // column directly (no defensive fallback) is intentional -- see the
    // ORIGINAL FamilyRow interface's note (this package's implementation
    // report, round 1): a fallback that treats a missing column as
    // "sharing enabled" would silently reopen the toggle. Do not add one.
    viewer_sharing_enabled: boolean;
    family_memberships: Array<{ user_id: string; role: string }>;
  } | null;
  memory_media: MemoryMediaRow[];
  memory_family_members: Array<{ family_member_id: string; family_members: FamilyMemberRow | null }>;
}

// ── Rate limiting (repo convention: analyze-emotion's per-caller cooldown,
// see supabase/functions/analyze-emotion/index.ts) ─────────────────────────
// Per-user sliding window rather than analyze-emotion's per-memory cooldown:
// compose-share-card is the most CPU-expensive user-triggered endpoint in
// the project (satori layout + resvg-wasm raster), so the limit must bound
// total compose attempts per caller, not just repeats on one memory.
// In-memory / per-isolate, same tradeoff as analyze-emotion's Map (no
// cross-isolate coordination) -- acceptable for a "don't hammer this" guard,
// not a hard billing limit.
export const SHARE_CARD_RATE_LIMIT_WINDOW_MS = 60_000;
// Bumped 10 -> 20 (four-part production fix, docs/plans/
// share-card-store-through.md): a fresh production probe found cold
// composes succeed only ~45-55% per attempt (stochastic
// WORKER_RESOURCE_LIMIT policing -- see this file's own header comment),
// and the client burns 2 attempts per tap (composeShareCard's single
// 546-retry, src/services/share-card.ts) -- at 10/min a user tapping share
// a handful of times in frustration could exhaust the whole window and see
// nothing but 429s, which is indistinguishable from "retry never works" in
// the UI. 20/min gives real headroom for that burn rate while still
// bounding the most CPU-expensive user-triggered endpoint in the project.
export const SHARE_CARD_RATE_LIMIT_MAX_PER_WINDOW = 20;

// ── Warm-mode rate limit (W2) ────────────────────────────────────────────
// A SEPARATE, looser bucket from the cold (streaming-share) limit above --
// warms are system-initiated (client fires them after memory create/edit
// and after the media queue posts, W3), not a human repeatedly tapping
// share, so they legitimately happen more often per user. Still real limits
// (not exempt): a runaway client bug firing warms in a loop must not be able
// to hammer this function unbounded. Kept as its own Map (not a shared one
// keyed by a "kind" string) so a burst of warms can never eat into a user's
// cold-path budget or vice versa.
export const SHARE_CARD_WARM_RATE_LIMIT_WINDOW_MS = 60_000;
export const SHARE_CARD_WARM_RATE_LIMIT_MAX_PER_WINDOW = 30;

const recentComposesByUser = new Map<string, number[]>();
const recentWarmsByUser = new Map<string, number[]>();

function isRateLimitedInStore(
  store: Map<string, number[]>,
  userId: string,
  now: number,
  windowMs: number,
  maxPerWindow: number,
): boolean {
  const timestamps = (store.get(userId) ?? []).filter((t) => now - t < windowMs);
  store.set(userId, timestamps);
  return timestamps.length >= maxPerWindow;
}

function markRunInStore(store: Map<string, number[]>, userId: string, now: number): void {
  const timestamps = store.get(userId) ?? [];
  timestamps.push(now);
  store.set(userId, timestamps);
}

export function isComposeRateLimited(
  userId: string,
  now = Date.now(),
  windowMs = SHARE_CARD_RATE_LIMIT_WINDOW_MS,
  maxPerWindow = SHARE_CARD_RATE_LIMIT_MAX_PER_WINDOW,
): boolean {
  return isRateLimitedInStore(recentComposesByUser, userId, now, windowMs, maxPerWindow);
}

export function markComposeRun(userId: string, now = Date.now()): void {
  markRunInStore(recentComposesByUser, userId, now);
}

export function isWarmRateLimited(
  userId: string,
  now = Date.now(),
  windowMs = SHARE_CARD_WARM_RATE_LIMIT_WINDOW_MS,
  maxPerWindow = SHARE_CARD_WARM_RATE_LIMIT_MAX_PER_WINDOW,
): boolean {
  return isRateLimitedInStore(recentWarmsByUser, userId, now, windowMs, maxPerWindow);
}

export function markWarmRun(userId: string, now = Date.now()): void {
  markRunInStore(recentWarmsByUser, userId, now);
}

// Exposed for tests only (avoids cross-test rate-limit bleed).
export function _resetRateLimitStateForTests(): void {
  recentComposesByUser.clear();
  recentWarmsByUser.clear();
}

// ── Filename ─────────────────────────────────────────────────────────────
const MONTH_ABBREVIATIONS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];

/** `momora-<mon>-<d>-<yyyy>.png`, e.g. `momora-jun-8-2026.png` (plan's
 * locked filename format). Parses as local midnight, matching
 * src/utils/memories.ts formatDisplayDate's `${date}T00:00:00` convention so
 * a YYYY-MM-DD memory_date never shifts a day across timezones. */
export function buildShareCardFilename(memoryDateIso: string): string {
  const parsed = new Date(`${memoryDateIso}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return 'momora-memory.png';
  }
  const month = MONTH_ABBREVIATIONS[parsed.getMonth()];
  return `momora-${month}-${parsed.getDate()}-${parsed.getFullYear()}.png`;
}

// ── Image MIME resolution ───────────────────────────────────────────────
// R2 object keys always carry a real file extension (see
// _shared/storage-keys.ts's build*Key functions), and family_members has no
// stored content_type for profile_picture_key/illustrated_profile_key, so
// the extension is the only reliable signal for those. Used uniformly for
// media/illustration/portrait keys for consistency.
const EXTENSION_MIME_MAP: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
};

export function mimeTypeFromObjectKey(objectKey: string): string {
  const ext = objectKey.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_MIME_MAP[ext] ?? 'image/jpeg';
}

// ── Real-bytes MIME sniffing (production-incident fix) ─────────────────
// Root cause of the "every share on a photo memory fails" incident (see
// this package's implementation report): generate-portrait-illustration
// requests `output_format: 'webp'` from OpenAI's image-edits endpoint and
// uploads the result under a `.webp`-suffixed R2 key, but OpenAI has been
// observed to silently return PNG (or JPEG, for profile_picture_key) bytes
// anyway -- verified against production data: 9/9 family members'
// illustrated_profile_key portraits are real PNG bytes under `.webp` keys.
// mimeTypeFromObjectKey derives the data-URI mime type from the KEY
// EXTENSION alone, so toDataUri was declaring `image/webp` for a data URI
// that actually contained PNG bytes. satori validates an `<img>` data URI's
// bytes against its declared mime type for WebP specifically and throws
// ("Invalid WebP") on the mismatch -- crashing the ENTIRE compose (500
// compose_failed) for ANY memory that tags a member with a mismatched
// portrait, regardless of memory type (text-only and illustrated memories
// call resolveMemberPortraits too, not just media memories).
//
// Fix: sniff the REAL format from the fetched bytes' magic-byte signature
// and trust that over the extension. Only PNG/JPEG/WEBP are sniffed (the
// three formats resvg-wasm can rasterize per this file's header comment);
// anything unrecognized (e.g. HEIC) falls back to the extension-derived
// mime type so isUnrasterizableMimeType's HEIC rejection still works.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

function bytesStartWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) {
    return false;
  }
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) {
      return false;
    }
  }
  return true;
}

/** RIFF....WEBP container signature. */
function isWebpSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 12) {
    return false;
  }
  return (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  );
}

/**
 * Resolves the real MIME type of `bytes` from their magic-byte signature,
 * falling back to the object key's extension when the signature isn't one
 * of the three sniffed formats. This is the authoritative resolver for any
 * data URI this function builds from fetched bytes -- see the header
 * comment above for why trusting the extension alone caused a production
 * incident.
 */
export function resolveImageMimeType(objectKey: string, bytes: Uint8Array): string {
  if (bytesStartWith(bytes, PNG_SIGNATURE)) {
    return 'image/png';
  }
  if (bytesStartWith(bytes, JPEG_SIGNATURE)) {
    return 'image/jpeg';
  }
  if (isWebpSignature(bytes)) {
    return 'image/webp';
  }
  return mimeTypeFromObjectKey(objectKey);
}

/** resvg-wasm@2.6.2 was verified (manual spike, see plan report) to decode
 * PNG/JPEG/WEBP data URIs, but HEIC/HEIF are not supported by the `image`
 * crate it's built on. HEIC can only reach this function via a legacy media
 * row's `object_key` fallback (preview_object_key, when present, is always
 * JPEG -- see supabase/scripts/backfill-media-previews.ts) -- narrow enough
 * to reject cleanly rather than silently emit a broken PNG. */
export function isUnrasterizableMimeType(mimeType: string): boolean {
  return mimeType === 'image/heic' || mimeType === 'image/heif';
}

// ── Aspect ratio math ───────────────────────────────────────────────────
// Keep in sync with src/utils/media-aspect.ts (Deno Edge Functions cannot
// import from src/). The client has ONE clamp used for both real media
// photos AND illustrations (media-aspect.ts's own header comment:
// "illustration-only cards still use the clamp helpers so extreme generated
// images do not take over the feed") -- these names/bounds mirror that.
export const DEFAULT_MEDIA_ASPECT_RATIO = 4 / 3;
export const MIN_MEDIA_ASPECT_RATIO = 3 / 4;
export const MAX_MEDIA_ASPECT_RATIO = 16 / 9;

/**
 * Clamps to [3/4, 16/9], matching src/utils/media-aspect.ts's
 * `clampMediaAspectRatio`.
 *
 * BUG FIX (device report -- carousel/media share cards render with a photo
 * far taller or shorter than the in-app card, and the resulting oversized
 * canvas is believed to be a contributor to WORKER_RESOURCE_LIMIT compose
 * failures): this clamp used to be named/scoped to "illustration" only and
 * was applied ONLY on the text_illustration branch below -- a 'media'
 * memory's `imageAspectRatio` was NEVER clamped, unlike every in-app
 * surface (MediaVisual/MemoryMediaCarousel always clamp via
 * `clampMediaAspectRatio`). `memory_media.aspect_ratio` only has a wide DB
 * CHECK constraint (`between 0.1 and 10`,
 * 20260713150000_media_aspect_ratios.sql) -- NOT the app's display clamp --
 * so the raw stored value can be far outside what the app ever shows.
 * Verified against production data: ~22% of real image assets (152/690)
 * store an aspect_ratio outside [3/4, 16/9]. An unclamped extreme ratio
 * inflates the card's image-block height (`imageBlockNode`, layout.ts) well
 * beyond the in-app card, both looking wrong AND pushing the rendered
 * canvas closer to the S0 spike's measured pixel ceiling. Applied to BOTH
 * branches now.
 */
export function clampMediaAspectRatio(ratio: number): number {
  return Math.min(MAX_MEDIA_ASPECT_RATIO, Math.max(MIN_MEDIA_ASPECT_RATIO, ratio));
}

/** Legacy-row fallback for a null/zero `aspect_ratio` column: decode
 * intrinsic dimensions from the fetched bytes via `npm:image-size`
 * (pure-JS, Deno-compatible, no hand-rolled header parsing -- verified
 * against PNG/JPEG/WEBP fixtures during implementation). Returns null if
 * the bytes can't be sniffed (caller falls back to DEFAULT_MEDIA_ASPECT_RATIO). */
export async function aspectRatioFromImageBytes(bytes: Uint8Array): Promise<number | null> {
  try {
    const { imageSize } = await import('npm:image-size@1.1.1');
    const { width, height } = imageSize(bytes);
    if (!width || !height) {
      return null;
    }
    return width / height;
  } catch {
    return null;
  }
}

// ── Memory-type / media validation ─────────────────────────────────────
const SHAREABLE_MEMORY_TYPES = new Set(['text_only', 'text_illustration', 'media']);

/** `audio` (specced, unshipped -- docs/features/audio-memories.md) and any
 * other unrecognized value are rejected explicitly, per S3 spec. */
export function isRejectedMemoryType(memoryType: string): boolean {
  return !SHAREABLE_MEMORY_TYPES.has(memoryType);
}

const VIDEO_CONTENT_TYPES = new Set(['video/mp4', 'video/quicktime']);
export function isVideoContentType(contentType: string): boolean {
  return VIDEO_CONTENT_TYPES.has(contentType);
}

export interface ShareCardValidationError {
  status: number;
  message: string;
  code: string;
}

export type ResolvedShareCardSource =
  | { kind: 'text' }
  | { kind: 'media'; objectKey: string; storedAspectRatio: number | null }
  | { kind: 'illustration'; objectKey: string };

/**
 * Resolves which image (if any) the card should embed, and validates the
 * request: memory-type rejection, media-asset ownership, video rejection,
 * illustration readiness. Round-3 rewrite of the original
 * `resolveShareCardSource` -- same exact validation logic, but reads the
 * candidate media asset from the single nested query's `row.memory_media`
 * array (already fetched) instead of issuing its own `memory_media` select.
 */
export function resolveShareCardSourceFromQueryRow(
  row: ShareCardMemoryQueryRow,
  mediaAssetId: string | undefined,
): { ok: true; source: ResolvedShareCardSource } | { ok: false; error: ShareCardValidationError } {
  if (isRejectedMemoryType(row.memory_type)) {
    return {
      ok: false,
      error: {
        status: 400,
        message: row.memory_type === 'audio'
          ? 'Audio memories cannot be shared yet'
          : 'Unsupported memory type for sharing',
        code: 'unsupported_memory_type',
      },
    };
  }

  if (row.memory_type === 'text_only') {
    return { ok: true, source: { kind: 'text' } };
  }

  if (row.memory_type === 'text_illustration') {
    // BUG FIX (production data profiling, this package's implementation
    // report -- the "47 deterministic 546s" investigation's tail finding):
    // 5 real text_illustration memories have illustration_status
    // 'pending'/'generating'/'failed' and a null illustration_key, and
    // previously 400'd here (`illustration_not_ready`) -- making the
    // memory permanently unshareable until (if ever) a generation
    // succeeds. That contradicts this app's "text always saved" ethos
    // (AGENTS.md/PRD): the memory's CONTENT was saved successfully;
    // illustration generation is a separate, best-effort async step (see
    // src/services/memories.ts's runMemoryIllustrationPipeline) that can
    // legitimately fail/stay pending forever without the memory itself
    // being broken. Fix: `illustration_key` presence is the ONLY signal
    // that matters here (mirrors resolveMemberPortraitKey's existing
    // "degrade gracefully while an image is in flight" pattern, same
    // file) -- a null key falls back to the QUOTE-variant card (the
    // caller derives `cardData.variant` from `source.kind`, not
    // `memory_type`, specifically so this degrade renders as an
    // intentional quote card, not a broken spread-with-no-image) instead
    // of erroring. `illustration_status` is no longer consulted at all:
    // if a key IS present (even mid-regeneration, where a prior
    // successful key can still be live), it's used.
    if (!row.illustration_key) {
      return { ok: true, source: { kind: 'text' } };
    }
    return { ok: true, source: { kind: 'illustration', objectKey: row.illustration_key } };
  }

  // memory_type === 'media'
  if (!mediaAssetId) {
    return {
      ok: false,
      error: { status: 400, message: 'mediaAssetId is required for media memories', code: 'validation_error' },
    };
  }

  // No server-side filter on the embedded select (see SHARE_CARD_MEMORY_SELECT's
  // header comment for why) -- pick the exact requested asset out of the
  // memory's full (small) media list here, same ownership guarantee as the
  // old `.eq('id', mediaAssetId).eq('memory_id', memory.id)` query since
  // every row in this array already belongs to this memory by construction
  // of the nested select.
  const asset = row.memory_media.find((m) => m.id === mediaAssetId);

  if (!asset) {
    return {
      ok: false,
      error: { status: 404, message: 'Media asset not found for this memory', code: 'asset_not_found' },
    };
  }

  if (isVideoContentType(asset.content_type)) {
    return {
      ok: false,
      error: { status: 400, message: 'Video memories cannot be shared', code: 'video_not_supported' },
    };
  }

  const objectKey = asset.preview_object_key ?? asset.object_key;
  // Only the legacy object_key fallback can carry a non-preview content
  // type; the preview variant is always JPEG (backfill-media-previews.ts).
  const usingPreview = Boolean(asset.preview_object_key);
  const mimeType = usingPreview ? 'image/jpeg' : mimeTypeFromObjectKey(objectKey);

  if (isUnrasterizableMimeType(mimeType)) {
    return {
      ok: false,
      error: { status: 415, message: 'Image format is not supported for sharing', code: 'unsupported_image_format' },
    };
  }

  return {
    ok: true,
    source: { kind: 'media', objectKey, storedAspectRatio: asset.aspect_ratio },
  };
}

// ── Authorization (role + viewer-sharing-toggle) ───────────────────────
// Round-3 rewrite: the original authorizeShareCardAccess made its own
// getCallerFamilyRole call (itself TWO sequential queries -- `families`
// then `family_memberships`, see _shared/family-access.ts) plus a THIRD
// query for a viewer's `viewer_sharing_enabled` -- all now already fetched
// by the single nested query. `resolveCallerRoleFromQueryRow` is exported
// separately from the check itself so a caller that only needs the role
// (none currently, but mirrors the old code's shape) doesn't have to thread
// a full authz-error type through.
export function resolveCallerRoleFromQueryRow(row: ShareCardMemoryQueryRow, callerId: string): FamilyRole | null {
  const membership = row.families?.family_memberships.find((m) => m.user_id === callerId);
  return (membership?.role as FamilyRole | undefined) ?? null;
}

export function authorizeShareCardAccessFromQueryRow(
  row: ShareCardMemoryQueryRow,
  callerId: string,
): { ok: true; role: FamilyRole } | { ok: false; error: ShareCardValidationError } {
  const role = resolveCallerRoleFromQueryRow(row, callerId);
  if (!role) {
    // Defensive-only in the real handler path: RLS's `is_family_member()`
    // check backs BOTH the `memories` SELECT policy (what gated whether
    // this row was returned at all) and `family_memberships`' own SELECT
    // policy the embedded relation reads from, so a row reaching this
    // point implies membership already. Kept as a safety net (and because
    // it's directly unit-testable with a synthetic row) rather than
    // asserted away.
    return { ok: false, error: { status: 403, message: 'Not authorized for this memory', code: 'forbidden' } };
  }

  if (role === 'viewer' && row.families?.viewer_sharing_enabled === false) {
    return {
      ok: false,
      error: { status: 403, message: 'Sharing is currently off for this family', code: 'sharing_disabled' },
    };
  }

  return { ok: true, role };
}

// ── Tagged-member portraits ─────────────────────────────────────────────
// Duplicates the "current portrait" branch of getMemberAvatarImageKey
// (src/utils/family-members.ts) -- simplified per S3 spec ("resolve via the
// same member portrait logic the card uses, simplified: current portrait
// only", i.e. no in-progress-generation photo-vs-illustration nuance beyond
// this). Deno Edge Functions cannot import from src/.
function isPortraitInProgress(status: string): boolean {
  return status === 'pending' || status === 'generating';
}

export function resolveMemberPortraitKey(member: FamilyMemberRow): string | null {
  if (isPortraitInProgress(member.illustrated_profile_status)) {
    return member.profile_picture_key;
  }
  return member.illustrated_profile_key ?? member.profile_picture_key;
}

export interface TaggedMembersResult {
  members: FamilyMemberRow[];
  overflowCount: number;
}

/**
 * Round-3 rewrite of the original fetchTaggedMembers -- same dedupe/cap
 * logic, but reads `row.memory_family_members` (already fetched by the
 * single nested query) instead of issuing its own
 * `memory_family_members` select. Pure/sync now: no DB call, no I/O.
 */
export function resolveTaggedMembersFromQueryRow(row: ShareCardMemoryQueryRow): TaggedMembersResult {
  const rows = row.memory_family_members
    .map((r) => r.family_members)
    .filter((member): member is FamilyMemberRow => Boolean(member));

  return {
    members: rows.slice(0, MAX_VISIBLE_MEMBERS),
    overflowCount: Math.max(0, rows.length - MAX_VISIBLE_MEMBERS),
  };
}

// ── Real-WebP decode (production-incident fix, bug 3) ──────────────────
// resvg-wasm@2.6.2's bundled `image` crate cannot decode real (i.e. NOT
// mislabeled -- see resolveImageMimeType above) WebP bytes: a genuine
// illustration_key's webp silently rasters as a BLANK image block -- no
// exception anywhere in the pipeline, satori embeds the <image> node with a
// correct href just fine, resvg just renders nothing for it. Verified
// against production data: 19/20 sampled illustration_key files are
// genuine webp (unlike portraits -- see the MIME-sniffing comment above,
// OpenAI IS honoring `output_format: 'webp'` for illustrations), so this
// silently broke nearly every illustrated memory's share card ("blank space
// where the illustration belongs" device report).
//
// Fix: decode real webp via @jsquash/webp (a pure-wasm codec verified
// against this exact production image where both resvg-wasm and
// imagescript's own decoder failed) and re-encode to JPEG via imagescript
// (already vendored/proven here for capImageMaxEdge) before embedding.
// @jsquash/webp's decode() normally fetches its own .wasm file at runtime
// via `new URL(..., import.meta.url)` -- the exact channel the S0 spike
// proved dead under `--use-api` deploys. Its `init(module)` accepts a
// PRE-COMPILED WebAssembly.Module instead, bypassing that fetch.
//
// ROUND 4: the wasm BYTES now arrive as a parameter (`webpDecWasmBytes`,
// R2-fetched by assets-loader.ts alongside every other asset -- see this
// file's header comment) instead of a per-request dynamic import of a
// base64 module. The npm MODULE import (`@jsquash/webp`'s JS glue code)
// stays a lazy dynamic `import()` here -- that part of round 1's "lazy
// webp" fix is still worth keeping: a compose whose sniffed source is NOT
// webp never resolves that module or pays the wasm COMPILE, regardless of
// whether the bytes themselves were fetched unconditionally as part of the
// round-4 asset batch (a small, already-parallelized network cost) or not.
// Memoized per isolate -- once a request DOES need it, subsequent webp
// sources in the same isolate reuse the already-compiled instance.
let webpModulePromise: Promise<{ decode: DecodeWebpFn }> | null = null;

function loadWebpModule(webpDecWasmBytes: Uint8Array): Promise<{ decode: DecodeWebpFn }> {
  if (!webpModulePromise) {
    webpModulePromise = (async () => {
      const { init, default: decode } = await import('npm:@jsquash/webp@1.4.0/decode.js') as {
        init: InitWebpDecoderFn;
        default: DecodeWebpFn;
      };
      const module = await WebAssembly.compile(webpDecWasmBytes.buffer as ArrayBuffer);
      await init(module);
      return { decode };
    })().catch((error) => {
      webpModulePromise = null;
      throw error;
    });
  }
  return webpModulePromise;
}

/** Exposed for tests only -- avoids cross-test memoization bleed. */
export function _resetWebpModuleForTests(): void {
  webpModulePromise = null;
}

// ── Emoji grapheme images (emoji fix -- see emoji.ts's header comment for
// the full "🇪🇸 renders as 'E S'" diagnosis and design) ───────────────────
// Per-isolate memo of already-fetched Twemoji SVG data URIs, keyed by the
// literal grapheme text. Captions across DIFFERENT memories/requests in the
// same warm isolate very likely reuse the same handful of common emoji, so
// this avoids re-fetching an unchanged SVG from R2 on every compose -- the
// SAME "amortize across requests in one isolate" reasoning as
// webpModulePromise above and render.ts's resvgInitPromise. Bounded at
// MAX_EMOJI_GRAPHEME_MEMO_ENTRIES (emoji.ts) with simple insertion-order
// (FIFO) eviction -- a Map preserves insertion order, so the oldest entry
// is always `.keys().next().value`. Tiny by design (a handful of KB of
// base64 SVG text at most, even at the cap) -- this is not trying to be a
// general cache, just cheap insurance against the common case.
const emojiGraphemeImageMemo = new Map<string, string>();

/** Exported (not test-prefixed) like markComposeRun/markWarmRun above --
 * real production logic, directly unit-testable. */
export function rememberEmojiGraphemeImage(grapheme: string, dataUri: string): void {
  // Re-inserting moves a key to the end of Map iteration order -- all the
  // "recency" this needs. An already-memoized grapheme re-seen in a later
  // request is therefore less likely to be the next one evicted.
  emojiGraphemeImageMemo.delete(grapheme);
  emojiGraphemeImageMemo.set(grapheme, dataUri);
  if (emojiGraphemeImageMemo.size > MAX_EMOJI_GRAPHEME_MEMO_ENTRIES) {
    const oldestKey = emojiGraphemeImageMemo.keys().next().value;
    if (oldestKey !== undefined) {
      emojiGraphemeImageMemo.delete(oldestKey);
    }
  }
}

/** Exposed for tests only -- avoids cross-test memo bleed. */
export function _resetEmojiGraphemeImageMemoForTests(): void {
  emojiGraphemeImageMemo.clear();
}

/** Exposed for tests only -- lets a test assert memo hit/eviction state
 * without reaching into module-private state directly. */
export function _hasEmojiGraphemeImageMemoizedForTests(grapheme: string): boolean {
  return emojiGraphemeImageMemo.has(grapheme);
}

/**
 * Decodes real webp `bytes` and re-encodes to JPEG, capped to `maxEdge` on
 * its longest side (same budget as capImageMaxEdge below -- avoids decoding
 * once at full illustration resolution then a second time inside
 * capImageMaxEdge). Returns null on any decode failure (corrupt bytes, an
 * unsupported webp feature) so the caller can fail closed rather than embed
 * bytes resvg silently can't render -- same "don't fail the whole card"
 * posture as resolveMemberPortraits' single-portrait failure handling.
 */
export async function convertWebpToJpeg(
  bytes: Uint8Array,
  maxEdge: number,
  webpDecWasmBytes: Uint8Array,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  try {
    const { decode: decodeWebp } = await loadWebpModule(webpDecWasmBytes);
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const imageData = await decodeWebp(arrayBuffer);
    const image = new RasterImage(imageData.width, imageData.height);
    image.bitmap.set(imageData.data);
    const target = computeResizedDimensions(imageData.width, imageData.height, maxEdge);
    if (target.width !== imageData.width || target.height !== imageData.height) {
      image.resize(target.width, target.height);
    }
    return { bytes: await image.encodeJPEG(REFERENCE_IMAGE_JPEG_QUALITY), contentType: 'image/jpeg' };
  } catch (error) {
    // error.name only (e.g. "Error", "RangeError") -- never error.message,
    // which for a decode/encode failure could theoretically echo bytes back
    // (AGENTS.md logging discipline). No memoryId in scope here; the
    // caller's own catch-all (runShareCardCompose) already logs memoryId
    // for anything that ultimately fails the whole compose.
    console.error('compose-share-card webp decode failed', error instanceof Error ? error.name : 'unknown');
    return null;
  }
}

// ── Embedded-image size cap (WORKER_RESOURCE_LIMIT mitigation, bug 1) ──
// The card's own raster canvas never exceeds SHARE_CARD_FULL_WIDTH
// (1080px) wide, and -- now that clampMediaAspectRatio bounds every
// imageAspectRatio to [3/4, 16/9] -- never more than 1080 / (3/4) = 1440px
// tall either. Any embedded source image larger than that costs resvg
// decode/raster compute for zero visible benefit. Verified against
// production data: legacy `memory_media` rows that fall back to the
// full-resolution `object_key` (no `preview_object_key`, see
// resolveShareCardSource's `usingPreview` branch) can reach 12 megapixels
// (3000x4000) -- 10x+ larger than a typical ~1MP generated preview. This is
// believed to be a material contributor to the WORKER_RESOURCE_LIMIT (546)
// failures the S0 spike already documented and partially mitigated via
// reduced-scale + the client's single retry (share-card.ts); capping here
// reduces the compute those failures track (pixel count) directly, for
// every image source (media photo, illustration, tagged-member portrait).
export const SHARE_CARD_MAX_IMAGE_EDGE = 1600;

// ── Skip-decode fast path (perf-audit fix, this package's implementation
// report) ────────────────────────────────────────────────────────────────
// capImageMaxEdge ALWAYS fully decodes the source image (imagescript
// Image.decode) just to learn its width/height, even when the bytes are
// already well under maxEdge and no resize will happen -- the decode (and
// the encode it does when it DOES resize) is real CPU time paid on every
// call regardless. Tagged-member portraits are the common case that never
// needed it: stored small (~25KB, generated/cropped well under 1600px on
// their longest edge already), so every share with tagged members was
// paying N unnecessary decode+dimension-check round trips.
//
// Fix: sniff dimensions via `npm:image-size` (header-only parse, no pixel
// decode -- the SAME dependency aspectRatioFromImageBytes above already
// uses for the identical reason) and skip capImageMaxEdge's decode entirely
// when the sniffed size is already within budget. Falls through to the full
// capImageMaxEdge path (which has its own defensive fallback) on any sniff
// failure or when a resize is actually needed.
export async function capImageMaxEdgeIfNeeded(
  bytes: Uint8Array,
  maxEdge: number,
  sourceContentType: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  try {
    const { imageSize } = await import('npm:image-size@1.1.1');
    const { width, height } = imageSize(bytes);
    if (width && height && Math.max(width, height) <= maxEdge) {
      return { bytes, contentType: sourceContentType };
    }
  } catch {
    // Sniff failed (unsupported/corrupt header) -- fall through; the full
    // path below still has capImageMaxEdge's own try/catch fallback.
  }
  const capped = await capImageMaxEdge(bytes, maxEdge, sourceContentType);
  return { bytes: capped.bytes, contentType: capped.contentType };
}

// ── Legacy oversized-PNG re-encode (production data profiling, this
// package's implementation report -- the "47 deterministic 546s"
// investigation's root cause) ───────────────────────────────────────────
// The original continuous-scaling hypothesis for the deterministic 546
// class was WRONG (verified: zero improvement). Real root cause, isolated
// via production data profiling (a 39-memory profile of failing vs.
// succeeding shares): failing memories have 3-4 tagged members vs. 2 for
// successes, and family portraits commonly store as ~2-2.2MB PNGs UNDER A
// `.webp` KEY (the SAME MIME-labeling incident resolveImageMimeType's
// sniffing already works around) at ~1024x1024 -- already under
// SHARE_CARD_MAX_IMAGE_EDGE (1600), so `capImageMaxEdgeIfNeeded`'s
// skip-if-small-enough fast path (its own header comment above) checks
// DIMENSIONS ONLY and let the ORIGINAL ~2.2MB PNG bytes straight through,
// base64-inflated to ~2.9MB, embedded once PER TAGGED MEMBER: 2 members
// stayed under budget, 3-4 meant 7-10MB of embedded SVG text --
// deterministically blowing the isolate's resource budget every time,
// independent of any pixel-count/scale math (hence why the scaling
// rewrite alone did nothing). Legacy 2.2MB PNG illustrations (mislabeled
// under a `.webp` key, same incident -- sniffed in 3 of 8 failing memories'
// hero images) stack on top of the portrait cost for text_illustration
// shares.
//
// Fix has two parts (this function covers the HERO half; portraits are
// `portraitBytesToDataUri` below, which is stricter):
//   - Portraits ALWAYS force a small JPEG re-encode regardless of size --
//     see portraitBytesToDataUri.
//   - A hero image gets the SAME oversized-PNG treatment ONLY when it's a
//     large legacy PNG (genuine WebPs already convert via
//     convertWebpToJpeg/jsquash above, and generated previews are already
//     JPEG per backfill-media-previews.ts) -- re-encoding EVERY hero
//     unconditionally would pay a real decode cost for the common case
//     (an already-small preview) for no benefit.
export const LEGACY_PNG_REENCODE_THRESHOLD_BYTES = 500 * 1024; // ~500KB

// ── Data-URI assembly ───────────────────────────────────────────────────
// Split into a pure-CPU processing step (bytesToDataUri) and a
// fetch-then-process convenience wrapper (toDataUri) so the request handler
// can batch-fetch multiple objects' BYTES concurrently (see
// getObjectBytesBatch, _shared/r2.ts) and then run each one's processing
// independently, instead of each caller doing its own serial fetch+process.
export async function bytesToDataUri(
  objectKey: string,
  rawBytes: Uint8Array,
  webpDecWasmBytes: Uint8Array,
): Promise<{ dataUri: string; bytes: Uint8Array; mimeType: string }> {
  // resolveImageMimeType (not mimeTypeFromObjectKey) -- see that function's
  // header comment for why trusting the key extension alone crashed every
  // compose that touched a mismatched portrait.
  const sniffedMimeType = resolveImageMimeType(objectKey, rawBytes);

  if (sniffedMimeType === 'image/webp') {
    const converted = await convertWebpToJpeg(rawBytes, SHARE_CARD_MAX_IMAGE_EDGE, webpDecWasmBytes);
    if (converted) {
      return {
        dataUri: `data:${converted.contentType};base64,${encodeBytesToBase64(converted.bytes)}`,
        bytes: converted.bytes,
        mimeType: converted.contentType,
      };
    }
    // Decode failed -- fall through to embedding the original bytes. This
    // is the SAME behavior as before this fix (a blank image block for a
    // genuine webp), not a new regression; only a successful decode makes
    // things better.
  }

  // Legacy oversized-PNG re-encode (see this section's header comment
  // above) -- deliberately keyed on RAW BYTE SIZE, not dimensions:
  // capImageMaxEdgeIfNeeded's fast path already handles dimensions, but a
  // ~2.2MB PNG already at/under 1600px sails through that check untouched.
  // JPEG's lossy compression collapses a multi-MB PNG to a fraction of the
  // size even with NO resizing at all, so this check alone (independent of
  // whatever capImageMaxEdgeAsJpeg's own resize decision ends up being) is
  // what actually fixes the payload.
  if (sniffedMimeType === 'image/png' && rawBytes.length > LEGACY_PNG_REENCODE_THRESHOLD_BYTES) {
    const capped = await capImageMaxEdgeAsJpeg(rawBytes, SHARE_CARD_MAX_IMAGE_EDGE);
    return {
      dataUri: `data:${capped.contentType};base64,${encodeBytesToBase64(capped.bytes)}`,
      bytes: capped.bytes,
      mimeType: capped.contentType,
    };
  }

  const capped = await capImageMaxEdgeIfNeeded(rawBytes, SHARE_CARD_MAX_IMAGE_EDGE, sniffedMimeType);
  return {
    dataUri: `data:${capped.contentType};base64,${encodeBytesToBase64(capped.bytes)}`,
    bytes: capped.bytes,
    mimeType: capped.contentType,
  };
}

// ── Portrait-specific data-URI assembly (production data profiling fix --
// see the section header comment above `bytesToDataUri` for the full
// diagnosis) ─────────────────────────────────────────────────────────────
// Tagged-member portraits render as small (~44 raster px at BASE_SCALE --
// `s(22)` circles, avatarClusterNode, layout.ts) circular avatars -- there
// is never a legitimate reason to embed a multi-megapixel/multi-MB source
// image for one. Unlike the hero image (bytesToDataUri above, which stays
// conservative -- only forcing a re-encode for a confirmed-oversized
// legacy PNG, to avoid paying a decode cost on the common small-preview
// case), portraits ALWAYS force a small JPEG re-encode regardless of
// source size/format: they're numerous (up to MAX_VISIBLE_MEMBERS = 6 per
// card) and small enough on-card that there is no quality tradeoff to
// protect the way there is for a hero photo.
/** Portraits render far smaller than the hero image -- 256px is already
 * generous headroom over their ~44px on-card display size, and produces a
 * JPEG comfortably under the ~50KB per-portrait target (verified in
 * index.test.ts against a realistic ~2.2MB source fixture). */
export const PORTRAIT_MAX_IMAGE_EDGE = 256;

export async function portraitBytesToDataUri(
  objectKey: string,
  rawBytes: Uint8Array,
  webpDecWasmBytes: Uint8Array,
): Promise<{ dataUri: string; mimeType: string }> {
  const sniffedMimeType = resolveImageMimeType(objectKey, rawBytes);

  if (isUnrasterizableMimeType(sniffedMimeType)) {
    // Explicit, not relying on capImageMaxEdgeAsJpeg's decode to happen to
    // throw for a known-bad format -- same up-front rejection bytesToDataUri's
    // caller (buildTaggedMemberPortraits) used to apply AFTER processing;
    // checking first avoids a doomed decode attempt entirely.
    throw new Error('portrait_unrasterizable');
  }

  if (sniffedMimeType === 'image/webp') {
    const converted = await convertWebpToJpeg(rawBytes, PORTRAIT_MAX_IMAGE_EDGE, webpDecWasmBytes);
    if (converted) {
      return {
        dataUri: `data:${converted.contentType};base64,${encodeBytesToBase64(converted.bytes)}`,
        mimeType: converted.contentType,
      };
    }
    // Real-webp decode failed -- fall through to the force-JPEG path below
    // on the ORIGINAL bytes, same fail-open posture bytesToDataUri has for
    // this case (a blank/unprocessed embed at worst, never a throw here --
    // capImageMaxEdgeAsJpeg below can still fail this path closed, which
    // the caller, buildTaggedMemberPortraits, turns into "no portrait for
    // this member" rather than a whole-card failure).
  }

  const capped = await capImageMaxEdgeAsJpeg(rawBytes, PORTRAIT_MAX_IMAGE_EDGE);
  return {
    dataUri: `data:${capped.contentType};base64,${encodeBytesToBase64(capped.bytes)}`,
    mimeType: capped.contentType,
  };
}

// ── Tagged-member portraits: batched fetch + fail-open processing ─────────
// Perf-audit restructure (this package's implementation report): the
// PREVIOUS resolveMemberPortraits fetched each portrait with its own
// getObjectBytes() call inside a Promise.all -- portraits were already
// parallel WITH EACH OTHER, but that whole step ran, as a unit, BEFORE the
// hero image's fetch (see the old work closure: `await
// resolveMemberPortraits(...)` was the very first line, hero's `await
// toDataUri(...)` came after). Split into two pieces so the caller
// (handleComposeShareCard's work closure) can fire the hero fetch and the
// portrait BYTE fetches in the same wall-clock window as each other:
//   1. resolvePortraitKeysToFetch -- pure, sync, no I/O.
//   2. buildTaggedMemberPortraits -- pure CPU processing (webp decode/cap,
//      data-URI assembly) given ALREADY-FETCHED bytes (a
//      getObjectBytesBatch result) -- no I/O of its own, so it's cheap to
//      unit-test with a fake Map instead of a fake Supabase/R2 backend.

/** Portrait keys for every tagged member that has one, in member order (a
 * member with no resolvable key -- e.g. no photo uploaded yet -- is simply
 * absent, not a null placeholder; buildTaggedMemberPortraits re-derives the
 * same key per member independently, so index alignment is never relied
 * on). */
export function resolvePortraitKeysToFetch(members: FamilyMemberRow[]): string[] {
  return members
    .map((member) => resolveMemberPortraitKey(member))
    .filter((key): key is string => Boolean(key));
}

/**
 * Builds each tagged member's portrait data URI from an already-fetched
 * bytes batch (see getObjectBytesBatch, _shared/r2.ts). FAIL-OPEN per
 * member, preserved exactly from the pre-restructure behavior: a member
 * with no portrait key, a failed R2 fetch (entry missing/`ok: false` in
 * `portraitBytesByKey`), an unrasterizable format (HEIC/HEIF), or a
 * processing failure (corrupt bytes, webp decode error) all fall back to
 * `{ dataUri: null }` -- the card's initial-letter-circle fallback -- NEVER
 * throws, so one bad portrait can never fail the whole compose.
 */
export async function buildTaggedMemberPortraits(
  members: FamilyMemberRow[],
  portraitBytesByKey: Map<string, ObjectBytesBatchEntry>,
  webpDecWasmBytes: Uint8Array,
): Promise<ShareCardMemberPortrait[]> {
  return await Promise.all(
    members.map(async (member): Promise<ShareCardMemberPortrait> => {
      const key = resolveMemberPortraitKey(member);
      if (!key) {
        return { name: member.name, dataUri: null };
      }

      const entry = portraitBytesByKey.get(key);
      if (!entry || !entry.ok || !entry.bytes) {
        // R2 fetch failed (or was never attempted) -- fall back, same as a
        // processing failure below.
        return { name: member.name, dataUri: null };
      }

      try {
        // portraitBytesToDataUri (NOT the shared bytesToDataUri used for
        // the hero image) -- ALWAYS forces a small JPEG re-encode
        // regardless of source size/format; see its header comment for the
        // production-data-profiling diagnosis this responds to (a
        // multi-MB portrait source sailing through the hero-oriented
        // dimension-only fast path untouched, per member).
        const { dataUri } = await portraitBytesToDataUri(key, entry.bytes, webpDecWasmBytes);
        return { name: member.name, dataUri };
      } catch {
        // A single member's portrait failing to process (incl. an
        // unrasterizable format, e.g. legacy HEIC) must not fail the
        // whole card -- fall back to the initial-letter circle.
        return { name: member.name, dataUri: null };
      }
    }),
  );
}

// ── Store-through cache (docs/plans/share-card-store-through.md, W2) ────
// A stored card exists behind `memories.share_card_key` (text_only /
// text_illustration) or `memory_media.share_card_key` (media, per asset) --
// see the 20260805130000 migration. A stored key encodes the layout version
// it was rendered under (`{designVersion}-{generationId}.png`, built by
// buildShareCardKey, _shared/storage-keys.ts); this section resolves which
// column applies to the current request and decides HIT vs MISS.

// LOUD REMINDER: bump this whenever a stored card's OUTPUT would look
// MEANINGFULLY DIFFERENT to a user -- layout.ts, render.ts's scale/format
// choices, this file's own card-shape assembly, or what gets embedded as
// NEW visible image content (e.g. emoji.ts's graphemeImages: a flag
// literally didn't render before, now it does -- a real, wanted visual
// change) -- it is the ONLY thing that invalidates a stored card. A stored
// key whose encoded version doesn't match this constant is always treated
// as a MISS (isFreshShareCardKey below), so old cards regenerate lazily on
// next share instead of ever being served stale. Currently 3: version 1 is
// the IMPLICIT pre-cache design (no share_card_key columns existed before
// this workstream, so there was nothing to compare a key against); 2 was
// this workstream's own batched wordmark tweak (layout.ts's
// SHARE_CARD_WORDMARK_FONT_SIZE/SHARE_CARD_WORDMARK_OPACITY); 3 -- STILL
// UNDEPLOYED as of this comment, so folded straight into the same version
// rather than bumping again -- is BOTH the quote-glyph's follow-up
// marginBottom bump (+2 -> +8 logical units, layout.ts's quoteGlyphNode)
// AND self-hosted Twemoji `graphemeImages` support (emoji.ts) for
// flag/ZWJ-sequence/keycap emoji that satori's font-only text shaping can
// never render correctly on its own (docs/plans/share-card-store-through.md's
// four-part production fix).
//
// NOT bumped for the tail fix's portrait/hero re-encode (bytesToDataUri's
// legacy-PNG branch, portraitBytesToDataUri) -- deliberately, per the
// distinction above: this changes HOW an image is encoded/compressed
// (JPEG vs PNG, downscaled to a small edge) to fix a payload-size bug, not
// WHAT is displayed -- the same photo/illustration renders into the same
// small avatar circle or hero slot either way, visually indistinguishable
// at final render size (a portrait was always downsampled from source
// into a ~44px circle; embedding a smaller/JPEG source changes nothing a
// viewer could actually see). A stored card composed under the OLD path
// is not stale or wrong to keep serving -- it just happens to have been
// composed from a larger source image. Same reasoning already applied to
// the continuous-scaling rewrite (scale.ts): the pixel BUDGET/SCALE a card
// renders at was never part of this key's contract either -- see
// buildShareCardKey's call site below (storeShareCardAndUpdateCache),
// which only ever embeds DESIGN_VERSION + a fresh uuid, never a scale
// value or an encoding choice.
export const DESIGN_VERSION = 3;

const SHARE_CARD_KEY_NAME_PATTERN = /^(\d+)-(.+)\.png$/i;

/** Parses the `{designVersion}-{generationId}` name segment out of a full
 * share-card object key's filename. Returns null for anything that doesn't
 * match the shape buildShareCardKey produces (defensive -- a malformed/
 * legacy value is simply treated as unparsable, never thrown). */
export function parseShareCardKeyDesignVersion(objectKey: string): number | null {
  const filename = objectKey.split('/').pop() ?? '';
  const match = filename.match(SHARE_CARD_KEY_NAME_PATTERN);
  if (!match) {
    return null;
  }
  const version = Number(match[1]);
  return Number.isInteger(version) ? version : null;
}

/** A stored key is fresh (a cache HIT) only when it exists AND its encoded
 * designVersion equals the current DESIGN_VERSION -- a key from an older
 * layout version is deliberately treated exactly like "no key at all". */
export function isFreshShareCardKey(storedKey: string | null | undefined): boolean {
  if (!storedKey) {
    return false;
  }
  return parseShareCardKeyDesignVersion(storedKey) === DESIGN_VERSION;
}

/** Which DB column/row a compose's stored card belongs to: per-ASSET
 * (`memory_media.share_card_key`) for a media memory's specific asset,
 * per-MEMORY (`memories.share_card_key`) for text_only/text_illustration
 * (the whole memory has exactly one card either way -- there's no
 * "asset" to key on). */
export interface ShareCardCacheTarget {
  table: 'memories' | 'memory_media';
  id: string;
  storedKey: string | null;
}

export function resolveShareCardCacheTarget(
  source: ResolvedShareCardSource,
  row: ShareCardMemoryQueryRow,
  mediaAssetId: string | undefined,
): ShareCardCacheTarget {
  if (source.kind === 'media') {
    // mediaAssetId is guaranteed to be a real id present in row.memory_media
    // here: resolveShareCardSourceFromQueryRow only ever returns a 'media'
    // source after successfully finding this exact asset in that array (see
    // its `asset = row.memory_media.find(...)` lookup) -- so re-finding it
    // here can't fail in practice. Re-finding (rather than threading the
    // asset through ResolvedShareCardSource) keeps that type unchanged for
    // every existing caller/test.
    const asset = row.memory_media.find((m) => m.id === mediaAssetId);
    return { table: 'memory_media', id: mediaAssetId as string, storedKey: asset?.share_card_key ?? null };
  }
  return { table: 'memories', id: row.id, storedKey: row.share_card_key };
}

export interface ShareCardStoreDependencies {
  putObjectBytes: typeof putObjectBytes;
  deleteObject: typeof deleteObject;
  createServiceClient: typeof createServiceClient;
}

/**
 * Miss-path store-through: uploads the freshly composed PNG under a new
 * `{DESIGN_VERSION}-{uuid}` key (ALWAYS under the memory CREATOR's userId
 * prefix -- `ownerUserId` must be `row.user_id`, never the caller, so a
 * viewer/manager sharing someone else's memory still writes to the same
 * prefix the memory's own illustration/media objects already live under --
 * matching the existing authz-path convention those keys rely on), then
 * updates `target`'s column via a SERVICE-ROLE client. `memories` and
 * `memory_media` are technically writable by the ordinary user client too
 * (see the migration's header comment), but service-role is used here by
 * CONVENTION -- the same posture generate-illustration already uses for
 * `illustration_key`/`illustration_generation_id`, columns with an
 * identical "only server-side code writes this" contract. If the target
 * previously held a DIFFERENT key (always a stale one at this call site --
 * a fresh key would have been a cache HIT, never reaching here), the old
 * object is deleted best-effort so it doesn't linger as orphaned storage.
 *
 * Every failure here (R2 put, DB update, stale-object delete) is caught and
 * logged id-only (AGENTS.md logging discipline -- never memory content, and
 * this function never even sees the caption) and swallowed: a caching
 * failure must never fail the share itself. Returns `{ stored: boolean }`
 * only so tests can assert the outcome directly instead of re-deriving it
 * from log side effects.
 */
export async function storeShareCardAndUpdateCache(
  target: ShareCardCacheTarget,
  ownerUserId: string,
  memoryId: string,
  png: Uint8Array,
  deps: ShareCardStoreDependencies,
): Promise<{ stored: boolean }> {
  const newKey = buildShareCardKey(ownerUserId, memoryId, `${DESIGN_VERSION}-${crypto.randomUUID()}`);

  try {
    await deps.putObjectBytes(newKey, png, 'image/png');
  } catch {
    console.error('compose-share-card cache store failed', memoryId, target.table);
    return { stored: false };
  }

  try {
    const service = deps.createServiceClient();
    const { error } = await service.from(target.table).update({ share_card_key: newKey }).eq('id', target.id);
    if (error) {
      throw error;
    }
  } catch {
    console.error('compose-share-card cache column update failed', memoryId, target.table);
    return { stored: false };
  }

  if (target.storedKey && target.storedKey !== newKey) {
    try {
      await deps.deleteObject(target.storedKey);
    } catch {
      console.error('compose-share-card stale card delete failed', memoryId, target.table);
    }
  }

  return { stored: true };
}

// ── Request handling ─────────────────────────────────────────────────────

/** Injectable seam over the single nested query (round 3's
 * SHARE_CARD_MEMORY_SELECT) -- default implementation is the exact query
 * handleComposeShareCard always ran; tests override this whole function to
 * supply a canned row/error without a real Supabase/PostgREST round trip
 * (the SAME approach generate-illustration's DEFAULT_DEPENDENCIES pattern
 * uses for its own DB/network seams). */
export type ShareCardQueryResult = {
  data: ShareCardMemoryQueryRow | null;
  error: { message: string } | null;
};

async function defaultFetchShareCardQueryRow(authHeader: string, memoryId: string): Promise<ShareCardQueryResult> {
  const supabase: SupabaseClient = createUserClient(authHeader);
  const { data, error } = await supabase
    .from('memories')
    .select(SHARE_CARD_MEMORY_SELECT)
    .eq('id', memoryId)
    .maybeSingle();
  return { data: data as unknown as ShareCardMemoryQueryRow | null, error };
}

export interface ComposeShareCardDependencies {
  fetchQueryRow: (authHeader: string, memoryId: string) => Promise<ShareCardQueryResult>;
  loadShareCardAssets: typeof loadShareCardAssetsImpl;
  getObjectBytes: typeof getObjectBytes;
  getObjectBytesBatch: typeof getObjectBytesBatch;
  putObjectBytes: typeof putObjectBytes;
  deleteObject: typeof deleteObject;
  createServiceClient: typeof createServiceClient;
  composeShareCardPng: typeof composeShareCardPngImpl;
}

const DEFAULT_COMPOSE_DEPENDENCIES: ComposeShareCardDependencies = {
  fetchQueryRow: defaultFetchShareCardQueryRow,
  loadShareCardAssets: loadShareCardAssetsImpl,
  getObjectBytes,
  getObjectBytesBatch,
  putObjectBytes,
  deleteObject,
  createServiceClient,
  composeShareCardPng: composeShareCardPngImpl,
};

/** Builds the Server-Timing header value + single structured log line for a
 * cache HIT -- deliberately separate from logComposeTiming below (a hit
 * never touches satori/resvg/assets, so most of that function's fields
 * would just be zeros/misleading). Same AGENTS.md logging discipline: ids
 * and numbers only. */
function logCacheHitTiming(memoryId: string, bootHintMs: number, dbMs: number, getMs: number, totalMs: number, pngBytes: number): string {
  console.log('compose-share-card timing', JSON.stringify({
    memoryId,
    cache: 'hit',
    bootHintMs,
    dbMs,
    getMs,
    totalMs,
    pngBytes,
  }));

  return [
    'cache;desc=hit',
    `boot;dur=${bootHintMs}`,
    `db;dur=${dbMs}`,
    `get;dur=${getMs}`,
    `total;dur=${totalMs}`,
  ].join(', ');
}

export async function handleComposeShareCard(
  req: Request,
  dependencyOverrides: Partial<ComposeShareCardDependencies> = {},
): Promise<Response> {
  const dependencies: ComposeShareCardDependencies = { ...DEFAULT_COMPOSE_DEPENDENCIES, ...dependencyOverrides };
  // See MODULE_EVAL_TIME's header comment: this is "handler entry" for the
  // bootHint delta, captured before any auth/DB/CORS work so it reflects
  // only module-graph-eval time, not request-handling time.
  const bootHintMs = Math.round(performance.now() - MODULE_EVAL_TIME);

  const corsResponse = handleCors(req);
  if (corsResponse) {
    return corsResponse;
  }

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405, 'method_not_allowed');
  }

  const user = await getAuthenticatedNonAnonymousUser(req);
  if (!user) {
    return errorResponse('Unauthorized', 401, 'unauthorized');
  }

  let body: ComposeShareCardRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }

  const { memoryId, mediaAssetId, warm } = body;

  if (!memoryId || typeof memoryId !== 'string') {
    return errorResponse('memoryId is required', 400, 'validation_error');
  }

  if (mediaAssetId !== undefined && typeof mediaAssetId !== 'string') {
    return errorResponse('mediaAssetId must be a string', 400, 'validation_error');
  }

  if (warm !== undefined && typeof warm !== 'boolean') {
    return errorResponse('warm must be a boolean', 400, 'validation_error');
  }

  // Same auth/role/validation as a normal (cold) share -- warm is not a
  // relaxed-permissions mode, just a different response shape + a looser
  // rate bucket (W2 spec: "a viewer with sharing disabled can still WARM?
  // No -- warms come from creators/editors post-create; keep the same 403
  // rules, harmless").
  const isWarm = warm === true;

  if (isWarm ? isWarmRateLimited(user.id) : isComposeRateLimited(user.id)) {
    return errorResponse('Too many share requests -- try again in a moment', 429, 'rate_limited');
  }

  const authHeader = req.headers.get('Authorization')!;

  // ── Round 3: ONE nested query replaces what was ~5-6 sequential DB round
  // trips (memory row, authorizeShareCardAccess's own 2-3 sequential
  // queries, resolveShareCardSource's memory_media select,
  // fetchTaggedMembers' select) -- see SHARE_CARD_MEMORY_SELECT's header
  // comment for the full diagnosis and the real-schema verification that
  // preceded wiring this in.
  //
  // Store-through cache (W2) note: the R2 ASSET fetch (loadShareCardAssets)
  // used to be kicked off here, before this query, so it could overlap with
  // it (round 4). It no longer is: a cache HIT must never touch fonts/wasm
  // at all (that is the entire point of the store-through cache), and
  // hit-vs-miss can't be known until AFTER this query + the cache check
  // below, so the asset fetch is now deferred to the confirmed-MISS branch
  // further down. This trades away some of the (now rarer, once the cache
  // is warm) miss path's overlap window for a hit path that touches R2
  // exactly once -- the cached PNG itself.
  const dbStart = performance.now();
  const { data: queryRow, error: queryError } = await dependencies.fetchQueryRow(authHeader, memoryId);
  const dbMs = Math.round(performance.now() - dbStart);

  if (queryError) {
    console.error('compose-share-card memory lookup failed', memoryId, 500);
    return errorResponse('Failed to load memory', 500, 'internal_error');
  }

  if (!queryRow) {
    // RLS scopes this query to the caller's families, so a non-member's
    // request lands here too -- same 404-for-non-member pattern as
    // analyze-emotion, avoiding leaking whether a memory id exists.
    return errorResponse('Memory not found', 404, 'MEMORY_NOT_FOUND');
  }

  const row = queryRow;

  // Both are now SYNC, pure post-processing of the single already-fetched
  // row -- no DB calls, no Promise.all needed (round 2 parallelized two
  // separate DB calls here; round 3 removed the second call entirely).
  // Error-priority order (authorization checked before resolution) is
  // unchanged, so a non-member/blocked-viewer still gets 403 rather than a
  // 400/404 leaking memory-type info.
  const authorization = authorizeShareCardAccessFromQueryRow(row, user.id);
  if (!authorization.ok) {
    return errorResponse(authorization.error.message, authorization.error.status, authorization.error.code);
  }

  const resolution = resolveShareCardSourceFromQueryRow(row, mediaAssetId);
  if (!resolution.ok) {
    return errorResponse(resolution.error.message, resolution.error.status, resolution.error.code);
  }

  if (isWarm) {
    markWarmRun(user.id);
  } else {
    markComposeRun(user.id);
  }

  // ── Cache check (W2) ─────────────────────────────────────────────────
  const cacheTarget = resolveShareCardCacheTarget(resolution.source, row, mediaAssetId);

  if (isFreshShareCardKey(cacheTarget.storedKey)) {
    if (isWarm) {
      // Already warm -- nothing to compose or store. No R2/asset access at
      // all on this path.
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const getStart = performance.now();
    try {
      const bytes = await dependencies.getObjectBytes(cacheTarget.storedKey as string);
      const getMs = Math.round(performance.now() - getStart);
      return new Response(bytes as BodyInit, {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'image/png',
          'Content-Disposition': `attachment; filename="${buildShareCardFilename(row.memory_date)}"`,
          'Server-Timing': logCacheHitTiming(memoryId, bootHintMs, dbMs, getMs, dbMs + getMs, bytes.length),
        },
      });
    } catch {
      // The cached object went missing/unreadable (e.g. deleted out from
      // under the DB row by an out-of-band sweep) -- fall through to a
      // normal MISS (recompose) below rather than fail the whole share.
      // id-only log (AGENTS.md logging discipline).
      console.error('compose-share-card cache hit read failed', memoryId, cacheTarget.table);
    }
  }

  // ── MISS: compose via the existing pipeline, then store-through ───────
  // Kicked off only now that a MISS is confirmed -- see the dbStart
  // comment above for why this moved off the top of the handler.
  const assetsStart = performance.now();
  const assetsPromise = dependencies.loadShareCardAssets();
  // Silences a Deno "uncaught (in promise)" warning if the work closure
  // below throws before ever awaiting this (e.g. the hero image fetch
  // failing closed) -- the fetch keeps running regardless (module-scope
  // memoization means the NEXT request in this isolate benefits even if
  // this one didn't need it); this only silences the warning for the
  // abandoned reference. Real error handling happens at the `await
  // assetsPromise` site below.
  assetsPromise.catch(() => {});

  const composeResponse = await runShareCardCompose(memoryId, async () => {
    // "fetch" phase is now R2-only -- tagged members and the media
    // asset/illustration key all came from the single query above, so
    // there is no DB call left in this closure at all. Round 2's two-phase
    // "kick off hero, await tagged-members DB query, then batch portraits"
    // dance is gone too: since tagged members are already in hand
    // (resolveTaggedMembersFromQueryRow is sync), the hero key and every
    // portrait key are known immediately, so they go into ONE
    // getObjectBytesBatch call together -- one presign round trip for
    // EVERYTHING this compose needs, not one for the hero and a separate
    // one for portraits (round 2) or N separate ones (round 1 and before).
    const { members, overflowCount } = resolveTaggedMembersFromQueryRow(row);
    const portraitKeys = resolvePortraitKeysToFetch(members);

    const heroObjectKey = resolution.source.kind === 'media' || resolution.source.kind === 'illustration'
      ? resolution.source.objectKey
      : null;

    // ── Emoji grapheme images (emoji fix -- emoji.ts's header comment) ───
    // Distinct emoji graphemes in the caption, split into memo hits (no
    // fetch needed) and misses (their Twemoji SVG key joins the SAME
    // getObjectBytesBatch call as the hero/portrait images below -- one
    // presign round trip for everything this compose needs, same reasoning
    // as the comment above this block).
    const captionEmojiGraphemes = extractDistinctEmojiGraphemes(row.content ?? '');
    const emojiGraphemesToFetch = captionEmojiGraphemes.filter((g) => !emojiGraphemeImageMemo.has(g));
    const emojiKeysToFetch = emojiGraphemesToFetch.map(buildTwemojiObjectKey);

    const allImageKeys = [
      ...(heroObjectKey ? [heroObjectKey] : []),
      ...portraitKeys,
      ...emojiKeysToFetch,
    ];

    // Awaited together with the (already-in-flight, kicked off right above)
    // asset fetch.
    const imageFetchStart = performance.now();
    const [imageBytesByKey, assets] = await Promise.all([
      dependencies.getObjectBytesBatch(allImageKeys),
      assetsPromise,
    ]);
    const imageFetchMs = Math.round(performance.now() - imageFetchStart);
    const assetsMs = Math.round(performance.now() - assetsStart);
    const fetchCount = allImageKeys.length;

    const portraits = await buildTaggedMemberPortraits(members, imageBytesByKey, assets.webpDecWasm);

    // FAIL-OPEN per grapheme (resolveGraphemeImages), same posture as
    // tagged-member portraits: a missing/failed SVG just means satori
    // falls back to its normal font-shaped (incomplete, ligature-less)
    // rendering for that one grapheme -- never fails the whole compose.
    const { graphemeImages, newlyResolved } = resolveGraphemeImages(
      captionEmojiGraphemes,
      emojiGraphemeImageMemo,
      imageBytesByKey,
      (bytes) => `data:image/svg+xml;base64,${encodeBytesToBase64(bytes)}`,
    );
    for (const [grapheme, dataUri] of newlyResolved) {
      rememberEmojiGraphemeImage(grapheme, dataUri);
    }

    let imageDataUri: string | null = null;
    let imageAspectRatio: number | null = null;
    // Wall time of hero-image PROCESSING (webp decode, or the legacy
    // oversized-PNG re-encode above) -- separate from imageFetchMs (network
    // only). Normally near-zero; the legacy-PNG branch's `Image.decode` of
    // a ~1024^2 source is the one case this is expected to show real cost
    // (accepted -- see bytesToDataUri's LEGACY_PNG_REENCODE_THRESHOLD_BYTES
    // comment for why the payload win is worth it).
    const heroProcessStart = performance.now();

    if (heroObjectKey) {
      const heroEntry = imageBytesByKey.get(heroObjectKey);
      if (!heroEntry || !heroEntry.ok || !heroEntry.bytes) {
        // Fail CLOSED for the hero image (unlike portraits, which fail
        // open) -- matches the pre-restructure behavior where a direct
        // `getObjectBytes()` throw on the hero fetch propagated up and
        // failed the whole compose via runShareCardCompose's catch-all.
        // No memory content in this message (AGENTS.md logging discipline
        // -- caught by that same catch-all, which logs memoryId + a fixed
        // code only, never this message).
        throw new Error('hero_image_fetch_failed');
      }

      if (resolution.source.kind === 'media') {
        const { dataUri, bytes } = await bytesToDataUri(heroObjectKey, heroEntry.bytes, assets.webpDecWasm);
        imageDataUri = dataUri;
        const decoded = resolution.source.storedAspectRatio
          ?? (await aspectRatioFromImageBytes(bytes))
          ?? DEFAULT_MEDIA_ASPECT_RATIO;
        imageAspectRatio = clampMediaAspectRatio(decoded);
      } else if (resolution.source.kind === 'illustration') {
        const { dataUri, bytes } = await bytesToDataUri(heroObjectKey, heroEntry.bytes, assets.webpDecWasm);
        imageDataUri = dataUri;
        const decoded = await aspectRatioFromImageBytes(bytes);
        imageAspectRatio = clampMediaAspectRatio(decoded ?? 1);
      }
    }
    const heroProcessMs = Math.round(performance.now() - heroProcessStart);

    const fetchMs = dbMs + imageFetchMs;

    const cardData: ShareCardData = {
      // Derived from the RESOLVED source, not `row.memory_type` directly --
      // a text_illustration memory with no illustration_key yet resolves to
      // `{ kind: 'text' }` (resolveShareCardSourceFromQueryRow's null-key
      // fallback above) and must render as an intentional quote card, not
      // a spread card missing its image.
      variant: resolution.source.kind === 'text' ? 'quote' : 'spread',
      dateLabel: formatShareCardDateLabel(row.memory_date),
      caption: row.content ?? '',
      imageDataUri,
      imageAspectRatio,
      members: portraits,
      memberOverflowCount: overflowCount,
      emotion: row.emotion,
    };

    const { png, initMs, satoriMs, resvgMs, scale } = await dependencies.composeShareCardPng(cardData, {
      resvgWasm: assets.resvgWasm,
      fonts: {
        newsreaderRegular: assets.newsreaderRegular,
        newsreaderItalic: assets.newsreaderItalic,
        newsreaderMedium: assets.newsreaderMedium,
        jakartaRegular: assets.jakartaRegular,
        jakartaBold: assets.jakartaBold,
        notoEmoji: assets.notoEmojiSubset,
      },
    }, graphemeImages);

    // ── Store-through (W2, non-fatal on failure) ─────────────────────────
    // Runs INSIDE this work closure (not after runShareCardCompose
    // returns) so both the cold streaming path and the warm 204-only path
    // below share this exact call site -- and its exact non-fatal-failure
    // guarantee: storeShareCardAndUpdateCache never throws, so a caching
    // failure can never turn a successful compose into a failed response.
    if (row.user_id) {
      await storeShareCardAndUpdateCache(cacheTarget, row.user_id, memoryId, png, dependencies);
    } else {
      // Defensive-only: user_id is nullable in the schema (src/types/
      // database.ts) but every real memory row has one. Without an owner
      // there is no valid key prefix to store under -- skip caching, the
      // share/warm response below still succeeds.
      console.error('compose-share-card missing owner user_id, skipping cache store', memoryId);
    }

    return {
      png,
      memoryDate: row.memory_date,
      timing: { bootHintMs, dbMs, fetchMs, satoriMs, resvgMs, initMs, scale, fetchCount, imageFetchMs, assetsMs, heroProcessMs },
    };
  });

  if (isWarm) {
    if (composeResponse.status !== 200) {
      // Propagate the same error status/code a cold share would have hit
      // (e.g. compose_failed, assets_unavailable) -- the client's
      // fire-and-forget warm hook (W3) ignores the response either way.
      return composeResponse;
    }
    // Drain the PNG body (never inspected -- warm never streams it) so the
    // underlying Deno resource doesn't leak, then respond 204 no body.
    await composeResponse.arrayBuffer().catch(() => {});
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  return composeResponse;
}

export interface ComposeTiming {
  bootHintMs: number;
  /** Round 3: the single nested-select's own wall time (auth/membership,
   * role, viewer-sharing-toggle, media asset, tagged members + portrait
   * keys -- everything that used to be ~5-6 sequential DB round trips).
   * Target (coordinator's fix design): <=250ms. */
  dbMs: number;
  /** dbMs + imageFetchMs -- kept as the same "everything before
   * satori/resvg" total the field meant pre-round-3, computed as a sum now
   * since the DB query (handleComposeShareCard) and the image fetch
   * (inside runShareCardCompose's closure) are no longer one contiguous
   * timed span. */
  fetchMs: number;
  satoriMs: number;
  resvgMs: number;
  /** Continuous output scale (render.ts's `ComposeShareCardResult.scale` --
   * see scale.ts's `resolveShareCardOutputScale`) -- replaces the old
   * `'full' | 'reduced'` label (tail fix, docs/plans/
   * share-card-store-through.md's four-part production fix). NOT part of
   * the stored-key contract (buildShareCardKey only ever embeds
   * DESIGN_VERSION + a fresh uuid, never a scale) -- a scale-formula change
   * does not need a DESIGN_VERSION bump, and does not invalidate any
   * already-stored card. */
  scale: number;
  /** Total R2 GET attempts this request made (hero [0 or 1] + every tagged
   * member with a resolvable portrait key) -- perf-audit fields added
   * alongside the fetch-concurrency restructure (this package's
   * implementation report) so a future regression is visible as "fetchCount
   * went up" or "imageFetchMs stopped tracking the slowest single fetch",
   * not re-diagnosed from scratch. */
  fetchCount: number;
  /** Wall time of the single batched hero+portraits getObjectBytesBatch
   * call -- this is the number that should look like "the slowest single
   * image fetch," not the sum of every fetch, if the concurrency fix is
   * working. */
  imageFetchMs: number;
  /** Round 3: the ONE-TIME per-isolate resvg-wasm-compile cost
   * (render.ts's ensureResvgInitialized), split out of satoriMs so a
   * first-request spike here isn't misread as "satori is slow." See
   * render.ts's ComposeShareCardResult.initMs doc comment. */
  initMs: number;
  /** Round 4: wall time of the R2 asset fetch (resvg wasm, webp-dec wasm,
   * every font TTF), measured from when it was KICKED OFF (before the DB
   * query, at the very start of the handler) to when it was actually
   * available. Expected to mostly overlap with dbMs+imageFetchMs (it's
   * fired in parallel with both) -- if this number is close to
   * dbMs+imageFetchMs or larger, the overlap isn't working as intended. */
  assetsMs: number;
  /** Production data profiling fix: wall time of hero-image PROCESSING
   * (webp decode via convertWebpToJpeg, or the legacy oversized-PNG
   * force-re-encode, `bytesToDataUri`'s `LEGACY_PNG_REENCODE_THRESHOLD_BYTES`
   * branch) -- separate from `imageFetchMs` (network only). Normally
   * near-zero (no hero, or a small/already-JPEG hero); the legacy-PNG
   * branch's real decode+encode cost is the one case this is expected to
   * show up, an accepted tradeoff for collapsing a multi-MB embedded
   * payload down. */
  heroProcessMs: number;
}

/** `Deno.memoryUsage()` guarded defensively -- instrumentation must never be
 * able to break the actual response if the Edge Function runtime restricts
 * or omits this API (unverified assumption; no prior usage elsewhere in
 * this repo to confirm it's always available here). */
function safeMemoryUsage(): { rss: number; heapUsed: number } | null {
  try {
    const usage = Deno.memoryUsage();
    return { rss: usage.rss, heapUsed: usage.heapUsed };
  } catch {
    return null;
  }
}

/**
 * Logs the single structured per-request timing line + builds the
 * Server-Timing header value (perf-audit instrumentation, this package's
 * implementation report). Every field is an id or a number -- NEVER memory
 * content (AGENTS.md logging discipline, same rule as the catch block
 * below).
 */
function logComposeTiming(memoryId: string, timing: ComposeTiming, totalMs: number, pngBytes: number): string {
  const mem = safeMemoryUsage();
  console.log('compose-share-card timing', JSON.stringify({
    memoryId,
    bootHintMs: timing.bootHintMs,
    dbMs: timing.dbMs,
    fetchMs: timing.fetchMs,
    initMs: timing.initMs,
    assetsMs: timing.assetsMs,
    satoriMs: timing.satoriMs,
    resvgMs: timing.resvgMs,
    totalMs,
    rss: mem?.rss ?? null,
    heapUsed: mem?.heapUsed ?? null,
    scale: timing.scale,
    pngBytes,
    fetchCount: timing.fetchCount,
    imageFetchMs: timing.imageFetchMs,
    heroProcessMs: timing.heroProcessMs,
  }));

  return [
    `boot;dur=${timing.bootHintMs}`,
    `db;dur=${timing.dbMs}`,
    `fetch;dur=${timing.fetchMs}`,
    `imgfetch;dur=${timing.imageFetchMs};desc="${timing.fetchCount} fetches"`,
    `heroprocess;dur=${timing.heroProcessMs}`,
    `assets;dur=${timing.assetsMs}`,
    `init;dur=${timing.initMs}`,
    `satori;dur=${timing.satoriMs}`,
    `resvg;dur=${timing.resvgMs};desc="scale ${timing.scale.toFixed(3)}"`,
    `total;dur=${totalMs}`,
  ].join(', ');
}

/**
 * Wraps the compose-and-respond step in the catch-all logging pattern
 * required by AGENTS.md's logging discipline + the S3 spec: satori's layout
 * errors can embed text-node content (i.e. the caption) in `error.message`,
 * so this catch block must NEVER read `error.message` -- only `memoryId` and
 * a fixed status/code are logged. Extracted from handleComposeShareCard so
 * the no-content-logging guarantee is unit-testable by injecting a `work`
 * function that throws an error containing caption-like text (see
 * index.test.ts) without needing a live Supabase/R2 backend.
 *
 * `timing` is optional so existing/unit-test `work` functions that don't
 * supply it keep working unchanged (see index.test.ts) -- only the real
 * handleComposeShareCard path populates it, which is every production
 * request.
 */
export async function runShareCardCompose(
  memoryId: string,
  work: () => Promise<{ png: Uint8Array; memoryDate: string; timing?: ComposeTiming }>,
): Promise<Response> {
  const callStart = performance.now();
  try {
    const { png, memoryDate, timing } = await work();
    const totalMs = Math.round(performance.now() - callStart);

    const headers: Record<string, string> = {
      ...corsHeaders,
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="${buildShareCardFilename(memoryDate)}"`,
    };

    if (timing) {
      headers['Server-Timing'] = logComposeTiming(memoryId, timing, totalMs, png.length);
    }

    return new Response(png as BodyInit, { status: 200, headers });
  } catch (error) {
    // Round 4: asset-loading failures (R2 fetch failure, size/hash
    // mismatch -- see assets-loader.ts) get their OWN error code so a
    // future dashboard/alert can tell "R2 asset outage" apart from a
    // generic layout/render failure. `instanceof` never reads
    // `error.message` (or anything dynamic), so this doesn't weaken the
    // logging-discipline guarantee below -- ShareCardAssetsUnavailableError
    // always carries the SAME fixed message regardless of the underlying
    // cause (missing key, size mismatch, hash mismatch), so there is
    // nothing content-bearing to accidentally log even if a future edit
    // read `.message` here.
    if (error instanceof ShareCardAssetsUnavailableError) {
      console.error('compose-share-card assets unavailable', memoryId, 500);
      return errorResponse('Share card assets are temporarily unavailable', 500, 'assets_unavailable');
    }
    void error; // deliberately unread -- see the doc comment above.
    console.error('compose-share-card compose failed', memoryId, 500);
    return errorResponse('Failed to compose share card', 500, 'compose_failed');
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleComposeShareCard(req));
}
