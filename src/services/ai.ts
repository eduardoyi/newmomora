import { FunctionsHttpError } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';

export interface ServiceError {
  message: string;
  code?: string;
}

interface EdgeFunctionErrorBody {
  error?: string;
  code?: string;
}

async function mapFunctionError(error: unknown): Promise<ServiceError> {
  if (error instanceof FunctionsHttpError) {
    try {
      const body = (await error.context.clone().json()) as EdgeFunctionErrorBody;
      if (body.error) {
        return { message: body.error, code: body.code ?? String(error.context.status) };
      }
    } catch {
      // Fall through to generic message.
    }

    const status = error.context.status;
    if (status === 504 || status === 546) {
      return {
        message: 'Illustration generation timed out. Please try again.',
        code: 'generation_timeout',
      };
    }

    return {
      message: 'Something went wrong. Please try again.',
      code: String(status),
    };
  }

  if (error instanceof Error) {
    return { message: error.message };
  }

  return { message: 'Unknown error' };
}

export async function invokeEdgeFunction<TResponse>(
  functionName: string,
  body: Record<string, unknown>,
): Promise<{ data: TResponse | null; error: ServiceError | null }> {
  const { data, error } = await supabase.functions.invoke<TResponse>(functionName, { body });

  if (error) {
    return { data: null, error: await mapFunctionError(error) };
  }

  return { data: data ?? null, error: null };
}

export async function generatePortraitIllustration(
  familyMemberId: string,
): Promise<{ error: ServiceError | null }> {
  const { error } = await invokeEdgeFunction('generate-portrait-illustration', {
    familyMemberId,
  });

  return { error };
}

export async function analyzeMemoryEmotion(
  memoryId: string,
): Promise<{ data: { emotion: string; colorPalette: string } | null; error: ServiceError | null }> {
  return invokeEdgeFunction('analyze-emotion', { memoryId });
}

export async function generateMemoryIllustration(
  memoryId: string,
  colorPalette?: string,
  options?: { forceRegenerate?: boolean },
): Promise<{ error: ServiceError | null }> {
  const { error } = await invokeEdgeFunction('generate-illustration', {
    memoryId,
    colorPalette,
    forceRegenerate: options?.forceRegenerate ?? false,
  });

  return { error };
}

export interface VoiceFamilyMemberPayload {
  id: string;
  name: string;
  nicknames?: string[];
  is_user_profile?: boolean;
}

export async function processVoiceMemory(
  audioBase64: string,
  familyMembers: VoiceFamilyMemberPayload[],
): Promise<{
  data: { cleanedText: string; mentionedMemberIds: string[] } | null;
  error: ServiceError | null;
}> {
  return invokeEdgeFunction('process-voice-memory', {
    audioBase64,
    familyMembers,
  });
}

export async function deleteUserAccount(): Promise<{ error: ServiceError | null }> {
  const { error } = await invokeEdgeFunction('delete-user-account', {});
  return { error };
}

export async function cancelAccountDeletion(): Promise<{ error: ServiceError | null }> {
  const { error } = await invokeEdgeFunction('cancel-account-deletion', {});
  return { error };
}
