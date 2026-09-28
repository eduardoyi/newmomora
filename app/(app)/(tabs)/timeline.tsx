import { router, useNavigation } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
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
import { CalendarMonthPickerSheet } from '@/components/calendar-month-picker-sheet';
import { FamilyActivitySheet } from '@/components/family-activity-sheet';
import { MemoryFab } from '@/components/memory-fab';
import { PendingMemoryUploadsBanner } from '@/components/pending-memory-uploads-banner';
import { LookingBackPackageRail } from '@/components/looking-back/package-rail';
import { ImportInviteCard } from '@/components/gallery-import/import-invite-card';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useFamily } from '@/hooks/use-family';
import { useAuth } from '@/hooks/use-auth';
import { TimelineHeaderBar } from '@/components/timeline/timeline-header-bar';
import { useFamilyActivityUnread } from '@/hooks/useFamilyActivity';
import { useMemories } from '@/hooks/useMemories';
import { useMemoryMonthCounts } from '@/hooks/useMemoryMonthCounts';
import { useContentSafety } from '@/hooks/useContentSafety';
import { useGalleryImportEntryStatus } from '@/hooks/useGalleryImport';
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
import { isGalleryImportFeatureEnabled } from '@/utils/gallery-import-flags';
import { hasSeenGalleryImportBell, markGalleryImportBellSeen } from '@/utils/gallery-import-bell-seen';
import { isGalleryImportRunTerminal } from '@/utils/gallery-import-deck';
import {
  dismissGalleryImportInvite,
  isGalleryImportInviteDismissed,
} from '@/utils/gallery-import-invite-dismissal';
import {
  formatTimelineMonthLabel,
  getMonthAnchorDate,
  getTimelineMonthOptions,
  toMonthKey,
  type TimelineMonthOption,
} from '@/utils/timeline-anchor';

