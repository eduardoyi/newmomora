import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { fetchWidgetRetainedMemoriesByIds } from '@/services/widget-memories';
import {
  isValidWidgetRouteId,
  memoryDetailRoute,
  noFamilyRoute,
  timelineRoute,
} from '@/lib/routes';

type EntryState = 'checking' | 'invalid' | 'forbidden';

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
        if (activeFamilyIdRef.current !== familyId) {
          await setActiveFamilyRef.current(familyId);
        }
        if (cancelled || firstUserIdRef.current !== userId) return;

        const result = await fetchWidgetRetainedMemoriesByIds(familyId, [memoryId]);
        if (cancelled || firstUserIdRef.current !== userId) return;
        const target = result.data?.find((memory) => memory.id === memoryId);
        if (result.error || !target) {
          setState('forbidden');
          inFlightTargetRef.current = null;
          router.replace(activeFamilyIdRef.current ? timelineRoute : noFamilyRoute);
          return;
        }
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
