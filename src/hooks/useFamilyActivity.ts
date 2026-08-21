import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useFamily } from '@/hooks/use-family';
import { familyActivityQueryKey, familyActivityUnreadQueryKey } from '@/hooks/queryKeys';
import {
  fetchFamilyActivity,
  fetchFamilyActivityUnread,
  markFamilyActivitySeen,
  type FamilyActivityEvent,
} from '@/services/family-activity';

function toError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return new Error(String(error.message));
  }
  return new Error(fallback);
}

interface UseFamilyActivityOptions {
  enabled?: boolean;
}

export function useFamilyActivity(
  familyId: string | null | undefined,
  options: UseFamilyActivityOptions = {},
) {
  const query = useQuery({
    queryKey: familyActivityQueryKey(familyId),
    queryFn: async (): Promise<FamilyActivityEvent[]> => {
      if (!familyId) return [];
      const { data, error } = await fetchFamilyActivity(familyId);
      if (error) throw toError(error, 'Could not load family activity');
      return data ?? [];
    },
    enabled: Boolean(familyId) && (options.enabled ?? true),
    // FamilyActivitySheetBody (the only caller) mounts fresh every time the
    // sheet opens -- see its class comment in family-activity-sheet.tsx --
    // so a 0 staleTime is what makes "mount = fresh fetch" actually true on
    // every reopen rather than only the first one. `enabled` stays in the
    // signature for callers that need to gate on something other than
    // mount/unmount; the sheet itself no longer needs it.
    staleTime: 0,
  });

  return {
    events: query.data ?? [],
    isLoading: query.isLoading,
    isRefetching: query.isRefetching,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}

export function useFamilyActivityUnread(familyId: string | null | undefined) {
  const query = useQuery({
    queryKey: familyActivityUnreadQueryKey(familyId),
    queryFn: async (): Promise<boolean> => {
      if (!familyId) return false;
      const { data, error } = await fetchFamilyActivityUnread(familyId);
      if (error) throw toError(error, 'Could not load family activity status');
      return data ?? false;
    },
    enabled: Boolean(familyId),
    staleTime: 0,
    // Cheap boolean RPC, so it's fine to refetch on every app foreground --
    // unlike useMemories' whole-timeline query (see the comment there on
    // why refetchOnWindowFocus is off for that one), there's no per-refetch
    // cost worth avoiding here. `refetchOnWindowFocus` is TanStack Query's
    // default `true`, but is set explicitly since this is the behavior the
    // bell's dot relies on -- `focusManager` is wired to RN `AppState` in
    // src/components/app-providers.tsx, so "window focus" means "app
    // foregrounded" in this RN app, not screen navigation focus.
    refetchOnWindowFocus: true,
  });

  return {
    unread: query.data ?? false,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}

export function useMarkFamilyActivitySeen() {
  const { familyId } = useFamily();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      if (!familyId) return;
      const { error } = await markFamilyActivitySeen(familyId);
      if (error) throw toError(error, 'Could not update family activity');
    },
    onMutate: async () => {
      if (!familyId) return undefined;
      const key = familyActivityUnreadQueryKey(familyId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<boolean>(key);
      queryClient.setQueryData<boolean>(key, false);
      return { key, previous };
    },
    onError: (_error, _variables, context) => {
      if (!context) return;
      queryClient.setQueryData(context.key, context.previous);
    },
  });
}
