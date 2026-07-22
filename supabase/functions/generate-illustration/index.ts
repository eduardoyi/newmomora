import { getAuthenticatedUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { getCallerFamilyRole, isManagerRole } from '../_shared/family-access.ts';
import { stripUrls } from '../_shared/link-preview.ts';
import { normalizeEmotionLabel } from '../_shared/media-emotion.ts';
import { chatJson, editImageWithReferences } from '../_shared/openai.ts';
import {
  buildMemberIllustrationDescription,
  prepareIllustrationReferences,
  sortMembersByTagOrder,
} from '../_shared/illustration-references.ts';
import {
  buildIllustrationPrompt,
  buildSafetySystemPrompt,
  buildEmotionSystemPrompt,
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
import {
  hasFreshInFlightPortraitVersion,
  type PortraitFreshnessCandidate,
} from '../_shared/portrait-readiness.ts';
import { createServiceClient, createUserClient } from '../_shared/supabase-admin.ts';
import { resolvePortraitVersionAtDate } from '../_shared/portrait-versions.ts';

export interface GenerateIllustrationRequest {
  memoryId: string;
  colorPalette?: string;
  /** Distinguishes user-initiated replacement from automatic recovery. */
  requestIntent?: 'initial' | 'recovery' | 'manual_regenerate';
  /** When true, regenerate even if an illustration is already ready. */
  forceRegenerate?: boolean;
}

export interface GenerateIllustrationResponse {
  success: true;
  illustrationKey: string;
  illustrationGenerationId: string;
}

export interface QueueIllustrationResponse {
  success: true;
  queued: true;
  jobId: string;
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
    // Workflow retries are sequential. Parallel hedging sometimes pays twice
    // for one memory, so it is deliberately disabled for this path.
    fallbackHedgeDelayMs: undefined,
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
  /** Re-invokes this function for a deferred memory once portraits settle. */
  invokeGenerateIllustration: (memoryId: string, authHeader: string) => Promise<void>;
  waitUntil: (task: Promise<void>) => void;
  createServiceClient: typeof createServiceClient;
  fetch: typeof fetch;
  delay: (ms: number) => Promise<void>;
}

export async function defaultInvokeGenerateIllustration(
  memoryId: string,
  authHeader: string,
): Promise<void> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  if (!supabaseUrl) {
    throw new Error('Missing SUPABASE_URL for self-retrigger invoke');
  }

  const response = await fetch(`${supabaseUrl}/functions/v1/generate-illustration`, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ memoryId, requestIntent: 'recovery' }),
  });
  // Always drain the body -- an unconsumed response leaks the underlying
  // Deno resource even when we're about to discard the result.
  await response.text().catch(() => '');

  if (response.status === 409) {
    // GENERATION_IN_PROGRESS/GENERATION_SUPERSEDED: a normal race outcome
    // (e.g. the portrait's own retrigger or a concurrent call already
    // claimed this memory), not a failure worth logging.
    return;
  }

  if (!response.ok) {
    throw new Error(`Self-retrigger invoke failed with status ${response.status}`);
  }
}

