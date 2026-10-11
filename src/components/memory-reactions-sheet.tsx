import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { resolveAttributionName, useFamilyMemberProfiles } from '@/hooks/useFamilyMemberProfiles';
import { useContentSafety } from '@/hooks/useContentSafety';
import { useMemoryEngagement } from '@/hooks/useMemoryEngagement';
import { useUserProfile } from '@/hooks/useUserProfile';
import type { MemoryReaction } from '@/services/engagement';
import type { MemoryWithTags } from '@/services/memories';
import { getBottomSheetBottomPadding, shouldDismissBottomSheet } from '@/utils/bottom-sheet-dismiss';

interface MemoryReactionsSheetProps {
  memory: MemoryWithTags;
  visible: boolean;
  onClose: () => void;
}

const ALL_FILTER = 'all';

export function MemoryReactionsSheet({ memory, visible, onClose }: MemoryReactionsSheetProps) {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { familyId } = useFamily();
  const { profile } = useUserProfile();
  const { profiles } = useFamilyMemberProfiles(familyId);
  const engagement = useMemoryEngagement(memory, { reactionsEnabled: visible });
  const contentSafety = useContentSafety();
  const [filter, setFilter] = useState<string>(ALL_FILTER);
  const isClosingRef = useRef(false);
  const translateY = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      isClosingRef.current = false;
    }
    translateY.set(0);
  }, [translateY, visible]);

  const handleClose = () => {
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    setFilter(ALL_FILTER);
    onClose();
  };

  const drag = Gesture.Pan()
    .withTestId('reactions-sheet-dismiss-pan')
    .activeOffsetY(8)
    .failOffsetX([-30, 30])
    .failOffsetY([-4, Number.MAX_SAFE_INTEGER])
    .maxPointers(1)
    .onUpdate((event) => {
      translateY.set(Math.max(0, event.translationY));
    })
    // `handleClose` deliberately gates concurrent close sources with a ref.
    // eslint-disable-next-line react-hooks/refs
    .onEnd((event) => {
      if (shouldDismissBottomSheet(event.translationY, event.velocityY)) {
        runOnJS(handleClose)();
        return;
      }
      translateY.set(withSpring(0));
    })
    .onFinalize((_event, success) => {
      if (!success) translateY.set(withSpring(0));
    });

  const animatedSheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.get() }],
  }));

  const reactions = engagement.reactions;

  const emojiCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const reaction of reactions) {
      counts.set(reaction.emoji, (counts.get(reaction.emoji) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [reactions]);

  // If the selected emoji disappears (e.g. my own removal), fall back to All.
  const activeFilter =
    filter === ALL_FILTER || emojiCounts.some(([emoji]) => emoji === filter) ? filter : ALL_FILTER;
  const visibleReactions =
    activeFilter === ALL_FILTER
      ? reactions
      : reactions.filter((reaction) => reaction.emoji === activeFilter);

  const nameFor = (reaction: MemoryReaction) => {
    if (reaction.userId === user?.id) return profile?.name ?? 'You';
    return resolveAttributionName(profiles, reaction.userId);
  };

  const removeMine = () => {
    void engagement.setReaction(null).catch(() => {});
  };

  return (
    <Modal
      animationType="slide"
      onRequestClose={handleClose}
      presentationStyle="overFullScreen"
      transparent
      visible={visible}
    >
      {/* A Modal is a separate Android native window, so it needs its own
          gesture root rather than relying on the app-level root. */}
      <GestureHandlerRootView style={styles.root}>
        <Pressable
          accessibilityLabel="Close reactions"
          accessibilityRole="button"
          onPress={handleClose}
          style={styles.backdrop}
          testID="reactions-sheet-backdrop"
        />
        <Animated.View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            animatedSheetStyle,
            { paddingBottom: getBottomSheetBottomPadding(insets.bottom, false) },
          ]}
          testID="reactions-sheet"
        >
          <GestureDetector gesture={drag}>
            <View collapsable={false} style={styles.dragRegion} testID="reactions-sheet-drag-region">
              <View style={styles.handle} />
              <View style={styles.header}>
                <Text style={styles.title}>Reactions</Text>
                <View style={styles.headerActions}>
                  {engagement.likeCount > 0 ? (
                    <Text style={styles.headerCount}>{engagement.likeCount}</Text>
                  ) : null}
                  <Pressable
                    accessibilityLabel="Close reactions"
                    accessibilityRole="button"
                    hitSlop={8}
                    onPress={handleClose}
                    style={styles.closeButton}
                    testID="reactions-sheet-close"
                  >
                    <SymbolView
                      fallback={<Text style={styles.closeButtonFallback}>×</Text>}
                      name={{ ios: 'xmark', android: 'close' }}
                      size={18}
                      tintColor={colors.ink2}
                    />
                  </Pressable>
                </View>
              </View>
            </View>
          </GestureDetector>

          {contentSafety.isLoading || engagement.areReactionsLoading ? (
            <View style={styles.centered}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : contentSafety.isError ? (
            <View style={styles.centered}>
              <Text style={styles.errorText}>Could not safely load reactions</Text>
              <Pressable onPress={() => void contentSafety.refetch()} testID="reactions-sheet-safety-retry">
                <Text style={styles.retryText}>Try again</Text>
              </Pressable>
            </View>
          ) : engagement.reactionsError ? (
            <View style={styles.centered}>
              <Text style={styles.errorText}>Could not load reactions</Text>
              <Pressable onPress={() => void engagement.refetchReactions()} testID="reactions-sheet-retry">
                <Text style={styles.retryText}>Try again</Text>
              </Pressable>
            </View>
          ) : reactions.length === 0 ? (
            <View style={styles.centered} testID="reactions-sheet-empty">
              <Text style={styles.emptyTitle}>No reactions yet</Text>
              <Text style={styles.emptyBody}>Tap and hold the heart to react.</Text>
            </View>
          ) : (
            <>
              <View style={styles.chips}>
                <FilterChip
                  active={activeFilter === ALL_FILTER}
                  label={`All ${reactions.length}`}
                  onPress={() => setFilter(ALL_FILTER)}
                  testID="reactions-filter-all"
                />
                {emojiCounts.map(([emoji, count]) => (
                  <FilterChip
                    active={activeFilter === emoji}
                    key={emoji}
                    label={`${emoji} ${count}`}
                    onPress={() => setFilter(emoji)}
                    testID={`reactions-filter-${emoji}`}
                  />
                ))}
              </View>
              <FlatList
                contentContainerStyle={styles.listContent}
                data={visibleReactions}
                keyExtractor={(reaction) => reaction.userId}
                renderItem={({ item }) => {
                  const mine = item.userId === user?.id;
                  const isBlocked = !mine && contentSafety.isUserBlocked(item.userId);
                  const name = isBlocked ? 'Blocked account' : nameFor(item);
                  const content = (
                    <>
                      <View style={styles.avatar}>
                        <Text style={styles.avatarText}>{isBlocked ? '•' : name.charAt(0).toUpperCase()}</Text>
                      </View>
                      <View style={styles.rowBody}>
                        <Text numberOfLines={1} style={styles.name}>
                          {mine ? 'You' : name}
                        </Text>
                        {mine ? <Text style={styles.subtle}>Tap to remove</Text> : null}
                      </View>
                      <Text style={styles.rowEmoji}>{item.emoji}</Text>
                    </>
                  );
                  return mine ? (
                    <Pressable
                      accessibilityLabel={`Remove your reaction ${item.emoji}`}
                      accessibilityRole="button"
                      onPress={removeMine}
                      style={styles.row}
                      testID={`reaction-row-${item.userId}`}
                    >
                      {content}
                    </Pressable>
                  ) : (
                    <View style={styles.row} testID={`reaction-row-${item.userId}`}>
                      {content}
                    </View>
                  );
                }}
                showsVerticalScrollIndicator={false}
                style={styles.list}
                testID="reactions-list"
              />
            </>
          )}
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}

function FilterChip({
  active,
  label,
  onPress,
  testID,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive]}
      testID={testID}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
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
    height: '60%',
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
  headerActions: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  headerCount: { color: colors.ink3, fontFamily: fonts.sansBold, fontSize: 13 },
  closeButton: { alignItems: 'center', height: 36, justifyContent: 'center', width: 36 },
  closeButtonFallback: { color: colors.ink2, fontSize: 20, lineHeight: 20 },
  centered: { alignItems: 'center', flex: 1, gap: spacing.sm, justifyContent: 'center' },
  errorText: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 14 },
  retryText: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 14 },
  emptyTitle: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 15 },
  emptyBody: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 13 },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingHorizontal: 20,
    paddingTop: 14,
  },
  chip: {
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  chipActive: { backgroundColor: colors.primaryTint },
  chipText: { color: colors.ink2, fontFamily: fonts.sansBold, fontSize: 13 },
  chipTextActive: { color: colors.primaryDark },
  list: { flex: 1 },
  listContent: { gap: 4, paddingHorizontal: 20, paddingTop: 10, paddingBottom: 10 },
  row: { alignItems: 'center', flexDirection: 'row', gap: 11, minHeight: 48 },
  avatar: {
    alignItems: 'center',
    backgroundColor: colors.primarySoft,
    borderRadius: 17,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  avatarText: { color: colors.primaryDark, fontFamily: fonts.displayMedium, fontSize: 16 },
  rowBody: { flex: 1, minWidth: 0 },
  name: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 14 },
  subtle: { color: colors.ink3, fontFamily: fonts.sansMedium, fontSize: 11.5 },
  rowEmoji: { fontSize: 24 },
});
