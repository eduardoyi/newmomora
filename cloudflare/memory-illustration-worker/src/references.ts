import type { LoadedReference, ReferenceCandidate } from './types';

const MAX_REFERENCE_EDGE = 1024;

async function loadAndResizeReference(bucket: R2Bucket, env: Env, key: string): Promise<ArrayBuffer | null> {
  try {
    const object = await bucket.get(key);
    if (!object?.body) {
      return null;
    }

    const transformed = await env.IMAGES
      .input(object.body)
      .transform({ width: MAX_REFERENCE_EDGE, height: MAX_REFERENCE_EDGE, fit: 'scale-down' })
      .output({ format: 'image/webp', quality: 85 });
    return await new Response(transformed.image()).arrayBuffer();
  } catch {
    // A single corrupt/missing reference must not prevent the other tagged members from rendering.
    return null;
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
