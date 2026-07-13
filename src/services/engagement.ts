import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

export const MAX_COMMENT_LENGTH = 1000;

export type MemoryComment = Database['public']['Tables']['memory_comments']['Row'];

export interface MemoryLikeResult {
  liked: boolean;
  changed: boolean;
  likeCount: number;
}

export interface ServiceError {
  message: string;
  code?: string;
}

export type EngagementNotificationKind = 'like' | 'comment';

function mapSupabaseError(error: { message: string; code?: string }): ServiceError {
  return { message: error.message, code: error.code };
}

export function validateCommentContent(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) {
    return 'Comment cannot be empty';
  }
  if (trimmed.length > MAX_COMMENT_LENGTH) {
    return `Comments can be up to ${MAX_COMMENT_LENGTH.toLocaleString()} characters`;
  }
  return null;
}

export async function setMemoryLike(
  memoryId: string,
  shouldLike: boolean,
): Promise<{ data: MemoryLikeResult | null; error: ServiceError | null }> {
  const { data, error } = await supabase.rpc('set_memory_like', {
    target_memory_id: memoryId,
    should_like: shouldLike,
  });

  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }

  const row = Array.isArray(data) ? data[0] : null;
  if (!row) {
    return { data: null, error: { message: 'Could not update like' } };
  }

  return {
    data: {
      liked: Boolean(row.liked),
      changed: Boolean(row.changed),
      likeCount: Number(row.like_count ?? 0),
    },
    error: null,
  };
}

export async function fetchMemoryComments(
  memoryId: string,
): Promise<{ data: MemoryComment[] | null; error: ServiceError | null }> {
  const { data, error } = await supabase
    .from('memory_comments')
    .select('*')
    .eq('memory_id', memoryId)
    .order('created_at', { ascending: true });

  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }

  return { data: (data ?? []) as MemoryComment[], error: null };
}

export async function createMemoryComment(
  memoryId: string,
  content: string,
): Promise<{ data: MemoryComment | null; error: ServiceError | null }> {
  const validationError = validateCommentContent(content);
  if (validationError) {
    return { data: null, error: { message: validationError, code: 'validation_error' } };
  }

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return {
      data: null,
      error: { message: authError?.message ?? 'You must be signed in to comment' },
    };
  }

  const { data, error } = await supabase
    .from('memory_comments')
    .insert({ memory_id: memoryId, user_id: user.id, content: content.trim() })
    .select('*')
    .single();

  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }

  return { data: data as MemoryComment, error: null };
}

export async function deleteMemoryComment(
  commentId: string,
): Promise<{ error: ServiceError | null }> {
  const { error } = await supabase
    .from('memory_comments')
    .delete()
    .eq('id', commentId);

  return { error: error ? mapSupabaseError(error) : null };
}

export async function notifyMemoryEngagement(
  memoryId: string,
  kind: EngagementNotificationKind,
  engagementId?: string,
): Promise<{ error: ServiceError | null }> {
  const { error } = await supabase.functions.invoke('notify-memory-engagement', {
    body: { memoryId, kind, ...(engagementId ? { engagementId } : {}) },
  });

  return { error: error ? mapSupabaseError(error) : null };
}

export function notifyMemoryEngagementFireAndForget(
  memoryId: string,
  kind: EngagementNotificationKind,
  engagementId?: string,
): void {
  void notifyMemoryEngagement(memoryId, kind, engagementId)
    .then(({ error }) => {
      if (error) {
        console.warn('Failed to send engagement notification', memoryId, kind, error.message);
      }
    })
    .catch((error) => {
      console.warn(
        'Failed to send engagement notification',
        memoryId,
        kind,
        error instanceof Error ? error.message : 'unknown',
      );
    });
}
