import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MemoryBooksBody } from '@/components/memory-books/memory-books-body';
import { colors, fonts, spacing } from '@/constants/theme';
import { trackEvent } from '@/services/analytics';
import { getLocalTodayIso } from '@/utils/portrait-versions';

/**
 * Keepsakes tab (docs/plans/timeline-calendar-keepsakes.md C4, replaces the
 * Calendar tab): the family's Memory Books, one shelf per child, and -- once
 * Year Film P2 ships -- its films above them. See docs/features/keepsakes.md.
 *
 * Tab screens never unmount, so "today" (which decides the books' scope
 * options) is recomputed on every focus, and the books poll only runs while
 * this tab is focused.
 */
export default function KeepsakesScreen() {
  const [todayIso, setTodayIso] = useState(() => getLocalTodayIso());
  const [isFocused, setIsFocused] = useState(false);

  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      setTodayIso((previous) => {
        const next = getLocalTodayIso();
        return previous === next ? previous : next;
      });
      trackEvent('keepsakes_opened', {});
      return () => setIsFocused(false);
    }, []),
  );

  return (
    <View style={styles.container}>
      <SafeAreaView edges={['top']}>
        <View style={styles.header} testID="keepsakes-header">
          <Text style={styles.eyebrow}>Keepsakes</Text>
          <Text style={styles.title}>Made from your moments.</Text>
        </View>
      </SafeAreaView>
      {/* Films section slot: Year Film P2 adds the family's films and
          upcoming-film cards here, above the books. */}
      <MemoryBooksBody isFocused={isFocused} todayIso={todayIso} variant="tab" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    paddingTop: 16,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    gap: 8,
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
    fontSize: 42,
    lineHeight: 42,
    color: colors.ink,
  },
});
