import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { memoryCommentsQueryKey, memoryReactionsQueryKey } from '@/hooks/queryKeys';
import { patchMemoryInCaches, type MemoryPatch } from '@/hooks/memory-cache';
import {
  createMemoryComment,
  deleteMemoryComment,
  DEFAULT_REACTION,
  fetchMemoryComments,
  fetchMemoryReactions,
  notifyMemoryEngagementFireAndForget,
  setMemoryReaction,
  type MemoryComment,
} from '@/services/engagement';
import type { MemoryWithTags } from '@/services/memories';

interface UseMemoryEngagementOptions {
  commentsEnabled?: boolean;
  /** Load the who-reacted list (only while the reactions sheet is open). */
  reactionsEnabled?: boolean;
}

function toError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return new Error(String(error.message));
  }
  return new Error(fallback);
}

// Was a standalone reimplementation of the list-key predicate + a raw
// Array.isArray(current).map(...) patch (docs/plans/performance-optimizations.md
// §A0) -- that silently no-ops now that list caches are InfiniteData
// (Workstream A2/A3). Thin wrapper over the shared patchMemoryInCaches so
// like/comment-count patches keep landing on InfiniteData timeline/member
// caches as well as the detail query.
function patchMemoryEngagement(
  queryClient: ReturnType<typeof useQueryClient>,
  familyId: string | null | undefined,
  memoryId: string,
  patch: MemoryPatch,
): void {
  patchMemoryInCaches(queryClient, familyId, memoryId, patch);
}

