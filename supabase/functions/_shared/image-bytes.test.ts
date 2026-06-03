import { assertEquals } from 'jsr:@std/assert@1';
import { computeResizedDimensions } from './image-bytes.ts';

Deno.test('computeResizedDimensions keeps dimensions when already within max edge', () => {
  assertEquals(computeResizedDimensions(800, 600, 1024), { width: 800, height: 600 });
});

Deno.test('computeResizedDimensions scales landscape images to max edge', () => {
  assertEquals(computeResizedDimensions(2048, 1024, 1024), { width: 1024, height: 512 });
});

Deno.test('computeResizedDimensions scales portrait images to max edge', () => {
  assertEquals(computeResizedDimensions(900, 1800, 1024), { width: 512, height: 1024 });
});

Deno.test('capImageMaxEdge returns original bytes when resize is not needed', async () => {
  const { Image } = await import('https://deno.land/x/imagescript@1.3.0/mod.ts');
  const image = new Image(512, 512);
  image.fill(0xff0000ff);
  const bytes = await image.encodeJPEG(85);

  const { capImageMaxEdge } = await import('./image-bytes.ts');
  const capped = await capImageMaxEdge(bytes, 1024, 'image/jpeg');

  assertEquals(capped.contentType, 'image/jpeg');
  assertEquals(capped.extension, 'jpg');
  assertEquals(capped.bytes, bytes);
});

Deno.test('capImageMaxEdge downscales large jpeg references', async () => {
  const { Image } = await import('https://deno.land/x/imagescript@1.3.0/mod.ts');
  const image = new Image(2048, 1536);
  image.fill(0x00ff00ff);
  const bytes = await image.encodeJPEG(90);

  const { capImageMaxEdge } = await import('./image-bytes.ts');
  const capped = await capImageMaxEdge(bytes, 1024, 'image/jpeg');
  const decoded = await Image.decode(capped.bytes);

  assertEquals(capped.contentType, 'image/jpeg');
  assertEquals(capped.extension, 'jpg');
  assertEquals(decoded.width, 1024);
  assertEquals(decoded.height, 768);
});
