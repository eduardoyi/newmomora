import { describe, expect, it, vi } from 'vitest';
import { measureOriginalDimensions, measureOriginalDimensionsForJobs, type DimensionMeasurementJob } from '../src/dimensions';

// ── Real, hand-built minimal fixture bytes ──────────────────────────────
//
// These are genuine, spec-following (if minimal) JPEG/HEIC byte streams --
// not mocked/stubbed `imageSize()` results -- so these tests exercise the
// SAME header-walking code (`image-size`'s real `jpg.js`/`heif.js`
// handlers) production traffic does. Verified against the real published
// `image-size@1.2.1` package before being committed here.

/** A minimal, real, parseable JPEG: SOI, a tiny APP0 marker, then an SOF0
 * marker carrying `width`/`height` directly -- optionally preceded by one or
 * more oversized APP1 "filler" markers (a stand-in for a large EXIF/maker-
 * note block) so the SOF0 marker can be pushed past a given byte offset,
 * e.g. to simulate a photo whose header doesn't fit in the first-pass
 * ranged read. A JPEG segment's length field is only 16 bits (max 65535),
 * so `fillerBytes` beyond that is spread across multiple chained APP1
 * segments rather than one -- a single oversized length would silently
 * wrap and desync the real parser's marker-walk (caught in review: the
 * unchained version made `image-size`'s scan degrade into an O(n) byte-by-
 * byte crawl through the zeroed payload once the wrapped length pointed
 * mid-segment, taking ~9s and still failing to find the marker). */
function buildJpegBytes(width: number, height: number, fillerBytes = 0): Uint8Array {
  const MAX_SEGMENT_PAYLOAD = 65000; // comfortably under the 16-bit length field's ~65533 payload ceiling.
  const segments: number[] = [];
  let remaining = fillerBytes;
  while (remaining > 0) {
    const payload = Math.min(remaining, MAX_SEGMENT_PAYLOAD);
    segments.push(payload);
    remaining -= payload;
  }

  const sofHeaderLen = 2 + 2 + 1 + 2 + 2 + 1 + 3; // marker(2) + length(2) + precision(1) + height(2) + width(2) + numComponents(1) + one component(3)
  const fillerLen = segments.reduce((sum, payload) => sum + 4 + payload, 0); // each: marker(2) + length(2) + payload
  const buf = new Uint8Array(2 + 6 + fillerLen + sofHeaderLen);
  let o = 0;
  buf[o++] = 0xff; buf[o++] = 0xd8; // SOI
  buf[o++] = 0xff; buf[o++] = 0xe0; buf[o++] = 0x00; buf[o++] = 0x04; buf[o++] = 0x00; buf[o++] = 0x00; // APP0, length 4, 2-byte dummy payload
  for (const payload of segments) {
    const segLen = payload + 2; // JPEG segment length includes the 2 length bytes themselves
    buf[o++] = 0xff; buf[o++] = 0xe1; // APP1 (filler)
    buf[o++] = (segLen >> 8) & 0xff; buf[o++] = segLen & 0xff;
    o += payload; // payload left zeroed
  }
  buf[o++] = 0xff; buf[o++] = 0xc0; // SOF0 (baseline)
  buf[o++] = 0x00; buf[o++] = 0x0b; // segment length = 11 (2 + 1 + 2 + 2 + 1 + 3)
  buf[o++] = 0x08; // precision
  buf[o++] = (height >> 8) & 0xff; buf[o++] = height & 0xff;
  buf[o++] = (width >> 8) & 0xff; buf[o++] = width & 0xff;
  buf[o++] = 0x01; // 1 component
  buf[o++] = 0x01; buf[o++] = 0x11; buf[o++] = 0x00; // component id, sampling, quant table
  return buf;
}

/** A minimal, real, parseable HEIC: `ftyp` box (brand `heic`) followed by a
 * `meta` box containing only the `iprp > ipco > ispe` chain image-size's
 * HEIC handler reads width/height from -- per the HEIF box format
 * (https://nokiatech.github.io/heif/technical.html), same box-offset math
 * `image-size`'s `heif.js` itself walks. */
