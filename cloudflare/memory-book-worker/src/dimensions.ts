/**
 * Original-photo pixel-dimension measurement (regression fix, 2026-09).
 *
 * `supabase/functions/_shared/memory-book-manifest.ts`'s
 * `shouldMeasureOriginalDimensions` says every `kind: 'photo'` manifest
 * asset should carry `originalWidth`/`originalHeight` measured from the
 * ORIGINAL (not preview) photo bytes -- `supabase/scripts/
 * eval-memory-book-assets.ts`'s `measureOriginalDimensions` does this by
 * downloading the full original object and running `image-size` on it. This
 * worker replicates that SAME semantic (every photo asset, never a
 * video-poster's original video file, never a hard failure -- absent, not
 * fabricated, on any read/parse problem) but deliberately reads far less
 * than the full object: `image-size` only ever needs the file's leading
 * header bytes (JPEG's SOF marker, HEIC/ISOBMFF's `ftyp`/`meta`/`ispe` box
 * chain), and this worker's own R2 binding supports ranged reads
 * (`R2GetOptions.range`) the eval CLI's presigned-URL fetches don't bother
 * with. A worker invocation also has a per-invocation subrequest budget
 * (~1000) shared with every other bridge/OpenAI/R2 call the Workflow makes,
 * so avoiding a full-object download per photo matters here in a way it
 * doesn't for the eval CLI's one-off local run.
 *
 * Documented V5a-era deviation, now narrowed: ranged reads instead of full
 * downloads is worker-specific plumbing, not a semantic difference -- the
 * MEASURED width/height this produces is identical to what the eval CLI
 * would record for the same original object (same `image-size` version,
 * same bytes at the offsets that matter), so the fitter's gates see the
 * same trust signal either way.
 */

// `image-size` is a CJS package (`module.exports = exports = imageSize`,
// with `.imageSize`/`.default` properties tacked onto that same function
// object for named-import ergonomics). Under this worker's bundler
// (esbuild via wrangler/vite-node in tests), the named import `{ imageSize }`
// resolves to `undefined` -- cjs-module-lexer's static named-export
// detection doesn't see through the `exports = imageSize` reassignment --
// while the DEFAULT import correctly receives the callable function itself.
// Verified directly against `@cloudflare/vitest-pool-workers`'s real
// workerd runtime (not just Node) before settling on this import shape.
import imageSize from 'image-size';

export interface OriginalDimensions {
  width: number;
  height: number;
}

/** First-pass ranged read -- comfortably covers a JPEG's EXIF block plus
 * SOF marker (the brief's own sizing: "256KB — enough for EXIF-heavy JPEG
 * and HEIC/isobmff") for the overwhelming majority of real photos. */
const DIMENSION_PROBE_RANGE_BYTES = 256 * 1024;

/** Second-pass fallback when the first read's bytes don't contain a
 * complete, parseable header (an unusually large EXIF/maker-note block, or
 * an HEIC box tree with extra sibling boxes ahead of `ispe`) -- still a
 * bounded read, never the full original (which could be tens of MB for a
 * modern phone photo); "a sane size cap" per the brief. */
const DIMENSION_PROBE_FALLBACK_BYTES = 4 * 1024 * 1024;

/** Bounded concurrency for the R2 reads inside the single measurement step
 * -- keeps the Workflow well under both R2's per-invocation concurrency
 * comfort zone and the ~1000 subrequest budget the whole Workflow instance
 * shares, without serializing hundreds of independent reads. */
export const DIMENSION_MEASURE_CONCURRENCY = 12;

/** Reads up to `length` leading bytes of `objectKey` from `bucket`. Returns
 * `null` (never throws) on a missing object or any R2 error -- the caller
 * treats that identically to "dimensions unmeasurable", never a hard
 * failure that would fail the whole step. */
async function readLeadingBytes(bucket: R2Bucket, objectKey: string, length: number): Promise<Uint8Array | null> {
  try {
    const object = await bucket.get(objectKey, { range: { offset: 0, length } });
    if (!object) return null;
    return new Uint8Array(await object.arrayBuffer());
  } catch {
    return null;
  }
}

