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

const MAX_AUDIO_SECONDS = 120;

export interface ProcessVoiceFamilyMember {
  id: string;
  name: string;
  nicknames?: string[];
  is_user_profile?: boolean;
}

export interface ProcessVoiceMemoryRequest {
  audioBase64: string;
  /** Required for new clients. Legacy callers are resolved conservatively. */
  familyId?: string;
  /** Ignored for authorization and prompt construction; retained for compatibility. */
  familyMembers?: ProcessVoiceFamilyMember[];
}

export interface ProcessVoiceMemoryResponse {
  cleanedText: string;
  mentionedMemberIds: string[];
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

export async function handleProcessVoiceMemory(req: Request): Promise<Response> {
  const corsResponse = handleCors(req);
  if (corsResponse) {
    return corsResponse;
  }

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405, 'method_not_allowed');
  }

  const user = await getAuthenticatedUser(req);
  if (!user) {
    return errorResponse('Unauthorized', 401, 'unauthorized');
  }

  let body: ProcessVoiceMemoryRequest;
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

  const estimatedSeconds = estimateAudioDurationSeconds(audioBase64);
  if (estimatedSeconds > MAX_AUDIO_SECONDS) {
    return errorResponse('Audio exceeds 2 minute limit', 400, 'AUDIO_TOO_LONG');
  }

  try {
    decodeBase64ToBytes(audioBase64);
  } catch {
    return errorResponse('Invalid audio payload', 400, 'validation_error');
  }

  try {
    const supabase = createServiceClient();
    if (body.familyId !== undefined && (typeof body.familyId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.familyId))) {
      return errorResponse('familyId is invalid', 400, 'validation_error');
    }
    const familyResolution = await resolveVoiceFamilyId({
      supabase: supabase as unknown as VoiceFamilyLookupClient,
      requestedFamilyId: body.familyId,
      userId: user.id,
      getFamilyRole: (familyId, userId) => getCallerFamilyRole(supabase, familyId, userId),
    });
    if ('code' in familyResolution && familyResolution.code === 'FAMILY_CONTEXT_REQUIRED') {
      return errorResponse('Choose a family before processing voice', 409, 'FAMILY_CONTEXT_REQUIRED');
    }
    if ('code' in familyResolution) {
      return errorResponse('Not authorized for this family', 403, 'forbidden');
    }
    const familyId = familyResolution.familyId;
    const { data: canonicalMembers, error: membersError } = await supabase
      .from('family_members')
      .select('id, name, nicknames, is_user_profile')
      .eq('family_id', familyId);
    if (membersError) throw membersError;
    const familyMembers = (canonicalMembers ?? []) as ProcessVoiceFamilyMember[];

    const transcript = await transcribeAudio(
      audioBase64,
      buildTranscriptionPrompt(familyMembers),
      { usageContext: { familyId, actorUserId: user.id, operation: 'transcription' } },
    );

    if (!transcript) {
      return errorResponse('Transcription returned empty text', 400, 'TRANSCRIPTION_FAILED');
    }

    const cleanup = await chatJson<{ cleanedText?: string; mentionedUserSelf?: boolean }>(
      buildVoiceCleanupSystemPrompt(),
      transcript,
      { usageContext: { familyId, actorUserId: user.id, operation: 'voice_cleanup' } },
    );

    const cleanedText = cleanup.cleanedText?.trim() || transcript;
    const mentionedMemberIds = matchMemberIdsMentionedInText(cleanedText, familyMembers);

    if (cleanup.mentionedUserSelf) {
      const selfMember = familyMembers.find((member) => member.is_user_profile);
      if (selfMember && !mentionedMemberIds.includes(selfMember.id)) {
        mentionedMemberIds.push(selfMember.id);
      }
    }

    const response: ProcessVoiceMemoryResponse = {
      cleanedText,
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

if (import.meta.main) {
  Deno.serve(handleProcessVoiceMemory);
}
