// The dashed "October recap · Nov 1" card on top of the current year's
// Family films (docs/plans/year-film-p2.md Step 7.2). Only rendered when the
// server says a recap will really be attempted (`year_films_enabled`), so it
// never promises a film that can't come.
import { StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radius } from '@/constants/theme';
import { parseDateParts } from '@/utils/memory-book-scope';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTH_ABBREVIATIONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "October recap · Nov 1" for a `todayIso` in October: the month in progress
 * is the recap that arrives on the next 1st. December rolls to "Jan 1".
 */
export function upcomingRecapLabel(todayIso: string): string {
  const { month } = parseDateParts(todayIso);
  const nextMonth = month === 12 ? 1 : month + 1;
  return `${MONTH_NAMES[month - 1]} recap · ${MONTH_ABBREVIATIONS[nextMonth - 1]} 1`;
}

export function UpcomingRecapCard({ todayIso }: { todayIso: string }) {
  return (
    <View
      accessibilityLabel={upcomingRecapLabel(todayIso)}
      style={styles.card}
      testID="keepsakes-upcoming-recap"
    >
      <Text style={styles.title}>{upcomingRecapLabel(todayIso)}</Text>
      <Text style={styles.hint}>We’ll gather this month’s moments into a short film.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderColor: colors.borderStrong,
    borderRadius: radius.lg,
    borderStyle: 'dashed',
    borderWidth: 1.5,
    gap: 4,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  title: {
    fontFamily: fonts.displayMedium,
    fontSize: 16,
    color: colors.ink,
  },
  hint: {
    fontFamily: fonts.sans,
    fontSize: 12.5,
    lineHeight: 18,
    color: colors.ink3,
  },
});