/** `image-size`'s `calculate()` can either throw (unsupported/truncated
 * input, e.g. an HEIC box chain that runs off the end of the buffer) or
 * return `{ width: NaN, height: NaN }` (a JPEG SOF marker whose declared
 * offset lands past the end of a truncated buffer -- `readUInt16BE` on an
 * out-of-range index reads `undefined`, and arithmetic on `undefined` is
 * `NaN`, not a thrown error). Both are "couldn't read it" -- `!NaN` is
 * `true` in JS, so the single falsy check below catches both. */
function parseDimensions(bytes: Uint8Array): OriginalDimensions | null {
  try {
    const { width, height } = imageSize(bytes);
    if (!width || !height) return null;
    return { width, height };
  } catch {
    return null;
  }
}

/**
 * Measures the real pixel dimensions of the ORIGINAL image object at
 * `objectKey` (never the preview) via bounded ranged reads. Returns `null`
 * -- never throws -- when the object is missing, unreadable, or its header
 * bytes don't parse even after the larger fallback read; the caller must
 * treat `null` as "never measured" (omit the field) rather than a hard
 * failure, exactly like `measureOriginalDimensions` in
 * `eval-memory-book-assets.ts`.
 */
export async function measureOriginalDimensions(bucket: R2Bucket, objectKey: string): Promise<OriginalDimensions | null> {
  const probeBytes = await readLeadingBytes(bucket, objectKey, DIMENSION_PROBE_RANGE_BYTES);
  if (!probeBytes) return null;

  const probed = parseDimensions(probeBytes);
  if (probed) return probed;

  // The probe read came back shorter than requested -- that IS the whole
  // object (R2 never pads a ranged read), so a header that still didn't
  // parse means the image is genuinely corrupt/unsupported, not merely
  // truncated by our own range. No point re-fetching the same bytes.
  if (probeBytes.byteLength < DIMENSION_PROBE_RANGE_BYTES) return null;

  const fallbackBytes = await readLeadingBytes(bucket, objectKey, DIMENSION_PROBE_FALLBACK_BYTES);
  if (!fallbackBytes) return null;
  return parseDimensions(fallbackBytes);
}

/** One media row's identity + the fields `measureOriginalDimensions`
 * needs -- deliberately narrow (not the full `DbMediaRow`) so this module
 * stays independently testable from `manifest.ts`'s DB row shape. */
export interface DimensionMeasurementJob {
  /** `memory_media.id` -- the map key the caller threads back into
   * `buildAssetsForMemory`. */
  id: string;
  /** `memory_media.object_key` -- the ORIGINAL object, never
   * `preview_object_key` (the exported/referenced file). */
  objectKey: string;
  contentType: string;
}

/**
 * Measures every image job's original dimensions with bounded concurrency,
 * returning a `{ [mediaId]: dimensions }` map that only contains entries
 * for jobs that actually resolved -- silently omits (never a placeholder
 * or a thrown error) any job whose original couldn't be measured, or whose
 * `contentType` isn't an image at all (a `video-poster` job's `objectKey`
 * is the ORIGINAL VIDEO file -- `image-size` would just fail on it, same
 * posture as `measureOriginalDimensions`'s own `contentType.startsWith
 * ('image/')` guard in the eval CLI -- so this skips the R2 read entirely
 * for those rather than spending a subrequest on a call that can only
 * fail).
 */
export async function measureOriginalDimensionsForJobs(
  bucket: R2Bucket,
  jobs: DimensionMeasurementJob[],
  concurrency: number = DIMENSION_MEASURE_CONCURRENCY,
): Promise<Record<string, OriginalDimensions>> {
  const results: Record<string, OriginalDimensions> = {};
  const imageJobs = jobs.filter((job) => job.contentType.startsWith('image/'));

  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < imageJobs.length) {
      const index = nextIndex;
      nextIndex += 1;
      const job = imageJobs[index];
      const dimensions = await measureOriginalDimensions(bucket, job.objectKey);
      if (dimensions) results[job.id] = dimensions;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, imageJobs.length) }, () => worker()));
  return results;
}
