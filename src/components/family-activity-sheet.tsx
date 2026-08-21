import { useEffect, useMemo, useRef } from 'react';
import { Modal, Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FamilyActivityRow } from '@/components/family-activity-row';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useFamily } from '@/hooks/use-family';
import { useFamilyActivity, useMarkFamilyActivitySeen } from '@/hooks/useFamilyActivity';
import { useFamilyMemberProfiles } from '@/hooks/useFamilyMemberProfiles';
import { groupFamilyActivity, type FamilyActivityGroup } from '@/services/family-activity';
import { getBottomSheetBottomPadding, shouldDismissBottomSheet } from '@/utils/bottom-sheet-dismiss';

export interface FamilyActivitySheetProps {
  visible: boolean;
  onClose: () => void;
  onOpenMemory: (memoryId: string) => void;
  onOpenComments: (memoryId: string) => void;
  onOpenApprovals: () => void;
  onInvite: () => void;
}

function SkeletonRow({ testID }: { testID: string }) {
  return (
    <View style={styles.skeletonRow} testID={testID}>
      <View style={styles.skeletonLines}>
        <View style={[styles.skeletonLine, styles.skeletonLineWide]} />
        <View style={[styles.skeletonLine, styles.skeletonLineNarrow]} />
      </View>
    </View>
  );
}

interface FamilyActivitySheetBodyProps {
  onClose: () => void;
  runAfterClose: (action: () => void) => void;
  onOpenMemory: (memoryId: string) => void;
  onOpenComments: (memoryId: string) => void;
  onOpenApprovals: () => void;
  onInvite: () => void;
}

/**
 * Everything data-dependent (RPC-backed hooks + the loading/error/empty/list
 * body) lives here rather than in `FamilyActivitySheet` itself, and this
 * component is rendered only inside the `Modal`'s children -- RN's `Modal`
 * renders `null` while `visible` is false, unmounting its children, so this
 * body (and every hook it calls) only exists while the sheet is actually
 * open. `FamilyActivitySheet` is mounted once, persistently, on the timeline
 * screen, so keeping these hooks there directly would fire an RPC on every
 * timeline mount regardless of whether the sheet was ever opened.
 */
