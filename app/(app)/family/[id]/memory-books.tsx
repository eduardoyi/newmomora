// Memory Book in-app scope picker (docs/plans/memory-book.md §"5a.5", owner
// decision 2026-09-07). Entry point: the "Memory Books" row on the child
// profile screen (app/(app)/family/[id]/index.tsx), near the portrait
// timeline. See docs/features/memory-book-generation.md for the full
// contract this screen drives.
import { Linking } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MemoryBookScopeRow } from '@/components/memory-book-scope-row';
import { colors, fonts, spacing } from '@/constants/theme';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useMemoryBooks } from '@/hooks/useMemoryBooks';
import { memoryBookWebUrl } from '@/services/memory-books';
import { canEditFamilyContent } from '@/utils/roles';

export default function MemoryBooksScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { familyId, role } = useFamily();
  const { members, isLoading: isLoadingMembers } = useFamilyMembers();
  const member = members.find((candidate) => candidate.id === id);
  const canGenerate = canEditFamilyContent(role);

  const { rows, isLoading, isError, isEligibilityLoading, generate, retryDispatch, refresh } = useMemoryBooks({
    familyId,
    childId: id,
    dateOfBirth: member?.date_of_birth ?? null,
  });

  if (isLoadingMembers || isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (!member) {
    return (
      <View style={styles.centered}>
        <Text style={styles.notFoundText}>Person not found</Text>
      </View>
    );
  }

  // Locked design point 6: viewers see books that already exist (status +
  // View), never the affordance to start a new one -- RLS would reject
  // their insert anyway, but this degrades gracefully instead of relying
  // on that error.
  const visibleRows = canGenerate ? rows : rows.filter((row) => row.book !== null);

  return (
    <View style={styles.container}>
      <SafeAreaView edges={['top']}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.iconBtn} testID="memory-books-back">
            <SymbolView
              fallback={<Text style={styles.iconBtnText}>‹</Text>}
              name={{ ios: 'chevron.left', android: 'chevron_left' }}
              size={17}
              tintColor={colors.ink2}
            />
          </Pressable>
          <Text style={styles.headerTitle}>Memory Books</Text>
          <View style={styles.iconBtnSpacer} />
        </View>
      </SafeAreaView>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.subtitle}>
          Turn {member.name}’s memories into a premium keepsake book.
        </Text>

        {isError ? (
          <View style={styles.errorState} testID="memory-books-error">
            <Text style={styles.errorStateText}>Couldn’t load Memory Books.</Text>
            <Pressable onPress={refresh} testID="memory-books-retry-load">
              <Text style={styles.errorStateRetry}>Try again</Text>
            </Pressable>
          </View>
        ) : visibleRows.length === 0 ? (
          <Text style={styles.emptyText}>
            Books aren’t ready yet for {member.name} — keep journaling and check back soon.
          </Text>
        ) : (
          <View style={styles.list}>
            {visibleRows.map((row) => (
              <MemoryBookScopeRow
                canGenerate={canGenerate}
                key={row.key}
                onGenerate={() => void generate(row.option)}
                onRetryDispatch={() => {
                  if (row.book) void retryDispatch(row.option, row.book.id);
                }}
                onView={() => {
                  if (row.book) void Linking.openURL(memoryBookWebUrl(row.book.id));
                }}
                row={row}
                testID={`memory-book-scope-${row.key}`}
              />
            ))}
          </View>
        )}

        {isEligibilityLoading ? (
          <View style={styles.eligibilityLoading}>
            <ActivityIndicator color={colors.ink3} size="small" />
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  notFoundText: {
    fontFamily: fonts.sans,
    fontSize: 16,
    color: colors.ink3,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  headerTitle: {
    fontFamily: fonts.displayMedium,
    fontSize: 17,
    color: colors.ink,
  },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnSpacer: { width: 38, height: 38 },
  iconBtnText: {
    fontSize: 22,
    color: colors.ink2,
    fontWeight: '300',
    marginTop: -2,
  },
  content: {
    paddingHorizontal: spacing.md,
    paddingBottom: 60,
    gap: 16,
  },
  subtitle: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.ink2,
    lineHeight: 14 * 1.4,
  },
  list: { gap: 10 },
  emptyText: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.ink3,
    fontStyle: 'italic',
  },
  errorState: { gap: 8, alignItems: 'flex-start' },
  errorStateText: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.error,
  },
  errorStateRetry: {
    fontFamily: fonts.sansBold,
    fontSize: 13.5,
    color: colors.primary,
  },
  eligibilityLoading: {
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
});
