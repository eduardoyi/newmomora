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
import { init as initWebpDecoder, default as decodeWebp } from 'npm:@jsquash/webp@1.4.0/decode.js';
import { Image as RasterImage } from 'https://deno.land/x/imagescript@1.3.0/mod.ts';

import { getAuthenticatedNonAnonymousUser } from '../_shared/auth.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { errorResponse } from '../_shared/errors.ts';
import { getCallerFamilyRole, type FamilyRole } from '../_shared/family-access.ts';
import { capImageMaxEdge, computeResizedDimensions } from '../_shared/image-bytes.ts';
import { REFERENCE_IMAGE_JPEG_QUALITY } from '../_shared/image-limits.ts';
import { encodeBytesToBase64 } from '../_shared/openai.ts';
import { getObjectBytes } from '../_shared/r2.ts';
import { createUserClient } from '../_shared/supabase-admin.ts';
import { composeShareCardPng } from './render.ts';
import { formatShareCardDateLabel, MAX_VISIBLE_MEMBERS, type ShareCardData, type ShareCardMemberPortrait } from './layout.ts';
import { WEBP_DEC_WASM_B64 } from './assets/webp-dec-wasm-b64.ts';

// deno-lint-ignore no-explicit-any -- untyped Supabase client, matching every other function in this package (see _shared/supabase-admin.ts).
type AnySupabase = any;

export interface ComposeShareCardRequest {
  memoryId: string;
  mediaAssetId?: string;
}

interface MemoryRow {
  id: string;
  family_id: string;
  content: string | null;
  memory_type: string;
  memory_date: string;
  illustration_key: string | null;
  illustration_status: string;
  /** Only used by the quote (text_only) card's accent strip + quote-glyph
   * color (see layout.ts's shareCardEmotionColors) -- never logged
   * (AGENTS.md logging discipline; enum-like label, fine to select/hold in
   * memory, just not to console.*). */
  emotion: string | null;
}

interface FamilyRow {
  id: string;
  // `viewer_sharing_enabled` ships in S1's migration
  // (docs/plans/offline-awareness-and-share-cards.md S1) and is NOT yet in
  // src/types/database.ts. This function must not be deployed until that
  // migration has been applied -- see the deploy sequencing note in this
  // package's implementation report. Selecting the column directly
  // (no defensive fallback) is intentional: a fallback that treats a
  // missing column as "sharing enabled" would silently reopen the toggle
  // the moment the column exists but a stale deploy lags behind, which is
  // exactly the security regression S1/S3 exist to prevent. Do not add one.
  viewer_sharing_enabled: boolean;
}

interface MemoryMediaRow {
  id: string;
  memory_id: string;
  object_key: string;
  preview_object_key: string | null;
  content_type: string;
  aspect_ratio: number | null;
}

