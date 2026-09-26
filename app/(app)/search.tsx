import { router } from 'expo-router';
import { Search, X } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ListRenderItemInfo,
} from 'react-native';
import { KeyboardAvoidingView, useKeyboardState } from 'react-native-keyboard-controller';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { FamilyMemberAvatar } from '@/components/family-member-avatar';
import { MemorySearchRow } from '@/components/memory-search-row';
import { colors, emotionColors, fonts, radius, spacing, type EmotionName } from '@/constants/theme';
import { useContentSafety } from '@/hooks/useContentSafety';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useMemorySearch } from '@/hooks/useMemories';
import { useBatchedMediaUrls } from '@/hooks/useMediaUrls';
import { memoryDetailRoute } from '@/lib/routes';
import { trackEvent } from '@/services/analytics';
import type { MemorySearchHit } from '@/services/memories';
import { searchResultThumbnail } from '@/utils/memory-search';

/** Typing settles for this long before a search runs. */
export const SEARCH_DEBOUNCE_MS = 250;

const FEELINGS = Object.keys(emotionColors) as EmotionName[];

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, value]);
  return debounced;
}

/**
 * Timeline search (docs/features/memory-search.md): free text plus one
 * person chip and one feeling chip, all combined. Results are compact rows,
 * best match first, loaded a page at a time.
 *
 * Keyboard: the field is at the top so it is always visible; the results
 * list is the only thing under the keyboard, and keyboard-controller's
 * KeyboardAvoidingView (padding) is the single owner of keyboard-height
 * compensation for it (AGENTS.md keyboard rules). The list's bottom padding
 * clears the navigation bar only while the keyboard is closed.
 */
