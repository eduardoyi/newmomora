import { capImageMaxEdge } from './image-bytes.ts';
import { MAX_EMOTION_SOURCE_BYTES, MAX_EMOTION_VISION_EDGE } from './image-limits.ts';
import { encodeBytesToBase64, type VisionImageInput } from './openai.ts';

export const ALLOWED_IMAGE_MEDIA_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
]);

export const VIDEO_MEDIA_CONTENT_TYPES = new Set(['video/mp4', 'video/quicktime']);

const HEIC_CONTENT_TYPES = new Set(['image/heic', 'image/heif']);

const VISION_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function isVideoMediaContentType(contentType: string): boolean {
  return VIDEO_MEDIA_CONTENT_TYPES.has(contentType);
}

export function isAllowedImageMediaContentType(contentType: string): boolean {
  return ALLOWED_IMAGE_MEDIA_CONTENT_TYPES.has(contentType);
}

export type PrepareVisionImageErrorCode = 'file_too_large' | 'unsupported_image_format';

export async function prepareVisionImageFromBytes(
  bytes: Uint8Array,
  sourceContentType: string,
): Promise<VisionImageInput | { code: PrepareVisionImageErrorCode }> {
  if (bytes.length > MAX_EMOTION_SOURCE_BYTES) {
    return { code: 'file_too_large' };
  }

  const capped = await capImageMaxEdge(bytes, MAX_EMOTION_VISION_EDGE, sourceContentType);

  if (HEIC_CONTENT_TYPES.has(capped.contentType)) {
    return { code: 'unsupported_image_format' };
  }

  if (!VISION_CONTENT_TYPES.has(capped.contentType)) {
    return { code: 'unsupported_image_format' };
  }

  return {
    base64: encodeBytesToBase64(capped.bytes),
    contentType: capped.contentType as VisionImageInput['contentType'],
  };
}

export function normalizeEmotionLabel(
  emotion: string | undefined,
  palettes: Record<string, string>,
): { emotion: string; colorPalette: string } {
  const resolved = emotion && palettes[emotion] ? emotion : 'tender';
  return {
    emotion: resolved,
    colorPalette: palettes[resolved],
  };
}
