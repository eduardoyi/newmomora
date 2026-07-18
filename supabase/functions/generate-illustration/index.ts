import { describeAgeAtDate } from '../_shared/age.ts';
import { getAuthenticatedUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { getCallerFamilyRole, isManagerRole } from '../_shared/family-access.ts';
import { stripUrls } from '../_shared/link-preview.ts';
import { chatJson, editImageWithReferences } from '../_shared/openai.ts';
import {
  prepareIllustrationReferences,
  sortMembersByTagOrder,
} from '../_shared/illustration-references.ts';
import {
  buildIllustrationPrompt,
  buildSafetySystemPrompt,
  EMOTION_PALETTES,
  normalizeEmotion,
  type SafetyPromptMember,
} from '../_shared/prompts.ts';
import {
  DEFAULT_ILLUSTRATION_STYLE_TOKEN,
  getStyleDescription,
} from '../_shared/styles.ts';
import { deleteObject, getObjectBytes, putObjectBytes } from '../_shared/r2.ts';
import { buildMemoryIllustrationKey } from '../_shared/storage-keys.ts';
import { resolveMemberIdsForIllustration } from '../_shared/illustration-members.ts';
import { isIllustrationGenerationStale } from '../_shared/illustration-status.ts';
import { createUserClient } from '../_shared/supabase-admin.ts';
import {
  type PortraitVersionCandidate,
  resolvePortraitVersionAtDate,
} from '../_shared/portrait-versions.ts';

export interface GenerateIllustrationRequest {
  memoryId: string;
  colorPalette?: string;
  /** When true, regenerate even if an illustration is already ready. */
  forceRegenerate?: boolean;
}

export interface GenerateIllustrationResponse {
  success: true;
  illustrationKey: string;
  illustrationGenerationId: string;
}

const EMPTY_MEMBER_ID = '00000000-0000-4000-8000-000000000000';
const MAX_ILLUSTRATION_MEMBERS = 6;
// Supabase's 150-second request-idle limit leaves 30 seconds for the
// un-aborted immutable upload, CAS publication, and claim cleanup.
const SUPABASE_REQUEST_IDLE_LIMIT_MS = 150_000;
const ILLUSTRATION_FINALIZATION_RESERVE_MS = 30_000;
export const ILLUSTRATION_GENERATION_TIMEOUT_MS =
  SUPABASE_REQUEST_IDLE_LIMIT_MS - ILLUSTRATION_FINALIZATION_RESERVE_MS;
const ALLOWED_EXPRESSION_STYLES = new Set(['comedic', 'tender', 'neutral']);
type ExpressionStyle = 'comedic' | 'tender' | 'neutral';

export function getIllustrationImageRequestOptions(referenceCount: number) {
  const isLargeReferenceSet = referenceCount >= 3;

  return {
    // `auto` can choose a costly output for a multi-character edit. Medium
    // keeps a polished final illustration while making that tail predictable;
    // we deliberately do not trade family-image quality down to `low`.
    quality: isLargeReferenceSet ? ('medium' as const) : undefined,
    // Illustration keys and R2 metadata are .webp/image-webp. Request the
    // same format instead of storing default PNG bytes under that identity.
    outputFormat: 'webp' as const,
    outputCompression: 85,
    // Do not cut off a healthy primary at a fixed point. For the slow
    // multi-character tail, start the compatible fallback halfway through
    // the pre-finalization budget and publish whichever edit completes.
    fallbackHedgeDelayMs: isLargeReferenceSet ? 55_000 : undefined,
  };
}

export interface GenerateIllustrationDependencies {
  getObjectBytes: typeof getObjectBytes;
  putObjectBytes: typeof putObjectBytes;
  deleteObject: typeof deleteObject;
  chatJson: typeof chatJson;
  editImageWithReferences: typeof editImageWithReferences;
  createId: () => string;
  generationTimeoutMs: number;
}

const DEFAULT_DEPENDENCIES: GenerateIllustrationDependencies = {
  getObjectBytes,
  putObjectBytes,
  deleteObject,
  chatJson,
  editImageWithReferences,
  createId: () => crypto.randomUUID(),
  generationTimeoutMs: ILLUSTRATION_GENERATION_TIMEOUT_MS,
};

interface CommitIllustrationGenerationInput {
  oldKey: string | null;
  newKey: string;
  bytes: Uint8Array;
  put: (key: string, bytes: Uint8Array, contentType: string) => Promise<void>;
  remove: (key: string) => Promise<void>;
  commitDatabase: () => Promise<boolean>;
  reconcileDatabase: () => Promise<boolean | null>;
}

/**
 * Publishes immutable bytes before the checked DB pointer swap. A failed or
 * superseded swap removes only the new object; the old DB pointer/object stay
 * intact. The old object is deleted only after the new pointer is committed.
 */
export async function commitIllustrationGeneration({
  oldKey,
  newKey,
  bytes,
  put,
  remove,
  commitDatabase,
  reconcileDatabase,
}: CommitIllustrationGenerationInput): Promise<void> {
  await put(newKey, bytes, 'image/webp');

  let didCommit = false;
  try {
    didCommit = await commitDatabase();
    if (!didCommit) throw new Error('Illustration generation was superseded');
  } catch (error) {
    let reconciliation: boolean | null = null;
    try {
      reconciliation = await reconcileDatabase();
    } catch {
      // Ambiguous reconciliation keeps the immutable new object. An orphan is
      // safer than deleting bytes a committed DB row may reference.
    }

    if (reconciliation === true) {
      didCommit = true;
    } else {
      if (reconciliation === false) {
        try {
          await remove(newKey);
        } catch {
          // Best effort orphan cleanup. Never touch the prior object here.
        }
      }
      throw error;
    }
  }

  if (oldKey && oldKey !== newKey) {
    try {
      await remove(oldKey);
    } catch {
      // Best effort cleanup after the authoritative DB swap.
    }
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException('Illustration generation aborted', 'AbortError');
  }
}

function logGenerationPhase(memoryId: string, phase: string, startedAt: number): void {
  console.info('generate-illustration phase complete', {
    memoryId,
    phase,
    durationMs: Date.now() - startedAt,
  });
}

function remainingPreFinalizationDeadlineMs(
  preFinalizationDeadlineMs: number,
  requestStartedAt: number,
): number {
  return Math.max(1, preFinalizationDeadlineMs - (Date.now() - requestStartedAt));
}

export async function handleGenerateIllustration(
  req: Request,
  dependencyOverrides: Partial<GenerateIllustrationDependencies> = {},
): Promise<Response> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const corsResponse = handleCors(req);
  if (corsResponse) {
    return corsResponse;
  }

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405, 'method_not_allowed');
  }

  const requestStartedAt = Date.now();

  const user = await getAuthenticatedUser(req);
  if (!user) {
    return errorResponse('Unauthorized', 401, 'unauthorized');
  }

  let body: GenerateIllustrationRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }

  const { memoryId, colorPalette, forceRegenerate = false } = body;

  if (!memoryId || typeof memoryId !== 'string') {
    return errorResponse('memoryId is required', 400, 'validation_error');
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return errorResponse('Unauthorized', 401, 'unauthorized');
  }

  const supabase = createUserClient(authHeader);

  const { data: memory, error: memoryError } = await supabase
    .from('memories')
    .select(
      'id, family_id, content, memory_date, emotion, illustration_key, illustration_generation_id, illustration_generation_attempt_id, illustration_status, updated_at, memory_type',
    )
    .eq('id', memoryId)
    .maybeSingle();

  if (memoryError) {
    console.error('generate-illustration memory lookup failed', memoryError.message);
    return errorResponse('Failed to load memory', 500, 'internal_error');
  }

  if (!memory) {
    return errorResponse('Memory not found', 404, 'MEMORY_NOT_FOUND');
  }

  const callerRole = await getCallerFamilyRole(supabase, memory.family_id, user.id);
  if (!isManagerRole(callerRole)) {
    return errorResponse('Not authorized for this memory', 403, 'forbidden');
  }

  if (memory.memory_type !== 'text_illustration' || !memory.content?.trim()) {
    return errorResponse(
      'Illustration only supported for text_illustration memories',
      400,
      'invalid_memory_type',
    );
  }

  if (
    !forceRegenerate &&
    memory.illustration_status === 'ready' &&
    memory.illustration_key &&
    memory.illustration_generation_id
  ) {
    const response: GenerateIllustrationResponse = {
      success: true,
      illustrationKey: memory.illustration_key,
      illustrationGenerationId: memory.illustration_generation_id,
    };
    return jsonResponse(response);
  }

  if (
    !forceRegenerate &&
    memory.illustration_status === 'generating' &&
    !isIllustrationGenerationStale(memory.illustration_status, memory.updated_at)
  ) {
    return errorResponse('Illustration generation in progress', 409, 'GENERATION_IN_PROGRESS');
  }

  const generationAttemptId = dependencies.createId();
  let startUpdate = supabase
    .from('memories')
    .update({
      illustration_status: 'generating',
      illustration_generation_attempt_id: generationAttemptId,
    })
    .eq('id', memoryId)
    .eq('content', memory.content)
    .eq('memory_date', memory.memory_date)
    .eq('memory_type', memory.memory_type)
    .eq('illustration_status', memory.illustration_status);

  startUpdate = memory.emotion
    ? startUpdate.eq('emotion', memory.emotion)
    : startUpdate.is('emotion', null);
  startUpdate = memory.illustration_generation_id
    ? startUpdate.eq('illustration_generation_id', memory.illustration_generation_id)
    : startUpdate.is('illustration_generation_id', null);
  startUpdate = memory.illustration_generation_attempt_id
    ? startUpdate.eq('illustration_generation_attempt_id', memory.illustration_generation_attempt_id)
    : startUpdate.is('illustration_generation_attempt_id', null);
  startUpdate = memory.illustration_key
    ? startUpdate.eq('illustration_key', memory.illustration_key)
    : startUpdate.is('illustration_key', null);

  const { data: startedMemory, error: startError } = await startUpdate
    .select('id')
    .maybeSingle();

  if (startError) {
    console.error('generate-illustration start update failed', startError.message);
    return errorResponse('Failed to start illustration generation', 500, 'internal_error');
  }
  if (!startedMemory) {
    return errorResponse('Illustration generation was superseded', 409, 'GENERATION_SUPERSEDED');
  }

  const generationStartedAt = Date.now();
  const generationController = new AbortController();
  let generationPhase = 'preparation';
  // Keep a small, bounded portion of the one claim-scoped budget for the
  // immutable upload + checked DB swap. Aborting those operations can make an
  // upload outcome ambiguous; the existing commit helper is deliberately
  // allowed to finish or reconcile that finalization safely.
  const generationTimeoutId = setTimeout(() => {
    generationController.abort('Illustration generation deadline exceeded');
    console.warn('generate-illustration deadline reached', {
      memoryId,
      phase: generationPhase,
      durationMs: Date.now() - generationStartedAt,
    });
  }, remainingPreFinalizationDeadlineMs(dependencies.generationTimeoutMs, requestStartedAt));
  let generationSucceeded = false;

  try {
    throwIfAborted(generationController.signal);
    const tagPhaseStartedAt = Date.now();
    const { data: tagRows, error: tagError } = await supabase
      .from('memory_family_members')
      .select('family_member_id')
      .eq('memory_id', memoryId)
      .abortSignal(generationController.signal);

    throwIfAborted(generationController.signal);
    if (tagError) {
      console.error('generate-illustration tag lookup failed', tagError.message);
      return errorResponse('Failed to load memory tags', 500, 'internal_error');
    }
    logGenerationPhase(memoryId, 'tags', tagPhaseStartedAt);

    const taggedMemberIds = (tagRows ?? []).map((row) => row.family_member_id);

    if (taggedMemberIds.length > MAX_ILLUSTRATION_MEMBERS) {
      return errorResponse(
        `AI illustrations support up to ${MAX_ILLUSTRATION_MEMBERS} family members`,
        400,
        'ILLUSTRATION_MEMBER_LIMIT',
      );
    }

    // Always load name/nickname rows for the whole family: used both for the
    // no-tag fallback member match below and for the safety-rewrite nickname
    // mapping, so any nickname mentioned in the text gets resolved even for
    // members that aren't tagged on this memory.
    generationPhase = 'family-member-lookup';
    const memberLookupPhaseStartedAt = Date.now();
    const { data: nameRows, error: nameRowsError } = await supabase
      .from('family_members')
      .select('id, name, nicknames')
      .eq('family_id', memory.family_id)
      .abortSignal(generationController.signal);

    throwIfAborted(generationController.signal);
    if (nameRowsError) {
      console.error('generate-illustration name lookup failed', nameRowsError.message);
      return errorResponse('Failed to load family members', 500, 'internal_error');
    }

    // URLs can't match member names, but strip for consistency with every
    // other content->prompt call site (docs/plans/inline-links.md §8).
    const memberIds = resolveMemberIdsForIllustration(
      taggedMemberIds,
      stripUrls(memory.content),
      nameRows ?? [],
      MAX_ILLUSTRATION_MEMBERS,
    );

    const { data: members, error: membersError } = await supabase
      .from('family_members')
      .select('id, name, nicknames, date_of_birth, gender, additional_info')
      .eq('family_id', memory.family_id)
      .in('id', memberIds.length > 0 ? memberIds : [EMPTY_MEMBER_ID])
      .abortSignal(generationController.signal);

    throwIfAborted(generationController.signal);
    if (membersError) {
      console.error('generate-illustration members lookup failed', membersError.message);
      return errorResponse('Failed to load family members', 500, 'internal_error');
    }

    const { data: portraitVersions, error: portraitVersionsError } = await supabase
      .from('family_member_portrait_versions')
      .select(
        'id, family_member_id, reference_date, profile_picture_key, illustrated_profile_key, illustrated_profile_status, deletion_token, created_at',
        )
        .in('family_member_id', memberIds.length > 0 ? memberIds : [EMPTY_MEMBER_ID])
        .not('illustrated_profile_key', 'is', null)
        .abortSignal(generationController.signal);

    throwIfAborted(generationController.signal);
    if (portraitVersionsError) {
      console.error('generate-illustration portrait lookup failed', portraitVersionsError.message);
      return errorResponse('Failed to load character portraits', 500, 'internal_error');
    }
    logGenerationPhase(memoryId, generationPhase, memberLookupPhaseStartedAt);

    const versionsByMember = new Map<string, PortraitVersionCandidate[]>();
    for (const portraitVersion of (portraitVersions ?? []) as PortraitVersionCandidate[]) {
      const current = versionsByMember.get(portraitVersion.family_member_id) ?? [];
      current.push(portraitVersion);
      versionsByMember.set(portraitVersion.family_member_id, current);
    }

    const readyMembers = sortMembersByTagOrder(
      (members ?? []).flatMap((member) => {
        const selected = resolvePortraitVersionAtDate(
          versionsByMember.get(member.id) ?? [],
          memory.memory_date,
        );
        return selected
          ? [
              {
                ...member,
                illustrated_profile_key: selected.illustrated_profile_key,
                profile_picture_key: selected.profile_picture_key,
              },
            ]
          : [];
      }),
      memberIds,
    );

    if (readyMembers.length === 0) {
      return errorResponse('No ready character portraits for tagged members', 400, 'NO_PORTRAITS');
    }

    // A URL-only memory passes the raw-content check at the top of the
    // handler but would produce an empty scene description once URLs are
    // stripped for the prompt -- never let that reach the safety rewrite or
    // the image API (docs/plans/inline-links.md §8).
    const strippedContent = stripUrls(memory.content);

    if (!strippedContent.trim()) {
      return errorResponse('Illustration requires descriptive text, not just a link', 400, 'EMPTY_CONTENT');
    }

    generationPhase = 'style-lookup';
    const stylePhaseStartedAt = Date.now();
    const { data: family } = await supabase
      .from('families')
      .select('illustration_style')
      .eq('id', memory.family_id)
      .abortSignal(generationController.signal)
      .maybeSingle();
    throwIfAborted(generationController.signal);
    logGenerationPhase(memoryId, generationPhase, stylePhaseStartedAt);

    const styleDescription = getStyleDescription(
      family?.illustration_style ?? DEFAULT_ILLUSTRATION_STYLE_TOKEN,
    );

    const illustrationGenerationId = dependencies.createId();
    const illustrationKey = buildMemoryIllustrationKey(user.id, memoryId, illustrationGenerationId);
    const normalizedEmotion = normalizeEmotion(memory.emotion);
    const resolvedPalette =
      colorPalette ??
      (normalizedEmotion ? EMOTION_PALETTES[normalizedEmotion] : undefined) ??
      EMOTION_PALETTES.tender;

    generationPhase = 'safety-precheck';
    const safetyPhaseStartedAt = Date.now();
    const safetyMembers: SafetyPromptMember[] = nameRows ?? [];
    const safety = await dependencies.chatJson<{
      safeDescription?: string;
      expressionStyle?: string;
    }>(buildSafetySystemPrompt(safetyMembers), strippedContent, {
      signal: generationController.signal,
    });
    throwIfAborted(generationController.signal);
    logGenerationPhase(memoryId, generationPhase, safetyPhaseStartedAt);

    const safeDescription = safety.safeDescription?.trim() || strippedContent.slice(0, 280);
    const expressionStyle: ExpressionStyle = ALLOWED_EXPRESSION_STYLES.has(safety.expressionStyle ?? '')
      ? (safety.expressionStyle as ExpressionStyle)
      : 'neutral';
    generationPhase = 'portrait-reference-preparation';
    const referencePhaseStartedAt = Date.now();
    const { characterReferences, referenceImages } = await prepareIllustrationReferences(
      readyMembers,
      memory.memory_date,
      dependencies.getObjectBytes,
      { signal: generationController.signal },
    );
    throwIfAborted(generationController.signal);
    logGenerationPhase(memoryId, generationPhase, referencePhaseStartedAt);

    if (referenceImages.length === 0) {
      throw new Error('Failed to load portrait references for tagged members');
    }

    const prompt = buildIllustrationPrompt({
      safeSceneDescription: safeDescription,
      characterReferences,
      colorPalette: resolvedPalette,
      emotion: memory.emotion,
      expressionStyle,
      memoryDate: memory.memory_date,
      styleDescription,
    });

    generationPhase = 'image-generation';
    const imagePhaseStartedAt = Date.now();
    const illustrationBytes = await dependencies.editImageWithReferences(prompt, referenceImages, {
      signal: generationController.signal,
      ...getIllustrationImageRequestOptions(referenceImages.length),
    });
    throwIfAborted(generationController.signal);
    logGenerationPhase(memoryId, generationPhase, imagePhaseStartedAt);

    // Do not pass an abort signal into immutable upload/CAS finalization. The
    // timer has reserved intended publication headroom so a
    // provider timeout cannot leave an ambiguous publication result.
    clearTimeout(generationTimeoutId);
    generationPhase = 'publication';
    const publicationPhaseStartedAt = Date.now();
    await commitIllustrationGeneration({
      oldKey: memory.illustration_key,
      newKey: illustrationKey,
      bytes: illustrationBytes,
      put: dependencies.putObjectBytes,
      remove: dependencies.deleteObject,
      commitDatabase: async () => {
        const { data: committedMemory, error: commitError } = await supabase
          .from('memories')
          .update({
            illustration_key: illustrationKey,
            illustration_generation_id: illustrationGenerationId,
            illustration_generation_attempt_id: null,
            illustration_prompt: prompt,
            illustration_status: 'ready',
          })
          .eq('id', memoryId)
          .eq('illustration_generation_attempt_id', generationAttemptId)
          .eq('illustration_status', 'generating')
          .select('id')
          .maybeSingle();

        if (commitError) {
          console.error('generate-illustration commit update failed', commitError.message);
          throw new Error('Failed to commit illustration generation');
        }
        return Boolean(committedMemory);
      },
      reconcileDatabase: async () => {
        const { data: currentMemory, error: reconcileError } = await supabase
          .from('memories')
          .select('illustration_key, illustration_generation_id')
          .eq('id', memoryId)
          .maybeSingle();
        if (reconcileError) {
          console.error('generate-illustration commit reconciliation failed', reconcileError.message);
          return null;
        }
        return Boolean(
          currentMemory?.illustration_key === illustrationKey &&
          currentMemory.illustration_generation_id === illustrationGenerationId,
        );
      },
    });
    logGenerationPhase(memoryId, generationPhase, publicationPhaseStartedAt);

    generationSucceeded = true;

    const response: GenerateIllustrationResponse = {
      success: true,
      illustrationKey,
      illustrationGenerationId,
    };

    return jsonResponse(response);
  } catch (error) {
    console.error('generate-illustration failed', error instanceof Error ? error.message : 'unknown');

    if (generationController.signal.aborted) {
      return errorResponse('Illustration generation timed out. Please try again.', 504, 'GENERATION_TIMEOUT');
    }

    return errorResponse('Illustration generation failed', 500, 'GENERATION_FAILED');
  } finally {
    clearTimeout(generationTimeoutId);
    if (!generationSucceeded) {
      await supabase
        .from('memories')
        .update({
          illustration_status:
            memory.illustration_key && memory.illustration_generation_id ? 'ready' : 'failed',
          illustration_generation_attempt_id: null,
        })
        .eq('id', memoryId)
        .eq('illustration_generation_attempt_id', generationAttemptId)
        .eq('illustration_status', 'generating');
    }
  }
}

if (import.meta.main) {
  Deno.serve((request) => handleGenerateIllustration(request));
}
