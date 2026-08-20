import { describeAgeAtDate } from '../_shared/age.ts';
import { getAuthenticatedUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { getCallerFamilyRole } from '../_shared/family-access.ts';
import {
  chatJson,
  decodeBase64ToBytes,
  estimateAudioDurationSeconds,
  transcribeAudio,
} from '../_shared/openai.ts';
import { matchMemberIdsMentionedInText } from '../_shared/member-mentions.ts';
import {
  buildTranscriptionPrompt,
  buildVoiceCleanupSystemPrompt,
} from '../_shared/prompts.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';
import { checkBillingFamilyWrite } from '../_shared/billing.ts';

const MAX_AUDIO_SECONDS = 120;

export interface ProcessVoiceFamilyMember {
  id: string;
  name: string;
  nicknames?: string[];
  is_user_profile?: boolean;
  /** Read server-side for the caption's derived age label only — never sent to the model or logged. */
  date_of_birth?: string | null;
}

export interface ProcessVoiceMemoryRequest {
  mode?: 'family';
  audioBase64: string;
  /** Required for new clients. Legacy callers are resolved conservatively. */
  familyId?: string;
  /** Ignored for authorization and prompt construction; retained for compatibility. */
  familyMembers?: ProcessVoiceFamilyMember[];
}

export interface ProcessOnboardingVoiceMemoryRequest {
  mode: 'onboarding';
  audioBase64: string;
  /** Spelling hints only. They never represent existing family-member IDs. */
  nameHints: string[];
}

export type ProcessVoiceRequest = ProcessVoiceMemoryRequest | ProcessOnboardingVoiceMemoryRequest;

export interface ProcessVoiceMemoryResponse {
  cleanedText: string;
  mentionedMemberIds: string[];
}

/**
 * Family mode only (audio-memories "keep the sound" fork,
 * docs/features/audio-memories.md). Onboarding mode's response shape is
 * unchanged -- no description field, since the fork does not exist pre-auth.
 */
export interface ProcessVoiceFamilyMemoryResponse extends ProcessVoiceMemoryResponse {
  /** One-line third-person caption, <= ~120 chars. '' when speech is unusable -- never absent, never an error. */
  description: string;
}

const MAX_DESCRIPTION_LENGTH = 120;

/** Server-side clamp/validate: missing or wrong-typed input defaults to ''; oversized input is truncated. Never throws. */
function sanitizeVoiceDescription(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim();
  return trimmed.length > MAX_DESCRIPTION_LENGTH ? trimmed.slice(0, MAX_DESCRIPTION_LENGTH) : trimmed;
}

interface VoiceFamilyLookupClient {
  from(table: 'user_profiles' | 'family_memberships'): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle?: () => Promise<{ data: { active_family_id?: string | null } | null; error: unknown }>;
        limit?: (limit: number) => Promise<{ data: Array<{ family_id: string }> | null; error: unknown }>;
      };
    };
  };
}

export type VoiceFamilyResolution =
  | { familyId: string }
  | { code: 'FAMILY_CONTEXT_REQUIRED' | 'forbidden' };

export interface VoiceAuthenticatedUser {
  id: string;
  is_anonymous?: boolean;
}

export interface ProcessVoiceMemoryDependencies {
  getAuthenticatedUser: (req: Request) => Promise<VoiceAuthenticatedUser | null>;
  createServiceClient: () => {
    rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
  };
  getCanonicalFamilyMembers: (input: {
    supabase: unknown;
    familyId: string;
  }) => Promise<ProcessVoiceFamilyMember[]>;
  getFamilyRole: (supabase: unknown, familyId: string, userId: string) => Promise<unknown>;
  transcribeAudio: (audioBase64: string, prompt: string, options: {
    usageContext: {
      attributionScope: 'family'; familyId: string; actorUserId: string; operation: 'transcription';
    } | {
      attributionScope: 'onboarding'; familyId: null; onboardingRequestId: string; operation: 'transcription';
    };
  }) => Promise<string>;
  chatJson: <T>(systemPrompt: string, userPrompt: string, options: {
    usageContext: {
      attributionScope: 'family'; familyId: string; actorUserId: string; operation: 'voice_cleanup';
    } | {
      attributionScope: 'onboarding'; familyId: null; onboardingRequestId: string; operation: 'voice_cleanup';
    };
  }) => Promise<T>;
}

