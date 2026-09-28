// "Who's who" sheet (docs/features/family-relationships.md).
//
// Part 1 -- "Which one is you?": any account without a "this is me" link
// picks their person (or "I'm not in the list"). `mode=self` shows only this
// part (the join flow, and viewers).
// Part 2 -- owners/managers review the AI's pending suggestions: every chip
// starts selected; tap to drop one, or "Not quite" to pick the role/side by
// hand. "Looks right" writes hand-picked values with a normal member update
// first, then accepts the kept chips and dismisses the rest in one RPC. The
// AI never writes a person's details on its own.
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FamilyProfilePortraitPhoto } from '@/components/family-profile-portrait-photo';
import { RelationshipPicker, type RelationshipValue } from '@/components/relationship-picker';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useFamily } from '@/hooks/use-family';
import { useContentSafety } from '@/hooks/useContentSafety';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useFamilyRelationships } from '@/hooks/useFamilyRelationships';
import { timelineRoute } from '@/lib/routes';
import { isAlreadyLinkedError, type FamilyMemberSuggestion } from '@/services/family-relationships';
import type { FamilyMember } from '@/services/family-members';
import {
  isLinkableMember,
  isRelationship,
  relationshipLabel,
  sideChoices,
} from '@/utils/family-relationships';

function suggestionLabel(suggestion: FamilyMemberSuggestion, members: FamilyMember[]): string {
  switch (suggestion.field) {
    case 'relationship':
      return relationshipLabel(suggestion.value) ?? suggestion.value;
    case 'family_side': {
      if (suggestion.value === 'member') {
        const parent = members.find((m) => m.id === suggestion.side_member_id);
        const first = parent ? parent.name.trim().split(/\s+/)[0] : 'Parent';
        return `${first}'s side`;
      }
      return sideChoices([]).find((c) => c.key === suggestion.value)?.label ?? suggestion.value;
    }
    default:
      return `“${suggestion.value}”`;
  }
}

function currentValue(member: FamilyMember): RelationshipValue {
  return {
    relationship: isRelationship(member.relationship) ? member.relationship : null,
    familySide: member.family_side ?? null,
    sideMemberId: member.side_member_id ?? null,
  };
}

