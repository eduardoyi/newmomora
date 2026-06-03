import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import { CastCard } from '@/components/cast-card';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { addFamilyMemberRoute, familyMemberRoute } from '@/lib/routes';

export default function FamilyScreen() {
  const { members, isLoading, isRefetching, isError, refetch } = useFamilyMembers();

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (isError) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>Could not load family members</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.primary} />
        }
      >
        <SafeAreaView>
          <View style={styles.header}>
            <Text style={styles.eyebrow}>The cast</Text>
            <Text style={styles.title}>Your people.</Text>
            <Text style={styles.subtitle}>
              Each one has a character portrait. Edit their photo to redraw it.
            </Text>
          </View>
        </SafeAreaView>

        <View style={styles.castList}>
          {members.map((member) => (
            <Pressable
              key={member.id}
              accessibilityRole="button"
              onPress={() => router.push(familyMemberRoute(member.id))}
              style={({ pressed }) => pressed && styles.castCardPressed}
              testID={`family-cast-card-${member.id}`}
            >
              <CastCard member={member} />
            </Pressable>
          ))}

          <Pressable
            onPress={() => router.push(addFamilyMemberRoute)}
            style={({ pressed }) => [styles.addTile, pressed && styles.addTilePressed]}
            accessibilityRole="button"
            testID="family-add-member"
          >
            <View style={styles.addIcon}>
              <Text style={styles.addIconText}>+</Text>
            </View>
            <View>
              <Text style={styles.addTitle}>Add someone</Text>
              <Text style={styles.addSubtitle}>A sibling, a partner, a grandparent</Text>
            </View>
          </Pressable>
        </View>
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
  errorText: {
    fontFamily: fonts.sans,
    color: colors.error,
    fontSize: 15,
    textAlign: 'center',
    padding: spacing.lg,
  },
  scrollContent: {
    paddingBottom: 130,
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
  subtitle: {
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 21,
    color: colors.ink3,
  },
  castList: {
    paddingHorizontal: spacing.md,
    gap: 16,
  },
  castCardPressed: {
    opacity: 0.85,
  },
  addTile: {
    backgroundColor: 'transparent',
    borderRadius: radius.lg,
    borderWidth: 2,
    borderColor: colors.borderStrong,
    borderStyle: 'dashed',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 22,
  },
  addTilePressed: {
    opacity: 0.7,
  },
  addIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addIconText: {
    fontSize: 24,
    color: colors.primary,
    lineHeight: 28,
  },
  addTitle: {
    fontFamily: fonts.sansBold,
    fontSize: 15,
    color: colors.ink,
  },
  addSubtitle: {
    fontFamily: fonts.sans,
    fontSize: 12.5,
    color: colors.ink3,
    marginTop: 2,
  },
});
