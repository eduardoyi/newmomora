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
