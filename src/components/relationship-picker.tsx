// Optional "Who are they to the kids?" chips + conditional "Whose side?"
// chips (docs/features/family-relationships.md). Used by Add/Edit person.
// Tapping the selected role again clears it -- the field is never required.
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import {
  isSideRole,
  RELATIONSHIP_LABELS,
  RELATIONSHIPS,
  sideChoices,
  type Relationship,
  type RelationshipMemberLike,
  type SideChoice,
} from '@/utils/family-relationships';

export interface RelationshipValue {
  relationship: Relationship | null;
  familySide: string | null;
  sideMemberId: string | null;
}

export const EMPTY_RELATIONSHIP: RelationshipValue = { relationship: null, familySide: null, sideMemberId: null };

function choiceKey(value: RelationshipValue): string | null {
  if (value.sideMemberId) return `member:${value.sideMemberId}`;
  return value.familySide;
}

interface RelationshipPickerProps {
  value: RelationshipValue;
  onChange: (value: RelationshipValue) => void;
  /** Everyone in the family, for the parents' names in "Whose side?". */
  members: RelationshipMemberLike[];
  /** The person being edited (never offered as their own side). */
  memberId?: string;
  testIDPrefix: string;
}

export function RelationshipPicker({ value, onChange, members, memberId, testIDPrefix }: RelationshipPickerProps) {
  const choices = sideChoices(members, memberId);
  const selectedSide = choiceKey(value);

  const selectRole = (role: Relationship) => {
    if (value.relationship === role) {
      onChange(EMPTY_RELATIONSHIP);
      return;
    }
    // Keep a chosen side when moving between side roles; drop it otherwise.
    onChange(isSideRole(role) ? { ...value, relationship: role } : { relationship: role, familySide: null, sideMemberId: null });
  };

  const selectSide = (choice: SideChoice) => {
    if (selectedSide === choice.key) {
      onChange({ ...value, familySide: null, sideMemberId: null });
      return;
    }
    onChange({ ...value, familySide: choice.familySide, sideMemberId: choice.sideMemberId });
  };

  return (
    <View style={styles.section}>
      <Text style={styles.label}>Who are they to the kids? (optional)</Text>
      <View style={styles.chips}>
        {RELATIONSHIPS.map((role) => {
          const selected = value.relationship === role;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected }}
              key={role}
              onPress={() => selectRole(role)}
              style={[styles.chip, selected && styles.chipSelected]}
              testID={`${testIDPrefix}-role-${role}`}
            >
              <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{RELATIONSHIP_LABELS[role]}</Text>
            </Pressable>
          );
        })}
      </View>

      {isSideRole(value.relationship) ? (
        <>
          <Text style={styles.label}>Whose side?</Text>
          <View style={styles.chips}>
            {choices.map((choice) => {
              const selected = selectedSide === choice.key;
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  key={choice.key}
                  onPress={() => selectSide(choice)}
                  style={[styles.chip, selected && styles.chipSelected]}
                  testID={`${testIDPrefix}-side-${choice.key.replace('member:', 'member-')}`}
                >
                  <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{choice.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: spacing.sm,
  },
  label: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    color: colors.ink2,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: colors.white,
  },
  chipSelected: {
    backgroundColor: colors.primaryTint,
    borderColor: colors.primary,
  },
  chipText: {
    color: colors.ink2,
    fontFamily: fonts.sansBold,
    fontSize: 13,
  },
  chipTextSelected: {
    color: colors.primary,
  },
});
