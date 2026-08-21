import { router } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ViewabilityConfig,
  type ViewToken,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MemoryCard } from '@/components/memory-card';
import { ContentHiddenNotice } from '@/components/content-hidden-notice';
import { FamilyActivitySheet } from '@/components/family-activity-sheet';
import { MemoryFab } from '@/components/memory-fab';
import { PendingMemoryUploadsBanner } from '@/components/pending-memory-uploads-banner';
import { LookingBackPackageRail } from '@/components/looking-back/package-rail';
import { TimelineActivityBell } from '@/components/timeline-activity-bell';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useFamily } from '@/hooks/use-family';
import { useFamilyActivityUnread } from '@/hooks/useFamilyActivity';
import { useMemories } from '@/hooks/useMemories';
import { useContentSafety } from '@/hooks/useContentSafety';
import { useLookingBackPackages } from '@/hooks/useLookingBackPackages';
import { useLookingBackSession } from '@/hooks/useLookingBackSession';
import type { MemoryWithTags } from '@/services/memories';
import { useOnboardingStatus } from '@/hooks/useFamilyMembers';
import {
  addFamilyMemberRoute,
  memoryDetailCommentsRoute,
  memoryDetailRoute,
  newMemoryRoute,
  lookingBackPackageRoute,
  sharingApprovalsRoute,
  sharingInviteRoute,
  sharingMembersRoute,
} from '@/lib/routes';
import { trackEvent } from '@/services/analytics';
import { canEditFamilyContent } from '@/utils/roles';
import { isVideoContentType } from '@/utils/media-validation';

function toLocalDateString(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const timelineViewabilityConfig: ViewabilityConfig = { viewAreaCoveragePercentThreshold: 60 };

// A8: computed from whatever pages useMemories has loaded so far, not the
// whole library -- page 1 (40 rows) covers the current week in practice, so
// this is an accepted tradeoff rather than a bug.
function StreakDots({ memories }: { memories: MemoryWithTags[] }) {
  const today = new Date();
  const todayStr = toLocalDateString(today);

  // Monday of the current week
  const dow = today.getDay(); // 0=Sun … 6=Sat
  const monday = new Date(today);
  monday.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));

  const datesWithMemories = new Set(memories.map((m) => m.memory_date));

  const dots = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const dateStr = toLocalDateString(d);
    return {
      isToday: dateStr === todayStr,
      hasMemory: datesWithMemories.has(dateStr),
    };
  });

  return (
    <View style={styles.streakRow}>
      <Text style={styles.streakLabel}>This week</Text>
      <View style={styles.streakDots}>
        {dots.map((d, i) => (
          <View
            key={i}
            testID={`timeline-streak-dot-${i}`}
            style={[
              styles.streakDot,
              d.hasMemory && styles.streakDotFilled,
              d.isToday && !d.hasMemory && styles.streakDotToday,
            ]}
          />
        ))}
      </View>
    </View>
  );
}

interface ActivityBellSlotProps {
  unread: boolean;
  onPressBell: () => void;
}

function TimelineTitle({ unread, onPressBell }: ActivityBellSlotProps) {
  const now = new Date();
  const dayLabel = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <View style={styles.header} testID="timeline-title-section">
      <View style={styles.headerTitleRow}>
        <View>
          <Text style={styles.eyebrow}>{dayLabel}</Text>
          <Text style={styles.title}>Your moments.</Text>
        </View>
        <TimelineActivityBell onPress={onPressBell} unread={unread} />
      </View>
    </View>
  );
}

function TimelineTitleWithStreak({
  memories,
  unread,
  onPressBell,
}: ActivityBellSlotProps & { memories: MemoryWithTags[] }) {
  return <>
    <TimelineTitle onPressBell={onPressBell} unread={unread} />
    <View style={styles.streakWrap} testID="timeline-week-section">
      <StreakDots memories={memories} />
    </View>
  </>;
}

function RecentlySection({ hasLookingBack }: { hasLookingBack: boolean }) {
  return <View style={[styles.recentlyRow, !hasLookingBack && styles.recentlyRowWithoutRail]} testID="timeline-recently-section">
    <Text style={styles.sectionLabel}>Recently</Text>
    <View style={styles.sectionRule} />
  </View>;
}