function buildHeicBytes(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(64);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 16);
  const ascii = (s: string) => new TextEncoder().encode(s);
  buf.set(ascii('ftyp'), 4);
  buf.set(ascii('heic'), 8);
  dv.setUint32(12, 0);
  dv.setUint32(16, 48);
  buf.set(ascii('meta'), 20);
  dv.setUint32(24, 0); // meta fullbox version+flags
  dv.setUint32(28, 36);
  buf.set(ascii('iprp'), 32);
  dv.setUint32(36, 28);
  buf.set(ascii('ipco'), 40);
  dv.setUint32(44, 20);
  buf.set(ascii('ispe'), 48);
  dv.setUint32(52, 0); // ispe fullbox version+flags
  dv.setUint32(56, width);
  dv.setUint32(60, height);
  return buf;
}

const DIMENSION_PROBE_RANGE_BYTES = 256 * 1024;
const DIMENSION_PROBE_FALLBACK_BYTES = 4 * 1024 * 1024;

/** A bucket whose `get` always returns the leading `length` bytes of
 * `fullBytes` (mirrors R2's own ranged-read semantics: a request for more
 * bytes than the object has just returns the whole object). */
function bucketServing(fullBytes: Uint8Array) {
  const get = vi.fn(async (_key: string, options?: { range?: { offset?: number; length?: number } }) => {
    const length = options?.range && 'length' in options.range ? options.range.length ?? fullBytes.length : fullBytes.length;
    const sliced = fullBytes.slice(0, length);
    return { arrayBuffer: async () => sliced.buffer };
  });
  return { get } as unknown as R2Bucket;
}

describe('measureOriginalDimensions', () => {
  it('parses real JPEG header bytes from a single ranged read', async () => {
    const bucket = bucketServing(buildJpegBytes(4032, 3024));
    const result = await measureOriginalDimensions(bucket, 'family/child/original.jpg');
    expect(result).toEqual({ width: 4032, height: 3024 });
    expect(bucket.get).toHaveBeenCalledTimes(1);
    expect(bucket.get).toHaveBeenCalledWith('family/child/original.jpg', { range: { offset: 0, length: DIMENSION_PROBE_RANGE_BYTES } });
  });

  it('parses real HEIC header bytes from a single ranged read', async () => {
    const bucket = bucketServing(buildHeicBytes(3024, 4032));
    const result = await measureOriginalDimensions(bucket, 'family/child/original.heic');
    expect(result).toEqual({ width: 3024, height: 4032 });
    expect(bucket.get).toHaveBeenCalledTimes(1);
  });

  it('falls back to a larger read when the SOF marker lands past the first probe', async () => {
    // Filler big enough that the SOF0 marker sits past DIMENSION_PROBE_RANGE_BYTES,
    // but the whole file still comfortably fits under the fallback cap.
    const bytes = buildJpegBytes(1600, 1200, DIMENSION_PROBE_RANGE_BYTES + 4096);
    expect(bytes.length).toBeGreaterThan(DIMENSION_PROBE_RANGE_BYTES);
    expect(bytes.length).toBeLessThan(DIMENSION_PROBE_FALLBACK_BYTES);

    const bucket = bucketServing(bytes);
    const result = await measureOriginalDimensions(bucket, 'family/child/exif-heavy.jpg');

    expect(result).toEqual({ width: 1600, height: 1200 });
    expect(bucket.get).toHaveBeenCalledTimes(2);
    expect(bucket.get).toHaveBeenNthCalledWith(1, 'family/child/exif-heavy.jpg', { range: { offset: 0, length: DIMENSION_PROBE_RANGE_BYTES } });
    expect(bucket.get).toHaveBeenNthCalledWith(2, 'family/child/exif-heavy.jpg', { range: { offset: 0, length: DIMENSION_PROBE_FALLBACK_BYTES } });
  });

  it('never fabricates a result -- omits (returns null) when even the fallback read is unparseable', async () => {
    const garbage = new Uint8Array(1024).fill(0x00);
    const bucket = bucketServing(garbage);
    const result = await measureOriginalDimensions(bucket, 'family/child/not-an-image.bin');
    expect(result).toBeNull();
  });

  it('skips the fallback read entirely when the first probe already covered the whole (small) object', async () => {
    // Object smaller than the probe range -- image-size still can't read it
    // (corrupt/truncated), but a second fetch of the SAME bytes would be
    // pointless: the probe already saw everything there is.
    const tinyGarbage = new Uint8Array(50).fill(0xab);
    const bucket = bucketServing(tinyGarbage);
    const result = await measureOriginalDimensions(bucket, 'family/child/tiny-corrupt.jpg');
    expect(result).toBeNull();
    expect(bucket.get).toHaveBeenCalledTimes(1);
  });

  it('returns null without throwing when the object is missing', async () => {
    const bucket = { get: vi.fn(async () => null) } as unknown as R2Bucket;
    const result = await measureOriginalDimensions(bucket, 'family/child/missing.jpg');
    expect(result).toBeNull();
  });

  it('returns null without throwing when the R2 read itself errors', async () => {
    const bucket = { get: vi.fn(async () => { throw new Error('R2 unavailable'); }) } as unknown as R2Bucket;
    const result = await measureOriginalDimensions(bucket, 'family/child/errors.jpg');
    expect(result).toBeNull();
  });
});

