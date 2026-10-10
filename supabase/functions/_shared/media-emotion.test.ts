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

Deno.test('prepareVisionImageFromBytes caps at MAX_EMOTION_VISION_EDGE by default and honors a per-call edge', async () => {
  const { Image } = await import('https://deno.land/x/imagescript@1.3.0/mod.ts');
  const image = new Image(2000, 1500);
  image.fill(0x336699ff);
  const bytes = await image.encodeJPEG(80);

  const decodeWidth = async (prepared: Awaited<ReturnType<typeof prepareVisionImageFromBytes>>) => {
    if ('code' in prepared) throw new Error(prepared.code);
    const decoded = await Image.decode(Uint8Array.from(atob(prepared.base64), (char) => char.charCodeAt(0)));
    return decoded.width;
  };

  assertEquals(await decodeWidth(await prepareVisionImageFromBytes(bytes, 'image/jpeg')), 768);
  assertEquals(await decodeWidth(await prepareVisionImageFromBytes(bytes, 'image/jpeg', 1280)), 1280);
});