export default function WhosWhoScreen() {
  const params = useLocalSearchParams<{ mode?: string; next?: string }>();
  const selfOnly = params.mode === 'self';
  const { members, isLoading, updateMember } = useFamilyMembers();
  const relationships = useFamilyRelationships(members);
  const contentSafety = useContentSafety();
  const { family } = useFamily();

  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Map<string, RelationshipValue>>(new Map());
  const [isSaving, setIsSaving] = useState(false);

  const finish = () => {
    if (params.next === 'timeline') {
      router.replace(timelineRoute);
    } else if (router.canGoBack()) {
      router.back();
    } else {
      router.replace(timelineRoute);
    }
  };

  const linkable = useMemo(
    () => members.filter(
      (m) => isLinkableMember(m) && !contentSafety.isTargetReported('family_member_profile', m.id),
    ),
    [members, contentSafety],
  );
  const me = members.find((m) => m.id === relationships.myMemberId) ?? null;
  const askSelf = !relationships.myMemberId;
  const showSuggestions = relationships.canEdit && !selfOnly;

  const rows = useMemo(() => {
    const byMember = new Map<string, FamilyMemberSuggestion[]>();
    for (const s of relationships.suggestions) {
      byMember.set(s.family_member_id, [...(byMember.get(s.family_member_id) ?? []), s]);
    }
    const order = { relationship: 0, family_side: 1, nickname: 2 } as Record<string, number>;
    return members
      .filter((m) => byMember.has(m.id))
      .map((m) => ({
        member: m,
        suggestions: (byMember.get(m.id) ?? []).sort((a, b) => (order[a.field] ?? 3) - (order[b.field] ?? 3)),
      }));
  }, [members, relationships.suggestions]);

  const pickMe = async (memberId: string | null, notInList = false) => {
    try {
      await relationships.linkMe({ memberId, notInList });
      if (selfOnly || rows.length === 0 || !showSuggestions) finish();
    } catch (error) {
      if (isAlreadyLinkedError(error as { message: string; code?: string })) {
        Alert.alert('Already taken', 'Someone else already picked this person — ask a family manager.');
      } else {
        Alert.alert('Could not save', 'Please try again.');
      }
    }
  };

  const toggleChip = (id: string) => {
    setDropped((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const startOverride = (member: FamilyMember) => {
    setOverrides((prev) => new Map(prev).set(member.id, currentValue(member)));
  };

  const confirm = async () => {
    setIsSaving(true);
    try {
      // (1) Hand-picked values first; if this fails nothing is decided and
      // the suggestions stay pending.
      for (const [memberId, value] of overrides) {
        await updateMember({
          memberId,
          relationship: value.relationship,
          familySide: value.familySide,
          sideMemberId: value.sideMemberId,
        });
      }
      // (2) One RPC: kept chips accepted, dropped chips and overridden
      // members' chips dismissed.
      const accept: string[] = [];
      const dismiss: string[] = [];
      for (const row of rows) {
        const overridden = overrides.has(row.member.id);
        for (const s of row.suggestions) {
          const overridesThisField = overridden && s.field !== 'nickname';
          (dropped.has(s.id) || overridesThisField ? dismiss : accept).push(s.id);
        }
      }
      await relationships.resolve({ accept, dismiss });
      finish();
    } catch {
      Alert.alert('Could not save', 'Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading || relationships.isLoadingLinks || (showSuggestions && relationships.isLoadingSuggestions)) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  const nothingLeft = !askSelf && (!showSuggestions || rows.length === 0);

  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.container}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={finish} testID="whos-who-close">
          <Text style={styles.headerAction}>{selfOnly ? 'Skip' : 'Close'}</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.content} testID="whos-who-screen">
        <Text style={styles.eyebrow}>Who’s who</Text>

        {askSelf ? (
          <View style={styles.section}>
            <Text style={styles.title}>{selfOnly ? 'Are you in the family?' : 'Which one is you?'}</Text>
            <Text style={styles.body}>
              {selfOnly && family?.name ? `You’ve joined ${family.name}. ` : ''}
              Pick yourself so your memories can say “me” and mean you.
            </Text>
            <View style={styles.grid}>
              {linkable.map((member) => {
                const taken = relationships.claimedByOthers.has(member.id);
                return (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled: taken }}
                    disabled={taken || relationships.isLinking}
                    key={member.id}
                    onPress={() => void pickMe(member.id)}
                    style={({ pressed }) => [styles.person, taken && styles.personTaken, pressed && styles.pressed]}
                    testID={`whos-who-me-${member.id}`}
                  >
                    <FamilyProfilePortraitPhoto borderRadius={36} member={member} width={72} />
                    <Text numberOfLines={1} style={styles.personName}>{member.name.trim().split(/\s+/)[0]}</Text>
                    {taken ? <Text style={styles.personTakenText}>Taken</Text> : null}
                  </Pressable>
                );
              })}
            </View>
            <Pressable
              accessibilityRole="button"
              disabled={relationships.isLinking}
              onPress={() => void pickMe(null, true)}
              style={styles.linkButton}
              testID="whos-who-not-listed"
            >
              <Text style={styles.linkButtonText}>I’m not in the list</Text>
            </Pressable>
          </View>
        ) : me ? (
          <Text style={styles.body} testID="whos-who-you-are">You’re {me.name}.</Text>
        ) : null}

        {showSuggestions && rows.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.title}>We sorted your people</Text>
            <Text style={styles.body}>Tap a chip to drop it. Nothing changes until you confirm.</Text>
            {rows.map(({ member, suggestions }) => {
              const override = overrides.get(member.id);
              return (
                <View key={member.id} style={styles.row} testID={`whos-who-row-${member.id}`}>
                  <View style={styles.rowHeader}>
                    <FamilyProfilePortraitPhoto borderRadius={22} member={member} width={44} />
                    <Text style={styles.rowName}>{member.name}</Text>
                    {!override ? (
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => startOverride(member)}
                        testID={`whos-who-not-quite-${member.id}`}
                      >
                        <Text style={styles.notQuite}>Not quite</Text>
                      </Pressable>
                    ) : null}
                  </View>
                  <View style={styles.chips}>
                    {suggestions
                      .filter((s) => !override || s.field === 'nickname')
                      .map((s) => {
                        const kept = !dropped.has(s.id);
                        return (
                          <Pressable
                            accessibilityRole="button"
                            accessibilityState={{ selected: kept }}
                            key={s.id}
                            onPress={() => toggleChip(s.id)}
                            style={[styles.chip, kept ? styles.chipKept : styles.chipDropped]}
                            testID={`whos-who-chip-${s.id}`}
                          >
                            <Text style={[styles.chipText, kept ? styles.chipTextKept : styles.chipTextDropped]}>
                              {suggestionLabel(s, members)}
                            </Text>
                          </Pressable>
                        );
                      })}
                  </View>
                  {override ? (
                    <RelationshipPicker
                      memberId={member.id}
                      members={members}
                      onChange={(value) => setOverrides((prev) => new Map(prev).set(member.id, value))}
                      testIDPrefix={`whos-who-${member.id}`}
                      value={override}
                    />
                  ) : null}
                </View>
              );
            })}
          </View>
        ) : null}

        {nothingLeft ? (
          <Text style={styles.body} testID="whos-who-all-sorted">Everyone’s sorted. Nice.</Text>
        ) : null}
      </ScrollView>

      {showSuggestions && rows.length > 0 ? (
        <View style={styles.footer}>
          <Pressable
            accessibilityRole="button"
            disabled={isSaving || relationships.isResolving}
            onPress={() => void confirm()}
            style={({ pressed }) => [styles.primaryButton, (isSaving || pressed) && styles.pressed]}
            testID="whos-who-confirm"
          >
            {isSaving ? (
              <ActivityIndicator color={colors.white} />
            ) : (
              <Text style={styles.primaryButtonText}>Looks right</Text>
            )}
          </Pressable>
        </View>
      ) : null}
    </SafeAreaView>
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
  header: {
    alignItems: 'flex-end',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  headerAction: {
    color: colors.primary,
    fontFamily: fonts.sansBold,
    fontSize: 16,
  },
  content: {
    gap: spacing.lg,
    paddingBottom: 40,
    paddingHorizontal: spacing.lg,
  },
  eyebrow: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 0.14 * 11,
    textTransform: 'uppercase',
    color: colors.ink3,
  },
  section: {
    gap: spacing.md,
  },
  title: {
    fontFamily: fonts.display,
    fontSize: 32,
    lineHeight: 36,
    color: colors.ink,
  },
  body: {
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 21,
    color: colors.ink3,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  person: {
    alignItems: 'center',
    gap: 6,
    width: 84,
  },
  personTaken: {
    opacity: 0.45,
  },
  personName: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    color: colors.ink,
  },
  personTakenText: {
    fontFamily: fonts.sans,
    fontSize: 11,
    color: colors.ink3,
  },
  linkButton: {
    alignSelf: 'flex-start',
    paddingVertical: 6,
  },
  linkButtonText: {
    color: colors.primary,
    fontFamily: fonts.sansBold,
    fontSize: 14,
  },
  row: {
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.md,
  },
  rowHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  rowName: {
    flex: 1,
    fontFamily: fonts.displayMedium,
    fontSize: 18,
    color: colors.ink,
  },
  notQuite: {
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    fontSize: 13,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  chipKept: {
    backgroundColor: colors.primaryTint,
    borderColor: colors.primary,
  },
  chipDropped: {
    backgroundColor: colors.white,
    borderColor: colors.border,
  },
  chipText: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
  },
  chipTextKept: {
    color: colors.primary,
  },
  chipTextDropped: {
    color: colors.ink3,
    textDecorationLine: 'line-through',
  },
  footer: {
    borderTopColor: colors.border,
    borderTopWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 16,
  },
  primaryButtonText: {
    color: colors.white,
    fontFamily: fonts.sansBold,
    fontSize: 16,
  },
  pressed: {
    opacity: 0.8,
  },
});
