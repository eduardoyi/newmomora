import { router } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewabilityConfig,
  type ViewToken,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MemoryCard } from '@/components/memory-card';
import { MemoryFab } from '@/components/memory-fab';
import { PendingMemoryUploadsBanner } from '@/components/pending-memory-uploads-banner';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useFamily } from '@/hooks/use-family';
import { useMemories } from '@/hooks/useMemories';
import type { MemoryWithTags } from '@/services/memories';
import { useOnboardingStatus } from '@/hooks/useFamilyMembers';
import { addFamilyMemberRoute, memoryDetailRoute, newMemoryRoute } from '@/lib/routes';
import { canEditFamilyContent } from '@/utils/roles';
import { isVideoContentType } from '@/utils/media-validation';

function toLocalDateString(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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
            style={[
              styles.streakDot,
              (d.hasMemory || d.isToday) && styles.streakDotFilled,
              d.isToday && styles.streakDotToday,
            ]}
          />
        ))}
      </View>
    </View>
  );
}

function TimelineHeader({ memories }: { memories: MemoryWithTags[] }) {
  const now = new Date();
  const dayLabel = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <View style={styles.header}>
      <Text style={styles.eyebrow}>{dayLabel}</Text>
      <Text style={styles.title}>Your moments.</Text>
      <StreakDots memories={memories} />
    </View>
  );
}

export default function TimelineScreen() {
  const { role } = useFamily();
  const canEdit = canEditFamilyContent(role);
  const { isLoading: isOnboardingLoading, needsFamilyMember } = useOnboardingStatus();
  const [searchQuery] = useState('');
  const { memories, isLoading, isRefetching, isError, refetch } = useMemories(searchQuery);
  const [activeVideoId, setActiveVideoId] = useState<string | null>(null);

  const viewabilityConfig = useRef<ViewabilityConfig>({
    viewAreaCoveragePercentThreshold: 60,
  }).current;

  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const firstVideo = viewableItems.find(
      (t) =>
        t.isViewable &&
        (t.item as MemoryWithTags).mediaAssets.some((asset) => isVideoContentType(asset.content_type)),
    );
    setActiveVideoId(firstVideo ? (firstVideo.item as MemoryWithTags).id : null);
  }, []);

  if (isOnboardingLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.primary} size="large" />
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
            <TimelineHeader memories={memories} />
          </SafeAreaView>
          <View style={styles.centeredInline}>
            <ActivityIndicator color={colors.primary} size="large" />
          </View>
        </>
      ) : isError ? (
        <ScrollView
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.primary} />
          }
        >
          <SafeAreaView>
            <TimelineHeader memories={memories} />
          </SafeAreaView>
          <Text style={styles.errorText}>Could not load memories</Text>
        </ScrollView>
      ) : memories.length === 0 ? (
        <ScrollView
          style={styles.emptyWrap}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.primary} />
          }
          testID="timeline-empty-state"
        >
          <SafeAreaView>
              <TimelineHeader memories={memories} />
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
          data={memories}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={
            <SafeAreaView>
              <TimelineHeader memories={memories} />
              <PendingMemoryUploadsBanner />
            </SafeAreaView>
          }
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.primary} />
          }
          renderItem={({ item }) => (
            <View style={styles.cardItem}>
              <MemoryCard
                key={item.id}
                memory={item}
                onPress={() => router.push(memoryDetailRoute(item.id))}
                isVideoActive={item.id === activeVideoId}
              />
            </View>
          )}
          testID="timeline-memory-list"
        />
      )}

      {canEdit && <MemoryFab onPress={() => router.push(newMemoryRoute)} />}
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
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
  },
  listContent: {
    gap: 14,
    paddingBottom: 130,
  },
  cardItem: {
    paddingHorizontal: spacing.md,
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
  errorText: {
    color: colors.error,
    padding: spacing.lg,
    fontFamily: fonts.sans,
  },
});
