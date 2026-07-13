import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import {
  memoriesQueryKeyBase,
  memoryCommentsQueryKey,
  memoryDetailQueryKey,
} from '@/hooks/queryKeys';
import {
  createMemoryComment,
  deleteMemoryComment,
  fetchMemoryComments,
  notifyMemoryEngagementFireAndForget,
  setMemoryLike,
  type MemoryComment,
} from '@/services/engagement';
import type { MemoryWithTags } from '@/services/memories';

interface UseMemoryEngagementOptions {
  commentsEnabled?: boolean;
}

interface EngagementPatch {
  likedByMe?: boolean;
  likeCount?: number;
  commentCount?: number;
}

function toError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return new Error(String(error.message));
  }
  return new Error(fallback);
}

function patchMemoryEngagement(
  queryClient: ReturnType<typeof useQueryClient>,
  familyId: string | null | undefined,
  memoryId: string,
  patch: EngagementPatch | ((memory: MemoryWithTags) => EngagementPatch),
): void {
  const applyPatch = (memory: MemoryWithTags): MemoryWithTags => {
    if (memory.id !== memoryId) return memory;
    const resolved = typeof patch === 'function' ? patch(memory) : patch;
    return { ...memory, ...resolved };
  };

  queryClient.setQueriesData<MemoryWithTags[]>({
    predicate: (query) =>
      query.queryKey[0] === memoriesQueryKeyBase &&
      query.queryKey[1] === familyId &&
      query.queryKey[2] !== 'detail',
  }, (current) => (Array.isArray(current) ? current.map(applyPatch) : current));

  queryClient.setQueryData<MemoryWithTags | null>(
    memoryDetailQueryKey(familyId, memoryId),
    (current) => (current ? applyPatch(current) : current),
  );
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

  const likeMutation = useMutation({
    mutationFn: async (shouldLike: boolean) => {
      const { data, error } = await setMemoryLike(memory.id, shouldLike);
      if (error || !data) throw toError(error, 'Could not update like');
      return data;
    },
    onMutate: async (shouldLike) => {
      const previous = {
        likedByMe: memory.likedByMe,
        likeCount: memory.likeCount,
      };
      patchMemoryEngagement(queryClient, familyId, memory.id, {
        likedByMe: shouldLike,
        likeCount: Math.max(0, memory.likeCount + (shouldLike ? 1 : -1)),
      });
      return previous;
    },
    onError: (_error, _shouldLike, previous) => {
      if (previous) patchMemoryEngagement(queryClient, familyId, memory.id, previous);
    },
    onSuccess: (result) => {
      patchMemoryEngagement(queryClient, familyId, memory.id, {
        likedByMe: result.liked,
        likeCount: result.likeCount,
      });
      if (result.liked && result.changed) {
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
    toggleLike: () => likeMutation.mutateAsync(!memory.likedByMe),
    isUpdatingLike: likeMutation.isPending,
    likeError: likeMutation.error,
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
