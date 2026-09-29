import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import { CastCard } from '@/components/cast-card';
import { ContentHiddenNotice } from '@/components/content-hidden-notice';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useContentSafety } from '@/hooks/useContentSafety';
import { useFamilyRelationships } from '@/hooks/useFamilyRelationships';
import { addFamilyMemberRoute, editFamilyMemberRoute, familyMemberRoute, whosWhoRoute } from '@/lib/routes';
import { isFamilyMemberProfileIncomplete } from '@/utils/family-members';
import {
  groupByRelationship,
  isLinkableMember,
  relationshipLabel,
  sideLabel,
} from '@/utils/family-relationships';
import {
  EMPTY_WHOS_WHO_DISMISSAL,
  getWhosWhoDismissal,
  newestSuggestionAt,
  setWhosWhoDismissal,
  whosWhoCardKind,
  type WhosWhoDismissal,
} from '@/utils/whos-who-card';
import { canEditFamilyContent } from '@/utils/roles';
import type { FamilyMember } from '@/services/family-members';

/**
 * Incomplete members (onboarding-created, name-only kids -- see
 * isFamilyMemberProfileIncomplete in src/utils/family-members.ts) route to
 * the edit screen instead of the normal detail screen, so tapping the card
 * is how you complete the profile. Viewers can't edit (canEditFamilyContent,
 * src/utils/roles.ts) and must never land on a screen they'll bounce out
 * of, so they always get the normal detail route regardless of completeness.
 */
function resolveMemberDestination(member: FamilyMember, canEdit: boolean) {
  if (canEdit && isFamilyMemberProfileIncomplete(member)) {
    return editFamilyMemberRoute(member.id);
  }
  return familyMemberRoute(member.id);
}

/**
 * The card line under a name. Section headers already say the role, so only
 * the side ("Eduardo's side") is added -- except in the mixed "Friends &
 * caregivers" section, where the role itself is the useful bit.
 */
function memberSubtitle(member: FamilyMember, members: FamilyMember[]): string | null {
  const side = sideLabel(member, members);
  if (side) return side;
  if (member.relationship === 'family_friend' || member.relationship === 'caregiver') {
    return relationshipLabel(member.relationship);
  }
  return null;
}

