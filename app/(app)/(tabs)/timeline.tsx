import { router, useNavigation } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  AppState,
  type CellRendererProps,
  FlatList,
  type LayoutChangeEvent,
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
import { CalendarGridMonth } from '@/components/timeline/calendar-month-grid';
import { getControlRowHeight, TimelineControlRow } from '@/components/timeline/timeline-control-row';
import { TimelineActivityBell } from '@/components/timeline-activity-bell';
import { TimelineSearchButton } from '@/components/timeline-search-button';
import { useCalendarMemoriesInRange } from '@/hooks/useCalendarMemories';
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
  buildGridMonthOffsets,
  buildGridMonths,
  getGridFetchRange,
  getGridMonthHeight,
  getGridTileSize,
  summarizeGridDays,
  type GridMonth,
} from '@/utils/calendar-grid';
import { toIsoDate } from '@/utils/dates';
import { loadTimelineView, saveTimelineView, type TimelineView } from '@/utils/timeline-view-preference';
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

// The Timeline is one FlatList for both views
// (docs/plans/timeline-calendar-keepsakes.md, sticky control row redesign):
// the control row first (sticky), then memories (List) or months (Calendar).
type ControlsRow = { kind: 'controls' };
type MemoryRow = { kind: 'memory'; memory: MemoryWithTags };
type MonthRow = { kind: 'month'; month: GridMonth; monthIndex: number };
type TimelineRow = ControlsRow | MemoryRow | MonthRow;
const CONTROL_ROW: ControlsRow = { kind: 'controls' };
// An anchored list starts loading newer pages this many screens before the
// top, so a quick scroll up doesn't hit the (not-yet-loaded) top first.
const NEWER_PAGE_THRESHOLD_SCREENS = 5;

// Where each rendered memory cell sits in the list's content (reported by
// MeasuredCell), so the control row's month label can read the card right
// under the row -- viewability can't: it counts the part of a card hidden
// under the pinned row as visible, which made the label flicker between
// neighbouring months.
type CellLayout = { y: number; height: number; date: string };
type CellLayoutReporter = (id: string, layout: CellLayout | null) => void;
const CellLayoutContext = createContext<CellLayoutReporter | null>(null);

function MeasuredCell({ children, item, onLayout, style }: CellRendererProps<TimelineRow>) {
  const report = useContext(CellLayoutContext);
  const memory = item.kind === 'memory' ? item.memory : null;
  const id = memory?.id ?? null;
  const date = memory?.memory_date ?? null;
  useEffect(() => () => {
    if (id) report?.(id, null);
  }, [id, report]);
  return (
    <View
      onLayout={(event) => {
        onLayout?.(event);
        if (id && date) {
          const { y, height } = event.nativeEvent.layout;
          report?.(id, { y, height, date });
        }
      }}
      style={style}
      testID={id ? `timeline-cell-${id}` : undefined}
    >
      {children}
    </View>
  );
}

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

interface ActivityBellSlotProps {
  bellUnread: boolean;
  onPressBell: () => void;
}

// The large scrolling title, with search and the activity bell beside it --
// they scroll away with it (owner decision 2026-09-29; the month label and
// Today live in the sticky control row). No date eyebrow: dropped
// 2026-09-28 as redundant with the month label.
function TimelineTitle({ bellUnread, onPressBell }: ActivityBellSlotProps) {
  return (
    <View style={styles.header} testID="timeline-title-section">
      <View style={styles.headerTitleRow}>
        <Text style={styles.title}>Your moments.</Text>
        <View style={styles.headerGlyphs}>
          <TimelineSearchButton />
          <TimelineActivityBell onPress={onPressBell} unread={bellUnread} />
        </View>
      </View>
    </View>
  );
}