export default function MemorySearchScreen() {
  const insets = useSafeAreaInsets();
  const isKeyboardVisible = useKeyboardState((state) => state.isVisible);
  const [text, setText] = useState('');
  const [memberId, setMemberId] = useState<string | null>(null);
  const [emotion, setEmotion] = useState<EmotionName | null>(null);
  const query = useDebouncedValue(text, SEARCH_DEBOUNCE_MS);

  const { members } = useFamilyMembers();
  const contentSafety = useContentSafety();
  const search = useMemorySearch({ query, memberId, emotion });

  useEffect(() => {
    trackEvent('memory_search_opened', { source: 'timeline' });
  }, []);

  // Reported memories stay out of results entirely, like the timeline's
  // hidden-notice cards (the notice itself would be noise in a result list).
  const hits = useMemo(
    () => search.hits.filter((hit) => !contentSafety.isTargetReported('memory', hit.memory.id)),
    [contentSafety, search.hits],
  );
  const thumbnails = useMemo(
    () => new Map(hits.map((hit) => [
      hit.memory.id,
      searchResultThumbnail(
        hit.memory,
        contentSafety.isTargetReported('memory_illustration', hit.memory.id, hit.memory.illustration_generation_id),
      ),
    ])),
    [contentSafety, hits],
  );
  const thumbnailKeys = useMemo(
    () => [...thumbnails.values()].flatMap((thumbnail) => (thumbnail.key ? [thumbnail.key] : [])),
    [thumbnails],
  );
  const thumbnailUrls = useBatchedMediaUrls(thumbnailKeys);

  const handleOpen = useCallback((memoryId: string) => {
    const position = hits.findIndex((hit) => hit.memory.id === memoryId);
    trackEvent('memory_search_result_opened', {
      matched_in: hits[position]?.matchedIn ?? 'chip',
      position,
      has_text: query.trim().length > 0,
      has_person: memberId !== null,
      has_feeling: emotion !== null,
    });
    router.push(memoryDetailRoute(memoryId));
  }, [emotion, hits, memberId, query]);

  const renderItem = useCallback(({ item }: ListRenderItemInfo<MemorySearchHit>) => {
    const thumbnail = thumbnails.get(item.memory.id) ?? { key: null, fallback: 'blank' as const };
    return (
      <MemorySearchRow
        matchedIn={item.matchedIn}
        memory={item.memory}
        onPress={handleOpen}
        query={query}
        thumbnail={thumbnail}
        thumbnailUrl={thumbnail.key ? thumbnailUrls[thumbnail.key] : undefined}
      />
    );
  }, [handleOpen, query, thumbnailUrls, thumbnails]);

  const chips = (
    <View style={styles.chips} testID="memory-search-chips">
      {members.length > 0 ? (
        <>
          <Text style={styles.chipsLabel}>People</Text>
          <ScrollView
            contentContainerStyle={styles.chipRow}
            horizontal
            keyboardShouldPersistTaps="handled"
            showsHorizontalScrollIndicator={false}
          >
            {members.map((member) => {
              const selected = memberId === member.id;
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  key={member.id}
                  onPress={() => setMemberId(selected ? null : member.id)}
                  style={[styles.chip, selected && styles.chipSelected]}
                  testID={`memory-search-person-${member.id}`}
                >
                  <FamilyMemberAvatar member={member} size={22} />
                  <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{member.name}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </>
      ) : null}
      <Text style={styles.chipsLabel}>Feelings</Text>
      <ScrollView
        contentContainerStyle={styles.chipRow}
        horizontal
        keyboardShouldPersistTaps="handled"
        showsHorizontalScrollIndicator={false}
      >
        {FEELINGS.map((feeling) => {
          const selected = emotion === feeling;
          const palette = emotionColors[feeling];
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected }}
              key={feeling}
              onPress={() => setEmotion(selected ? null : feeling)}
              style={[styles.chip, selected && { backgroundColor: palette.soft, borderColor: palette.c }]}
              testID={`memory-search-feeling-${feeling}`}
            >
              <View style={[styles.feelingDot, { backgroundColor: palette.c }]} />
              <Text style={[styles.chipText, selected && { color: palette.ink }]}>{capitalize(feeling)}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );

  let emptyState: ReactNode = null;
  if (!search.hasCriteria) {
    emptyState = (
      <Text style={styles.hint} testID="memory-search-hint">
        Search for words, what was said, or what&apos;s in a photo — or pick a person or feeling.
      </Text>
    );
  } else if (search.isLoading) {
    emptyState = <ActivityIndicator color={colors.primary} style={styles.loading} testID="memory-search-loading" />;
  } else if (search.isError) {
    emptyState = (
      <View style={styles.centered} testID="memory-search-error">
        <Text style={styles.hint}>Could not search your memories.</Text>
        <Pressable accessibilityRole="button" onPress={() => void search.refetch()}>
          <Text style={styles.retry}>Try again</Text>
        </Pressable>
      </View>
    );
  } else if (hits.length === 0) {
    emptyState = (
      <Text style={styles.hint} testID="memory-search-empty">
        No memories match. Try fewer words, or a different person or feeling.
      </Text>
    );
  }

  return (
    <SafeAreaView edges={['top']} style={styles.screen} testID="memory-search-screen">
      <View style={styles.searchBar}>
        <View style={styles.field}>
          <Search color={colors.ink3} size={18} strokeWidth={2} />
          <TextInput
            accessibilityLabel="Search memories"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            clearButtonMode="never"
            onChangeText={setText}
            placeholder="Search memories"
            placeholderTextColor={colors.ink3}
            returnKeyType="search"
            style={styles.input}
            testID="memory-search-input"
            value={text}
          />
          {text ? (
            <Pressable
              accessibilityLabel="Clear search"
              accessibilityRole="button"
              hitSlop={10}
              onPress={() => setText('')}
              testID="memory-search-clear"
            >
              <X color={colors.ink3} size={16} strokeWidth={2.2} />
            </Pressable>
          ) : null}
        </View>
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => router.back()}
          testID="memory-search-cancel"
        >
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
      </View>

      <KeyboardAvoidingView behavior="padding" style={styles.flex} testID="memory-search-keyboard-avoider">
        <FlatList
          ListEmptyComponent={emptyState}
          ListFooterComponent={search.isFetchingNextPage
            ? <ActivityIndicator color={colors.primary} style={styles.loading} />
            : null}
          ListHeaderComponent={chips}
          // Keyboard closed: clear the navigation bar. Open: the keyboard
          // (and the avoider's padding) already covers that region.
          contentContainerStyle={{ paddingBottom: (isKeyboardVisible ? 0 : insets.bottom) + spacing.lg }}
          data={hits}
          keyExtractor={(hit) => hit.memory.id}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          onEndReached={() => {
            if (search.hasNextPage && !search.isFetchingNextPage) void search.fetchNextPage();
          }}
          onEndReachedThreshold={0.5}
          renderItem={renderItem}
          testID="memory-search-results"
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.bg, flex: 1 },
  flex: { flex: 1 },
  searchBar: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingBottom: 10,
    paddingHorizontal: spacing.lg,
    paddingTop: 8,
  },
  field: {
    alignItems: 'center',
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: 1,
    flex: 1,
    flexDirection: 'row',
    gap: 8,
    height: 42,
    paddingHorizontal: 14,
  },
  input: { color: colors.ink, flex: 1, fontFamily: fonts.sans, fontSize: 16, paddingVertical: 0 },
  cancel: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 15 },
  chips: { gap: 8, paddingBottom: 8, paddingTop: 4 },
  chipsLabel: {
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1.2,
    paddingHorizontal: spacing.lg,
    textTransform: 'uppercase',
  },
  chipRow: { gap: 8, paddingHorizontal: spacing.lg },
  chip: {
    alignItems: 'center',
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    height: 34,
    paddingLeft: 6,
    paddingRight: 12,
  },
  chipSelected: { backgroundColor: colors.primaryTint, borderColor: colors.primary },
  chipText: { color: colors.ink2, fontFamily: fonts.sansMedium, fontSize: 13.5 },
  chipTextSelected: { color: colors.primaryDark },
  feelingDot: { borderRadius: 5, height: 10, marginLeft: 6, width: 10 },
  hint: {
    color: colors.ink3,
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 21,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    textAlign: 'center',
  },
  centered: { alignItems: 'center', gap: spacing.sm },
  retry: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 14 },
  loading: { paddingVertical: spacing.xl },
});
