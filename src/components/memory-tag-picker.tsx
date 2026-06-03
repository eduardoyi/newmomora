import { useCallback, useMemo, useState } from 'react';
import { type LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';

import { FamilyMemberAvatar } from '@/components/family-member-avatar';
import { FamilyRosterSheet } from '@/components/family-roster-sheet';
import { colors, fonts, spacing } from '@/constants/theme';
import type { FamilyMember } from '@/services/family-members';
import { calculateInlineTagCount, formatMoreTagLabel } from '@/utils/memory-tag-layout';
import { MAX_MEMORY_TAGS } from '@/utils/memories';

const CHIP_GAP = spacing.sm;
const CHIP_HEIGHT = 36;
const FALLBACK_INLINE_CHIP_LIMIT = 3;

interface MemoryTagPickerProps {
  members: FamilyMember[];
  selectedMemberIds: string[];
  onToggleMember: (memberId: string) => void;
}

interface MemberChipProps {
  member: FamilyMember;
  isSelected: boolean;
  isDisabled: boolean;
  onPress: () => void;
  testID?: string;
}

function MemberChip({ member, isSelected, isDisabled, onPress, testID }: MemberChipProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: isSelected, disabled: isDisabled }}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        isSelected && styles.chipSelected,
        isDisabled && styles.chipDisabled,
        pressed && !isDisabled && styles.chipPressed,
      ]}
      testID={testID}
    >
      <FamilyMemberAvatar member={member} size={22} />
      <Text style={[styles.chipText, isSelected && styles.chipTextSelected]}>
        {member.name}
      </Text>
    </Pressable>
  );
}

