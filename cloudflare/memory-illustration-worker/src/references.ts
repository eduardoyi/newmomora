import { sniffImageFormat } from './image-output';
import type { LoadedReference, ReferenceCandidate } from './types';

const MAX_REFERENCE_EDGE = 1024;
// OpenAI accepts up to 50MB per input image; stay well under it.
const MAX_ORIGINAL_REFERENCE_BYTES = 20 * 1024 * 1024;

/**
 * Reads a reference from R2 and downsizes it via the Images binding. The
 * resize is only an upload-size optimization, so when the binding fails
 * (2026-11-06: IMAGES_TRANSFORM_ERROR 9523 on every call, which failed every
 * new portrait) the original png/jpeg/webp bytes are used instead. Null only
 * when the object is missing/unreadable or its bytes are not an image OpenAI
 * accepts.
 */
export async function loadAndResizeReference(bucket: R2Bucket, env: Env, key: string): Promise<ArrayBuffer | null> {
  let original: ArrayBuffer;
  try {
    const object = await bucket.get(key);
    if (!object?.body) {
      return null;
    }
    original = await new Response(object.body).arrayBuffer();
  } catch {
    return null;
  }

  try {
    const transformed = await env.IMAGES
      .input(new Blob([original]).stream())
      .transform({ width: MAX_REFERENCE_EDGE, height: MAX_REFERENCE_EDGE, fit: 'scale-down' })
      .output({ format: 'image/webp', quality: 85 });
    return await new Response(transformed.image()).arrayBuffer();
  } catch (error) {
    if (sniffImageFormat(new Uint8Array(original)) === null || original.byteLength > MAX_ORIGINAL_REFERENCE_BYTES) {
      // A single corrupt reference must not prevent the other tagged members from rendering.
      return null;
    }
    console.error('reference resize failed; using original bytes', error instanceof Error ? error.message : String(error));
    return original;
  }
}

export async function loadIllustrationReferences(
  env: Env,
  candidates: ReferenceCandidate[],
): Promise<LoadedReference[]> {
  // Members load concurrently (each is an R2 read plus an Images transform);
  // the result keeps candidate order because it maps reference indexes in the
  // prompt.
  const loaded = await Promise.all(candidates.map(async (candidate): Promise<LoadedReference | null> => {
    const portrait = candidate.portraitKey
      ? await loadAndResizeReference(env.CHARACTER_PORTRAITS, env, candidate.portraitKey)
      : null;
    const bytes = portrait ?? (candidate.profileKey
      ? await loadAndResizeReference(env.PROFILE_PICTURES, env, candidate.profileKey)
      : null);
    return bytes ? { description: candidate.description, bytes } : null;
  }));

  return loaded.filter((reference): reference is LoadedReference => reference !== null);
}