function toLocalDateString(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const timelineViewabilityConfig: ViewabilityConfig = { viewAreaCoveragePercentThreshold: 60 };
// The pinned month label's own viewability pair (the Calendar tab's value):
// the topmost card that's at least 15% on screen names the month. It can't
// share the 60% autoplay config above, and RN forbids swapping
// onViewableItemsChanged/viewabilityConfig on the fly -- hence
// viewabilityConfigCallbackPairs with both pairs fixed at mount.
const monthLabelViewabilityConfig: ViewabilityConfig = { itemVisiblePercentThreshold: 15 };

// An anchored (jumped-to-a-date) Timeline returns to today's feed once the
// app has been backgrounded this long -- coming back hours later to March
// 2024 would read as a bug.
const ANCHOR_RESET_AFTER_BACKGROUND_MS = 30 * 60 * 1000;

function monthsBetween(fromKey: string, toKey: string): number {
  const [fromYear, fromMonth] = fromKey.split('-').map(Number) as [number, number];
  const [toYear, toMonth] = toKey.split('-').map(Number) as [number, number];
  return (fromYear - toYear) * 12 + (fromMonth - toMonth);
}

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

// The post-onboarding empty-state invitation (design: gi-entry.jsx
// GIImportInvite). Dismissal persists per user+family in AsyncStorage
// (src/utils/gallery-import-invite-dismissal.ts) so closing it stays closed
// across app restarts, not just for the current session.
function TimelineGalleryImportInvite() {
  const { user } = useAuth();
  const { familyId, role } = useFamily();
  const canEdit = canEditFamilyContent(role);
  // Defaults to hidden until the dismissal check resolves -- avoids a flash
  // of the card for a user who already closed it.
  const [isDismissed, setIsDismissed] = useState(true);

  useEffect(() => {
    if (!isGalleryImportFeatureEnabled || !canEdit || !user?.id || !familyId) {
      setIsDismissed(true);
      return;
    }
    let cancelled = false;
    void isGalleryImportInviteDismissed(user.id, familyId).then((dismissed) => {
      if (!cancelled) setIsDismissed(dismissed);
    });
    return () => {
      cancelled = true;
    };
  }, [canEdit, familyId, user?.id]);

  if (!isGalleryImportFeatureEnabled || !canEdit || isDismissed) return null;

  const handleStart = () => {
    // See the matching NOTE on the glyph's handleGlyphPress above -- the
    // offer screen doesn't read this param yet, so this is forward-
    // compatible rather than currently wired end-to-end.
    router.push({ pathname: '/(app)/gallery-import' as never, params: { surface: 'timeline' } });
  };
  const handleDismiss = () => {
    setIsDismissed(true);
    if (user?.id && familyId) void dismissGalleryImportInvite(user.id, familyId);
  };

  return <ImportInviteCard onDismiss={handleDismiss} onStart={handleStart} />;
}

// Search, the activity bell and the month label live in the pinned
// TimelineHeaderBar now (docs/plans/timeline-calendar-keepsakes.md A4) --
// this is just the large scrolling title. The old day eyebrow ("MONDAY,
// SEPTEMBER 28") was dropped: it read as a duplicate of the bar's month label
// directly above it.
function TimelineTitle() {
  return (
    <View style={styles.header} testID="timeline-title-section">
      <Text style={styles.title}>Your moments.</Text>
    </View>
  );
}

// Streak dots are "this week" -- meaningless (and wrong) over an anchored
// list that starts somewhere in the past, so anchored callers pass
// showStreak={false}.
function TimelineTitleWithStreak({
  memories,
  showStreak,
}: { memories: MemoryWithTags[]; showStreak: boolean }) {
  return <>
    <TimelineTitle />
    {showStreak ? (
      <View style={styles.streakWrap} testID="timeline-week-section">
        <StreakDots memories={memories} />
      </View>
    ) : null}
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
  const { user } = useAuth();
  const canEdit = canEditFamilyContent(role);
  const { unread: hasUnreadActivity, refetch: refetchActivityUnread } = useFamilyActivityUnread(familyId);
  // Continuous gallery-import sweep (docs/plans/gallery-import-continuous.md
  // I4a): the Timeline keeps this hook alive ONLY to feed the activity
  // bell's dot and the sheet's pinned ephemeral row -- the header glyph and
  // its drawer are gone (owner decision: the activity bell is now the one
  // re-entry point).
  const galleryEntry = useGalleryImportEntryStatus({ enabled: canEdit });
  const galleryRunId = galleryEntry.checkpoint?.runId ?? null;
  const galleryReadyCount = galleryEntry.readyCount;
  // Defaults to "seen" until the AsyncStorage check resolves, matching the
  // invite card's own flash-avoidance default below.
  const [isGalleryBellSeen, setIsGalleryBellSeen] = useState(true);
  useEffect(() => {
    if (!canEdit || !user?.id || !familyId || !galleryRunId || galleryReadyCount <= 0) {
      setIsGalleryBellSeen(true);
      return;
    }
    let cancelled = false;
    void hasSeenGalleryImportBell(user.id, familyId, galleryRunId, galleryReadyCount).then((seen) => {
      if (!cancelled) setIsGalleryBellSeen(seen);
    });
    return () => {
      cancelled = true;
    };
  }, [canEdit, familyId, galleryReadyCount, galleryRunId, user]);
  const galleryBellUnread = canEdit && galleryReadyCount > 0 && !isGalleryBellSeen;
  // Row hidden when there is no checkpoint/run for this device, or the run
  // has already reached a terminal status -- see
  // docs/features/family-activity.md's extension guide for this ephemeral,
  // non-persisted, non-grouped row.
  const showGalleryImportActivityRow = canEdit && Boolean(galleryRunId) && !isGalleryImportRunTerminal(galleryEntry.run?.status);
  const [isActivitySheetVisible, setIsActivitySheetVisible] = useState(false);
  const handleOpenActivitySheet = useCallback(() => {
    setIsActivitySheetVisible(true);
    if (canEdit && user?.id && familyId && galleryRunId && galleryReadyCount > 0) {
      void markGalleryImportBellSeen(user.id, familyId, galleryRunId, galleryReadyCount);
      setIsGalleryBellSeen(true);
    }
  }, [canEdit, familyId, galleryReadyCount, galleryRunId, user]);
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
  const handleGalleryImportActivityOpen = useCallback(() => {
    const pathname = galleryReadyCount > 0 ? '/(app)/gallery-import/review' : '/(app)/gallery-import/progress';
    if (galleryRunId) {
      router.push({ pathname: pathname as never, params: { runId: galleryRunId } });
    } else {
      router.push(pathname as never);
    }
  }, [galleryReadyCount, galleryRunId]);
  const { isLoading: isOnboardingLoading, needsFamilyMember } = useOnboardingStatus();
  const windowHeight = useWindowDimensions().height;
  // Coarse scroll-position tracking (a ref write, so no re-renders) --
  // useMemories' app-foreground reconcile trims the cached timeline down to
  // page 1, which clamps the FlatList's scroll to the bottom of the
  // shortened list if the user was scrolled deep when it fires. Reading this
  // ref from shouldReconcileOnForeground below lets that reconcile skip
  // itself while scrolled deep instead of losing the user's place.
  const scrollOffsetRef = useRef(0);
  // Drives the pinned bar's Today button on the feed (anchored lists always
  // show it). State, not just the ref, but only written when it flips.
  const [isScrolledDeep, setIsScrolledDeep] = useState(false);
  const isScrolledDeepRef = useRef(false);
  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const offset = event.nativeEvent.contentOffset.y;
    scrollOffsetRef.current = offset;
    const deep = offset > windowHeight;
    if (deep !== isScrolledDeepRef.current) {
      isScrolledDeepRef.current = deep;
      setIsScrolledDeep(deep);
    }
  }, [windowHeight]);
  // Date anchor (docs/plans/timeline-calendar-keepsakes.md A3): null is
  // today's feed; an ISO date shows the list starting at the newest memory on
  // or before it. Set by the month picker; cleared by Today, a Timeline tab
  // re-press, starting a new memory from the FAB, or a long background.
  const [anchorDate, setAnchorDate] = useState<string | null>(null);
  const isAnchored = anchorDate !== null;
  // Month of the topmost visible card -- the pinned bar's label.
  const [topVisibleDate, setTopVisibleDate] = useState<string | null>(null);
  const flatListRef = useRef<FlatList<MemoryWithTags>>(null);
  const [isMonthPickerVisible, setIsMonthPickerVisible] = useState(false);
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
  // docs/features/memories.md). Search lives on its own screen
  // (app/(app)/search.tsx), not in this query.
  const {
    memories,
    isLoading,
    isRefetching,
    isError,
    refetch,
    fetchNextPage,
    isFetchingNextPage,
    fetchPreviousPage,
    hasPreviousPage,
    isFetchingPreviousPage,
  } = useMemories({ shouldReconcileOnForeground, anchorDate });
  const contentSafety = useContentSafety();
  const { isUserBlocked } = contentSafety;
  const lookingBack = useLookingBackPackages({ enabled: !isOnboardingLoading });
  const { clearCheckpoint, savePackageSnapshot } = useLookingBackSession();
  const visibleMemories = useMemo(
    () => memories.filter((memory) => !isUserBlocked(memory.user_id)),
    [isUserBlocked, memories],
  );
  const [activeVideoId, setActiveVideoId] = useState<string | null>(null);

  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const firstVideo = viewableItems.find(
      (t) =>
        t.isViewable &&
        (t.item as MemoryWithTags).mediaAssets.some((asset) => isVideoContentType(asset.content_type)),
    );
    setActiveVideoId(firstVideo ? (firstVideo.item as MemoryWithTags).id : null);
  }, []);

  const onMonthLabelViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    let top: ViewToken | null = null;
    for (const token of viewableItems) {
      if (token.isViewable && token.index !== null && (top === null || token.index < (top.index ?? Infinity))) {
        top = token;
      }
    }
    if (top) {
      const date = (top.item as MemoryWithTags).memory_date;
      setTopVisibleDate((previous) => (previous === date ? previous : date));
    }
  }, []);

  // Fixed at mount -- RN throws if these change on a mounted list.
  const [viewabilityConfigCallbackPairs] = useState(() => [
    { viewabilityConfig: timelineViewabilityConfig, onViewableItemsChanged },
    { viewabilityConfig: monthLabelViewabilityConfig, onViewableItemsChanged: onMonthLabelViewableItemsChanged },
  ]);

  // ── Month picker + anchor ────────────────────────────────────────────────
  const monthCounts = useMemoryMonthCounts(isUserBlocked);
  const monthOptions = useMemo(
    () => getTimelineMonthOptions(new Date(), monthCounts.counts),
    [monthCounts.counts],
  );
  const canJumpToMonth = monthOptions.some((option) => !option.isCurrent && option.count > 0);
  const monthLabel = formatTimelineMonthLabel(topVisibleDate ?? anchorDate ?? new Date());
  const showTodayButton = isAnchored || isScrolledDeep;

  // Every anchor change (including back to the feed) remounts the list via its
  // `key`, which starts it at offset 0 -- no scrollToIndex, no height model.
  const applyAnchor = useCallback((next: string | null) => {
    setTopVisibleDate(null);
    setActiveVideoId(null);
    scrollOffsetRef.current = 0;
    isScrolledDeepRef.current = false;
    setIsScrolledDeep(false);
    setAnchorDate(next);
  }, []);

  const goToToday = useCallback(() => {
    if (anchorDate !== null) {
      applyAnchor(null);
      return;
    }
    flatListRef.current?.scrollToOffset({ animated: true, offset: 0 });
  }, [anchorDate, applyAnchor]);

  const handlePressToday = useCallback(() => {
    trackEvent('timeline_jumped', { source: 'today_button', months_back: 0 });
    goToToday();
  }, [goToToday]);

  const handleOpenMonthPicker = useCallback(() => {
    monthCounts.refreshIfStale();
    setIsMonthPickerVisible(true);
  }, [monthCounts]);

  const handleSelectMonth = useCallback((option: TimelineMonthOption) => {
    setIsMonthPickerVisible(false);
    trackEvent('timeline_jumped', {
      source: 'month_picker',
      months_back: Math.max(0, monthsBetween(toMonthKey(new Date()), toMonthKey(option.iso))),
    });
    const next = getMonthAnchorDate(option);
    if (next === anchorDate) {
      flatListRef.current?.scrollToOffset({ animated: true, offset: 0 });
      return;
    }
    applyAnchor(next);
  }, [anchorDate, applyAnchor]);

  // Re-pressing the focused Timeline tab goes home: back to today's feed, or
  // to the top of it.
  const navigation = useNavigation();
  useEffect(() => {
    const unsubscribe = navigation.addListener('tabPress' as never, () => {
      if (navigation.isFocused()) {
        goToToday();
      }
    });
    return unsubscribe;
  }, [goToToday, navigation]);

  // A long background drops the anchor (see ANCHOR_RESET_AFTER_BACKGROUND_MS).
  const anchorDateRef = useRef(anchorDate);
  anchorDateRef.current = anchorDate;
  const backgroundedAtRef = useRef<number | null>(null);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'background') {
        backgroundedAtRef.current = Date.now();
        return;
      }
      if (status === 'active') {
        const backgroundedAt = backgroundedAtRef.current;
        backgroundedAtRef.current = null;
        if (
          anchorDateRef.current !== null &&
          backgroundedAt !== null &&
          Date.now() - backgroundedAt > ANCHOR_RESET_AFTER_BACKGROUND_MS
        ) {
          applyAnchor(null);
        }
      }
    });
    return () => subscription.remove();
  }, [applyAnchor]);

  // A new memory is prepended to the feed, never to an anchored list (see
  // memoryBelongsToListKey) -- so starting one from the FAB returns to today
  // first, and the user comes back to find it at the top.
  const handlePressFab = useCallback(() => {
    if (anchorDate !== null) {
      applyAnchor(null);
    }
    router.push(newMemoryRoute('fab_timeline'));
  }, [anchorDate, applyAnchor]);

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

  // The top inset belongs to the pinned TimelineHeaderBar now, so the list
  // header is a plain View. Anchored lists drop the "now" sections (streak,
  // Looking Back, Recently, the import invite) -- they start in the past.
  const listHeader = useMemo(
    () => (
      <View testID="timeline-top-sections">
        {isAnchored ? (
          <>
            <TimelineTitle />
            {isFetchingPreviousPage ? (
              <View style={styles.listHeaderLoading} testID="timeline-newer-loading">
                <ActivityIndicator color={colors.primary} />
              </View>
            ) : null}
          </>
        ) : (
          <>
            <TimelineTitleWithStreak memories={visibleMemories} showStreak />
            <LookingBackPackageRail packages={lookingBack.packages} onOpen={handleOpenLookingBackPackage} />
            <RecentlySection hasLookingBack={lookingBack.packages.length > 0} />
            <PendingMemoryUploadsBanner />
            {/* The invite renders as the first list item when there is exactly
                one memory, matching its empty-state placement below --
                visibleMemories.length <= 1 is the one condition both branches
                share (docs/plans/gallery-import-continuous.md I4a step 1). */}
            {canEdit && visibleMemories.length === 1 ? <TimelineGalleryImportInvite /> : null}
          </>
        )}
      </View>
    ),
    [canEdit, handleOpenLookingBackPackage, isAnchored, isFetchingPreviousPage, lookingBack.packages, visibleMemories],
  );

  // fetchNextPage's signature (FetchNextPageOptions) doesn't match FlatList's
  // onEndReached ({ distanceFromEnd }) -- wrap rather than pass directly.
  const handleEndReached = useCallback(() => {
    void fetchNextPage();
  }, [fetchNextPage]);
  // Anchored lists extend upward too; maintainVisibleContentPosition (set on
  // the FlatList only while anchored) keeps the prepend from jumping the
  // scroll.
  const handleStartReached = useCallback(() => {
    if (hasPreviousPage && !isFetchingPreviousPage) {
      void fetchPreviousPage();
    }
  }, [fetchPreviousPage, hasPreviousPage, isFetchingPreviousPage]);
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

  const bellUnread = hasUnreadActivity || galleryBellUnread;
  const refreshControl = (
    <RefreshControl refreshing={isRefetching || lookingBack.isRefetching} onRefresh={handleRefresh} tintColor={colors.primary} />
  );

  return (
    <View style={styles.container}>
      <TimelineHeaderBar
        bellUnread={bellUnread}
        canJumpToMonth={canJumpToMonth}
        monthLabel={monthLabel}
        onPressBell={handleOpenActivitySheet}
        onPressMonth={handleOpenMonthPicker}
        onPressToday={handlePressToday}
        showToday={showTodayButton}
      />
      {isLoading ? (
        <>
          <TimelineTitleWithStreak memories={memories} showStreak={!isAnchored} />
          <View style={styles.centeredInline}>
            <ActivityIndicator color={colors.primary} size="large" />
          </View>
        </>
      ) : isError ? (
        <ScrollView refreshControl={refreshControl}>
          <TimelineTitleWithStreak memories={memories} showStreak={!isAnchored} />
          <Text style={styles.errorText}>Could not load memories</Text>
        </ScrollView>
      ) : memories.length > 0 && visibleMemories.length === 0 ? (
        <ScrollView
          contentContainerStyle={styles.hiddenOnlyWrap}
          refreshControl={refreshControl}
          testID="timeline-hidden-content-state"
        >
          <View>
            <TimelineTitleWithStreak memories={memories} showStreak={!isAnchored} />
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
          </View>
        </ScrollView>
      ) : visibleMemories.length === 0 && isAnchored ? (
        // Only reachable if the anchored range emptied out underneath us (the
        // picker never offers an empty month) -- offer the way home.
        <ScrollView style={styles.emptyWrap} refreshControl={refreshControl} testID="timeline-anchored-empty-state">
          <TimelineTitle />
          <Text style={styles.emptyBody}>No memories on or before this date.</Text>
          <Pressable
            accessibilityRole="button"
            onPress={goToToday}
            style={styles.hiddenOnlyButton}
            testID="timeline-anchored-empty-today"
          >
            <Text style={styles.hiddenOnlyButtonText}>Back to today</Text>
          </Pressable>
        </ScrollView>
      ) : visibleMemories.length === 0 ? (
        <ScrollView
          style={styles.emptyWrap}
          refreshControl={refreshControl}
          testID="timeline-empty-state"
        >
          <View>
            <TimelineTitleWithStreak memories={visibleMemories} showStreak />
            <PendingMemoryUploadsBanner />
            <View style={styles.emptyCard}>
              <Text style={styles.emptyScript}>nothing yet</Text>
              <Text style={styles.emptyHint}>but today is still happening.</Text>
            </View>
            <Text style={styles.emptyBody}>
              Capture your first moment when you are ready — type, or just speak it.
            </Text>
            {canEdit ? <TimelineGalleryImportInvite /> : null}
          </View>
        </ScrollView>
      ) : (
        <FlatList
          contentContainerStyle={styles.listContent}
          data={visibleMemories}
          initialNumToRender={6}
          key={anchorDate ?? 'feed'}
          keyExtractor={keyExtractor}
          ListFooterComponent={listFooter}
          ListHeaderComponent={listHeader}
          maintainVisibleContentPosition={isAnchored ? { minIndexForVisible: 0 } : undefined}
          maxToRenderPerBatch={6}
          onEndReached={handleEndReached}
          onEndReachedThreshold={0.5}
          onScroll={handleScroll}
          onStartReached={isAnchored ? handleStartReached : undefined}
          onStartReachedThreshold={0.5}
          ref={flatListRef}
          refreshControl={refreshControl}
          removeClippedSubviews
          renderItem={renderItem}
          scrollEventThrottle={100}
          testID="timeline-memory-list"
          viewabilityConfigCallbackPairs={viewabilityConfigCallbackPairs}
          windowSize={7}
        />
      )}

      {canEdit && <MemoryFab onPress={handlePressFab} />}

      <CalendarMonthPickerSheet
        onClose={() => setIsMonthPickerVisible(false)}
        onSelect={handleSelectMonth}
        options={monthOptions}
        visible={isMonthPickerVisible}
      />

      <FamilyActivitySheet
        galleryImport={showGalleryImportActivityRow ? {
          readyCount: galleryReadyCount,
          comingIndicator: galleryEntry.comingIndicator,
          phase: galleryEntry.driverState.phase,
          expiringInDays: galleryEntry.state === 'expiring' ? galleryEntry.reviewDaysLeft : null,
          onOpen: handleGalleryImportActivityOpen,
        } : undefined}
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
  streakWrap: { paddingHorizontal: spacing.lg },
  title: {
    fontFamily: fonts.display,
    fontSize: 44,
    lineHeight: 44 * 0.98,
    letterSpacing: -0.018 * 44,
    color: colors.ink,
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
  listHeaderLoading: {
    paddingTop: spacing.md,
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
