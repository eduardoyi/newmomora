import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { FamilyMemberAvatar } from '@/components/family-member-avatar';
import { FamilyRosterSheet } from '@/components/family-roster-sheet';
import { PlusGlyph } from '@/components/plus-glyph';
import { colors, fonts, spacing } from '@/constants/theme';
import { registerFamilyMemberCreationRequest } from '@/lib/family-member-creation-requests';
import { addFamilyMemberRouteFor } from '@/lib/routes';
import type { FamilyMember } from '@/services/family-members';
import { isFamilyMemberProfileIncomplete } from '@/utils/family-members';
import { calculateInlineTagCount, formatMoreTagLabel } from '@/utils/memory-tag-layout';
import { runAfterNativeChooserDismisses } from '@/utils/native-permissions';

const CHIP_GAP = spacing.sm;
const CHIP_HEIGHT = 36;
const FALLBACK_INLINE_CHIP_LIMIT = 3;
// The round "+" add chip ends the row only when every member fits beside it;
// once anything overflows, "add someone new" lives in the roster sheet
// instead (one entry point at a time, never both).
const ADD_CHIP_WIDTH = CHIP_HEIGHT;

interface MemoryTagPickerProps {
  members: FamilyMember[];
  selectedMemberIds: string[];
  maxSelected?: number;
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
  // Same signal as the family card (src/components/cast-card.tsx), much
  // lighter here: a name-only kid is still perfectly taggable, so this is a
  // visual hint only -- the chip never disables or loses tap behavior for
  // an incomplete member.
  const isIncomplete = isFamilyMemberProfileIncomplete(member);

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
      <View
        style={[styles.avatarWrap, isIncomplete && styles.avatarWrapIncomplete]}
        testID={isIncomplete && testID ? `${testID}-incomplete-hint` : undefined}
      >
        <FamilyMemberAvatar member={member} size={22} />
      </View>
      <Text style={[styles.chipText, isSelected && styles.chipTextSelected]}>
        {member.name}
      </Text>
    </Pressable>
  );
}