function validateOnboardingNameHints(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 6) return null;

  const hints: string[] = [];
  for (const valueItem of value) {
    if (typeof valueItem !== 'string') return null;
    const hint = valueItem.trim();
    if (!hint || hint.length > 50) return null;
    hints.push(hint);
  }
  return hints;
}

function buildOnboardingTranscriptionPrompt(nameHints: string[]): string {
  // This prompt builder reads only display-name hints. The temporary blank ids
  // satisfy the existing prompt helper shape and never leave this function.
  return buildTranscriptionPrompt(nameHints.map((name) => ({ id: '', name })));
}

export type OnboardingVoiceReservation =
  | { state: 'reserved'; requestId: string }
  | { state: 'denied' }
  | { state: 'invalid' };

export function parseOnboardingVoiceReservation(data: unknown): OnboardingVoiceReservation {
  if (!Array.isArray(data) || data.length !== 1) return { state: 'invalid' };
  const row = data[0];
  if (!row || typeof row !== 'object') return { state: 'invalid' };
  const result = row as Record<string, unknown>;
  if (result.reserved === false && result.request_id === null && typeof result.attempts_used === 'number') {
    return { state: 'denied' };
  }
  if (
    result.reserved === true
    && typeof result.request_id === 'string'
    && /^[0-9a-f-]{36}$/i.test(result.request_id)
    && typeof result.attempts_used === 'number'
  ) {
    return { state: 'reserved', requestId: result.request_id };
  }
  return { state: 'invalid' };
}

async function reserveOnboardingVoiceAttempt(
  supabase: { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> },
  userId: string,
): Promise<OnboardingVoiceReservation> {
  const { data, error } = await supabase.rpc('reserve_onboarding_voice_attempt', {
    p_actor_user_id: userId,
  });
  if (error) return { state: 'invalid' };
  return parseOnboardingVoiceReservation(data);
}

async function markOnboardingVoiceCleanupExpected(
  supabase: { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> },
  requestId: string,
  userId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('mark_onboarding_voice_cleanup_expected', {
    p_request_id: requestId,
    p_actor_user_id: userId,
  });
  return !error && data === true;
}

/**
 * Legacy voice callers do not send a family. A profile's active family is a
 * convenience, never authorization; after a stale value we infer only one
 * remaining membership and still validate the role before returning it.
 */
export async function resolveVoiceFamilyId(input: {
  supabase: VoiceFamilyLookupClient;
  requestedFamilyId?: string;
  userId: string;
  getFamilyRole: (familyId: string, userId: string) => Promise<unknown>;
}): Promise<VoiceFamilyResolution> {
  if (input.requestedFamilyId) {
    return await input.getFamilyRole(input.requestedFamilyId, input.userId)
      ? { familyId: input.requestedFamilyId }
      : { code: 'forbidden' };
  }

  const { data: profile, error: profileError } = await input.supabase
    .from('user_profiles')
    .select('active_family_id')
    .eq('id', input.userId)
    .maybeSingle!();
  if (profileError) throw profileError;
  if (profile?.active_family_id && await input.getFamilyRole(profile.active_family_id, input.userId)) {
    return { familyId: profile.active_family_id };
  }

  const { data: memberships, error: membershipError } = await input.supabase
    .from('family_memberships')
    .select('family_id')
    .eq('user_id', input.userId)
    .limit!(2);
  if (membershipError) throw membershipError;
  if ((memberships ?? []).length !== 1) return { code: 'FAMILY_CONTEXT_REQUIRED' };
  const familyId = memberships![0].family_id;
  return await input.getFamilyRole(familyId, input.userId)
    ? { familyId }
    : { code: 'forbidden' };
}

