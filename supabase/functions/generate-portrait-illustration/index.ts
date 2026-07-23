import { describeAgeAtDate, isAdultAtDate } from '../_shared/age.ts';
import { getAuthenticatedUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { getCallerFamilyRole, isManagerRole } from '../_shared/family-access.ts';
import { capImageMaxEdge } from '../_shared/image-bytes.ts';
import { MAX_PORTRAIT_REFERENCE_EDGE } from '../_shared/image-limits.ts';
import { editImageWithReferences } from '../_shared/openai.ts';
import {
  buildCharacterSheetAbstractionAddon,
  buildPortraitPrompt,
} from '../_shared/prompts.ts';
import { deleteObject, getObjectBytes, putObjectBytes } from '../_shared/r2.ts';
import {
  buildPortraitVersionAttemptKey,
  parseStorageKey,
} from '../_shared/storage-keys.ts';
import {
  DEFAULT_ILLUSTRATION_STYLE_TOKEN,
  getIllustrationStyle,
  getStyleReferencePath,
  loadStyleReferenceBytes,
} from '../_shared/styles.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

export interface GeneratePortraitRequest {
  portraitVersionId: string;
}

export interface GeneratePortraitResponse {
  success: true;
  queued: true;
}

export interface GeneratePortraitDependencies {
  getAuthenticatedUser: typeof getAuthenticatedUser;
  createServiceClient: typeof createServiceClient;
  getCallerFamilyRole: typeof getCallerFamilyRole;
  getObjectBytes: typeof getObjectBytes;
  capImageMaxEdge: typeof capImageMaxEdge;
  loadStyleReferenceBytes: typeof loadStyleReferenceBytes;
  editImageWithReferences: typeof editImageWithReferences;
  putObjectBytes: typeof putObjectBytes;
  deleteObject: typeof deleteObject;
  generationTimeoutMs: number;
  waitUntil: (task: Promise<void>) => void;
  fetch: typeof fetch;
}

export const RETRIGGER_MIN_AGE_MS = 30_000;
export const RETRIGGER_MAX_CANDIDATES = 3;
// Only used by the temporary rollback path. The durable backend owns the
// five-minute application lease and its publication headroom independently.
export const PORTRAIT_GENERATION_TIMEOUT_MS = 120_000;
export const PORTRAIT_WORKFLOW_LEASE_MS = 5 * 60_000;
export const PORTRAIT_WORKFLOW_RECOVERY_GRACE_MS = 30_000;
export const PORTRAIT_UNCLAIMED_RECOVERY_MS = 3 * 60_000;

const DEFAULT_DEPENDENCIES: GeneratePortraitDependencies = {
  getAuthenticatedUser,
  createServiceClient,
  getCallerFamilyRole,
  getObjectBytes,
  capImageMaxEdge,
  loadStyleReferenceBytes,
  editImageWithReferences,
  putObjectBytes,
  deleteObject,
  generationTimeoutMs: PORTRAIT_GENERATION_TIMEOUT_MS,
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  waitUntil: (task) => (
    globalThis as unknown as { EdgeRuntime: { waitUntil: (task: Promise<void>) => void } }
  ).EdgeRuntime.waitUntil(task),
};

function getPortraitGenerationBackend(): 'legacy' | 'cloudflare' {
  return Deno.env.get('PORTRAIT_GENERATION_BACKEND') === 'cloudflare'
    ? 'cloudflare'
    : 'legacy';
}

export function isFreshMatchingPortraitWorkflowJob(input: {
  versionAttemptId: string | null;
  versionStartedAt: string | null;
  jobAttemptId: string;
  jobStartedAt: string;
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  const versionStartedAt = input.versionStartedAt ? Date.parse(input.versionStartedAt) : Number.NaN;
  const jobStartedAt = Date.parse(input.jobStartedAt);
  return input.versionAttemptId === input.jobAttemptId &&
    Number.isFinite(versionStartedAt) && Number.isFinite(jobStartedAt) &&
    now - versionStartedAt < PORTRAIT_WORKFLOW_LEASE_MS + PORTRAIT_WORKFLOW_RECOVERY_GRACE_MS &&
    now - jobStartedAt < PORTRAIT_WORKFLOW_LEASE_MS + PORTRAIT_WORKFLOW_RECOVERY_GRACE_MS;
}

export function getPortraitGenerationRequestIntent(input: {
  illustratedProfileKey: string | null;
  illustratedProfileStatus: string;
  generationToken: string | null;
  createdAt: string;
  now?: number;
}): 'initial' | 'recovery' | 'manual_regenerate' {
  if (input.illustratedProfileKey) return 'manual_regenerate';
  if (input.generationToken || input.illustratedProfileStatus === 'failed') return 'recovery';
  const createdAt = Date.parse(input.createdAt);
  if (input.illustratedProfileStatus === 'pending' && Number.isFinite(createdAt) &&
    (input.now ?? Date.now()) - createdAt >= PORTRAIT_UNCLAIMED_RECOVERY_MS) {
    return 'recovery';
  }
  return 'initial';
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function dispatchPortraitWorkflow(
  fetchFn: typeof fetch,
  jobId: string,
): Promise<void> {
  const endpoint = Deno.env.get('CLOUDFLARE_PORTRAIT_WORKFLOW_URL');
  const secret = Deno.env.get('CLOUDFLARE_PORTRAIT_DISPATCH_SECRET');
  if (!endpoint || !secret) {
    throw new Error('Cloudflare portrait workflow is not configured');
  }

  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const rawBody = JSON.stringify({ jobId });
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = hex(await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${nonce}.${rawBody}`),
  ));
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
  await response.text().catch(() => '');
  // A Worker that sees an existing deterministic instance accepts it as an
  // idempotent 202. Retain 409 compatibility for an older deployment during
  // the short rollout overlap.
  if (!response.ok && response.status !== 409) {
    throw new Error(`Cloudflare portrait workflow dispatch failed (${response.status})`);
  }
}

function buildFrozenPortraitPrompt(input: {
  member: { name: string; date_of_birth: string | null; gender: string | null; additional_info: string | null };
  referenceDate: string;
  styleToken: string;
}): string {
  const ageDescription = input.member.date_of_birth
    ? describeAgeAtDate(input.member.date_of_birth, input.referenceDate)
    : 'young child';
  const isAdult = input.member.date_of_birth
    ? isAdultAtDate(input.member.date_of_birth, input.referenceDate)
    : false;
  return `${buildPortraitPrompt({
    name: input.member.name,
    ageDescription,
    isAdult,
    gender: input.member.gender,
    styleToken: input.styleToken,
    additionalInfo: input.member.additional_info,
  })} ${buildCharacterSheetAbstractionAddon(isAdult)}`;
}

export async function handleGeneratePortraitIllustration(
  req: Request,
  dependencyOverrides: Partial<GeneratePortraitDependencies> = {},
): Promise<Response> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'method_not_allowed');

  const user = await dependencies.getAuthenticatedUser(req);
  if (!user) return errorResponse('Unauthorized', 401, 'unauthorized');

  let body: GeneratePortraitRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }
  if (!body.portraitVersionId || typeof body.portraitVersionId !== 'string') {
    return errorResponse('portraitVersionId is required', 400, 'validation_error');
  }

  const supabase = dependencies.createServiceClient();
  const { data: version, error: versionError } = await supabase
    .from('family_member_portrait_versions')
    .select('*')
    .eq('id', body.portraitVersionId)
    .maybeSingle();
  if (versionError) {
    console.error('generate-portrait-illustration version lookup failed', versionError.message);
    return errorResponse('Failed to load portrait version', 500, 'internal_error');
  }
  if (!version) return errorResponse('Portrait version not found', 404, 'PORTRAIT_VERSION_NOT_FOUND');

  const callerRole = await dependencies.getCallerFamilyRole(supabase, version.family_id, user.id);
  if (!isManagerRole(callerRole)) {
    return errorResponse('Not authorized for this portrait version', 403, 'forbidden');
  }
  if (!version.reference_date) {
    return errorResponse('Set a portrait date before generation', 400, 'DATE_REQUIRED');
  }

  const { data: member, error: memberError } = await supabase
    .from('family_members')
    .select('*')
    .eq('id', version.family_member_id)
    .eq('family_id', version.family_id)
    .maybeSingle();
  if (memberError || !member) return errorResponse('Family member not found', 404, 'MEMBER_NOT_FOUND');

  const parsedPhotoKey = parseStorageKey(version.profile_picture_key);
  if (!parsedPhotoKey || parsedPhotoKey.kind !== 'portrait_version_photo' ||
    parsedPhotoKey.portraitVersionId !== version.id || parsedPhotoKey.entityId !== member.id) {
    return errorResponse('Invalid profile photo key', 400, 'validation_error');
  }

  const { data: family } = await supabase
    .from('families')
    .select('illustration_style')
    .eq('id', version.family_id)
    .maybeSingle();
  const style = getIllustrationStyle(
    family?.illustration_style ?? DEFAULT_ILLUSTRATION_STYLE_TOKEN,
  );
  const prompt = buildFrozenPortraitPrompt({
    member,
    referenceDate: version.reference_date,
    styleToken: style.token,
  });

  const backend = getPortraitGenerationBackend();
  if (backend === 'cloudflare') {
    const { data: activeJob, error: activeJobError } = await supabase
      .from('portrait_generation_jobs')
      .select('id, attempt_id, started_at')
      .eq('portrait_version_id', version.id)
      .in('status', ['queued', 'running'])
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (activeJobError) {
      return errorResponse('Failed to load active portrait generation', 500, 'internal_error');
    }
    if (activeJob && isFreshMatchingPortraitWorkflowJob({
      versionAttemptId: version.generation_token,
      versionStartedAt: version.generation_started_at,
      jobAttemptId: activeJob.attempt_id,
      jobStartedAt: activeJob.started_at,
    })) {
      // A prior request may have timed out after persisting the job but before
      // observing Cloudflare's 202. Re-dispatch its deterministic id instead
      // of returning a misleading in-progress error or paying twice.
      try {
        await dispatchPortraitWorkflow(dependencies.fetch, activeJob.id);
      } catch {
        console.error('generate-portrait-illustration active workflow redispatch failed', version.id);
      }
      return jsonResponse({ success: true, queued: true } satisfies GeneratePortraitResponse, 202);
    }
  }

  const attemptId = crypto.randomUUID();
  const portraitKey = buildPortraitVersionAttemptKey(
    parsedPhotoKey.ownerUserId,
    member.id,
    version.id,
    attemptId,
  );
  const { data: claimedVersion, error: claimError } = await supabase.rpc(
    'claim_family_member_portrait_generation',
    {
      target_version_id: version.id,
      attempt_token: attemptId,
      attempt_key: portraitKey,
      actor_user_id: user.id,
    },
  );
  if (claimError || !claimedVersion) {
    return errorResponse('Portrait generation already in progress', 409, 'GENERATION_IN_PROGRESS');
  }

  // Claim success with a prior output means the old lease had already passed
  // its recovery window. It can no longer publish this version, so remove the
  // abandoned attempt object but never the portrait currently on display.
  if (version.generation_output_key && version.generation_output_key !== portraitKey) {
    await dependencies.deleteObject(version.generation_output_key).catch(() => undefined);
  }

  if (backend === 'cloudflare') {
    let jobCreated = false;
    try {
      const { error: supersedeError } = await supabase.rpc(
        'supersede_portrait_generation_workflow_jobs',
        { p_portrait_version_id: version.id, p_current_attempt_id: attemptId },
      );
      if (supersedeError) throw supersedeError;

      const { error: jobError } = await supabase.from('portrait_generation_jobs').insert({
        id: attemptId,
        workflow_instance_id: attemptId,
        portrait_version_id: version.id,
        family_id: version.family_id,
        actor_user_id: user.id,
        attempt_id: attemptId,
        request_intent: getPortraitGenerationRequestIntent({
          illustratedProfileKey: version.illustrated_profile_key,
          illustratedProfileStatus: version.illustrated_profile_status,
          generationToken: version.generation_token,
          createdAt: version.created_at,
        }),
        status: 'queued',
        started_at: new Date().toISOString(),
        provider_deadline_at: new Date(Date.now() + PORTRAIT_WORKFLOW_LEASE_MS).toISOString(),
        source_photo_key: version.profile_picture_key,
        style_reference_key: getStyleReferencePath(style.token),
        portrait_prompt: prompt,
        output_key: portraitKey,
        old_portrait_key: version.illustrated_profile_key,
      });
      if (jobError) throw jobError;
      jobCreated = true;
      await dispatchPortraitWorkflow(dependencies.fetch, attemptId);
      return jsonResponse({ success: true, queued: true } satisfies GeneratePortraitResponse, 202);
    } catch (error) {
      console.error('generate-portrait-illustration workflow dispatch failed', version.id);
      if (jobCreated) {
        // The durable job is the source of truth from this point onward. A
        // network failure or non-202 response can mean Cloudflare accepted
        // the deterministic instance after all; terminalizing it here would
        // discard valid work and leave no automatic-recovery path. Preserve
        // the queued job/claim so the next recovery request re-dispatches the
        // same job ID without another paid attempt.
        return jsonResponse({ success: true, queued: true } satisfies GeneratePortraitResponse, 202);
      }

      // No durable job exists, so this request owns the claim rollback.
      await supabase.rpc('fail_family_member_portrait_generation', {
        target_version_id: version.id,
        attempt_token: attemptId,
      });
      return errorResponse('Failed to queue portrait generation', 500, 'GENERATION_DISPATCH_FAILED');
    }
  }

  async function retriggerPendingIllustrations(): Promise<void> {
    try {
      const { data: candidates, error: candidatesError } = await supabase
        .from('memory_family_members')
        .select('memory_id, memories!inner(id, family_id, memory_type, illustration_status, created_at)')
        .eq('family_member_id', member.id)
        .eq('memories.family_id', version.family_id)
        .eq('memories.memory_type', 'text_illustration')
        .eq('memories.illustration_status', 'pending')
        .lt('memories.created_at', new Date(Date.now() - RETRIGGER_MIN_AGE_MS).toISOString())
        .limit(RETRIGGER_MAX_CANDIDATES);
      if (candidatesError) {
        console.error('generate-portrait-illustration retrigger query failed', candidatesError.message);
        return;
      }
      const authHeader = req.headers.get('Authorization');
      const supabaseUrl = Deno.env.get('SUPABASE_URL');
      if (!authHeader || !supabaseUrl) return;
      const headers: Record<string, string> = {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      };
      const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
      if (anonKey) headers.apikey = anonKey;
      await Promise.allSettled((candidates ?? []).map(async (candidate) => {
        const response = await dependencies.fetch(`${supabaseUrl}/functions/v1/generate-illustration`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ memoryId: candidate.memory_id, requestIntent: 'recovery' }),
        });
        await response.text().catch(() => '');
      }));
    } catch {
      // The legacy retrigger is best effort and never changes portrait
      // publication. Durable retriggering is handled by the signed bridge.
      console.error('generate-portrait-illustration retrigger failed');
    }
  }

  const completeGeneration = async (): Promise<void> => {
    let uploadedAttempt = false;
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort('Portrait generation deadline exceeded'),
      dependencies.generationTimeoutMs,
    );
    try {
      const photoBytes = await dependencies.getObjectBytes(version.profile_picture_key);
      const cappedPhoto = await dependencies.capImageMaxEdge(
        photoBytes,
        MAX_PORTRAIT_REFERENCE_EDGE,
        'image/jpeg',
      );
      const styleReference = await dependencies.loadStyleReferenceBytes(style.token);
      if (!styleReference) throw new Error('STYLE_REFERENCE_UNAVAILABLE');
      const cappedStyle = await dependencies.capImageMaxEdge(
        styleReference.bytes,
        MAX_PORTRAIT_REFERENCE_EDGE,
        styleReference.contentType,
      );
      const portraitBytes = await dependencies.editImageWithReferences(prompt, [
        { bytes: cappedStyle.bytes, contentType: cappedStyle.contentType, filename: 'reference-1-style.png' },
        { bytes: cappedPhoto.bytes, contentType: cappedPhoto.contentType, filename: 'reference-2-person-photo.jpg' },
      ], {
        signal: controller.signal,
        outputFormat: 'webp',
        outputCompression: 85,
      });
      await dependencies.putObjectBytes(portraitKey, portraitBytes, 'image/webp');
      uploadedAttempt = true;

      const { error: finishError } = await supabase.rpc('finish_family_member_portrait_generation', {
        target_version_id: version.id,
        attempt_token: attemptId,
        generated_portrait_key: portraitKey,
      });
      if (finishError) {
        const { data: committedVersion } = await supabase
          .from('family_member_portrait_versions')
          .select('illustrated_profile_key, generation_token')
          .eq('id', version.id)
          .maybeSingle();
        if (committedVersion?.illustrated_profile_key !== portraitKey || committedVersion.generation_token !== null) {
          await dependencies.deleteObject(portraitKey).catch(() => undefined);
          await retriggerPendingIllustrations();
          return;
        }
      }
      if (version.illustrated_profile_key && version.illustrated_profile_key !== portraitKey) {
        await dependencies.deleteObject(version.illustrated_profile_key).catch(() => undefined);
      }
      await retriggerPendingIllustrations();
    } catch (error) {
      console.error('generate-portrait-illustration failed', version.id, error instanceof Error ? error.name : 'unknown');
      await supabase.rpc('fail_family_member_portrait_generation', {
        target_version_id: version.id,
        attempt_token: attemptId,
      });
      if (uploadedAttempt) await dependencies.deleteObject(portraitKey).catch(() => undefined);
      await retriggerPendingIllustrations();
    } finally {
      clearTimeout(timeoutId);
    }
  };

  dependencies.waitUntil(completeGeneration());
  return jsonResponse({ success: true, queued: true } satisfies GeneratePortraitResponse);
}

if (import.meta.main) Deno.serve((request) => handleGeneratePortraitIllustration(request));
