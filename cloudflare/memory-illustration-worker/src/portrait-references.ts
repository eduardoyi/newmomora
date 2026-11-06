import { loadAndResizeReference } from './references';
import type { LoadedReference, PortraitLoadedReferences } from './types';

export class PortraitReferenceError extends Error {
  constructor(public readonly code: 'SOURCE_REFERENCE_UNAVAILABLE' | 'STYLE_REFERENCE_UNAVAILABLE') {
    super(code);
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
  // Load both at once; the style check still wins when both are missing.
  const [styleBytes, sourceBytes] = await Promise.all([
    loadAndResizeReference(env.STYLE_REFERENCES, env, styleReferenceKey),
    loadAndResizeReference(env.PROFILE_PICTURES, env, sourcePhotoKey),
  ]);
  if (!styleBytes) throw new PortraitReferenceError('STYLE_REFERENCE_UNAVAILABLE');
  if (!sourceBytes) throw new PortraitReferenceError('SOURCE_REFERENCE_UNAVAILABLE');

  const style: LoadedReference = { description: 'The canonical Momora illustration style.', bytes: styleBytes };
  const source: LoadedReference = { description: 'The person whose portrait is being created.', bytes: sourceBytes };
  return { style, source };
}
