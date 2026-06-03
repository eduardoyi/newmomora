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