const DEFAULT_DEPENDENCIES: GenerateIllustrationDependencies = {
  getObjectBytes,
  putObjectBytes,
  deleteObject,
  chatJson,
  editImageWithReferences,
  createId: () => crypto.randomUUID(),
  generationTimeoutMs: ILLUSTRATION_GENERATION_TIMEOUT_MS,
  invokeGenerateIllustration: defaultInvokeGenerateIllustration,
  waitUntil: (task) =>
    (
      globalThis as unknown as {
        EdgeRuntime: { waitUntil: (task: Promise<void>) => void };
      }
    ).EdgeRuntime.waitUntil(task),
  createServiceClient,
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const CLOUD_FLARE_LEASE_MS = 5 * 60_000;
const CLOUD_FLARE_RECOVERY_GRACE_MS = 30_000;

export function isFreshMatchingWorkflowJob(input: {
  memoryAttemptId: string | null;
  jobAttemptId: string;
  startedAt: string;
  now?: number;
}): boolean {
  const startedAt = Date.parse(input.startedAt);
  return input.memoryAttemptId === input.jobAttemptId && Number.isFinite(startedAt) &&
    (input.now ?? Date.now()) - startedAt < CLOUD_FLARE_LEASE_MS + CLOUD_FLARE_RECOVERY_GRACE_MS;
}

function getIllustrationBackend(): 'legacy' | 'cloudflare' {
  // Keep rollback cheap while installed clients transition away from their
  // old direct status writes. Invalid values intentionally fail closed to the
  // established in-process implementation.
  return Deno.env.get('MEMORY_ILLUSTRATION_BACKEND') === 'cloudflare'
    ? 'cloudflare'
    : 'legacy';
}

async function dispatchWorkflowJob(
  fetchFn: typeof fetch,
  jobId: string,
): Promise<void> {
  const endpoint = Deno.env.get('CLOUDFLARE_ILLUSTRATION_WORKFLOW_URL');
  const dispatchSecret = Deno.env.get('CLOUDFLARE_ILLUSTRATION_DISPATCH_SECRET');
  if (!endpoint || !dispatchSecret) {
    throw new Error('Cloudflare illustration workflow is not configured');
  }

  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const rawBody = JSON.stringify({ jobId });
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(dispatchSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signatureBytes = new Uint8Array(await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`${timestamp}.${nonce}.${rawBody}`),
  ));
  const signature = [...signatureBytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const response = await fetchFn(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-dispatch-timestamp': timestamp,
      'x-dispatch-nonce': nonce,
      'x-dispatch-signature': signature,
    },
    body: rawBody,
  });
  // Drain even 409 duplicate responses so the Edge runtime does not retain a
  // network resource across the retry/recovery path.
  await response.text().catch(() => '');
  // A duplicate Workflow instance is success: the deterministic job ID is
  // deliberately reused after a network-ambiguous dispatch response.
  if (!response.ok && response.status !== 409) {
    throw new Error(`Cloudflare workflow dispatch failed (${response.status})`);
  }
}

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

  const { memoryId, colorPalette, forceRegenerate = false, requestIntent } = body;

  if (!memoryId || typeof memoryId !== 'string') {
    return errorResponse('memoryId is required', 400, 'validation_error');
  }
  if (requestIntent !== undefined &&
    requestIntent !== 'initial' && requestIntent !== 'recovery' && requestIntent !== 'manual_regenerate') {
    return errorResponse('Invalid request intent', 400, 'validation_error');
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return errorResponse('Unauthorized', 401, 'unauthorized');
  }

  const supabase = createUserClient(authHeader);

  let { data: memory, error: memoryError } = await supabase
    .from('memories')
    .select(
      'id, family_id, content, memory_date, emotion, illustration_key, illustration_generation_id, illustration_generation_attempt_id, illustration_status, illustration_generation_started_at, updated_at, memory_type',
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

  const backend = getIllustrationBackend();
  const isExplicitManualRegenerate = requestIntent === 'manual_regenerate';
  if (backend === 'cloudflare' && !isExplicitManualRegenerate) {
    const service = dependencies.createServiceClient();
    const { data: activeJob, error: activeJobError } = await service
      .from('memory_illustration_jobs')
      .select('id, attempt_id, started_at')
      .eq('memory_id', memoryId)
      .in('status', ['queued', 'running'])
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (activeJobError) throw new Error('Failed to load active illustration workflow job');
    if (activeJob && isFreshMatchingWorkflowJob({
      memoryAttemptId: memory.illustration_generation_attempt_id,
      jobAttemptId: activeJob.attempt_id,
      startedAt: activeJob.started_at,
    })) {
      // A legacy app may have directly flipped generating -> pending. The
      // attempt token, not that mutable display status, remains authoritative.
      const { error: restoreError } = await service
        .from('memories')
        .update({ illustration_status: 'generating' })
        .eq('id', memoryId)
        .eq('illustration_generation_attempt_id', activeJob.attempt_id);
      if (restoreError) throw new Error('Failed to restore active illustration status');
      // Re-send the deterministic id on every reuse. A prior request can
      // time out after the job insert but before Cloudflare acknowledged it.
      await dispatchWorkflowJob(dependencies.fetch, activeJob.id);
      return jsonResponse({ success: true, queued: true, jobId: activeJob.id } satisfies QueueIllustrationResponse, 202);
    }
  }

  // New clients no longer run emotion analysis locally.  Do it before the
  // attempt claim: an emotion write intentionally invalidates an in-flight
  // attempt, so doing it after claim would immediately discard our token.
  // Legacy force-regeneration deliberately retains the old behavior and does
  // not reclassify an already analyzed memory.
  let analyzedPalette: string | undefined;
  const shouldAnalyzeMissingEmotion = !memory.emotion &&
    (requestIntent === 'initial' || requestIntent === 'recovery' || !forceRegenerate);
  if (shouldAnalyzeMissingEmotion) {
    for (let analysisAttempt = 0; analysisAttempt < 2; analysisAttempt += 1) {
      try {
        const result = await dependencies.chatJson<{ emotion?: string; colorPalette?: string }>(
          buildEmotionSystemPrompt(),
          stripUrls(memory.content),
        );
        const normalized = normalizeEmotionLabel(result.emotion, EMOTION_PALETTES);
        const emotion = normalized.emotion;
        analyzedPalette = result.colorPalette ?? normalized.colorPalette;
        const service = dependencies.createServiceClient();
        const { data: updated } = await service
          .from('memories')
          .update({ emotion })
          .eq('id', memoryId)
          .eq('updated_at', memory.updated_at)
          .select('id')
          .maybeSingle();
        if (!updated) break; // A real edit won; the normal claim CAS will re-read next time.
        const { data: refreshed } = await supabase
          .from('memories')
          .select('id, family_id, content, memory_date, emotion, illustration_key, illustration_generation_id, illustration_generation_attempt_id, illustration_status, illustration_generation_started_at, updated_at, memory_type')
          .eq('id', memoryId)
          .maybeSingle();
        if (refreshed) memory = refreshed;
        break;
      } catch (error) {
        if (analysisAttempt === 1) {
          console.error('generate-illustration emotion recovery failed', error instanceof Error ? error.message : 'unknown');
          break;
        }
        await dependencies.delay(6_000);
      }
    }
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
    !isIllustrationGenerationStale(
      memory.illustration_status,
      memory.updated_at,
      memory.illustration_generation_started_at,
    )
  ) {
    return errorResponse('Illustration generation in progress', 409, 'GENERATION_IN_PROGRESS');
  }

  const generationAttemptId = dependencies.createId();
  let startUpdate = supabase
    .from('memories')
    .update({
      illustration_status: 'generating',
      illustration_generation_started_at: new Date().toISOString(),
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
  let generationDispatched = false;
  // Once this is true the durable row owns recovery. A network failure after
  // insert is ambiguous: clearing the memory attempt here would make a later
  // idempotently redispatched Workflow unable to publish.
  let durableJobCreated = false;
  // Set only on the fresh-in-flight-portrait deferral path below; read in
  // `finally` (a different block scope from `try`, so it can't be a local
  // there) to decide the reset target and whether to schedule a retrigger.
  let deferredForPortraits = false;
  // Also read in `finally`'s self-retrigger recheck, so it's declared here
  // rather than as a `const` inside `try`.
  let memberIds: string[] = [];
  // Narrowing from the earlier null checks above doesn't carry into a nested
  // function declaration, so alias the already-validated values here.
  const memoryDateForRetriggerRecheck = memory.memory_date;
  const authHeaderForRetrigger = authHeader;

  // Runs only for the no-key deferral path, after the `finally` reset below
  // lands. While this invocation held the CAS claim, the memory read
  // 'generating', so a portrait completing in that window is invisible both
  // to a candidate query keyed on `illustration_status = 'pending'` and to
  // any concurrent caller (which would see `GENERATION_IN_PROGRESS`) -- and
  // the portrait pipeline's own retrigger fires at most once. Re-checking
  // here, after our own reset, closes that race without a second durable
  // mechanism.
  async function selfRetriggerAfterDeferral(): Promise<void> {
    try {
      const { data: recheckVersions, error: recheckError } = await supabase
        .from('family_member_portrait_versions')
        .select(
          'id, family_member_id, reference_date, profile_picture_key, illustrated_profile_key, illustrated_profile_status, deletion_token, generation_token, generation_started_at, created_at',
        )
        .in('family_member_id', memberIds.length > 0 ? memberIds : [EMPTY_MEMBER_ID]);

      if (recheckError) {
        console.error('generate-illustration self-retrigger recheck failed', recheckError.message);
        return;
      }

      const versions = (recheckVersions ?? []) as PortraitFreshnessCandidate[];
      const versionsByMemberRecheck = new Map<string, PortraitFreshnessCandidate[]>();
      for (const version of versions) {
        const current = versionsByMemberRecheck.get(version.family_member_id) ?? [];
        current.push(version);
        versionsByMemberRecheck.set(version.family_member_id, current);
      }

      const someMemberNowReady = memberIds.some(
        (id) =>
          resolvePortraitVersionAtDate(versionsByMemberRecheck.get(id) ?? [], memoryDateForRetriggerRecheck) !==
          null,
      );
      const stillFreshInFlight = hasFreshInFlightPortraitVersion(versions);

      if (!someMemberNowReady && stillFreshInFlight) {
        // Genuinely still generating -- the portrait pipeline's own
        // completion retrigger (out of scope here) will resume this memory.
        return;
      }

      await dependencies.invokeGenerateIllustration(memoryId, authHeaderForRetrigger);
    } catch (error) {
      console.error(
        'generate-illustration self-retrigger failed',
        error instanceof Error ? error.message : 'unknown',
      );
    }
  }

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
    memberIds = resolveMemberIdsForIllustration(
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

    // No `.not('illustrated_profile_key', 'is', null)` filter here: that
    // would hide in-flight versions from the fresh-in-flight check below.
    // `resolvePortraitVersionAtDate` still requires `ready`, so it is
    // unaffected by widening this select.
    const { data: portraitVersions, error: portraitVersionsError } = await supabase
      .from('family_member_portrait_versions')
      .select(
        'id, family_member_id, reference_date, profile_picture_key, illustrated_profile_key, illustrated_profile_status, deletion_token, generation_token, generation_started_at, created_at',
      )
      .in('family_member_id', memberIds.length > 0 ? memberIds : [EMPTY_MEMBER_ID])
      .abortSignal(generationController.signal);

    throwIfAborted(generationController.signal);
    if (portraitVersionsError) {
      console.error('generate-illustration portrait lookup failed', portraitVersionsError.message);
      return errorResponse('Failed to load character portraits', 500, 'internal_error');
    }
    logGenerationPhase(memoryId, generationPhase, memberLookupPhaseStartedAt);

    const portraitVersionRows = (portraitVersions ?? []) as PortraitFreshnessCandidate[];
    const versionsByMember = new Map<string, PortraitFreshnessCandidate[]>();
    for (const portraitVersion of portraitVersionRows) {
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
      // A resolved member's portrait may just not have finished yet (the
      // onboarding-guaranteed case: the first memory lands seconds after
      // portrait generation starts). Only defer for a version that could
      // still plausibly complete; a dead/deletion-claimed attempt falls
      // through to the ordinary NO_PORTRAITS failure below.
      if (hasFreshInFlightPortraitVersion(portraitVersionRows)) {
        deferredForPortraits = true;
        return errorResponse('Character portraits are still generating', 409, 'PORTRAITS_NOT_READY');
      }
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
      analyzedPalette ??
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

    if (backend === 'cloudflare') {
      // The Workflow event has only this job id. Prompt inputs remain in the
      // private jobs table and are fetched within the paid Workflow step.
      const jobId = generationAttemptId;
      const illustrationKey = buildMemoryIllustrationKey(user.id, memoryId, jobId);
      const referenceCandidates = readyMembers.map((member) => ({
        memberId: member.id,
        name: member.name,
        description: buildMemberIllustrationDescription(member, memory.memory_date),
        portraitKey: member.illustrated_profile_key,
        profileKey: member.profile_picture_key,
        portraitContentType: 'image/webp',
        profileContentType: 'image/jpeg',
      }));
      const service = dependencies.createServiceClient();
      // Reaching here means there is no fresh matching active job: this is a
      // manual replacement, an expired lease, or an edit invalidated the old
      // attempt. Supersede/scrub before insert so the one-active-job index
      // cannot strand recovery behind a job that cannot publish.
      if (backend === 'cloudflare') {
        const { error: supersedeError } = await service
          .from('memory_illustration_jobs')
          .update({
            status: 'superseded',
            completed_at: new Date().toISOString(),
            safe_scene_description: null,
            reference_candidates: [],
            illustration_prompt: null,
          })
          .eq('memory_id', memoryId)
          .in('status', ['queued', 'running']);
        if (supersedeError) throw new Error('Failed to supersede prior illustration workflow job');
      }
      const { error: jobError } = await service.from('memory_illustration_jobs').insert({
        id: jobId,
        workflow_instance_id: jobId,
        memory_id: memoryId,
        family_id: memory.family_id,
        attempt_id: generationAttemptId,
        request_intent: requestIntent ?? 'initial',
        status: 'queued',
        started_at: new Date().toISOString(),
        provider_deadline_at: new Date(Date.now() + CLOUD_FLARE_LEASE_MS).toISOString(),
        color_palette: resolvedPalette,
        safe_scene_description: safeDescription,
        expression_style: expressionStyle,
        style_description: styleDescription,
        memory_date: memory.memory_date,
        emotion: memory.emotion,
        reference_candidates: referenceCandidates,
        output_key: illustrationKey,
        old_illustration_key: memory.illustration_key,
      });
      if (jobError) throw new Error('Failed to create illustration workflow job');
      durableJobCreated = true;
      await dispatchWorkflowJob(dependencies.fetch, jobId);
      generationDispatched = true;
      return jsonResponse({ success: true, queued: true, jobId } satisfies QueueIllustrationResponse, 202);
    }

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
            illustration_generation_started_at: null,
          })
          .eq('id', memoryId)
          .eq('illustration_generation_attempt_id', generationAttemptId)
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
    if (!generationSucceeded && !generationDispatched && !durableJobCreated) {
      const hasRetainedIllustration = Boolean(
        memory.illustration_key && memory.illustration_generation_id,
      );
      // Key-aware deferral: a memory with a retained illustration keeps the
      // existing 'ready' restore (the old illustration stays visible) even
      // when this was a portrait deferral. Only a keyless deferral parks at
      // 'pending' -- reusing the status the client's shared poll already
      // treats as in-flight -- and only that case needs a self-retrigger,
      // since a retained-key memory isn't waiting on anything to resume.
      const parkedPendingForPortraits = deferredForPortraits && !hasRetainedIllustration;

      await supabase
        .from('memories')
        .update({
          illustration_status: hasRetainedIllustration
            ? 'ready'
            : parkedPendingForPortraits
              ? 'pending'
              : 'failed',
          illustration_generation_attempt_id: null,
          illustration_generation_started_at: parkedPendingForPortraits ? new Date().toISOString() : null,
        })
        .eq('id', memoryId)
        .eq('illustration_generation_attempt_id', generationAttemptId)
        .eq('illustration_status', 'generating');

      if (parkedPendingForPortraits) {
        dependencies.waitUntil(selfRetriggerAfterDeferral());
      }
    }
  }
}

if (import.meta.main) {
  Deno.serve((request) => handleGenerateIllustration(request));
}
