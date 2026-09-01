/**
 * Cover-candidate vision-verification pass, ported from
 * supabase/scripts/eval-memory-book-outline.ts's `verifyCoverCandidates` --
 * same fail-open posture (any total failure keeps every original
 * candidate), same per-candidate fail-open on a missing/unfetchable thumb.
 * The eval CLI fetches thumbnails via presigned R2 GET URLs
 * (`getObjectBytesBatch`); this worker instead reads them directly off the
 * `MEMORY_BOOK_PREVIEWS` R2 binding (the Worker-native equivalent -- same
 * bucket, see wrangler.jsonc's comment).
 */
import {
  applyCoverVerifyVerdicts,
  buildCoverVerifyRequestBody,
  buildCoverVerifySystemPrompt,
  buildCoverVerifyUserText,
  parseCoverVerifyResponse,
  sumOpenAiUsage,
  type CoverVerifyImageInput,
  type OpenAiUsage,
  type OutlineIntegrityViolation,
} from '../../../supabase/functions/_shared/memory-book-outline.ts';
import { callOpenAiChat, DEFAULT_OUTLINE_MODEL } from './openai';
import type { Env } from './types';

function contentTypeFromObjectKey(key: string): 'image/jpeg' | 'image/png' | 'image/webp' {
  const lower = key.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

function bytesToBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < view.length; i += chunkSize) {
    binary += String.fromCharCode(...view.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export interface CoverVerifyResult {
  coverCandidates: string[];
  violations: OutlineIntegrityViolation[];
  usage: OpenAiUsage | null;
}

export async function verifyCoverCandidates(
  env: Env,
  candidateIds: string[],
  previewKeyByMemoryId: Map<string, string | null>,
  model: string = DEFAULT_OUTLINE_MODEL,
): Promise<CoverVerifyResult> {
  if (candidateIds.length === 0) {
    return { coverCandidates: [], violations: [], usage: null };
  }

  const previewKeyById = new Map<string, string>();
  for (const id of candidateIds) {
    const previewKey = previewKeyByMemoryId.get(id);
    if (previewKey) previewKeyById.set(id, previewKey);
  }

  const images: CoverVerifyImageInput[] = [];
  const indexToId = new Map<number, string>();
  const violations: OutlineIntegrityViolation[] = [];
  let index = 0;

  for (const id of candidateIds) {
    const key = previewKeyById.get(id);
    if (!key) {
      violations.push({ kind: 'cover_verify_thumb_unavailable', detail: id });
      continue;
    }
    let object: R2ObjectBody | null;
    try {
      object = await env.MEMORY_BOOK_PREVIEWS.get(key);
    } catch {
      object = null;
    }
    if (!object) {
      violations.push({ kind: 'cover_verify_thumb_unavailable', detail: id });
      continue;
    }
    const bytes = await object.arrayBuffer();
    images.push({ index, base64: bytesToBase64(bytes), contentType: contentTypeFromObjectKey(key) });
    indexToId.set(index, id);
    index += 1;
  }

  if (images.length === 0) {
    violations.push({ kind: 'cover_verify_unparseable', detail: 'no fetchable thumbnails; kept all candidates' });
    return { coverCandidates: candidateIds, violations, usage: null };
  }

  const systemPrompt = buildCoverVerifySystemPrompt();
  const userText = buildCoverVerifyUserText(images.length);
  const body = buildCoverVerifyRequestBody(systemPrompt, userText, images, model);

  let verdicts = null;
  let usage: OpenAiUsage | null = null;
  try {
    const result = await callOpenAiChat(env, body);
    usage = result.usage;
    const parsed: unknown = JSON.parse(result.content);
    verdicts = parseCoverVerifyResponse(parsed, images.length);
  } catch {
    verdicts = null;
  }

  // Only candidates that actually got a fetched thumbnail (and therefore a
  // real vision judgment) are eligible to survive -- a candidate skipped
  // above for an unfetchable thumbnail was never judged against the
  // disqualification checklist, so it must not fall through as "kept" by
  // default (applyCoverVerifyVerdicts only REMOVES an explicitly
  // disqualified id; passing the full original `candidateIds` here would
  // silently un-exclude every skipped one).
  const judgedCandidateIds = [...indexToId.values()];
  const applied = applyCoverVerifyVerdicts(judgedCandidateIds, indexToId, verdicts);
  return {
    coverCandidates: applied.coverCandidates,
    violations: [...violations, ...applied.violations],
    usage: sumOpenAiUsage(null, usage),
  };
}
