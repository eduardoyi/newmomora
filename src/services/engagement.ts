import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

export const MAX_COMMENT_LENGTH = 1000;

export type MemoryComment = Database['public']['Tables']['memory_comments']['Row'];

export interface MemoryLikeResult {
  liked: boolean;
  changed: boolean;
  likeCount: number;
}

export interface MemoryReactionResult {
  reaction: string | null;
  changed: boolean;
  /** True only when a brand-new reaction row was created (drives push notifications). */
  inserted: boolean;
  likeCount: number;
  topReactions: string[];
}

export interface MemoryReaction {
  userId: string;
  emoji: string;
  updatedAt: string;
}

export const QUICK_REACTIONS = ['❤️', '😂', '😮', '😢', '🙏', '👍'] as const;
export const DEFAULT_REACTION = '❤️';
export const MAX_REACTION_CODE_POINTS = 16;

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

/**
 * Mirrors the DB constraint `memory_likes_emoji_valid`: trimmed, 1-16 code
 * points, no whitespace/control characters. The client only ever offers
 * emoji; this just bounds what is sent.
 */
export function isValidReaction(value: string): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed !== value) return false;
  const length = Array.from(trimmed).length;
  if (length < 1 || length > MAX_REACTION_CODE_POINTS) return false;
  return !/[\s\u0000-\u001f\u007f]/.test(trimmed);
}

export async function setMemoryReaction(
  memoryId: string,
  reaction: string | null,
): Promise<{ data: MemoryReactionResult | null; error: ServiceError | null }> {
  if (reaction !== null && !isValidReaction(reaction)) {
    return { data: null, error: { message: 'Invalid reaction', code: 'validation_error' } };
  }

  const { data, error } = await supabase.rpc('set_memory_reaction', {
    target_memory_id: memoryId,
    // Generated args type it as `string`; null is the documented "remove".
    reaction: reaction as string,
  });

  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }

  const row = Array.isArray(data) ? data[0] : null;
  if (!row) {
    return { data: null, error: { message: 'Could not update reaction' } };
  }

  return {
    data: {
      reaction: (row.my_reaction as string | null) ?? null,
      changed: Boolean(row.changed),
      inserted: Boolean(row.inserted),
      likeCount: Number(row.like_count ?? 0),
      topReactions: Array.isArray(row.top_reactions) ? row.top_reactions : [],
    },
    error: null,
  };
}

export async function fetchMemoryReactions(
  memoryId: string,
): Promise<{ data: MemoryReaction[] | null; error: ServiceError | null }> {
  const { data, error } = await supabase
    .from('memory_likes')
    .select('user_id, emoji, updated_at')
    .eq('memory_id', memoryId)
    .order('updated_at', { ascending: false });

  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }

  return {
    data: (data ?? []).map((row) => ({
      userId: row.user_id,
      emoji: row.emoji,
      updatedAt: row.updated_at,
    })),
    error: null,
  };
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
