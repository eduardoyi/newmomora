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

export async function analyzeMemoryEmotion(
  memoryId: string,
): Promise<{ data: { emotion: string; colorPalette: string } | null; error: ServiceError | null }> {
  return invokeEdgeFunction('analyze-emotion', { memoryId });
}

export interface FetchLinkPreviewsResponse {
  linkPreviews: Record<string, { title: string | null; fetchedAt: string }>;
}

/**
 * Fire-and-forget from the caller's perspective (docs/plans/inline-links.md
 * §7): fetches/prunes link-preview titles for URLs in a memory's content
 * and writes them server-side. Never awaited on the save path -- a failure
 * just leaves links rendered with their domain fallback.
 */
export async function fetchLinkPreviews(
  memoryId: string,
): Promise<{ data: FetchLinkPreviewsResponse | null; error: ServiceError | null }> {
  return invokeEdgeFunction('fetch-link-previews', { memoryId });
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

export interface NotifyFamilyActivityResponse {
  sent: boolean;
  reason?: 'debounced';
  recipientCount?: number;
}

/**
 * Fire-and-forget: announces the caller's own new memory to the rest of
 * the family (docs/plans/family-sharing.md §10). Callers must not await
 * this on the create-memory happy path -- see useMemories.ts, which wraps
 * it in `void ... .catch(console.warn)` so a notify failure never blocks
 * or fails the create UX.
 */
export async function notifyFamilyActivity(
  memoryId: string,
): Promise<{ data: NotifyFamilyActivityResponse | null; error: ServiceError | null }> {
  return invokeEdgeFunction('notify-family-activity', { memoryId });
}

export async function deleteUserAccount(): Promise<{ error: ServiceError | null }> {
  const { error } = await invokeEdgeFunction('delete-user-account', {});
  return { error };
}

export async function cancelAccountDeletion(): Promise<{ error: ServiceError | null }> {
  const { error } = await invokeEdgeFunction('cancel-account-deletion', {});
  return { error };
}