export function useMemoryEngagement(
  memory: MemoryWithTags,
  options: UseMemoryEngagementOptions = {},
) {
  const { user } = useAuth();
  const { familyId } = useFamily();
  const queryClient = useQueryClient();
  const commentsKey = memoryCommentsQueryKey(familyId, memory.id);

  const commentsQuery = useQuery({
    queryKey: commentsKey,
    queryFn: async () => {
      const { data, error } = await fetchMemoryComments(memory.id);
      if (error) throw toError(error, 'Could not load comments');
      return data ?? [];
    },
    enabled: Boolean(user && options.commentsEnabled),
    staleTime: 0,
  });

  const reactionsKey = memoryReactionsQueryKey(familyId, memory.id);

  const reactionsQuery = useQuery({
    queryKey: reactionsKey,
    queryFn: async () => {
      const { data, error } = await fetchMemoryReactions(memory.id);
      if (error) throw toError(error, 'Could not load reactions');
      return data ?? [];
    },
    enabled: Boolean(user && options.reactionsEnabled),
    staleTime: 0,
  });

  const reactionMutation = useMutation({
    mutationFn: async (reaction: string | null) => {
      const { data, error } = await setMemoryReaction(memory.id, reaction);
      if (error || !data) throw toError(error, 'Could not update reaction');
      return data;
    },
    onMutate: async (reaction) => {
      const previous = {
        likedByMe: memory.likedByMe,
        likeCount: memory.likeCount,
        myReaction: memory.myReaction,
        topReactions: memory.topReactions,
      };
      const hadReaction = memory.myReaction != null;
      const hasReaction = reaction != null;
      const likeCount = Math.max(
        0,
        memory.likeCount + (hasReaction && !hadReaction ? 1 : !hasReaction && hadReaction ? -1 : 0),
      );
      // Best effort only -- the server's top_reactions replaces this on success.
      const topReactions = hasReaction
        ? [reaction, ...memory.topReactions.filter((emoji) => emoji !== reaction)].slice(0, 3)
        : likeCount === 0
          ? []
          : memory.topReactions;
      patchMemoryEngagement(queryClient, familyId, memory.id, {
        likedByMe: hasReaction,
        likeCount,
        myReaction: reaction,
        topReactions,
      });
      return previous;
    },
    onError: (_error, _reaction, previous) => {
      if (previous) patchMemoryEngagement(queryClient, familyId, memory.id, previous);
    },
    onSuccess: (result) => {
      patchMemoryEngagement(queryClient, familyId, memory.id, {
        likedByMe: result.reaction != null,
        likeCount: result.likeCount,
        myReaction: result.reaction,
        topReactions: result.topReactions,
      });
      void queryClient.invalidateQueries({ queryKey: reactionsKey });
      // Only a brand-new reaction notifies; changing or removing one stays silent.
      if (result.inserted) {
        notifyMemoryEngagementFireAndForget(memory.id, 'like');
      }
    },
  });

  const addCommentMutation = useMutation({
    mutationFn: async (content: string) => {
      const { data, error } = await createMemoryComment(memory.id, content);
      if (error || !data) throw toError(error, 'Could not post comment');
      return data;
    },
    onMutate: async (content) => {
      await queryClient.cancelQueries({ queryKey: commentsKey });
      const previous = queryClient.getQueryData<MemoryComment[]>(commentsKey) ?? [];
      const optimisticId = `optimistic-${Date.now()}`;
      const optimistic: MemoryComment = {
        id: optimisticId,
        memory_id: memory.id,
        user_id: user?.id ?? '',
        content: content.trim(),
        created_at: new Date().toISOString(),
      };
      queryClient.setQueryData<MemoryComment[]>(commentsKey, [...previous, optimistic]);
      patchMemoryEngagement(queryClient, familyId, memory.id, (current) => ({
        commentCount: (current.commentCount ?? 0) + 1,
      }));
      return { previous, optimisticId };
    },
    onError: (_error, _content, context) => {
      if (!context) return;
      queryClient.setQueryData(commentsKey, context.previous);
      patchMemoryEngagement(queryClient, familyId, memory.id, (current) => ({
        commentCount: Math.max(0, (current.commentCount ?? 0) - 1),
      }));
    },
    onSuccess: (comment, _content, context) => {
      queryClient.setQueryData<MemoryComment[]>(commentsKey, (current = []) =>
        current.map((candidate) => candidate.id === context?.optimisticId ? comment : candidate),
      );
      notifyMemoryEngagementFireAndForget(memory.id, 'comment', comment.id);
    },
  });

  const deleteCommentMutation = useMutation({
    mutationFn: async (comment: MemoryComment) => {
      const { error } = await deleteMemoryComment(comment.id);
      if (error) throw toError(error, 'Could not delete comment');
      return comment;
    },
    onMutate: async (comment) => {
      await queryClient.cancelQueries({ queryKey: commentsKey });
      const previous = queryClient.getQueryData<MemoryComment[]>(commentsKey) ?? [];
      queryClient.setQueryData<MemoryComment[]>(
        commentsKey,
        previous.filter((candidate) => candidate.id !== comment.id),
      );
      patchMemoryEngagement(queryClient, familyId, memory.id, (current) => ({
        commentCount: Math.max(0, (current.commentCount ?? 0) - 1),
      }));
      return { previous };
    },
    onError: (_error, _comment, context) => {
      if (!context) return;
      queryClient.setQueryData(commentsKey, context.previous);
      patchMemoryEngagement(queryClient, familyId, memory.id, (current) => ({
        commentCount: (current.commentCount ?? 0) + 1,
      }));
    },
  });

  return {
    likedByMe: memory.likedByMe,
    likeCount: memory.likeCount,
    commentCount: memory.commentCount,
    myReaction: memory.myReaction,
    topReactions: memory.topReactions,
    setReaction: reactionMutation.mutateAsync,
    // Tap behavior: no reaction yet -> heart, otherwise remove whatever it is.
    toggleLike: () => reactionMutation.mutateAsync(memory.myReaction == null ? DEFAULT_REACTION : null),
    isUpdatingLike: reactionMutation.isPending,
    likeError: reactionMutation.error,
    reactions: reactionsQuery.data ?? [],
    areReactionsLoading: reactionsQuery.isLoading,
    reactionsError: reactionsQuery.error,
    refetchReactions: reactionsQuery.refetch,
    comments: commentsQuery.data ?? [],
    areCommentsLoading: commentsQuery.isLoading,
    commentsError: commentsQuery.error,
    refetchComments: commentsQuery.refetch,
    addComment: addCommentMutation.mutateAsync,
    isAddingComment: addCommentMutation.isPending,
    addCommentError: addCommentMutation.error,
    deleteComment: deleteCommentMutation.mutateAsync,
    isDeletingComment: deleteCommentMutation.isPending,
    deleteCommentError: deleteCommentMutation.error,
  };
}
