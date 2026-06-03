import { getAuthenticatedUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
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

const MAX_AUDIO_SECONDS = 120;

export interface ProcessVoiceFamilyMember {
  id: string;
  name: string;
  nicknames?: string[];
  is_user_profile?: boolean;
}

export interface ProcessVoiceMemoryRequest {
  audioBase64: string;
  familyMembers: ProcessVoiceFamilyMember[];
}

export interface ProcessVoiceMemoryResponse {
  cleanedText: string;
  mentionedMemberIds: string[];
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

  const { audioBase64, familyMembers } = body;

  if (!audioBase64 || typeof audioBase64 !== 'string') {
    return errorResponse('audioBase64 is required', 400, 'validation_error');
  }

  if (!Array.isArray(familyMembers)) {
    return errorResponse('familyMembers must be an array', 400, 'validation_error');
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
    const transcript = await transcribeAudio(
      audioBase64,
      buildTranscriptionPrompt(familyMembers),
    );

    if (!transcript) {
      return errorResponse('Transcription returned empty text', 400, 'TRANSCRIPTION_FAILED');
    }

    const cleanup = await chatJson<{ cleanedText?: string; mentionedUserSelf?: boolean }>(
      buildVoiceCleanupSystemPrompt(),
      transcript,
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
    console.error('process-voice-memory failed', message);

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