export function MemoryTagPicker({
  members,
  selectedMemberIds,
  maxSelected,
  onToggleMember,
}: MemoryTagPickerProps) {
  const [isRosterOpen, setIsRosterOpen] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const [moreChipWidth, setMoreChipWidth] = useState(0);
  const [chipWidths, setChipWidths] = useState<Record<string, number>>({});
  // People created from this picker (newest first). They're pinned to the
  // front of the row for this compose session; otherwise a brand-new member
  // (zero tags) would sort last and land hidden behind "+ More".
  const [recentlyAddedIds, setRecentlyAddedIds] = useState<string[]>([]);

  const atLimit = maxSelected !== undefined && selectedMemberIds.length >= maxSelected;

  const orderedMembers = useMemo(() => {
    if (recentlyAddedIds.length === 0) return members;
    const recent = recentlyAddedIds.flatMap((id) => members.filter((member) => member.id === id));
    if (recent.length === 0) return members;
    return [...recent, ...members.filter((member) => !recentlyAddedIds.includes(member.id))];
  }, [members, recentlyAddedIds]);

  const onToggleMemberRef = useRef(onToggleMember);
  const atLimitRef = useRef(atLimit);
  useEffect(() => {
    onToggleMemberRef.current = onToggleMember;
    atLimitRef.current = atLimit;
  }, [atLimit, onToggleMember]);

  const creationRequestRef = useRef<{ unregister: () => void } | null>(null);
  useEffect(() => () => creationRequestRef.current?.unregister(), []);

  const measuredChipWidths = useMemo(
    () => orderedMembers.map((member) => chipWidths[member.id]),
    [chipWidths, orderedMembers],
  );
  const measuredInlineCount = useMemo(
    () =>
      calculateInlineTagCount({
        chipWidths: measuredChipWidths,
        containerWidth,
        gap: CHIP_GAP,
        moreChipWidth,
        trailingChipWidth: ADD_CHIP_WIDTH,
      }),
    [containerWidth, measuredChipWidths, moreChipWidth],
  );
  const inlineCount =
    measuredInlineCount ?? Math.min(orderedMembers.length, FALLBACK_INLINE_CHIP_LIMIT);
  const inlineMembers = orderedMembers.slice(0, inlineCount);
  const hiddenMembers = orderedMembers.slice(inlineCount);
  const hasOverflow = inlineCount < orderedMembers.length;
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

  const handleOpenRoster = useCallback(() => {
    Keyboard.dismiss();
    setIsRosterOpen(true);
  }, []);

  // Opens the full add-person form over the composer. The composer stays
  // mounted underneath, so the created member is handed back here and tagged
  // (unless the illustration cap is already full).
  const openAddMember = useCallback((prefillName: string) => {
    creationRequestRef.current?.unregister();
    const request = registerFamilyMemberCreationRequest((memberId) => {
      setRecentlyAddedIds((current) => [memberId, ...current.filter((id) => id !== memberId)]);
      if (!atLimitRef.current) {
        onToggleMemberRef.current(memberId);
      }
    });
    creationRequestRef.current = request;
    router.push(addFamilyMemberRouteFor({ name: prefillName, requestId: request.requestId }));
  }, []);

  const handleAddChipPress = useCallback(() => {
    Keyboard.dismiss();
    openAddMember('');
  }, [openAddMember]);

  // The roster sheet is an RN Modal; pushing a route while it's still
  // animating out would present the form underneath it on iOS.
  const handleRosterAddMember = useCallback(
    (prefillName: string) => {
      runAfterNativeChooserDismisses(() => openAddMember(prefillName));
    },
    [openAddMember],
  );

  return (
    <View style={styles.container}>
      <Text style={styles.label}>
        WHO’S IN IT
        {selectedMemberIds.length > 0 ? (
          <Text style={styles.labelCount} testID="memory-tag-count">
            {' '}· {selectedMemberIds.length}{maxSelected !== undefined ? `/${maxSelected}` : ''}
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
            onPress={handleOpenRoster}
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

        {!hasOverflow ? (
          <Pressable
            accessibilityLabel="Add someone new to your family"
            accessibilityRole="button"
            onPress={handleAddChipPress}
            style={({ pressed }) => [
              orderedMembers.length === 0 ? styles.addChipWide : styles.addChip,
              pressed && styles.chipPressed,
            ]}
            testID="memory-tag-add"
          >
            <PlusGlyph size={12} />
            {orderedMembers.length === 0 ? (
              <Text style={styles.addChipText}>Add someone</Text>
            ) : null}
          </Pressable>
        ) : null}
      </View>

      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        style={styles.measurementChips}
      >
        {orderedMembers.map((member) => (
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
        members={orderedMembers}
        maxSelected={maxSelected}
        onAddMember={handleRosterAddMember}
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
  avatarWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Much lighter than the family card's dashed ring: a thin neutral outline
  // hint, no text, no color change, no disabling -- the chip stays fully
  // taggable (docs/plans/onboarding-design-brief.md's "invitation, not
  // nagging" rule, applied at the lightest weight this surface allows).
  avatarWrapIncomplete: {
    borderColor: colors.borderStrong,
    borderRadius: 13,
    borderStyle: 'dashed',
    borderWidth: 1,
    padding: 1,
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
  addChip: {
    alignItems: 'center',
    borderColor: colors.borderStrong,
    borderRadius: 999,
    borderStyle: 'dashed',
    borderWidth: 1,
    height: CHIP_HEIGHT,
    justifyContent: 'center',
    width: CHIP_HEIGHT,
  },
  addChipWide: {
    alignItems: 'center',
    borderColor: colors.borderStrong,
    borderRadius: 999,
    borderStyle: 'dashed',
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    minHeight: CHIP_HEIGHT,
    paddingHorizontal: spacing.md,
  },
  addChipText: {
    color: colors.primary,
    fontFamily: fonts.sansBold,
    fontSize: 14,
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
