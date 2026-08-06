// ── Real-bytes format sniffing (source-of-the-mismatch fix, worker side) ───
// OpenAI's images/edits endpoint has been observed to ignore
// `output_format: 'webp'` and return PNG (or JPEG) bytes anyway -- see
// openai.ts's editImageWithUsage for the call site that requests webp
// output, and compose-share-card/index.ts's `resolveImageMimeType` header
// comment for the production-incident history (a satori "Invalid WebP"
// crash, then a multi-MB PNG payload bloat once the crash itself was
// defended against by sniffing on the READ side).
//
// The sniffing logic below is kept deliberately in sync with
// supabase/functions/_shared/image-bytes.ts's `sniffImageFormat` (same
// three formats, same thresholds) -- "is this really webp" must mean the
// same thing on both runtimes. The FIX differs here, though: this worker's
// `outputKey` is minted Supabase-side, always `.webp`, and is woven through
// the bridge upload-lease/publish/reconcile protocol, so the key cannot be
// renamed the way the Supabase fix renames non-webp output to `.jpg`.
// Instead, this module re-encodes non-webp bytes to real webp (via the
// Cloudflare Images binding, already used for reference loading in
// references.ts) so the bytes always match the fixed `.webp` key.
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
 * that -- see `resolveOutputBytesForR2`'s fail-open handling). */
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

export interface ResolvedR2Output {
  bytes: ArrayBuffer;
  contentType: string;
}

const WEBP_QUALITY = 85;

async function reencodeToWebp(env: Env, bytes: ArrayBuffer): Promise<ArrayBuffer> {
  const transformed = await env.IMAGES
    .input(new Blob([bytes]).stream())
    .output({ format: 'image/webp', quality: WEBP_QUALITY });
  return await new Response(transformed.image()).arrayBuffer();
}

/**
 * Resolves what should actually be stored in R2 for a generated illustration
 * or portrait, given the fixed `.webp` `outputKey` this worker must write to
 * (see this module's header comment for why the key can't change).
 *
 *  - Real webp bytes: stored unchanged (the expected/requested case).
 *  - Real PNG or JPEG bytes: re-encoded to webp via the Images binding so
 *    the stored bytes match the `.webp` key's implied format.
 *  - Re-encode throws: fails open to the ORIGINAL bytes under their real
 *    sniffed content type (never a false `image/webp` label) -- a paid,
 *    successful image generation must not become a hard failure because of
 *    a storage-format guess, and a truthful Content-Type is strictly better
 *    than a false one. The read side (compose-share-card) already sniffs
 *    bytes defensively rather than trusting Content-Type.
 *  - Unrecognized bytes: stored unchanged under `image/webp` (pre-fix
 *    behavior; should not happen against the real OpenAI image APIs).
 *
 * Never throws.
 */
export async function resolveOutputBytesForR2(env: Env, bytes: ArrayBuffer): Promise<ResolvedR2Output> {
  const sniffed = sniffImageFormat(new Uint8Array(bytes));

  if (sniffed === 'webp' || sniffed === null) {
    return { bytes, contentType: 'image/webp' };
  }

  try {
    const reencoded = await reencodeToWebp(env, bytes);
    return { bytes: reencoded, contentType: 'image/webp' };
  } catch (error) {
    console.error(
      'resolveOutputBytesForR2 re-encode failed',
      error instanceof Error ? error.message : 'unknown',
    );
    return { bytes, contentType: sniffed === 'png' ? 'image/png' : 'image/jpeg' };
  }
}