export function MemoryTagPicker({
  members,
  selectedMemberIds,
  onToggleMember,
}: MemoryTagPickerProps) {
  const [isRosterOpen, setIsRosterOpen] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const [moreChipWidth, setMoreChipWidth] = useState(0);
  const [chipWidths, setChipWidths] = useState<Record<string, number>>({});

  const atLimit = selectedMemberIds.length >= MAX_MEMORY_TAGS;
  const measuredChipWidths = useMemo(
    () => members.map((member) => chipWidths[member.id]),
    [chipWidths, members],
  );
  const measuredInlineCount = useMemo(
    () =>
      calculateInlineTagCount({
        chipWidths: measuredChipWidths,
        containerWidth,
        gap: CHIP_GAP,
        moreChipWidth,
      }),
    [containerWidth, measuredChipWidths, moreChipWidth],
  );
  const inlineCount =
    measuredInlineCount ?? Math.min(members.length, FALLBACK_INLINE_CHIP_LIMIT);
  const inlineMembers = members.slice(0, inlineCount);
  const hiddenMembers = members.slice(inlineCount);
  const hasOverflow = inlineCount < members.length;
  const hiddenSelectedCount = hiddenMembers.filter((member) =>
    selectedMemberIds.includes(member.id),
  ).length;
  const hasHiddenSelectedMembers = hiddenSelectedCount > 0;
  const moreLabel = formatMoreTagLabel(hiddenSelectedCount);

  const handleContainerLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = event.nativeEvent.layout.width;
    setContainerWidth((currentWidth) =>
      Math.abs(currentWidth - nextWidth) < 0.5 ? currentWidth : nextWidth,
    );
  }, []);

  const handleMoreLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = event.nativeEvent.layout.width;
    setMoreChipWidth((currentWidth) =>
      Math.abs(currentWidth - nextWidth) < 0.5 ? currentWidth : nextWidth,
    );
  }, []);

  const handleChipLayout = useCallback((memberId: string, event: LayoutChangeEvent) => {
    const nextWidth = event.nativeEvent.layout.width;
    setChipWidths((currentWidths) => {
      const currentWidth = currentWidths[memberId];
      if (currentWidth !== undefined && Math.abs(currentWidth - nextWidth) < 0.5) {
        return currentWidths;
      }

      return {
        ...currentWidths,
        [memberId]: nextWidth,
      };
    });
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.label}>
        WHO'S IN IT
        {selectedMemberIds.length > 0 ? (
          <Text style={styles.labelCount} testID="memory-tag-count">
            {' '}· {selectedMemberIds.length}/{MAX_MEMORY_TAGS}
          </Text>
        ) : null}
      </Text>

      <View onLayout={handleContainerLayout} style={styles.chips}>
        {inlineMembers.map((member) => {
          const isSelected = selectedMemberIds.includes(member.id);
          const isDisabled = !isSelected && atLimit;
          return (
            <MemberChip
              isDisabled={isDisabled}
              isSelected={isSelected}
              key={member.id}
              member={member}
              onPress={() => onToggleMember(member.id)}
              testID={`memory-tag-${member.id}`}
            />
          );
        })}

        {hasOverflow ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: hasHiddenSelectedMembers }}
            accessibilityLabel={
              hasHiddenSelectedMembers
                ? `${hiddenSelectedCount} selected family ${
                    hiddenSelectedCount === 1 ? 'member is' : 'members are'
                  } hidden`
                : 'Show more family members'
            }
            onPress={() => setIsRosterOpen(true)}
            style={({ pressed }) => [
              styles.moreChip,
              hasHiddenSelectedMembers && styles.moreChipSelected,
              pressed && styles.chipPressed,
            ]}
            testID="memory-tag-more"
          >
            <Text
              style={[
                styles.moreChipText,
                hasHiddenSelectedMembers && styles.moreChipTextSelected,
              ]}
            >
              {moreLabel}
            </Text>
          </Pressable>
        ) : null}
      </View>

      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        style={styles.measurementChips}
      >
        {members.map((member) => (
          <View key={member.id} onLayout={(event) => handleChipLayout(member.id, event)}>
            <MemberChip
              isDisabled={false}
              isSelected={selectedMemberIds.includes(member.id)}
              member={member}
              onPress={() => {}}
            />
          </View>
        ))}
        <Pressable
          style={[styles.moreChip, hasHiddenSelectedMembers && styles.moreChipSelected]}
          onLayout={handleMoreLayout}
        >
          <Text
            style={[
              styles.moreChipText,
              hasHiddenSelectedMembers && styles.moreChipTextSelected,
            ]}
          >
            {moreLabel}
          </Text>
        </Pressable>
      </View>

      <FamilyRosterSheet
        members={members}
        onClose={() => setIsRosterOpen(false)}
        onToggleMember={onToggleMember}
        selectedMemberIds={selectedMemberIds}
        visible={isRosterOpen}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.sm,
    position: 'relative',
  },
  label: {
    color: colors.ink2,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  labelCount: {
    color: colors.primary,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 0.8,
  },
  chips: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'nowrap',
    gap: CHIP_GAP,
    overflow: 'hidden',
  },
  measurementChips: {
    flexDirection: 'row',
    gap: CHIP_GAP,
    left: 0,
    opacity: 0,
    position: 'absolute',
    top: 0,
  },
  chip: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    minHeight: CHIP_HEIGHT,
    paddingLeft: 5,
    paddingRight: spacing.md,
    paddingVertical: 5,
  },
  chipSelected: {
    backgroundColor: colors.primaryDark,
    borderColor: colors.primaryDark,
  },
  chipDisabled: {
    opacity: 0.45,
  },
  chipPressed: {
    opacity: 0.82,
  },
  chipText: {
    color: colors.ink,
    fontFamily: fonts.sansMedium,
    fontSize: 14,
  },
  chipTextSelected: {
    color: colors.white,
  },
  moreChip: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: CHIP_HEIGHT,
    paddingHorizontal: spacing.md,
    paddingVertical: 0,
  },
  moreChipSelected: {
    backgroundColor: colors.primaryDark,
    borderColor: colors.primaryDark,
  },
  moreChipText: {
    color: colors.ink2,
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    lineHeight: 18,
    textAlignVertical: 'center',
  },
  moreChipTextSelected: {
    color: colors.white,
  },
});