// Streak dots are "this week" -- meaningless (and wrong) over an anchored
// list that starts somewhere in the past, so anchored callers pass
// showStreak={false}.
function TimelineTitleWithStreak({
  memories,
  showStreak,
  ...titleProps
}: ActivityBellSlotProps & { memories: MemoryWithTags[]; showStreak: boolean }) {
  return <>
    <TimelineTitle {...titleProps} />
    {showStreak ? (
      <View style={styles.streakWrap} testID="timeline-week-section">
        <StreakDots memories={memories} />
      </View>
    ) : null}
  </>;
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
  const viewportHeightRef = useRef(windowHeight);
  // Set below, once the row geometry and grid offsets exist.
  const updateMonthLabelRef = useRef<() => void>(() => undefined);
  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const offset = event.nativeEvent.contentOffset.y;
    scrollOffsetRef.current = offset;
    viewportHeightRef.current = event.nativeEvent.layoutMeasurement.height || windowHeight;
    const deep = offset > windowHeight;
    if (deep !== isScrolledDeepRef.current) {
      isScrolledDeepRef.current = deep;
      setIsScrolledDeep(deep);
    }
    updateMonthLabelRef.current();
  }, [windowHeight]);
  // Date anchor (docs/plans/timeline-calendar-keepsakes.md A3): null is
  // today's feed; an ISO date shows the list starting at the newest memory on
  // or before it. Set by the month picker; cleared by Today, a Timeline tab
  // re-press, starting a new memory from the FAB, or a long background.
  const [anchorDate, setAnchorDate] = useState<string | null>(null);
  const isAnchored = anchorDate !== null;
  // Month of the topmost visible card -- the pinned bar's label.
  const [topVisibleDate, setTopVisibleDate] = useState<string | null>(null);
  const flatListRef = useRef<FlatList<TimelineRow>>(null);
  // The list's scroll offset on the native driver -- moves the pinned control
  // row overlay with the content until it reaches the top.
  const [scrollY] = useState(() => new Animated.Value(0));
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

  // ── List / Calendar view (docs/plans/timeline-calendar-keepsakes.md B1) ──
  // Both views are one FlatList: [sticky control row, ...memories | ...months]
  // under the same top content, so switching only changes what's below the
  // control row. The choice persists per device; tapping a day switches to
  // List for this session without overwriting it.
  const [view, setView] = useState<TimelineView>('list');
  // A switch (or day tap) that beats the stored-preference read wins -- the
  // late read must not flip the view back underneath the user.
  const hasChosenViewRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void loadTimelineView().then((saved) => {
      if (!cancelled && !hasChosenViewRef.current) setView(saved);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const { width: windowWidth } = useWindowDimensions();
  const tileSize = getGridTileSize(windowWidth);
  const todayIso = toIsoDate(new Date());
  const currentMonthKey = toMonthKey(todayIso);

  // ── Month picker + counts ────────────────────────────────────────────────
  const monthCounts = useMemoryMonthCounts(isUserBlocked);
  const monthOptions = useMemo(
    () => getTimelineMonthOptions(new Date(), monthCounts.counts),
    [monthCounts.counts],
  );
  const canJumpToMonth = monthOptions.some((option) => !option.isCurrent && option.count > 0);

  // ── Calendar grid data ───────────────────────────────────────────────────
  const gridMonths = useMemo(() => buildGridMonths(monthOptions, todayIso), [monthOptions, todayIso]);
  const gridMonthOffsets = useMemo(() => buildGridMonthOffsets(gridMonths, tileSize), [gridMonths, tileSize]);
  // Month the grid's top row is showing (the control row's label in Calendar
  // view) and the visible month range (drives the range fetch, ± 1 month).
  const [gridTopMonthKey, setGridTopMonthKey] = useState<string>(currentMonthKey);
  const [gridVisibleRange, setGridVisibleRange] = useState({ first: 0, last: 0 });
  const gridFetchRange = useMemo(
    () => (view === 'calendar' ? getGridFetchRange(gridMonths, gridVisibleRange.first, gridVisibleRange.last) : null),
    [gridMonths, gridVisibleRange.first, gridVisibleRange.last, view],
  );
  const { data: gridMemories = [], refetch: refetchGridMemories } = useCalendarMemoriesInRange(gridFetchRange);
  const gridSummaries = useMemo(() => summarizeGridDays(gridMemories, isUserBlocked), [gridMemories, isUserBlocked]);

  // ── Top content height ───────────────────────────────────────────────────
  // Measured (not estimated): Calendar view's getItemLayout offsets start
  // below it, and month jumps scroll to exact offsets from it. Kept in a ref
  // too so a view switch can scroll before the new list re-measures.
  const [headerHeight, setHeaderHeight] = useState(0);
  const headerHeightRef = useRef(0);
  const handleHeaderLayout = useCallback((event: LayoutChangeEvent) => {
    const height = Math.round(event.nativeEvent.layout.height);
    headerHeightRef.current = height;
    setHeaderHeight((previous) => (previous === height ? previous : height));
  }, []);

  // An anchored list that has loaded all the way up to the newest memory is
  // back at today's top: the top content returns above the control row (the
  // insert keeps the on-screen memory in place via
  // maintainVisibleContentPosition), so scrolling up reveals it again.
  const reachedNewest = isAnchored && !isLoading && !hasPreviousPage && !isFetchingPreviousPage;
  // Anchored lists (a jump) start at the control row: the top content (title,
  // search, bell, This week, Looking Back) is hidden until Today -- or until
  // scrolling back up to the newest memory.
  const showTopContent = view === 'calendar' || !isAnchored || reachedNewest;
  const controlRowHeight = getControlRowHeight(view);
  // Content offset of the control row's slot in the list.
  const rowTop = showTopContent ? headerHeight : 0;

  const monthLabel = view === 'calendar'
    ? formatTimelineMonthLabel(`${gridTopMonthKey}-01`)
    : formatTimelineMonthLabel(topVisibleDate ?? anchorDate ?? new Date());
  const showTodayButton = view === 'calendar'
    ? gridTopMonthKey !== currentMonthKey || isScrolledDeep
    : (isAnchored && !reachedNewest) || isScrolledDeep;

  // Video autoplay (fixed at mount -- RN throws if this changes).
  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const firstVideo = viewableItems.find((token) => {
      const row = token.item as TimelineRow;
      return token.isViewable && row.kind === 'memory'
        && row.memory.mediaAssets.some((asset) => isVideoContentType(asset.content_type));
    });
    setActiveVideoId(firstVideo ? (firstVideo.item as MemoryRow).memory.id : null);
  }, []);

  // ── Month label: the row under the control row ───────────────────────────
  // Read from real geometry on every scroll: in List view the measured cell
  // positions (MeasuredCell), in Calendar view the exact month offsets. The
  // probe line is just below the row -- pinned (at the scroll offset) or in
  // place (at its slot) -- so a card hidden under the row never counts.
  const cellLayoutsRef = useRef(new Map<string, CellLayout>());
  const geometryRef = useRef({ view, rowTop, controlRowHeight, gridMonths, gridMonthOffsets });
  useEffect(() => {
    geometryRef.current = { view, rowTop, controlRowHeight, gridMonths, gridMonthOffsets };
  });
  const updateMonthLabel = useCallback(() => {
    const geometry = geometryRef.current;
    const offset = scrollOffsetRef.current;
    const probe = Math.max(offset, geometry.rowTop) + geometry.controlRowHeight + 1;
    if (geometry.view === 'calendar') {
      const base = geometry.rowTop + geometry.controlRowHeight;
      const months = geometry.gridMonths;
      if (months.length === 0) return;
      let first = 0;
      while (first + 1 < months.length && base + (geometry.gridMonthOffsets[first + 1] ?? 0) <= probe) first += 1;
      let last = first;
      const viewportBottom = offset + viewportHeightRef.current;
      while (last + 1 < months.length && base + (geometry.gridMonthOffsets[last + 1] ?? 0) < viewportBottom) last += 1;
      const key = months[first]!.key;
      setGridTopMonthKey((previous) => (previous === key ? previous : key));
      setGridVisibleRange((previous) => (previous.first === first && previous.last === last ? previous : { first, last }));
      return;
    }
    // The card the probe line falls in: the one with the smallest top among
    // cards whose bottom is below the line.
    let best: CellLayout | null = null;
    for (const layout of cellLayoutsRef.current.values()) {
      if (layout.y + layout.height > probe && (best === null || layout.y < best.y)) best = layout;
    }
    if (best) {
      const date = best.date;
      setTopVisibleDate((previous) => (previous === date ? previous : date));
    }
  }, []);
  useEffect(() => {
    updateMonthLabelRef.current = updateMonthLabel;
  }, [updateMonthLabel]);
  // Cells report on mount, resize and move (prepends shift them); coalesce to
  // one label update per frame.
  const labelFrameRef = useRef<number | null>(null);
  const reportCellLayout = useCallback<CellLayoutReporter>((id, layout) => {
    if (layout) {
      cellLayoutsRef.current.set(id, layout);
    } else {
      cellLayoutsRef.current.delete(id);
    }
    if (labelFrameRef.current === null) {
      labelFrameRef.current = requestAnimationFrame(() => {
        labelFrameRef.current = null;
        updateMonthLabelRef.current();
      });
    }
  }, []);
  useEffect(() => () => {
    if (labelFrameRef.current !== null) cancelAnimationFrame(labelFrameRef.current);
  }, []);

  // ── Scrolling helpers ────────────────────────────────────────────────────
  const scrollToTop = useCallback((animated = true) => {
    scrollOffsetRef.current = 0;
    flatListRef.current?.scrollToOffset({ animated, offset: 0 });
  }, []);

  // Calendar view: put `monthKey` right under the pinned control row -- the
  // top content scrolls off above it.
  const scrollGridToMonth = useCallback((monthKey: string, animated: boolean) => {
    const index = gridMonths.findIndex((month) => month.key === monthKey);
    if (index < 0) return;
    setGridTopMonthKey(monthKey);
    setGridVisibleRange({ first: index, last: index });
    const offset = index === 0 ? 0 : headerHeightRef.current + (gridMonthOffsets[index] ?? 0);
    // Record the target now: a queued label update must not re-derive the
    // month from the old offset before the scroll event lands.
    scrollOffsetRef.current = offset;
    flatListRef.current?.scrollToOffset({ animated, offset });
  }, [gridMonthOffsets, gridMonths]);

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
    if (view === 'list' && anchorDate !== null) {
      applyAnchor(null);
      return;
    }
    setGridTopMonthKey(currentMonthKey);
    scrollToTop();
  }, [anchorDate, applyAnchor, currentMonthKey, scrollToTop, view]);

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
    if (view === 'calendar') {
      // In the grid a pick scrolls to that month; the list's anchor is
      // untouched.
      scrollGridToMonth(toMonthKey(option.iso), false);
      return;
    }
    const next = getMonthAnchorDate(option);
    if (next === anchorDate) {
      scrollToTop();
      return;
    }
    applyAnchor(next);
  }, [anchorDate, applyAnchor, scrollGridToMonth, scrollToTop, view]);

  // Switching to Calendar opens the grid at the month the list was showing
  // (at the very top when the list was at the top of today's feed).
  const pendingGridMonthRef = useRef<string | null>(null);
  const handleChangeView = useCallback((next: TimelineView) => {
    hasChosenViewRef.current = true;
    trackEvent('timeline_view_switched', { view: next });
    if (next === 'calendar') {
      const monthKey = toMonthKey(topVisibleDate ?? anchorDate ?? todayIso);
      const atTop = anchorDate === null && scrollOffsetRef.current <= headerHeightRef.current;
      pendingGridMonthRef.current = atTop ? null : monthKey;
      setGridTopMonthKey(atTop ? currentMonthKey : monthKey);
      const index = Math.max(0, gridMonths.findIndex((month) => month.key === monthKey));
      setGridVisibleRange({ first: atTop ? 0 : index, last: atTop ? 0 : index });
    } else {
      setTopVisibleDate(null);
    }
    scrollOffsetRef.current = 0;
    isScrolledDeepRef.current = false;
    setIsScrolledDeep(false);
    setActiveVideoId(null);
    setView(next);
    void saveTimelineView(next);
  }, [anchorDate, currentMonthKey, gridMonths, todayIso, topVisibleDate]);

  // The Calendar list mounts at offset 0; land it on the pending month once
  // it has laid out (exact offsets: getItemLayout + the measured header).
  useEffect(() => {
    if (view !== 'calendar' || !pendingGridMonthRef.current) return;
    const monthKey = pendingGridMonthRef.current;
    pendingGridMonthRef.current = null;
    const frame = requestAnimationFrame(() => scrollGridToMonth(monthKey, false));
    return () => cancelAnimationFrame(frame);
  }, [scrollGridToMonth, view]);

  // A day tile opens the list at that day (today = the feed itself).
  const handleGridDayPress = useCallback((iso: string) => {
    trackEvent('timeline_jumped', {
      source: 'calendar_day',
      months_back: Math.max(0, monthsBetween(currentMonthKey, toMonthKey(iso))),
    });
    applyAnchor(iso === todayIso ? null : iso);
    hasChosenViewRef.current = true;
    setView('list');
  }, [applyAnchor, currentMonthKey, todayIso]);

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

  const bellUnread = hasUnreadActivity || galleryBellUnread;

  // ── Rows ─────────────────────────────────────────────────────────────────
  const rows = useMemo<TimelineRow[]>(() => {
    const content: TimelineRow[] = view === 'calendar'
      ? gridMonths.map((month, monthIndex) => ({ kind: 'month', month, monthIndex }))
      : visibleMemories.map((memory) => ({ kind: 'memory', memory }));
    // No "loading newer" row: newer pages land above the viewport, and an
    // extra row at index 1 would become maintainVisibleContentPosition's
    // anchor and then vanish.
    return [CONTROL_ROW, ...content];
  }, [gridMonths, view, visibleMemories]);

  // Calendar view only: every row's height is known (control row, months),
  // offset by the measured top content.
  const getGridItemLayout = useCallback(
    (_data: ArrayLike<TimelineRow> | null | undefined, index: number) => {
      if (index === 0) {
        return { index, length: controlRowHeight, offset: headerHeight };
      }
      const month = gridMonths[index - 1];
      return {
        index,
        length: month ? getGridMonthHeight(month, tileSize) : 0,
        offset: headerHeight + controlRowHeight + (gridMonthOffsets[index - 1] ?? 0),
      };
    },
    [controlRowHeight, gridMonthOffsets, gridMonths, headerHeight, tileSize],
  );

  const keyExtractor = useCallback((row: TimelineRow) => {
    switch (row.kind) {
      case 'memory':
        return row.memory.id;
      case 'month':
        return `month-${row.month.key}`;
      default:
        return row.kind;
    }
  }, []);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<TimelineRow>) => {
      if (item.kind === 'controls') {
        // An empty slot: the real row is the overlay above the list.
        return <View style={{ height: controlRowHeight }} testID="timeline-control-row-slot" />;
      }
      if (item.kind === 'month') {
        return (
          <CalendarGridMonth
            isTargetReported={contentSafety.isTargetReported}
            month={item.month}
            onDayPress={handleGridDayPress}
            summaries={gridSummaries}
            tileSize={tileSize}
          />
        );
      }
      const memory = item.memory;
      const isMemoryReported = contentSafety.isTargetReported('memory', memory.id);
      const isIllustrationReported = contentSafety.isTargetReported(
        'memory_illustration',
        memory.id,
        memory.illustration_generation_id,
      );
      if (isMemoryReported) {
        return (
          <View style={styles.cardItem}>
            <ContentHiddenNotice
              label="Reported memory hidden"
              onShow={() => contentSafety.revealTarget('memory', memory.id)}
              testID={`timeline-memory-${memory.id}-hidden`}
            />
          </View>
        );
      }
      return (
        <View style={styles.cardItem}>
          <MemoryCard
            memory={memory}
            onPress={handleCardPress}
            onOpenComments={handleOpenComments}
            isVideoActive={memory.id === activeVideoId}
            isIllustrationHidden={isIllustrationReported}
            onShowIllustration={() => contentSafety.revealTarget(
              'memory_illustration',
              memory.id,
              memory.illustration_generation_id,
            )}
          />
        </View>
      );
    },
    [activeVideoId, contentSafety, controlRowHeight, gridSummaries, handleCardPress, handleGridDayPress, handleOpenComments, tileSize],
  );

  // Top content above the control row. Scrolls away; hidden while anchored.
  const listHeader = useMemo(
    () => (showTopContent ? (
      <View onLayout={handleHeaderLayout} testID="timeline-top-sections">
        <TimelineTitleWithStreak
          bellUnread={bellUnread}
          memories={visibleMemories}
          onPressBell={handleOpenActivitySheet}
          showStreak
        />
        <LookingBackPackageRail packages={lookingBack.packages} onOpen={handleOpenLookingBackPackage} />
        <PendingMemoryUploadsBanner />
        {/* The invite renders above the first memory when there is exactly
            one memory, matching its empty-state placement below --
            visibleMemories.length <= 1 is the one condition both branches
            share (docs/plans/gallery-import-continuous.md I4a step 1). */}
        {canEdit && view === 'list' && visibleMemories.length === 1 ? <TimelineGalleryImportInvite /> : null}
        <View style={lookingBack.packages.length > 0 ? styles.controlRowGap : styles.controlRowGapWithoutRail} />
      </View>
    ) : null),
    [
      bellUnread, canEdit, handleHeaderLayout, handleOpenActivitySheet, handleOpenLookingBackPackage,
      lookingBack.packages, showTopContent, view, visibleMemories,
    ],
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
    void Promise.all([
      view === 'calendar' ? Promise.all([refetchGridMemories(), monthCounts.refresh()]) : refetch(),
      lookingBack.refetch(),
      refetchActivityUnread(),
    ]);
  }, [lookingBack, monthCounts, refetch, refetchActivityUnread, refetchGridMemories, view]);

  const listFooter = view === 'list' && isFetchingNextPage ? (
    <View style={styles.listFooterLoading}>
      <ActivityIndicator color={colors.primary} />
    </View>
  ) : null;

  // ── Pinned control row overlay ───────────────────────────────────────────
  const listKey = `${view}:${view === 'list' ? anchorDate ?? 'feed' : 'grid'}`;
  // translateY = rowTop - scrollY while the slot is below the top, then 0.
  const controlRowTranslateY = useMemo(
    () => scrollY.interpolate({
      inputRange: [rowTop - 1, rowTop],
      outputRange: [1, 0],
      extrapolateLeft: 'extend',
      extrapolateRight: 'clamp',
    }),
    [rowTop, scrollY],
  );
  const isControlRowReady = !showTopContent || headerHeight > 0;
  const animatedScrollHandler = useMemo(
    () => Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
      useNativeDriver: true,
      listener: handleScroll,
    }),
    [handleScroll, scrollY],
  );
  // A remounted list starts at offset 0; so must the overlay.
  useEffect(() => {
    scrollY.setValue(0);
    scrollOffsetRef.current = 0;
    cellLayoutsRef.current.clear();
  }, [listKey, scrollY]);

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

  const refreshControl = (
    <RefreshControl refreshing={isRefetching || lookingBack.isRefetching} onRefresh={handleRefresh} tintColor={colors.primary} />
  );
  // An anchored list's top isn't today's top until the newest memory has
  // loaded: pulling there would re-fetch the anchor and throw the user back
  // to the jumped-to month mid-scroll. No pull-to-refresh until then.
  const listRefreshControl = view === 'list' && isAnchored && !reachedNewest ? undefined : refreshControl;
  const titleProps = { bellUnread, onPressBell: handleOpenActivitySheet };

  return (
    // The screen owns the top inset, so the sticky control row pins below the
    // status bar and the title scrolls under a solid strip.
    <SafeAreaView edges={['top']} style={styles.container} testID="timeline-screen">
      {view === 'list' && isLoading ? (
        <>
          <TimelineTitleWithStreak {...titleProps} memories={memories} showStreak={!isAnchored} />
          <View style={styles.centeredInline}>
            <ActivityIndicator color={colors.primary} size="large" />
          </View>
        </>
      ) : view === 'list' && isError ? (
        <ScrollView refreshControl={refreshControl}>
          <TimelineTitleWithStreak {...titleProps} memories={memories} showStreak={!isAnchored} />
          <Text style={styles.errorText}>Could not load memories</Text>
        </ScrollView>
      ) : view === 'list' && memories.length > 0 && visibleMemories.length === 0 ? (
        <ScrollView
          contentContainerStyle={styles.hiddenOnlyWrap}
          refreshControl={refreshControl}
          testID="timeline-hidden-content-state"
        >
          <View>
            <TimelineTitleWithStreak {...titleProps} memories={memories} showStreak={!isAnchored} />
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
      ) : view === 'list' && visibleMemories.length === 0 && isAnchored ? (
        // Only reachable if the anchored range emptied out underneath us (the
        // picker never offers an empty month) -- offer the way home.
        <ScrollView style={styles.emptyWrap} refreshControl={refreshControl} testID="timeline-anchored-empty-state">
          <TimelineTitle {...titleProps} />
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
      ) : view === 'list' && visibleMemories.length === 0 ? (
        <ScrollView
          style={styles.emptyWrap}
          refreshControl={refreshControl}
          testID="timeline-empty-state"
        >
          <View>
            <TimelineTitleWithStreak {...titleProps} memories={visibleMemories} showStreak />
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
        <View style={styles.listFrame}>
          <CellLayoutContext.Provider value={reportCellLayout}>
            <Animated.FlatList
              CellRendererComponent={MeasuredCell}
              contentContainerStyle={view === 'calendar' ? styles.gridContent : styles.listContent}
              data={rows}
              getItemLayout={view === 'calendar' ? getGridItemLayout : undefined}
              initialNumToRender={view === 'calendar' ? 4 : 6}
              key={listKey}
              keyExtractor={keyExtractor}
              ListFooterComponent={listFooter}
              ListHeaderComponent={listHeader}
              // Index 1: the first memory -- never the control row's slot,
              // which doesn't move when newer pages are inserted below it.
              maintainVisibleContentPosition={view === 'list' && isAnchored ? { minIndexForVisible: 1 } : undefined}
              maxToRenderPerBatch={view === 'calendar' ? 3 : 6}
              onEndReached={view === 'list' ? handleEndReached : undefined}
              onEndReachedThreshold={0.5}
              onScroll={animatedScrollHandler}
              onStartReached={view === 'list' && isAnchored ? handleStartReached : undefined}
              onStartReachedThreshold={NEWER_PAGE_THRESHOLD_SCREENS}
              ref={flatListRef as never}
              refreshControl={listRefreshControl}
              removeClippedSubviews={view === 'list'}
              renderItem={renderItem}
              scrollEventThrottle={16}
              testID={view === 'calendar' ? 'calendar-grid' : 'timeline-memory-list'}
              onViewableItemsChanged={onViewableItemsChanged}
              viewabilityConfig={timelineViewabilityConfig}
              windowSize={7}
            />
          </CellLayoutContext.Provider>
          {/* The control row, pinned: rides with its slot (rowTop - scrollY)
              until it reaches the top, then stays -- on the native driver, so
              it tracks the scroll frame-for-frame. Hidden until the top
              content has been measured, so it can't flash over the title. */}
          <Animated.View
            pointerEvents={isControlRowReady ? 'box-none' : 'none'}
            style={[
              styles.controlRowOverlay,
              { opacity: isControlRowReady ? 1 : 0, transform: [{ translateY: controlRowTranslateY }] },
            ]}
          >
            <TimelineControlRow
              canJumpToMonth={canJumpToMonth}
              monthLabel={monthLabel}
              onChangeView={handleChangeView}
              onPressMonth={handleOpenMonthPicker}
              onPressToday={handlePressToday}
              showToday={showTodayButton}
              tileSize={tileSize}
              view={view}
            />
          </Animated.View>
        </View>
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
    </SafeAreaView>
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
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  headerGlyphs: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
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
  // No `gap`: spacing lives in the cells (cardItem's paddingBottom) and the
  // control row's own bottom gap, identical in both views.
  listContent: {
    paddingBottom: 130,
  },
  listFrame: {
    flex: 1,
  },
  controlRowOverlay: {
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  // No gap: Calendar view's getItemLayout offsets assume rows sit flush.
  gridContent: {
    paddingBottom: 130,
  },
  // Space above the control row (the old "Recently" separator's padding).
  controlRowGap: { height: 2 },
  controlRowGapWithoutRail: { height: 14 },
  cardItem: {
    paddingBottom: 14,
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