export default function TimelineScreen() {
  const { role, familyId } = useFamily();
  const canEdit = canEditFamilyContent(role);
  const { unread: hasUnreadActivity, refetch: refetchActivityUnread } = useFamilyActivityUnread(familyId);
  const [isActivitySheetVisible, setIsActivitySheetVisible] = useState(false);
  const handleOpenActivitySheet = useCallback(() => setIsActivitySheetVisible(true), []);
  const handleCloseActivitySheet = useCallback(() => setIsActivitySheetVisible(false), []);
  const handleActivityOpenMemory = useCallback((memoryId: string) => {
    router.push(memoryDetailRoute(memoryId));
  }, []);
  const handleActivityOpenComments = useCallback((memoryId: string) => {
    router.push(memoryDetailCommentsRoute(memoryId));
  }, []);
  const handleActivityOpenApprovals = useCallback(() => {
    router.push(sharingApprovalsRoute);
  }, []);
  const handleActivityInvite = useCallback(() => {
    router.push(sharingInviteRoute);
  }, []);
  const { isLoading: isOnboardingLoading, needsFamilyMember } = useOnboardingStatus();
  const windowHeight = useWindowDimensions().height;
  // Coarse scroll-position tracking (a ref write, so no re-renders) --
  // useMemories' app-foreground reconcile trims the cached timeline down to
  // page 1, which clamps the FlatList's scroll to the bottom of the
  // shortened list if the user was scrolled deep when it fires. Reading this
  // ref from shouldReconcileOnForeground below lets that reconcile skip
  // itself while scrolled deep instead of losing the user's place.
  const scrollOffsetRef = useRef(0);
  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollOffsetRef.current = event.nativeEvent.contentOffset.y;
  }, []);
  const shouldReconcileOnForeground = useCallback(
    () => scrollOffsetRef.current <= windowHeight,
    [windowHeight],
  );
  // refetch here trims to page 1 then refetches (Workstream A4) -- not a
  // raw multi-page useInfiniteQuery.refetch(). The old useFocusEffect(refetch)
  // is gone: it bypassed staleTime on every tab focus, and tab screens never
  // unmount so it fired far more than intended. Freshness is now staleTime +
  // mutation/poll cache patches + this pull-to-refresh + an app-foreground
  // reconcile inside useMemories, gated to near-top scroll positions (see
  // docs/features/memories.md). No search UI exists yet (useMemories no
  // longer takes a search query -- see useMemoriesSearch in useMemories.ts).
  const {
    memories,
    isLoading,
    isRefetching,
    isError,
    refetch,
    fetchNextPage,
    isFetchingNextPage,
  } = useMemories({ shouldReconcileOnForeground });
  const contentSafety = useContentSafety();
  const { isUserBlocked } = contentSafety;
  const lookingBack = useLookingBackPackages({ enabled: !isOnboardingLoading });
  const { clearCheckpoint, savePackageSnapshot } = useLookingBackSession();
  const visibleMemories = useMemo(
    () => memories.filter((memory) => !isUserBlocked(memory.user_id)),
    [isUserBlocked, memories],
  );
  const [activeVideoId, setActiveVideoId] = useState<string | null>(null);

  const viewabilityConfig = timelineViewabilityConfig;

  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const firstVideo = viewableItems.find(
      (t) =>
        t.isViewable &&
        (t.item as MemoryWithTags).mediaAssets.some((asset) => isVideoContentType(asset.content_type)),
    );
    setActiveVideoId(firstVideo ? (firstVideo.item as MemoryWithTags).id : null);
  }, []);

  // B1: stable, id-based callbacks -- MemoryCard is memoized and the parent
  // FlatList re-renders on every list-affecting state change (new page,
  // active-video swap, refetch), so these must not be recreated per render
  // or the memo comparison never bails out.
  const handleCardPress = useCallback((memoryId: string, mediaIndex?: number) => {
    router.push(memoryDetailRoute(memoryId, mediaIndex));
  }, []);
  const handleOpenComments = useCallback((memoryId: string) => {
    router.push(memoryDetailCommentsRoute(memoryId));
  }, []);
  const handleOpenLookingBackPackage = useCallback((packageId: string, sourceGeometry: { x: number; y: number; width: number; height: number; windowWidth: number; windowHeight: number } | null) => {
    const item = lookingBack.packages.find((candidate) => candidate.id === packageId);
    if (!item) return;
    // A new Timeline open is always a fresh play, even if a previous route
    // saved a completed checkpoint before its close transition finished.
    clearCheckpoint(item.id);
    savePackageSnapshot(item, sourceGeometry ? { ...sourceGeometry, capturedAtMs: Date.now() } : null);
    trackEvent('looking_back_package_opened', {
      package_type: item.packageType,
      memory_count: item.memories.length,
      was_revisited: Boolean(item.view.firstViewedAt),
    });
    router.push(lookingBackPackageRoute(item.id));
  }, [clearCheckpoint, lookingBack.packages, savePackageSnapshot]);

  // B3: stable renderItem/keyExtractor so FlatList doesn't treat every render
  // as a brand-new render function, and a memoized header element so
  // unrelated state changes (e.g. activeVideoId) don't recreate it.
  const keyExtractor = useCallback((item: MemoryWithTags) => item.id, []);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<MemoryWithTags>) => {
      const isMemoryReported = contentSafety.isTargetReported('memory', item.id);
      const isIllustrationReported = contentSafety.isTargetReported(
        'memory_illustration',
        item.id,
        item.illustration_generation_id,
      );
      if (isMemoryReported) {
        return (
          <View style={styles.cardItem}>
            <ContentHiddenNotice
              label="Reported memory hidden"
              onShow={() => contentSafety.revealTarget('memory', item.id)}
              testID={`timeline-memory-${item.id}-hidden`}
            />
          </View>
        );
      }
      return (
        <View style={styles.cardItem}>
          <MemoryCard
            memory={item}
            onPress={handleCardPress}
            onOpenComments={handleOpenComments}
            isVideoActive={item.id === activeVideoId}
            isIllustrationHidden={isIllustrationReported}
            onShowIllustration={() => contentSafety.revealTarget(
              'memory_illustration',
              item.id,
              item.illustration_generation_id,
            )}
          />
        </View>
      );
    },
    [activeVideoId, contentSafety, handleCardPress, handleOpenComments],
  );

  const listHeader = useMemo(
    () => (
      <SafeAreaView edges={['top']} testID="timeline-top-sections">
        <TimelineTitle onPressBell={handleOpenActivitySheet} unread={hasUnreadActivity} />
        <View style={styles.streakWrap} testID="timeline-week-section">
          <StreakDots memories={visibleMemories} />
        </View>
        <LookingBackPackageRail packages={lookingBack.packages} onOpen={handleOpenLookingBackPackage} />
        <RecentlySection hasLookingBack={lookingBack.packages.length > 0} />
        <PendingMemoryUploadsBanner />
      </SafeAreaView>
    ),
    [handleOpenActivitySheet, handleOpenLookingBackPackage, hasUnreadActivity, lookingBack.packages, visibleMemories],
  );

  // fetchNextPage's signature (FetchNextPageOptions) doesn't match FlatList's
  // onEndReached ({ distanceFromEnd }) -- wrap rather than pass directly.
  const handleEndReached = useCallback(() => {
    void fetchNextPage();
  }, [fetchNextPage]);
  const handleRefresh = useCallback(() => {
    void Promise.all([refetch(), lookingBack.refetch(), refetchActivityUnread()]);
  }, [lookingBack, refetch, refetchActivityUnread]);

  const listFooter = isFetchingNextPage ? (
    <View style={styles.listFooterLoading}>
      <ActivityIndicator color={colors.primary} />
    </View>
  ) : null;

  if (isOnboardingLoading || contentSafety.isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (contentSafety.isError) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>Couldn’t load memories</Text>
        <Pressable onPress={() => void contentSafety.refetch()}>
          <Text style={styles.buttonText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  if (needsFamilyMember) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.onboardingWrap}>
          <Text style={styles.onboardingTitle}>Who comes first?</Text>
          <Text style={styles.onboardingBody}>
            {canEdit
              ? "Add your child first — Momora is about their moments. We'll draw their portrait so every memory features them."
              : 'Ask a family manager to add the first family member — their portrait will bring every memory to life.'}
          </Text>
          {canEdit && (
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push(addFamilyMemberRoute)}
              style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
              testID="timeline-add-family-member"
            >
              <Text style={styles.buttonText}>Add family member</Text>
            </Pressable>
          )}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.container}>
      {isLoading ? (
        <>
          <SafeAreaView>
            <TimelineTitleWithStreak memories={memories} onPressBell={handleOpenActivitySheet} unread={hasUnreadActivity} />
          </SafeAreaView>
          <View style={styles.centeredInline}>
            <ActivityIndicator color={colors.primary} size="large" />
          </View>
        </>
      ) : isError ? (
        <ScrollView
          refreshControl={
            <RefreshControl refreshing={isRefetching || lookingBack.isRefetching} onRefresh={handleRefresh} tintColor={colors.primary} />
          }
        >
          <SafeAreaView>
            <TimelineTitleWithStreak memories={memories} onPressBell={handleOpenActivitySheet} unread={hasUnreadActivity} />
          </SafeAreaView>
          <Text style={styles.errorText}>Could not load memories</Text>
        </ScrollView>
      ) : memories.length > 0 && visibleMemories.length === 0 ? (
        <ScrollView
          contentContainerStyle={styles.hiddenOnlyWrap}
          refreshControl={
            <RefreshControl refreshing={isRefetching || lookingBack.isRefetching} onRefresh={handleRefresh} tintColor={colors.primary} />
          }
          testID="timeline-hidden-content-state"
        >
          <SafeAreaView>
            <TimelineTitleWithStreak memories={memories} onPressBell={handleOpenActivitySheet} unread={hasUnreadActivity} />
            <PendingMemoryUploadsBanner />
            <View style={styles.emptyCard}>
              <Text style={styles.hiddenOnlyTitle}>Blocked-account memories are hidden</Text>
              <Text style={styles.emptyBody}>You can review or change blocked accounts at any time.</Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push(sharingMembersRoute)}
                style={styles.hiddenOnlyButton}
                testID="timeline-manage-blocked-accounts"
              >
                <Text style={styles.hiddenOnlyButtonText}>Manage blocked accounts</Text>
              </Pressable>
            </View>
          </SafeAreaView>
        </ScrollView>
      ) : visibleMemories.length === 0 ? (
        <ScrollView
          style={styles.emptyWrap}
          refreshControl={
            <RefreshControl refreshing={isRefetching || lookingBack.isRefetching} onRefresh={handleRefresh} tintColor={colors.primary} />
          }
          testID="timeline-empty-state"
        >
          <SafeAreaView>
              <TimelineTitleWithStreak memories={visibleMemories} onPressBell={handleOpenActivitySheet} unread={hasUnreadActivity} />
            <PendingMemoryUploadsBanner />
            <View style={styles.emptyCard}>
              <Text style={styles.emptyScript}>nothing yet</Text>
              <Text style={styles.emptyHint}>but today is still happening.</Text>
            </View>
            <Text style={styles.emptyBody}>
              Capture your first moment when you are ready — type, or just speak it.
            </Text>
          </SafeAreaView>
        </ScrollView>
      ) : (
        <FlatList
          contentContainerStyle={styles.listContent}
          data={visibleMemories}
          initialNumToRender={6}
          keyExtractor={keyExtractor}
          ListFooterComponent={listFooter}
          ListHeaderComponent={listHeader}
          maxToRenderPerBatch={6}
          onEndReached={handleEndReached}
          onEndReachedThreshold={0.5}
          onScroll={handleScroll}
          onViewableItemsChanged={onViewableItemsChanged}
          refreshControl={
            <RefreshControl refreshing={isRefetching || lookingBack.isRefetching} onRefresh={handleRefresh} tintColor={colors.primary} />
          }
          removeClippedSubviews
          renderItem={renderItem}
          scrollEventThrottle={100}
          testID="timeline-memory-list"
          viewabilityConfig={viewabilityConfig}
          windowSize={7}
        />
      )}

      {canEdit && <MemoryFab onPress={() => router.push(newMemoryRoute('fab_timeline'))} />}

      <FamilyActivitySheet
        onClose={handleCloseActivitySheet}
        onInvite={handleActivityInvite}
        onOpenApprovals={handleActivityOpenApprovals}
        onOpenComments={handleActivityOpenComments}
        onOpenMemory={handleActivityOpenMemory}
        visible={isActivitySheetVisible}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.bg,
    flex: 1,
  },
  centered: {
    alignItems: 'center',
    backgroundColor: colors.bg,
    flex: 1,
    justifyContent: 'center',
  },
  centeredInline: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
  header: {
    paddingTop: 16,
    paddingHorizontal: spacing.lg,
    paddingBottom: 0,
  },
  headerTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  streakWrap: { paddingHorizontal: spacing.lg },
  eyebrow: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 0.14 * 11,
    textTransform: 'uppercase',
    color: colors.ink3,
  },
  title: {
    fontFamily: fonts.display,
    fontSize: 44,
    lineHeight: 44 * 0.98,
    letterSpacing: -0.018 * 44,
    color: colors.ink,
    marginTop: 8,
  },
  streakRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginTop: 18,
    marginBottom: spacing.lg,
  },
  streakLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 0.14 * 11,
    textTransform: 'uppercase',
    color: colors.ink3,
  },
  streakDots: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  streakDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.border,
  },
  streakDotFilled: {
    backgroundColor: colors.primary,
  },
  streakDotToday: {
    backgroundColor: colors.border,
    borderColor: colors.primary,
    borderWidth: 1.5,
  },
  recentlyRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 9,
    paddingHorizontal: spacing.lg,
    paddingTop: 14,
  },
  recentlyRowWithoutRail: {
    paddingTop: 26,
  },
  sectionLabel: {
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    fontSize: 10.5,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  sectionRule: {
    backgroundColor: colors.border,
    flex: 1,
    height: 1,
  },
  listContent: {
    gap: 14,
    paddingBottom: 130,
  },
  cardItem: {
    paddingHorizontal: spacing.md,
  },
  listFooterLoading: {
    paddingVertical: spacing.lg,
  },
  // Onboarding empty
  onboardingWrap: {
    flex: 1,
    padding: spacing.lg,
    paddingTop: 24,
  },
  onboardingTitle: {
    fontFamily: fonts.display,
    fontSize: 36,
    lineHeight: 36,
    color: colors.ink,
    marginBottom: spacing.md,
  },
  onboardingBody: {
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 24,
    color: colors.ink2,
    marginBottom: spacing.lg,
  },
  button: {
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    paddingVertical: 16,
    alignItems: 'center',
  },
  buttonPressed: {
    backgroundColor: colors.primaryDark,
  },
  buttonText: {
    fontFamily: fonts.sansBold,
    fontSize: 16,
    color: colors.white,
  },
  // Timeline empty state
  emptyWrap: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  emptyCard: {
    marginHorizontal: spacing.xl,
    marginTop: spacing.lg,
    backgroundColor: colors.white,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 48,
    alignItems: 'center',
    gap: 8,
    shadowColor: '#281E0000',
    shadowOffset: { width: 0, height: 24 },
    shadowOpacity: 0.06,
    shadowRadius: 48,
  },
  emptyScript: {
    fontFamily: fonts.script,
    fontSize: 32,
    color: colors.primary,
  },
  emptyHint: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.ink3,
  },
  emptyBody: {
    fontFamily: fonts.sans,
    fontSize: 14.5,
    lineHeight: 22,
    color: colors.ink3,
    textAlign: 'center',
    paddingHorizontal: spacing.xl,
    marginTop: spacing.lg,
  },
  hiddenOnlyWrap: {
    flexGrow: 1,
  },
  hiddenOnlyTitle: {
    color: colors.ink,
    fontFamily: fonts.sansBold,
    fontSize: 18,
    textAlign: 'center',
  },
  hiddenOnlyButton: {
    alignSelf: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    marginTop: spacing.lg,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  hiddenOnlyButtonText: {
    color: colors.white,
    fontFamily: fonts.sansBold,
  },
  errorText: {
    color: colors.error,
    padding: spacing.lg,
    fontFamily: fonts.sans,
  },
});
