import {
  MAX_ILLUSTRATION_REFERENCE_EDGE,
  REFERENCE_IMAGE_JPEG_QUALITY,
} from './image-limits.ts';

export interface CappedImageBytes {
  bytes: Uint8Array;
  contentType: string;
  extension: string;
}

export function computeResizedDimensions(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const largestEdge = Math.max(width, height);

  if (largestEdge <= maxEdge) {
    return { width, height };
  }

  const scale = maxEdge / largestEdge;

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function extensionForContentType(contentType: string): string {
  if (contentType === 'image/jpeg') {
    return 'jpg';
  }

  if (contentType === 'image/png') {
    return 'png';
  }

  if (contentType === 'image/webp') {
    return 'webp';
  }

  return 'jpg';
}

async function loadImageScript() {
  return await import('https://deno.land/x/imagescript@1.3.0/mod.ts');
}

export async function capImageMaxEdge(
  bytes: Uint8Array,
  maxEdge: number,
  sourceContentType: string,
): Promise<CappedImageBytes> {
  const fallback = {
    bytes,
    contentType: sourceContentType,
    extension: extensionForContentType(sourceContentType),
  };

  try {
    const { Image } = await loadImageScript();
    const image = await Image.decode(bytes);
    const target = computeResizedDimensions(image.width, image.height, maxEdge);

    if (target.width === image.width && target.height === image.height) {
      return fallback;
    }

    image.resize(target.width, target.height);

    return {
      bytes: await image.encodeJPEG(REFERENCE_IMAGE_JPEG_QUALITY),
      contentType: 'image/jpeg',
      extension: 'jpg',
    };
  } catch (error) {
    console.error(
      'capImageMaxEdge skipped resize',
      error instanceof Error ? error.message : 'unknown',
    );
    return fallback;
  }
}

export async function capIllustrationReferenceImage(
  bytes: Uint8Array,
  sourceContentType: string,
): Promise<CappedImageBytes> {
  return capImageMaxEdge(bytes, MAX_ILLUSTRATION_REFERENCE_EDGE, sourceContentType);
}

/**
 * Like `capImageMaxEdge`, but ALWAYS decodes and re-encodes to JPEG at
 * `quality` -- even when the source is already at or under `maxEdge` and
 * `capImageMaxEdge`'s own fast path would return the ORIGINAL bytes/format
 * unchanged (the right behavior for `capImageMaxEdge`'s existing callers,
 * which only care about capping DIMENSIONS). This variant is for callers
 * that need FILE SIZE reduction via JPEG re-compression regardless of
 * whether resizing happens at all -- e.g. compose-share-card's tagged-
 * member portraits and legacy oversized-PNG illustrations (production
 * data profiling found ~2-2.2MB source PNGs already at/under 1600px on
 * their longest edge, so the dimension-only fast path let their full
 * multi-MB byte size straight through into the composed SVG unchanged --
 * see compose-share-card/index.ts's `portraitBytesToDataUri` and
 * `bytesToDataUri` for the full diagnosis).
 *
 * Does NOT catch its own decode/encode errors (unlike `capImageMaxEdge`,
 * which fails open to the original bytes) -- callers here specifically
 * need FILE SIZE guarantees, so silently falling back to a multi-MB
 * original would defeat the point; let the caller's own fail-open policy
 * (e.g. compose-share-card's per-portrait "omit this one, don't fail the
 * whole card" posture) decide what to do on failure instead.
 */
export async function capImageMaxEdgeAsJpeg(
  bytes: Uint8Array,
  maxEdge: number,
  quality: number = REFERENCE_IMAGE_JPEG_QUALITY,
): Promise<CappedImageBytes> {
  const { Image } = await loadImageScript();
  const image = await Image.decode(bytes);
  const target = computeResizedDimensions(image.width, image.height, maxEdge);

  if (target.width !== image.width || target.height !== image.height) {
    image.resize(target.width, target.height);
  }

  return {
    bytes: await image.encodeJPEG(quality),
    contentType: 'image/jpeg',
    extension: 'jpg',
  };
}

// ── Real-bytes format sniffing (source-of-the-mismatch fix) ────────────────
// OpenAI's images/edits and images/generations endpoints have been observed
// to ignore `output_format: 'webp'` and return PNG (or JPEG) bytes anyway --
// see generate-portrait-illustration/index.ts and generate-illustration/
// index.ts for the call sites that request webp output, and
// compose-share-card/index.ts's `resolveImageMimeType` header comment for
// the production-incident history (a satori "Invalid WebP" crash, then a
// multi-MB PNG payload bloat once the crash itself was defended against by
// sniffing on the READ side). This module sniffs on the WRITE side instead,
// at the point of storage, so the mismatch stops accumulating in R2.
//
// The signature check below intentionally matches compose-share-card's
// `resolveImageMimeType` byte-for-byte (same three formats, same thresholds)
// -- kept in sync deliberately so "is this really webp" means the same thing
// on both the write path (here) and the read path (that function).
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

function bytesStartWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) {
    return false;
  }
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) {
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

export type SniffedImageFormat = 'png' | 'jpeg' | 'webp' | null;

/** Sniffs the real image format from magic bytes only. Returns null for
 * anything unrecognized (should not happen against the real OpenAI image
 * APIs, which only ever return png/jpeg/webp, but callers must not assume
 * that -- see `resolveRealImageBytesForStorage`'s fail-open handling). */
export function sniffImageFormat(bytes: Uint8Array): SniffedImageFormat {
  if (bytesStartWith(bytes, PNG_SIGNATURE)) {
    return 'png';
  }
  if (bytesStartWith(bytes, JPEG_SIGNATURE)) {
    return 'jpeg';
  }
  if (isWebpSignature(bytes)) {
    return 'webp';
  }
  return null;
}

export type StoredImageExtension = 'webp' | 'jpg';

export interface ResolvedStorageBytes {
  bytes: Uint8Array;
  contentType: string;
  extension: StoredImageExtension;
  /** True when the source bytes were not already webp and got re-encoded to
   * JPEG before storage (i.e. the PNG branch below actually ran). */
  reencoded: boolean;
}

/**
 * Source-of-truth fix for the `output_format: 'webp'`-vs-real-bytes
 * mismatch: given bytes an OpenAI image call returned while requesting webp
 * output, resolves what should ACTUALLY be stored so the extension always
 * matches the real bytes.
 *
 *  - Real webp bytes: stored unchanged (the expected/requested case).
 *  - Real JPEG bytes (OpenAI has also been observed to return this):
 *    stored unchanged under a `.jpg` extension -- already compact lossy
 *    bytes, so a second re-encode would only cost quality for no size win.
 *  - Real PNG bytes (the incident's dominant case -- production profiling
 *    found ~2-2.2MB per image): re-encoded to JPEG at
 *    `REFERENCE_IMAGE_JPEG_QUALITY`, at the caller's own `maxEdge` (pass the
 *    generation's own output edge, e.g. 1024, so a same-size image is never
 *    downscaled -- only re-encoded). No vendored WEBP ENCODER exists in
 *    this codebase (`@jsquash/webp` here is DECODE-only, see
 *    compose-share-card's header comment for why a second large wasm
 *    wasn't worth vendoring for this); JPEG collapses the typical ~2MB PNG
 *    down to roughly the 150-350KB range with imagescript, which is
 *    already vendored and proven for exactly this job.
 *  - Anything unrecognized: FAILS OPEN to the original bytes under the
 *    webp label, matching this codebase's behavior before this fix. Never
 *    throws -- an image generation that already succeeded (and cost money)
 *    must not be turned into a hard failure by a storage-format guess.
 */
export async function resolveRealImageBytesForStorage(
  bytes: Uint8Array,
  maxEdge: number,
): Promise<ResolvedStorageBytes> {
  const sniffed = sniffImageFormat(bytes);

  if (sniffed === 'jpeg') {
    return { bytes, contentType: 'image/jpeg', extension: 'jpg', reencoded: false };
  }

  if (sniffed === 'png') {
    const capped = await capImageMaxEdgeAsJpeg(bytes, maxEdge, REFERENCE_IMAGE_JPEG_QUALITY);
    return { bytes: capped.bytes, contentType: capped.contentType, extension: 'jpg', reencoded: true };
  }

  // 'webp' or unrecognized: nothing to correct, or nothing safe to correct.
  return { bytes, contentType: 'image/webp', extension: 'webp', reencoded: false };
}
