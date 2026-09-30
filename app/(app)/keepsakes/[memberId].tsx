import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { KeepsakesBody } from '@/components/memory-books/memory-books-body';
import { colors, fonts } from '@/constants/theme';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { familyRosterRoute } from '@/lib/routes';
import { getLocalTodayIso } from '@/utils/portrait-versions';

/**
 * One child's keepsakes (docs/plans/timeline-calendar-keepsakes.md C5),
 * opened from the child profile's "See {name}'s keepsakes" link and from
 * book-ready notifications (`memoryBooksRoute`). Replaces
 * family/[id]/memory-books. Birthday films (all years) sit above the books.
 */
export default function MemberKeepsakesScreen() {
  const { memberId } = useLocalSearchParams<{ memberId: string }>();
  const { members, isLoading } = useFamilyMembers();
  const member = members.find((candidate) => candidate.id === memberId);
  // A stack screen: "today" is fixed for this visit.
  const [todayIso] = useState(() => getLocalTodayIso());

  // A cold-start notification tap lands here with nothing to go back to.
  const handleBack = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace(familyRosterRoute);
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
            testID="memory-books-back"
          >
            <SymbolView
              fallback={<Text style={styles.iconBtnText}>‹</Text>}
              name={{ ios: 'chevron.left', android: 'chevron_left' }}
              size={17}
              tintColor={colors.ink2}
            />
          </Pressable>
          <Text style={styles.headerTitle}>{member ? `${member.name}’s keepsakes` : 'Keepsakes'}</Text>
          <View style={styles.iconBtnSpacer} />
        </View>
      </SafeAreaView>

      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      ) : !member ? (
        <View style={styles.centered}>
          <Text style={styles.notFoundText}>Person not found</Text>
        </View>
      ) : (
        <KeepsakesBody isFocused memberId={member.id} todayIso={todayIso} variant="stack" />
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
});