describe('measureOriginalDimensionsForJobs', () => {
  function bucketByKey(bytesByKey: Record<string, Uint8Array>) {
    const get = vi.fn(async (key: string, options?: { range?: { length?: number } }) => {
      const bytes = bytesByKey[key];
      if (!bytes) return null;
      const length = options?.range?.length ?? bytes.length;
      const sliced = bytes.slice(0, length);
      return { arrayBuffer: async () => sliced.buffer };
    });
    return { get } as unknown as R2Bucket;
  }

  it('keys results by media id and omits jobs that never resolved', async () => {
    const bucket = bucketByKey({
      'a.jpg': buildJpegBytes(800, 600),
      'b.jpg': new Uint8Array(10), // unparseable -> omitted
    });
    const jobs: DimensionMeasurementJob[] = [
      { id: 'media-a', objectKey: 'a.jpg', contentType: 'image/jpeg' },
      { id: 'media-b', objectKey: 'b.jpg', contentType: 'image/jpeg' },
    ];
    const result = await measureOriginalDimensionsForJobs(bucket, jobs);
    expect(result).toEqual({ 'media-a': { width: 800, height: 600 } });
  });

  it('never attempts a read for a non-image content type (e.g. a video-poster job\'s original video)', async () => {
    const bucket = bucketByKey({ 'clip.mp4': buildJpegBytes(800, 600) }); // even if it "would" parse, it must never be tried
    const jobs: DimensionMeasurementJob[] = [{ id: 'media-video', objectKey: 'clip.mp4', contentType: 'video/mp4' }];
    const result = await measureOriginalDimensionsForJobs(bucket, jobs);
    expect(result).toEqual({});
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it('respects the given concurrency bound', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const get = vi.fn(async (_key: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      const bytes = buildJpegBytes(100, 100);
      return { arrayBuffer: async () => bytes.buffer };
    });
    const bucket = { get } as unknown as R2Bucket;
    const jobs: DimensionMeasurementJob[] = Array.from({ length: 20 }, (_, i) => ({
      id: `media-${i}`,
      objectKey: `photo-${i}.jpg`,
      contentType: 'image/jpeg',
    }));
    const result = await measureOriginalDimensionsForJobs(bucket, jobs, 3);
    expect(Object.keys(result)).toHaveLength(20);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it('returns an empty map with no R2 calls for an empty job list', async () => {
    const bucket = { get: vi.fn(async () => null) } as unknown as R2Bucket;
    const result = await measureOriginalDimensionsForJobs(bucket, []);
    expect(result).toEqual({});
    expect(bucket.get).not.toHaveBeenCalled();
  });
});
