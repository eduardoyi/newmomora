import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { KeepsakesBody } from '@/components/memory-books/memory-books-body';
import { colors, fonts, spacing } from '@/constants/theme';
import { trackEvent } from '@/services/analytics';
import { getLocalTodayIso } from '@/utils/portrait-versions';

/**
 * Keepsakes tab (docs/plans/timeline-calendar-keepsakes.md C4, replaces the
 * Calendar tab): one section per year -- the family's films, then a shelf per
 * child with birthday films and Memory Books (docs/plans/year-film-p2.md
 * Step 7). See docs/features/keepsakes.md.
 *
 * Tab screens never unmount, so "today" (which decides the books' scope
 * options and the upcoming-recap card) is recomputed on every focus, and the
 * books poll and films refetch only run while this tab is focused.
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
      <KeepsakesBody isFocused={isFocused} todayIso={todayIso} variant="tab" />
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
