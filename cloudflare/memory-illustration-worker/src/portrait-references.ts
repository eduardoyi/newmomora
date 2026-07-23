import type { LoadedReference, PortraitLoadedReferences } from './types';

const MAX_REFERENCE_EDGE = 1024;

export class PortraitReferenceError extends Error {
  constructor(public readonly code: 'SOURCE_REFERENCE_UNAVAILABLE' | 'STYLE_REFERENCE_UNAVAILABLE') {
    super(code);
  }
}

async function loadAndResizeReference(
  bucket: R2Bucket,
  env: Env,
  key: string,
): Promise<ArrayBuffer | null> {
  try {
    const object = await bucket.get(key);
    if (!object?.body) return null;

    const transformed = await env.IMAGES
      .input(object.body)
      .transform({ width: MAX_REFERENCE_EDGE, height: MAX_REFERENCE_EDGE, fit: 'scale-down' })
      .output({ format: 'image/webp', quality: 85 });
    return await new Response(transformed.image()).arrayBuffer();
  } catch {
    return null;
  }
}

/**
 * Portrait generation intentionally has no profile/portrait fallback. Both
 * frozen references are required to preserve the subject and style contract.
 */
export async function loadPortraitReferences(
  env: Env,
  sourcePhotoKey: string,
  styleReferenceKey: string,
): Promise<PortraitLoadedReferences> {
  const styleBytes = await loadAndResizeReference(env.STYLE_REFERENCES, env, styleReferenceKey);
  if (!styleBytes) throw new PortraitReferenceError('STYLE_REFERENCE_UNAVAILABLE');

  const sourceBytes = await loadAndResizeReference(env.PROFILE_PICTURES, env, sourcePhotoKey);
  if (!sourceBytes) throw new PortraitReferenceError('SOURCE_REFERENCE_UNAVAILABLE');

  const style: LoadedReference = { description: 'The canonical Momora illustration style.', bytes: styleBytes };
  const source: LoadedReference = { description: 'The person whose portrait is being created.', bytes: sourceBytes };
  return { style, source };
}