export async function handleProcessVoiceMemoryWithDependencies(
  req: Request,
  dependencies: ProcessVoiceMemoryDependencies,
): Promise<Response> {
  const corsResponse = handleCors(req);
  if (corsResponse) {
    return corsResponse;
  }

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405, 'method_not_allowed');
  }

  const user = await dependencies.getAuthenticatedUser(req);
  if (!user) {
    return errorResponse('Unauthorized', 401, 'unauthorized');
  }

  let body: ProcessVoiceRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }

  const { audioBase64 } = body;

  if (!audioBase64 || typeof audioBase64 !== 'string') {
    return errorResponse('audioBase64 is required', 400, 'validation_error');
  }

  if (audioBase64.trim().length === 0) {
    return errorResponse('Audio payload is empty', 400, 'EMPTY_AUDIO');
  }

  let estimatedSeconds: number;
  try {
    decodeBase64ToBytes(audioBase64);
    estimatedSeconds = estimateAudioDurationSeconds(audioBase64);
  } catch {
    return errorResponse('Invalid audio payload', 400, 'validation_error');
  }
  if (estimatedSeconds > MAX_AUDIO_SECONDS) {
    return errorResponse('Audio exceeds 2 minute limit', 400, 'AUDIO_TOO_LONG');
  }

  try {
    const supabase = dependencies.createServiceClient();
    if (body.mode === 'onboarding') {
      if (user.is_anonymous !== true) {
        return errorResponse('Onboarding voice requires an anonymous session', 403, 'ONBOARDING_ANONYMOUS_REQUIRED');
      }
      const onboardingBody = body as unknown as Record<string, unknown>;
      if (onboardingBody.familyId !== undefined || onboardingBody.familyMembers !== undefined) {
        return errorResponse('Onboarding voice cannot include family context', 400, 'validation_error');
      }
      const nameHints = validateOnboardingNameHints(body.nameHints);
      if (!nameHints) {
        return errorResponse('nameHints must contain at most 6 non-empty names of 50 characters or fewer', 400, 'validation_error');
      }
      const reservation = await reserveOnboardingVoiceAttempt(supabase, user.id);
      if (reservation.state === 'denied') {
        return errorResponse('Onboarding voice limit reached', 429, 'ONBOARDING_VOICE_LIMIT_REACHED');
      }
      if (reservation.state !== 'reserved') {
        return errorResponse('Onboarding voice is temporarily unavailable', 503, 'ONBOARDING_VOICE_RESERVATION_FAILED');
      }

      const transcriptionUsageContext = {
        attributionScope: 'onboarding' as const,
        familyId: null,
        onboardingRequestId: reservation.requestId,
        operation: 'transcription' as const,
      };
      const transcript = await dependencies.transcribeAudio(
        audioBase64,
        buildOnboardingTranscriptionPrompt(nameHints),
        { usageContext: transcriptionUsageContext },
      );
      if (!transcript) {
        return errorResponse('Transcription returned empty text', 400, 'TRANSCRIPTION_FAILED');
      }
      if (!await markOnboardingVoiceCleanupExpected(supabase, reservation.requestId, user.id)) {
        return errorResponse('Onboarding voice is temporarily unavailable', 503, 'ONBOARDING_VOICE_CLEANUP_RESERVATION_FAILED');
      }

      const cleanup = await dependencies.chatJson<{ cleanedText?: string }>(
        buildVoiceCleanupSystemPrompt(),
        transcript,
        {
          usageContext: {
            ...transcriptionUsageContext,
            operation: 'voice_cleanup',
          },
        },
      );
      return jsonResponse({
        cleanedText: cleanup.cleanedText?.trim() || transcript,
        mentionedMemberIds: [],
      } satisfies ProcessVoiceMemoryResponse);
    }

    if (body.mode !== undefined && body.mode !== 'family') {
      return errorResponse('mode is invalid', 400, 'validation_error');
    }
    if (body.familyId !== undefined && (typeof body.familyId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.familyId))) {
      return errorResponse('familyId is invalid', 400, 'validation_error');
    }
    const familyResolution = await resolveVoiceFamilyId({
      supabase: supabase as unknown as VoiceFamilyLookupClient,
      requestedFamilyId: body.familyId,
      userId: user.id,
      getFamilyRole: (familyId, userId) => dependencies.getFamilyRole(supabase, familyId, userId),
    });
    if ('code' in familyResolution && familyResolution.code === 'FAMILY_CONTEXT_REQUIRED') {
      return errorResponse('Choose a family before processing voice', 409, 'FAMILY_CONTEXT_REQUIRED');
    }
    if ('code' in familyResolution) {
      return errorResponse('Not authorized for this family', 403, 'forbidden');
    }
    const familyId = familyResolution.familyId;
    const billingResponse = await checkBillingFamilyWrite(supabase, familyId, user.id, 'voice_memory');
    if (billingResponse) return billingResponse;
    const familyMembers = await dependencies.getCanonicalFamilyMembers({ supabase, familyId });

    const transcript = await dependencies.transcribeAudio(
      audioBase64,
      buildTranscriptionPrompt(familyMembers),
      { usageContext: { attributionScope: 'family', familyId, actorUserId: user.id, operation: 'transcription' } },
    );

    if (!transcript) {
      return errorResponse('Transcription returned empty text', 400, 'TRANSCRIPTION_FAILED');
    }

    const cleanup = await dependencies.chatJson<{
      cleanedText?: string;
      mentionedUserSelf?: boolean;
      description?: unknown;
    }>(
      buildVoiceCleanupSystemPrompt({
        includeDescription: true,
        // Caption context (owner decision 2026-08-20): names + nicknames +
        // derived age label only. date_of_birth itself never enters the
        // prompt; the age is computed here and sent as a label.
        members: familyMembers.map((member) => ({
          name: member.name,
          nicknames: member.nicknames ?? undefined,
          ageLabel: member.date_of_birth
            ? describeAgeAtDate(member.date_of_birth, new Date().toISOString().slice(0, 10))
            : null,
        })),
      }),
      transcript,
      { usageContext: { attributionScope: 'family', familyId, actorUserId: user.id, operation: 'voice_cleanup' } },
    );

    const cleanedText = cleanup.cleanedText?.trim() || transcript;
    const description = sanitizeVoiceDescription(cleanup.description);
    const mentionedMemberIds = matchMemberIdsMentionedInText(cleanedText, familyMembers);

    if (cleanup.mentionedUserSelf) {
      const selfMember = familyMembers.find((member) => member.is_user_profile);
      if (selfMember && !mentionedMemberIds.includes(selfMember.id)) {
        mentionedMemberIds.push(selfMember.id);
      }
    }

    const response: ProcessVoiceFamilyMemoryResponse = {
      cleanedText,
      description,
      mentionedMemberIds: mentionedMemberIds.slice(0, 4),
    };

    return jsonResponse(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown';
    // Do not log transcript/audio or member data. Error text may be provider
    // supplied, so only log the stable category below.
    console.error('process-voice-memory failed');

    if (message.includes('Missing OPENAI_API_KEY')) {
      return errorResponse('Voice transcription is not configured', 503, 'OPENAI_NOT_CONFIGURED');
    }

    if (message.includes('OpenAI transcription failed')) {
      return errorResponse('Could not transcribe audio. Try recording again.', 502, 'TRANSCRIPTION_FAILED');
    }

    if (message.includes('OpenAI chat failed')) {
      return errorResponse('Could not clean up transcript. Try again.', 502, 'CLEANUP_FAILED');
    }

    return errorResponse('Voice processing failed', 500, 'TRANSCRIPTION_FAILED');
  }
}

export async function handleProcessVoiceMemory(req: Request): Promise<Response> {
  return handleProcessVoiceMemoryWithDependencies(req, {
    getAuthenticatedUser,
    createServiceClient,
    getCanonicalFamilyMembers: async ({ supabase, familyId }) => {
      const { data, error } = await (supabase as ReturnType<typeof createServiceClient>)
        .from('family_members')
        .select('id, name, nicknames, is_user_profile, date_of_birth')
        .eq('family_id', familyId);
      if (error) throw error;
      return (data ?? []) as ProcessVoiceFamilyMember[];
    },
    getFamilyRole: (supabase, familyId, userId) => getCallerFamilyRole(
      supabase as ReturnType<typeof createServiceClient>, familyId, userId,
    ),
    transcribeAudio,
    chatJson,
  });
}

if (import.meta.main) {
  Deno.serve(handleProcessVoiceMemory);
}