function FamilyActivitySheetBody({
  onClose,
  runAfterClose,
  onOpenMemory,
  onOpenComments,
  onOpenApprovals,
  onInvite,
}: FamilyActivitySheetBodyProps) {
  const { familyId } = useFamily();
  const { profiles } = useFamilyMemberProfiles(familyId);
  const { events, isLoading, isError, refetch } = useFamilyActivity(familyId);
  const markSeen = useMarkFamilyActivitySeen();

  // This component mounts fresh every time the sheet opens (see the class
  // comment above), so a mount-only computation is exactly "compute once per
  // open" -- no need to key it off `visible` the way the previous
  // single-component version did.
  const now = useMemo(() => new Date(), []);
  const sections = useMemo(() => groupFamilyActivity(events, { now }), [events, now]);
  const activeMemberCount = useMemo(
    () => profiles.filter((profile) => profile.is_active_member).length,
    [profiles],
  );

  useEffect(() => {
    markSeen.mutate();
    // Fire exactly once per mount (i.e. once per open) -- `mutate`'s
    // identity isn't a meaningful dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRowPress = (group: FamilyActivityGroup) => {
    const memoryId = group.events[0].memoryId;
    switch (group.kind) {
      case 'memory_added':
      case 'memory_liked':
        if (memoryId) {
          runAfterClose(() => onOpenMemory(memoryId));
        } else {
          onClose();
        }
        break;
      case 'memory_commented':
        if (memoryId) {
          runAfterClose(() => onOpenComments(memoryId));
        } else {
          onClose();
        }
        break;
      case 'member_pending':
        runAfterClose(() => onOpenApprovals());
        break;
      case 'member_joined':
        // No dedicated members-list callback is wired for this sheet (plan
        // §7's prop list doesn't include one) -- closing is the whole
        // action, matching the event catalogue's "...or no-op" tap target.
        onClose();
        break;
    }
  };

  const handleInvite = () => {
    runAfterClose(() => onInvite());
  };

  if (isLoading) {
    return (
      <View testID="family-activity-sheet-loading">
        <SkeletonRow testID="family-activity-skeleton-row-0" />
        <SkeletonRow testID="family-activity-skeleton-row-1" />
        <SkeletonRow testID="family-activity-skeleton-row-2" />
      </View>
    );
  }

  if (isError) {
    return (
      <View style={styles.centered} testID="family-activity-sheet-error">
        <Text style={styles.errorText}>Could not load family activity</Text>
        <Pressable accessibilityRole="button" onPress={() => void refetch()}>
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  if (sections.length === 0) {
    return (
      <View style={styles.emptyState} testID="family-activity-sheet-empty">
        <Text style={styles.emptyTitle}>
          {"Quiet for now. When someone adds a moment or leaves a comment, it'll show up here."}
        </Text>
        {activeMemberCount === 1 ? (
          <Pressable accessibilityRole="button" onPress={handleInvite} testID="family-activity-sheet-invite">
            <Text style={styles.inviteLink}>Invite a family member</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <SectionList
      contentContainerStyle={styles.listContent}
      keyExtractor={(group) => group.id}
      renderItem={({ item }) => <FamilyActivityRow group={item} onPress={() => handleRowPress(item)} />}
      renderSectionHeader={({ section }) => <Text style={styles.sectionHeader}>{section.title}</Text>}
      sections={sections}
      showsVerticalScrollIndicator={false}
      stickySectionHeadersEnabled={false}
      testID="family-activity-sheet-list"
    />
  );
}

export function FamilyActivitySheet({
  visible,
  onClose,
  onOpenMemory,
  onOpenComments,
  onOpenApprovals,
  onInvite,
}: FamilyActivitySheetProps) {
  const insets = useSafeAreaInsets();
  const drawerTranslateY = useSharedValue(0);
  // Holds a navigation action queued by a row/invite tap so it runs only
  // once the sheet has actually finished closing (see the effect below) --
  // firing `router.push` synchronously alongside `onClose()` can run the
  // navigation before the Modal has re-rendered closed, which on Android
  // can leave the destination route stranded underneath the modal window.
  const pendingActionRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (visible) return;
    const action = pendingActionRef.current;
    if (!action) return;
    pendingActionRef.current = null;
    action();
  }, [visible]);

  const runAfterClose = (action: () => void) => {
    pendingActionRef.current = action;
    onClose();
  };

  useEffect(() => {
    if (visible) drawerTranslateY.set(0);
  }, [drawerTranslateY, visible]);

  const handleClose = () => {
    onClose();
  };

  const drawerDrag = Gesture.Pan()
    .withTestId('family-activity-sheet-dismiss-pan')
    .activeOffsetY(8)
    .failOffsetX([-30, 30])
    .failOffsetY([-4, Number.MAX_SAFE_INTEGER])
    .maxPointers(1)
    .onUpdate((event) => {
      drawerTranslateY.set(Math.max(0, event.translationY));
    })
    .onEnd((event) => {
      if (shouldDismissBottomSheet(event.translationY, event.velocityY)) {
        runOnJS(handleClose)();
        return;
      }
      drawerTranslateY.set(withSpring(0));
    })
    .onFinalize((_event, success) => {
      if (!success) {
        drawerTranslateY.set(withSpring(0));
      }
    });

  const animatedSheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: drawerTranslateY.get() }],
  }));

  return (
    <Modal
      animationType="slide"
      onRequestClose={handleClose}
      presentationStyle="overFullScreen"
      transparent
      visible={visible}
    >
      {/* A Modal is a separate Android native window -- needs its own
          gesture root, same as MemoryCommentsDrawer. Modal renders `null`
          while `visible` is false, so everything below (including
          FamilyActivitySheetBody and its RPC-backed hooks) only mounts
          while the sheet is actually open. */}
      <GestureHandlerRootView style={styles.root}>
        <Pressable
          accessibilityLabel="Close family activity"
          accessibilityRole="button"
          onPress={handleClose}
          style={styles.backdrop}
          testID="family-activity-sheet-backdrop"
        />
        <Animated.View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            animatedSheetStyle,
            { paddingBottom: getBottomSheetBottomPadding(insets.bottom, false) },
          ]}
          testID="family-activity-sheet"
        >
          <GestureDetector gesture={drawerDrag}>
            <View collapsable={false} style={styles.dragRegion} testID="family-activity-sheet-drag-region">
              <View style={styles.handle} />
              <View style={styles.header}>
                <Text style={styles.title}>Family activity</Text>
                <Pressable
                  accessibilityLabel="Close family activity"
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={handleClose}
                  style={styles.closeButton}
                  testID="family-activity-sheet-close"
                >
                  <Text style={styles.closeButtonText}>×</Text>
                </Pressable>
              </View>
            </View>
          </GestureDetector>

          <FamilyActivitySheetBody
            onClose={onClose}
            onInvite={onInvite}
            onOpenApprovals={onOpenApprovals}
            onOpenComments={onOpenComments}
            onOpenMemory={onOpenMemory}
            runAfterClose={runAfterClose}
          />
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(44,36,24,0.34)',
  },
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    flex: 1,
    maxHeight: '80%',
    overflow: 'hidden',
  },
  handle: {
    alignSelf: 'center',
    backgroundColor: colors.borderStrong,
    borderRadius: radius.pill,
    height: 5,
    marginTop: 10,
    width: 40,
  },
  dragRegion: { minHeight: 44 },
  header: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  title: { color: colors.ink, fontFamily: fonts.displayMedium, fontSize: 18 },
  closeButton: { alignItems: 'center', height: 36, justifyContent: 'center', width: 36 },
  closeButtonText: { color: colors.ink2, fontSize: 22, lineHeight: 22 },
  centered: { alignItems: 'center', flex: 1, gap: spacing.sm, justifyContent: 'center', paddingVertical: spacing.xxl },
  errorText: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 14 },
  retryText: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 14 },
  emptyState: { alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.xl, paddingVertical: spacing.xxl },
  emptyTitle: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 14, lineHeight: 21, textAlign: 'center' },
  inviteLink: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 14 },
  listContent: { paddingBottom: 10, paddingTop: 4 },
  sectionHeader: {
    backgroundColor: colors.white,
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    fontSize: 12,
    paddingHorizontal: spacing.lg,
    paddingTop: 14,
    paddingBottom: 6,
    textTransform: 'uppercase',
  },
  skeletonRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 11,
    paddingHorizontal: spacing.lg,
    paddingVertical: 12,
  },
  skeletonLines: { flex: 1, gap: 8 },
  skeletonLine: { backgroundColor: colors.surface, borderRadius: radius.sm, height: 10 },
  skeletonLineWide: { width: '80%' },
  skeletonLineNarrow: { width: '45%' },
});
