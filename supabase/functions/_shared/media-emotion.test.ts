import { assertEquals } from 'jsr:@std/assert@1';
import {
  isAllowedImageMediaContentType,
  isVideoMediaContentType,
  normalizeEmotionLabel,
  prepareVisionImageFromBytes,
} from './media-emotion.ts';
import { MAX_EMOTION_SOURCE_BYTES } from './image-limits.ts';

Deno.test('isVideoMediaContentType detects video MIME types', () => {
  assertEquals(isVideoMediaContentType('video/mp4'), true);
  assertEquals(isVideoMediaContentType('video/quicktime'), true);
  assertEquals(isVideoMediaContentType('image/jpeg'), false);
});

Deno.test('isAllowedImageMediaContentType allows photo MIME types', () => {
  assertEquals(isAllowedImageMediaContentType('image/jpeg'), true);
  assertEquals(isAllowedImageMediaContentType('image/heic'), true);
  assertEquals(isAllowedImageMediaContentType('video/mp4'), false);
});

Deno.test('prepareVisionImageFromBytes rejects oversized sources', async () => {
  const oversized = new Uint8Array(MAX_EMOTION_SOURCE_BYTES + 1);
  const result = await prepareVisionImageFromBytes(oversized, 'image/jpeg');

  assertEquals('code' in result, true);
  if ('code' in result) {
    assertEquals(result.code, 'file_too_large');
  }
});

Deno.test('normalizeEmotionLabel falls back to tender for unknown labels', () => {
  const result = normalizeEmotionLabel('not_a_real_emotion', {
    tender: 'soft rose',
    joyful: 'warm gold',
  });

  assertEquals(result.emotion, 'tender');
  assertEquals(result.colorPalette, 'soft rose');
});