interface FamilyMemberRow {
  id: string;
  name: string;
  illustrated_profile_key: string | null;
  illustrated_profile_status: string;
  profile_picture_key: string | null;
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
export const SHARE_CARD_RATE_LIMIT_MAX_PER_WINDOW = 10;

const recentComposesByUser = new Map<string, number[]>();

export function isComposeRateLimited(
  userId: string,
  now = Date.now(),
  windowMs = SHARE_CARD_RATE_LIMIT_WINDOW_MS,
  maxPerWindow = SHARE_CARD_RATE_LIMIT_MAX_PER_WINDOW,
): boolean {
  const timestamps = (recentComposesByUser.get(userId) ?? []).filter((t) => now - t < windowMs);
  recentComposesByUser.set(userId, timestamps);
  return timestamps.length >= maxPerWindow;
}

export function markComposeRun(userId: string, now = Date.now()): void {
  const timestamps = recentComposesByUser.get(userId) ?? [];
  timestamps.push(now);
  recentComposesByUser.set(userId, timestamps);
}

// Exposed for tests only (avoids cross-test rate-limit bleed).
export function _resetRateLimitStateForTests(): void {
  recentComposesByUser.clear();
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
 * request against the memory row: memory-type rejection, media-asset
 * ownership, video rejection, illustration readiness.
 */
export async function resolveShareCardSource(
  supabase: AnySupabase,
  memory: MemoryRow,
  mediaAssetId: string | undefined,
): Promise<{ ok: true; source: ResolvedShareCardSource } | { ok: false; error: ShareCardValidationError }> {
  if (isRejectedMemoryType(memory.memory_type)) {
    return {
      ok: false,
      error: {
        status: 400,
        message: memory.memory_type === 'audio'
          ? 'Audio memories cannot be shared yet'
          : 'Unsupported memory type for sharing',
        code: 'unsupported_memory_type',
      },
    };
  }

  if (memory.memory_type === 'text_only') {
    return { ok: true, source: { kind: 'text' } };
  }

  if (memory.memory_type === 'text_illustration') {
    if (memory.illustration_status !== 'ready' || !memory.illustration_key) {
      return {
        ok: false,
        error: {
          status: 400,
          message: 'Illustration is not ready to share yet',
          code: 'illustration_not_ready',
        },
      };
    }
    return { ok: true, source: { kind: 'illustration', objectKey: memory.illustration_key } };
  }

  // memory_type === 'media'
  if (!mediaAssetId) {
    return {
      ok: false,
      error: { status: 400, message: 'mediaAssetId is required for media memories', code: 'validation_error' },
    };
  }

  const { data: asset, error } = await supabase
    .from('memory_media')
    .select('id, memory_id, object_key, preview_object_key, content_type, aspect_ratio')
    .eq('id', mediaAssetId)
    .eq('memory_id', memory.id)
    .maybeSingle();

  if (error) {
    console.error('compose-share-card media asset lookup failed', memory.id, 500);
    return {
      ok: false,
      error: { status: 500, message: 'Failed to load media asset', code: 'internal_error' },
    };
  }

  if (!asset) {
    return {
      ok: false,
      error: { status: 404, message: 'Media asset not found for this memory', code: 'asset_not_found' },
    };
  }

  const row = asset as MemoryMediaRow;

  if (isVideoContentType(row.content_type)) {
    return {
      ok: false,
      error: { status: 400, message: 'Video memories cannot be shared', code: 'video_not_supported' },
    };
  }

  const objectKey = row.preview_object_key ?? row.object_key;
  // Only the legacy object_key fallback can carry a non-preview content
  // type; the preview variant is always JPEG (backfill-media-previews.ts).
  const usingPreview = Boolean(row.preview_object_key);
  const mimeType = usingPreview ? 'image/jpeg' : mimeTypeFromObjectKey(objectKey);

  if (isUnrasterizableMimeType(mimeType)) {
    return {
      ok: false,
      error: { status: 415, message: 'Image format is not supported for sharing', code: 'unsupported_image_format' },
    };
  }

  return {
    ok: true,
    source: { kind: 'media', objectKey, storedAspectRatio: row.aspect_ratio },
  };
}

// ── Authorization (role + viewer-sharing-toggle) ───────────────────────
// Extracted from handleComposeShareCard so the full authz matrix (owner /
// manager / viewer×toggle / non-member) is unit-testable with a fake
// supabase client, mirroring how getCallerFamilyRole itself is tested in
// _shared/family-access.test.ts.
export async function authorizeShareCardAccess(
  supabase: AnySupabase,
  familyId: string,
  callerId: string,
): Promise<{ ok: true; role: FamilyRole } | { ok: false; error: ShareCardValidationError }> {
  const role = await getCallerFamilyRole(supabase, familyId, callerId);
  if (!role) {
    return { ok: false, error: { status: 403, message: 'Not authorized for this memory', code: 'forbidden' } };
  }

  if (role === 'viewer') {
    const { data: family, error } = await supabase
      .from('families')
      .select('id, viewer_sharing_enabled')
      .eq('id', familyId)
      .maybeSingle();

    if (error) {
      console.error('compose-share-card family lookup failed', familyId, 500);
      return { ok: false, error: { status: 500, message: 'Failed to load family', code: 'internal_error' } };
    }

    if ((family as FamilyRow | null)?.viewer_sharing_enabled === false) {
      return {
        ok: false,
        error: { status: 403, message: 'Sharing is currently off for this family', code: 'sharing_disabled' },
      };
    }
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

export async function fetchTaggedMembers(
  supabase: AnySupabase,
  memoryId: string,
): Promise<TaggedMembersResult> {
  const { data, error } = await supabase
    .from('memory_family_members')
    .select('family_member_id, family_members(id, name, illustrated_profile_key, illustrated_profile_status, profile_picture_key)')
    .eq('memory_id', memoryId);

  if (error) {
    console.error('compose-share-card tagged member lookup failed', memoryId, 500);
    throw new Error('tagged_member_lookup_failed');
  }

  const rows = (data ?? [])
    .map((row: { family_members: FamilyMemberRow | null }) => row.family_members)
    .filter((member: FamilyMemberRow | null): member is FamilyMemberRow => Boolean(member));

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
// proved dead under `--use-api` deploys (see this file's header comment and
// webp-dec-wasm-b64.ts). Its `init(module)` accepts a PRE-COMPILED
// WebAssembly.Module instead, bypassing that fetch -- webp-dec-wasm-b64.ts
// supplies the bytes, decoded once per isolate (same cold-start-once
// pattern as render.ts's font/resvg init).
let webpDecoderInitPromise: Promise<void> | null = null;

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function getWebpDecoder(): Promise<void> {
  if (!webpDecoderInitPromise) {
    const wasmBytes = base64ToBytes(WEBP_DEC_WASM_B64);
    webpDecoderInitPromise = WebAssembly.compile(wasmBytes.buffer as ArrayBuffer)
      .then((module) => initWebpDecoder(module))
      .catch((error) => {
        webpDecoderInitPromise = null;
        throw error;
      });
  }
  return webpDecoderInitPromise;
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
export async function convertWebpToJpeg(bytes: Uint8Array, maxEdge: number): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  try {
    await getWebpDecoder();
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

// ── Data-URI assembly ───────────────────────────────────────────────────
export async function toDataUri(objectKey: string): Promise<{ dataUri: string; bytes: Uint8Array; mimeType: string }> {
  const rawBytes = await getObjectBytes(objectKey);
  // resolveImageMimeType (not mimeTypeFromObjectKey) -- see that function's
  // header comment for why trusting the key extension alone crashed every
  // compose that touched a mismatched portrait.
  const sniffedMimeType = resolveImageMimeType(objectKey, rawBytes);

  if (sniffedMimeType === 'image/webp') {
    const converted = await convertWebpToJpeg(rawBytes, SHARE_CARD_MAX_IMAGE_EDGE);
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

  const capped = await capImageMaxEdge(rawBytes, SHARE_CARD_MAX_IMAGE_EDGE, sniffedMimeType);
  return {
    dataUri: `data:${capped.contentType};base64,${encodeBytesToBase64(capped.bytes)}`,
    bytes: capped.bytes,
    mimeType: capped.contentType,
  };
}

async function resolveMemberPortraits(
  supabase: AnySupabase,
  memoryId: string,
): Promise<{ portraits: ShareCardMemberPortrait[]; overflowCount: number }> {
  const { members, overflowCount } = await fetchTaggedMembers(supabase, memoryId);

  const portraits = await Promise.all(
    members.map(async (member): Promise<ShareCardMemberPortrait> => {
      const key = resolveMemberPortraitKey(member);
      if (!key) {
        return { name: member.name, dataUri: null };
      }
      try {
        const { dataUri, mimeType } = await toDataUri(key);
        if (isUnrasterizableMimeType(mimeType)) {
          return { name: member.name, dataUri: null };
        }
        return { name: member.name, dataUri };
      } catch {
        // A single member's portrait failing to load must not fail the
        // whole card -- fall back to the initial-letter circle.
        return { name: member.name, dataUri: null };
      }
    }),
  );

  return { portraits, overflowCount };
}

// ── Request handling ─────────────────────────────────────────────────────
export async function handleComposeShareCard(req: Request): Promise<Response> {
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

  const { memoryId, mediaAssetId } = body;

  if (!memoryId || typeof memoryId !== 'string') {
    return errorResponse('memoryId is required', 400, 'validation_error');
  }

  if (mediaAssetId !== undefined && typeof mediaAssetId !== 'string') {
    return errorResponse('mediaAssetId must be a string', 400, 'validation_error');
  }

  if (isComposeRateLimited(user.id)) {
    return errorResponse('Too many share requests -- try again in a moment', 429, 'rate_limited');
  }

  const authHeader = req.headers.get('Authorization')!;
  const supabase = createUserClient(authHeader);

  const { data: memory, error: memoryError } = await supabase
    .from('memories')
    .select('id, family_id, content, memory_type, memory_date, illustration_key, illustration_status, emotion')
    .eq('id', memoryId)
    .maybeSingle();

  if (memoryError) {
    console.error('compose-share-card memory lookup failed', memoryId, 500);
    return errorResponse('Failed to load memory', 500, 'internal_error');
  }

  if (!memory) {
    // RLS scopes this query to the caller's families, so a non-member's
    // request lands here too -- same 404-for-non-member pattern as
    // analyze-emotion, avoiding leaking whether a memory id exists.
    return errorResponse('Memory not found', 404, 'MEMORY_NOT_FOUND');
  }

  const row = memory as MemoryRow;

  const authorization = await authorizeShareCardAccess(supabase, row.family_id, user.id);
  if (!authorization.ok) {
    return errorResponse(authorization.error.message, authorization.error.status, authorization.error.code);
  }

  const resolution = await resolveShareCardSource(supabase, row, mediaAssetId);
  if (!resolution.ok) {
    return errorResponse(resolution.error.message, resolution.error.status, resolution.error.code);
  }

  markComposeRun(user.id);

  return runShareCardCompose(memoryId, async () => {
    const { portraits, overflowCount } = await resolveMemberPortraits(supabase, memoryId);

    let imageDataUri: string | null = null;
    let imageAspectRatio: number | null = null;

    if (resolution.source.kind === 'media') {
      const { dataUri, bytes } = await toDataUri(resolution.source.objectKey);
      imageDataUri = dataUri;
      const decoded = resolution.source.storedAspectRatio
        ?? (await aspectRatioFromImageBytes(bytes))
        ?? DEFAULT_MEDIA_ASPECT_RATIO;
      imageAspectRatio = clampMediaAspectRatio(decoded);
    } else if (resolution.source.kind === 'illustration') {
      const { dataUri, bytes } = await toDataUri(resolution.source.objectKey);
      imageDataUri = dataUri;
      const decoded = await aspectRatioFromImageBytes(bytes);
      imageAspectRatio = clampMediaAspectRatio(decoded ?? 1);
    }

    const cardData: ShareCardData = {
      variant: row.memory_type === 'text_only' ? 'quote' : 'spread',
      dateLabel: formatShareCardDateLabel(row.memory_date),
      caption: row.content ?? '',
      imageDataUri,
      imageAspectRatio,
      members: portraits,
      memberOverflowCount: overflowCount,
      emotion: row.emotion,
    };

    return { png: await composeShareCardPng(cardData), memoryDate: row.memory_date };
  });
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
 */
export async function runShareCardCompose(
  memoryId: string,
  work: () => Promise<{ png: Uint8Array; memoryDate: string }>,
): Promise<Response> {
  try {
    const { png, memoryDate } = await work();

    return new Response(png as BodyInit, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'image/png',
        'Content-Disposition': `attachment; filename="${buildShareCardFilename(memoryDate)}"`,
      },
    });
  } catch (error) {
    void error; // deliberately unread -- see the doc comment above.
    console.error('compose-share-card compose failed', memoryId, 500);
    return errorResponse('Failed to compose share card', 500, 'compose_failed');
  }
}

if (import.meta.main) {
  Deno.serve(handleComposeShareCard);
}
