import { router, useIsFocused, useLocalSearchParams, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { KeepsakeFilmTile } from '@/components/keepsakes/keepsake-film-tile';
import { colors, fonts, spacing } from '@/constants/theme';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useFamilyYearFilms } from '@/hooks/useYearFilms';
import { trackEvent } from '@/services/analytics';

const COLUMNS = 3;
const GAP = 12;
const KEEPSAKES_TAB_ROUTE = '/(app)/(tabs)/keepsakes' as Href;

/**
 * Every monthly recap of one year, as a grid (docs/plans/year-film-p2.md
 * Step 7): reached from "See all {year} recaps" on the Keepsakes tab.
 */
export default function KeepsakeRecapsScreen() {
  const { year: yearParam } = useLocalSearchParams<{ year: string }>();
  const year = Number(yearParam);
  const { familyId } = useFamily();
  const { members } = useFamilyMembers();
  const isFocused = useIsFocused();
  const { films, isLoading } = useFamilyYearFilms(familyId, { isFocused });
  const { width } = useWindowDimensions();
  const tileWidth = Math.floor((width - spacing.md * 2 - GAP * (COLUMNS - 1)) / COLUMNS);

  useEffect(() => {
    if (Number.isFinite(year)) trackEvent('year_film_recaps_opened', { year });
  }, [year]);

  const recaps = useMemo(
    () =>
      films
        .filter((film) => film.kind === 'family_month' && Number(film.placement_date.slice(0, 4)) === year)
        .sort((a, b) => (a.placement_date < b.placement_date ? 1 : a.placement_date > b.placement_date ? -1 : 0)),
    [films, year],
  );

  // A cold-start push could land here with nothing to go back to.
  const handleBack = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace(KEEPSAKES_TAB_ROUTE);
    }
  };

  return (
    <View style={styles.container}>
      <SafeAreaView edges={['top']}>
        <View style={styles.header}>
          <Pressable
            accessibilityLabel="Back"
            accessibilityRole="button"
            onPress={handleBack}
            style={styles.iconBtn}
            testID="keepsakes-recaps-back"
          >
            <SymbolView
              fallback={<Text style={styles.iconBtnText}>‹</Text>}
              name={{ ios: 'chevron.left', android: 'chevron_left' }}
              size={17}
              tintColor={colors.ink2}
            />
          </Pressable>
          <Text style={styles.headerTitle}>{Number.isFinite(year) ? `${year} recaps` : 'Recaps'}</Text>
          <View style={styles.iconBtnSpacer} />
        </View>
      </SafeAreaView>

      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      ) : recaps.length === 0 ? (
        <View style={styles.centered} testID="keepsakes-recaps-empty">
          <Text style={styles.emptyText}>No recaps for this year yet.</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.grid}
          showsVerticalScrollIndicator={false}
          testID="keepsakes-recaps-grid"
        >
          {recaps.map((film) => (
            <KeepsakeFilmTile film={film} key={film.id} members={members} width={tileWidth} />
          ))}
        </ScrollView>
      )}
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
  },
  emptyText: {
    fontFamily: fonts.sans,
    fontSize: 15,
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
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: GAP,
    rowGap: 22,
    paddingHorizontal: spacing.md,
    paddingTop: 8,
    paddingBottom: 48,
  },
});
