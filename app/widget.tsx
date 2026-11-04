import { useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { memoryDetailQueryKey } from '@/hooks/queryKeys';
import type { MemoryWithTags } from '@/services/memories';
import { fetchWidgetRetainedMemoriesByIds } from '@/services/widget-memories';
import {
  isValidWidgetRouteId,
  memoryDetailRoute,
  noFamilyRoute,
  timelineRoute,
} from '@/lib/routes';

type EntryState = 'checking' | 'invalid' | 'forbidden';

type WidgetValidationResult = Awaited<ReturnType<typeof fetchWidgetRetainedMemoriesByIds>>;

// A widget tap wakes the app, and the first read can land before the session
// refresh settles: an expired-JWT error, or (when the refresh itself failed)
// an anon-key read that RLS answers with zero rows. Re-check a couple of times
// before treating the memory as gone; only an explicit membership denial is
// final immediately.
const WIDGET_VALIDATION_RETRY_DELAYS_MS = [800, 2000] as const;

function shouldRetryValidation(result: WidgetValidationResult, memoryId: string): boolean {
  if (result.failure === 'authorization') return false;
  if (result.error) return true;
  return !result.data?.some((memory) => memory.id === memoryId);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseMediaIndex(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 9 ? parsed : undefined;
}

/**
 * Native widget taps enter here before the normal app family gate. The target
 * is accepted only after current membership and an RLS-scoped memory read;
 * malformed, deleted, or forbidden targets fall back to a neutral route.
 */
export default function WidgetEntryRoute() {
  const params = useLocalSearchParams<{
    memoryId?: string | string[];
    familyId?: string | string[];
    mediaIndex?: string | string[];
  }>();
  const memoryId = firstParam(params.memoryId);
  const familyId = firstParam(params.familyId);
  const rawMediaIndex = firstParam(params.mediaIndex);
  const mediaIndex = parseMediaIndex(rawMediaIndex);
  const { session, user, isLoading: isAuthLoading } = useAuth();
  const hasSession = Boolean(session);
  const userId = user?.id;
  const isAnonymous = user?.is_anonymous;
  const { familyId: activeFamilyId, memberships, isLoading: isFamilyLoading, setActiveFamily } = useFamily();
  const queryClient = useQueryClient();
  const [state, setState] = useState<EntryState>('checking');
  const completedTargetRef = useRef<string | null>(null);
  const inFlightTargetRef = useRef<string | null>(null);
  const firstUserIdRef = useRef<string | null>(null);
  const activeFamilyIdRef = useRef(activeFamilyId);
  const membershipsRef = useRef(memberships);
  const setActiveFamilyRef = useRef(setActiveFamily);
  useLayoutEffect(() => {
    activeFamilyIdRef.current = activeFamilyId;
    membershipsRef.current = memberships;
    setActiveFamilyRef.current = setActiveFamily;
  }, [activeFamilyId, memberships, setActiveFamily]);
  const targetKey = useMemo(
    () => `${memoryId ?? ''}:${familyId ?? ''}:${rawMediaIndex ?? ''}`,
    [memoryId, familyId, rawMediaIndex],
  );

  useEffect(() => {
    if (isAuthLoading || isFamilyLoading) return;

    if (!hasSession || !userId || isAnonymous) {
      // Once auth has settled without a session, consume the pending target
      // instead of allowing a later account sign-in to replay it.
      router.replace('/(auth)/login');
      return;
    }

    if (firstUserIdRef.current && firstUserIdRef.current !== userId) {
      router.replace(activeFamilyIdRef.current ? timelineRoute : noFamilyRoute);
      return;
    }
    firstUserIdRef.current = userId;

    // A neutral widget deep link has no target. Let the normal app route
    // decide where the signed-in user belongs instead of showing an
    // "unavailable" card for an intentionally empty payload.
    if (memoryId === undefined && familyId === undefined) {
      router.replace(activeFamilyIdRef.current ? timelineRoute : noFamilyRoute);
      return;
    }

    if (
      !isValidWidgetRouteId(memoryId)
      || !isValidWidgetRouteId(familyId)
      || (rawMediaIndex !== undefined && mediaIndex === undefined)
    ) {
      router.replace(activeFamilyIdRef.current ? timelineRoute : noFamilyRoute);
      return;
    }
    if (completedTargetRef.current === targetKey || inFlightTargetRef.current === targetKey) return;
    inFlightTargetRef.current = targetKey;

    const membership = membershipsRef.current.find((candidate) => candidate.familyId === familyId);
    if (!membership) {
      inFlightTargetRef.current = null;
      router.replace(activeFamilyIdRef.current ? timelineRoute : noFamilyRoute);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const needsFamilySwitch = activeFamilyIdRef.current !== familyId;
        const detailKey = memoryDetailQueryKey(familyId, memoryId);

        // Fast path: the detail query for this exact (family, memory) is
        // already cached (in-session or restored from the persisted cache).
        // That entry can only exist because this account was authorized to
        // read the memory in this family earlier: the persisted cache is
        // purged on sign-out and on family/membership loss (use-auth,
        // use-family clearPersistedQueryCache) and the key embeds the family.
        // Current membership was just verified above, so skip the two-round-
        // trip validation read and open immediately. The detail screen
        // refetches on mount and shows its own "Memory not found" state when
        // the memory was deleted or became invisible, so this stays
        // fail-closed. docs/features/home-screen-widget.md "Tap routing".
        const cached = queryClient.getQueryData<MemoryWithTags | null>(detailKey);
        if (cached && cached.id === memoryId && cached.family_id === familyId) {
          if (needsFamilySwitch) await setActiveFamilyRef.current(familyId);
          if (cancelled || firstUserIdRef.current !== userId) return;
          completedTargetRef.current = targetKey;
          inFlightTargetRef.current = null;
          router.replace(memoryDetailRoute(memoryId, mediaIndex));
          return;
        }

        // The validation read takes the family explicitly, so it does not
        // depend on the profile write that switches the active family; run
        // both together instead of serially.
        let [result] = await Promise.all([
          fetchWidgetRetainedMemoriesByIds(familyId, [memoryId]),
          needsFamilySwitch ? setActiveFamilyRef.current(familyId) : Promise.resolve(),
        ]);
        for (const delayMs of WIDGET_VALIDATION_RETRY_DELAYS_MS) {
          if (cancelled || firstUserIdRef.current !== userId) return;
          if (!shouldRetryValidation(result, memoryId)) break;
          await wait(delayMs);
          if (cancelled || firstUserIdRef.current !== userId) return;
          result = await fetchWidgetRetainedMemoriesByIds(familyId, [memoryId]);
        }
        if (cancelled || firstUserIdRef.current !== userId) return;
        const target = result.data?.find((memory) => memory.id === memoryId);
        if (result.error || !target) {
          setState('forbidden');
          inFlightTargetRef.current = null;
          router.replace(activeFamilyIdRef.current ? timelineRoute : noFamilyRoute);
          return;
        }
        // Seed the detail query so the screen paints from the row we just
        // validated instead of repeating the same select + tags/media/
        // engagement reads. fetchMemoriesByIds and useMemory's fetchMemoryById
        // both select '*' and attach tags, media assets and engagement
        // (myReaction/topReactions), so the shapes are identical. This runs
        // AFTER setActiveFamily resolved: its invalidateQueries calls on the
        // memories base would otherwise mark this entry stale.
        queryClient.setQueryData<MemoryWithTags | null>(detailKey, target);
        completedTargetRef.current = targetKey;
        inFlightTargetRef.current = null;
        router.replace(memoryDetailRoute(target.id, mediaIndex));
      } catch {
        if (cancelled) return;
        setState('forbidden');
        inFlightTargetRef.current = null;
        router.replace(activeFamilyIdRef.current ? timelineRoute : noFamilyRoute);
      }
    })();
    return () => {
      cancelled = true;
      if (inFlightTargetRef.current === targetKey) inFlightTargetRef.current = null;
    };
  }, [
    familyId,
    isAuthLoading,
    isFamilyLoading,
    memoryId,
    mediaIndex,
    rawMediaIndex,
    hasSession,
    queryClient,
    targetKey,
    userId,
    isAnonymous,
  ]);

  if (state === 'invalid' || state === 'forbidden') {
    return (
      <View style={styles.centered}>
        <Text style={styles.title}>This memory is unavailable.</Text>
        <Text style={styles.body}>Momora returned you to your journal.</Text>
      </View>
    );
  }
  return (
    <View style={styles.centered}>
      <ActivityIndicator color={colors.primary} size="small" />
      <Text style={styles.body}>Opening your memory…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  centered: {
    alignItems: 'center',
    backgroundColor: colors.bg,
    flex: 1,
    justifyContent: 'center',
    padding: spacing.lg,
  },
  title: {
    color: colors.ink,
    fontFamily: fonts.displayMedium,
    fontSize: 22,
    marginBottom: spacing.sm,
    textAlign: 'center',
  },
  body: {
    color: colors.ink2,
    fontFamily: fonts.sans,
    fontSize: 14,
    textAlign: 'center',
  },
});