export default function FamilyScreen() {
  const { role, familyId } = useFamily();
  const canEdit = canEditFamilyContent(role);
  const { members, isLoading, isRefetching, isError, refetch } = useFamilyMembers();
  const contentSafety = useContentSafety();
  const relationships = useFamilyRelationships(members);
  const { requestSuggestions } = relationships;
  const [dismissal, setDismissal] = useState<WhosWhoDismissal>(EMPTY_WHOS_WHO_DISMISSAL);

  useEffect(() => {
    if (!familyId) return;
    let isMounted = true;
    void getWhosWhoDismissal(familyId).then((value) => {
      if (isMounted) setDismissal(value);
    });
    return () => {
      isMounted = false;
    };
  }, [familyId]);

  // Owner/manager opening the tab is the suggestion trigger; the server
  // throttles (docs/features/family-relationships.md).
  useFocusEffect(useCallback(() => {
    requestSuggestions();
  }, [requestSuggestions]));

  const groups = useMemo(() => groupByRelationship(members), [members]);
  const showSectionHeaders = groups.length >= 2;
  const cardKind = whosWhoCardKind({
    canEdit,
    suggestions: relationships.suggestions,
    isLinked: Boolean(relationships.myMemberId),
    notInList: relationships.myLink?.notInList ?? false,
    hasLinkableMember: !relationships.isLoadingLinks && members.some((m) => isLinkableMember(m)),
    dismissal,
  });

  const dismissCard = () => {
    if (!familyId) return;
    const next: WhosWhoDismissal = cardKind === 'suggestions'
      ? { ...dismissal, suggestionsSeenAt: newestSuggestionAt(relationships.suggestions) }
      : { ...dismissal, selfPromptDismissed: true };
    setDismissal(next);
    void setWhosWhoDismissal(familyId, next);
  };

  if (isLoading || contentSafety.isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (isError || contentSafety.isError) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>Could not load family members</Text>
        {contentSafety.isError ? (
          <Pressable accessibilityRole="button" onPress={() => void contentSafety.refetch()}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        ) : null}
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
        {/* Top edge only: the default (all edges) added the Android
            navigation-bar inset as padding under the header, a big gap above
            the cast. */}
        <SafeAreaView edges={['top']}>
          <View style={styles.header}>
            <Text style={styles.eyebrow}>The cast</Text>
            <Text style={styles.title}>Your people.</Text>
            <Text style={styles.subtitle}>
              Each one has a character portrait. Edit their photo to redraw it.
            </Text>
          </View>
        </SafeAreaView>

        <View style={styles.castList}>
          {cardKind ? (
            <View style={styles.whosWhoCard} testID="family-whos-who-card">
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push(whosWhoRoute)}
                style={({ pressed }) => [styles.whosWhoBody, pressed && styles.addTilePressed]}
                testID="family-whos-who-open"
              >
                <Text style={styles.whosWhoTitle}>Who’s who?</Text>
                <Text style={styles.whosWhoText}>
                  {cardKind === 'suggestions'
                    ? 'We sorted your people — take a look.'
                    : 'Tell us which one is you.'}
                </Text>
              </Pressable>
              <Pressable
                accessibilityLabel="Hide for now"
                accessibilityRole="button"
                hitSlop={10}
                onPress={dismissCard}
                style={styles.whosWhoClose}
                testID="family-whos-who-dismiss"
              >
                <Text style={styles.whosWhoCloseText}>×</Text>
              </Pressable>
            </View>
          ) : null}

          {groups.map((group) => (
            <View key={group.key} style={styles.group} testID={`family-group-${group.key}`}>
              {showSectionHeaders ? <Text style={styles.groupTitle}>{group.title}</Text> : null}
              {group.members.map((member) => {
                const portraitId = member.resolvedPortraitVersion?.id ?? null;
                const isProfileHidden = contentSafety.isTargetReported('family_member_profile', member.id);
                const isPortraitHidden = contentSafety.isTargetReported('family_member_portrait', portraitId);
                if (isProfileHidden) {
                  return (
                    <ContentHiddenNotice
                      key={member.id}
                      label="Reported family profile hidden"
                      onShow={() => contentSafety.revealTarget('family_member_profile', member.id)}
                      testID={`family-cast-card-${member.id}-hidden`}
                    />
                  );
                }
                const destination = resolveMemberDestination(member, canEdit);
                return (
                  <View key={member.id} testID={`family-cast-card-${member.id}`}>
                    <CastCard
                      canEdit={canEdit}
                      isMe={relationships.myMemberId === member.id}
                      isPortraitHidden={isPortraitHidden}
                      member={member}
                      subtitle={memberSubtitle(member, members)}
                      onPress={() => router.push(destination)}
                      onPortraitPress={() => router.push(destination)}
                      onShowPortrait={portraitId
                        ? () => contentSafety.revealTarget('family_member_portrait', portraitId)
                        : undefined}
                    />
                  </View>
                );
              })}
            </View>
          ))}

          {canEdit ? (
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
          ) : members.length === 0 ? (
            <Text style={styles.emptyViewerText} testID="family-empty-viewer">
              Ask a family manager to add the first family member.
            </Text>
          ) : null}
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
  retryText: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 14 },
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
  group: {
    gap: 16,
  },
  groupTitle: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 0.14 * 11,
    textTransform: 'uppercase',
    color: colors.ink3,
    marginTop: 4,
    paddingHorizontal: 4,
  },
  whosWhoCard: {
    backgroundColor: colors.primaryTint,
    borderColor: colors.primarySoft,
    borderRadius: radius.lg,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  whosWhoBody: {
    flex: 1,
    gap: 4,
    padding: 18,
  },
  whosWhoTitle: {
    fontFamily: fonts.displayMedium,
    fontSize: 20,
    color: colors.ink,
  },
  whosWhoText: {
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
    color: colors.ink2,
  },
  whosWhoClose: {
    padding: 14,
  },
  whosWhoCloseText: {
    color: colors.ink3,
    fontSize: 20,
    lineHeight: 22,
  },
  emptyViewerText: {
    fontFamily: fonts.sans,
    fontSize: 13.5,
    lineHeight: 20,
    color: colors.ink3,
    textAlign: 'center',
    paddingVertical: spacing.lg,
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
