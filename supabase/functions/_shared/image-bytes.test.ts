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

// ── capImageMaxEdgeAsJpeg (production data profiling, compose-share-card's
// "3-4 tagged members deterministically 546" root cause) -- unlike
// capImageMaxEdge, this ALWAYS re-encodes to JPEG, even when no resize is
// needed, because the whole point is FILE SIZE reduction, not just a
// dimension cap.

Deno.test('capImageMaxEdgeAsJpeg re-encodes to JPEG even when the source is already within maxEdge (the exact gap capImageMaxEdge leaves)', async () => {
  const { Image } = await import('https://deno.land/x/imagescript@1.3.0/mod.ts');
  const image = new Image(300, 300);
  image.fill(0xff0000ff);
  const pngBytes = await image.encode(); // PNG, not JPEG -- imagescript's default encode()

  const { capImageMaxEdgeAsJpeg } = await import('./image-bytes.ts');
  const capped = await capImageMaxEdgeAsJpeg(pngBytes, 1024);
  const decoded = await Image.decode(capped.bytes);

  assertEquals(capped.contentType, 'image/jpeg');
  assertEquals(capped.extension, 'jpg');
  // Dimensions unchanged (well within the 1024 cap) -- only the FORMAT/byte
  // size changed, proving this is NOT capImageMaxEdge's "skip if already
  // small enough" fast path.
  assertEquals(decoded.width, 300);
  assertEquals(decoded.height, 300);
});

Deno.test('capImageMaxEdgeAsJpeg downscales when the source exceeds maxEdge, same as capImageMaxEdge', async () => {
  const { Image } = await import('https://deno.land/x/imagescript@1.3.0/mod.ts');
  const image = new Image(2048, 1536);
  image.fill(0x00ff00ff);
  const pngBytes = await image.encode();

  const { capImageMaxEdgeAsJpeg } = await import('./image-bytes.ts');
  const capped = await capImageMaxEdgeAsJpeg(pngBytes, 1024);
  const decoded = await Image.decode(capped.bytes);

  assertEquals(capped.contentType, 'image/jpeg');
  assertEquals(decoded.width, 1024);
  assertEquals(decoded.height, 768);
});

Deno.test('capImageMaxEdgeAsJpeg produces a dramatically smaller payload than the original PNG for a realistic (non-flat-color) source', async () => {
  const { Image } = await import('https://deno.land/x/imagescript@1.3.0/mod.ts');
  const image = new Image(1024, 1024);
  // A flat-color fill compresses trivially under EITHER format -- fill with
  // per-pixel noise so PNG can't cheat its way to a small size either,
  // approximating a real photographic portrait's entropy.
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const r = (x * 37 + y * 91) % 256;
      const g = (x * 53 + y * 17) % 256;
      const b = (x * 13 + y * 61) % 256;
      image.setPixelAt(x + 1, y + 1, (r << 24) | (g << 16) | (b << 8) | 0xff);
    }
  }
  const pngBytes = await image.encode();

  const { capImageMaxEdgeAsJpeg } = await import('./image-bytes.ts');
  const capped = await capImageMaxEdgeAsJpeg(pngBytes, 256);

  assertEquals(capped.contentType, 'image/jpeg');
  // The real regression this fix targets: a multi-hundred-KB (here,
  // noise-inflated) PNG collapsing to a small JPEG once both downscaled to
  // a small edge AND re-encoded lossily.
  assertEquals(capped.bytes.length < pngBytes.length / 4, true);
});
