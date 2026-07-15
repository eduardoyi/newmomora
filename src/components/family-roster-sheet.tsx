import { useEffect, useMemo, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FamilyMemberAvatar } from '@/components/family-member-avatar';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import type { FamilyMember } from '@/services/family-members';

interface RosterRowProps {
  member: FamilyMember;
  isSelected: boolean;
  isDisabled: boolean;
  onPress: () => void;
}

function RosterRow({ member, isSelected, isDisabled, onPress }: RosterRowProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: isSelected, disabled: isDisabled }}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        rowStyles.row,
        isDisabled && rowStyles.rowDisabled,
        pressed && !isDisabled && rowStyles.rowPressed,
      ]}
      testID={`roster-member-${member.id}`}
    >
      <FamilyMemberAvatar member={member} size={38} />
      <View style={rowStyles.info}>
        <Text numberOfLines={1} style={rowStyles.name}>
          {member.name}
        </Text>
      </View>
      <View style={[rowStyles.checkCircle, isSelected && rowStyles.checkCircleSelected]}>
        {isSelected ? <Text style={rowStyles.checkMark}>✓</Text> : null}
      </View>
    </Pressable>
  );
}

const rowStyles = StyleSheet.create({
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: 11,
  },
  rowDisabled: { opacity: 0.4 },
  rowPressed: { opacity: 0.82 },
  info: { flex: 1 },
  name: {
    color: colors.ink,
    fontFamily: fonts.sansBold,
    fontSize: 15,
  },
  checkCircle: {
    alignItems: 'center',
    borderColor: colors.borderStrong,
    borderRadius: 11,
    borderWidth: 1.5,
    height: 22,
    justifyContent: 'center',
    width: 22,
  },
  checkCircleSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  checkMark: {
    color: colors.white,
    fontFamily: fonts.sansBold,
    fontSize: 12,
  },
});

export interface FamilyRosterSheetProps {
  visible: boolean;
  members: FamilyMember[];
  selectedMemberIds: string[];
  maxSelected?: number;
  onToggleMember: (memberId: string) => void;
  onClose: () => void;
}

export function getRosterKeyboardAvoidingBehavior(
  platform: string,
  isKeyboardVisible: boolean,
) {
  if (platform === 'ios') return 'padding' as const;
  if (platform === 'android' && isKeyboardVisible) return 'height' as const;
  return undefined;
}

export function getRosterBottomPadding(
  bottomInset: number,
  isKeyboardVisible: boolean,
) {
  return isKeyboardVisible ? spacing.md : Math.max(bottomInset, spacing.lg);
}

export function FamilyRosterSheet({
  visible,
  members,
  selectedMemberIds,
  maxSelected,
  onToggleMember,
  onClose,
}: FamilyRosterSheetProps) {
  const insets = useSafeAreaInsets();
  const [searchQuery, setSearchQuery] = useState('');
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);

  const atLimit = maxSelected !== undefined && selectedMemberIds.length >= maxSelected;
  const taggedCount = selectedMemberIds.length;

  useEffect(() => {
    if (!visible) {
      return;
    }

    const showSubscription = Keyboard.addListener('keyboardDidShow', () => {
      setIsKeyboardVisible(true);
    });
    const hideSubscription = Keyboard.addListener('keyboardDidHide', () => {
      setIsKeyboardVisible(false);
    });

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, [visible]);

  const filteredMembers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return members;
    return members.filter((m) => m.name.toLowerCase().includes(q));
  }, [members, searchQuery]);

  const hasNoFamilyMembers = members.length === 0;
  const hasNoResults = searchQuery.trim().length > 0 && filteredMembers.length === 0;

  const handleClose = () => {
    Keyboard.dismiss();
    setIsKeyboardVisible(false);
    setSearchQuery('');
    onClose();
  };

  return (
    <Modal
      animationType="slide"
      onRequestClose={handleClose}
      presentationStyle="overFullScreen"
      transparent
      visible={visible}
    >
      <KeyboardAvoidingView
        behavior={getRosterKeyboardAvoidingBehavior(Platform.OS, isKeyboardVisible)}
        keyboardVerticalOffset={0}
        style={styles.root}
        testID="roster-keyboard-avoiding-view"
      >
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          onPress={handleClose}
          style={styles.backdrop}
        />
        <View
          style={[
            styles.sheet,
            { paddingBottom: getRosterBottomPadding(insets.bottom, isKeyboardVisible) },
          ]}
          testID="roster-sheet"
        >
          {/* Drag handle */}
          <View style={styles.handle} />

          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Who’s in it</Text>
            <Text style={styles.headerCount}>
              {maxSelected !== undefined ? `${taggedCount} of ${maxSelected}` : `${taggedCount} tagged`}
            </Text>
          </View>

          {/* Search */}
          <View style={styles.searchWrap}>
            <TextInput
              autoCorrect={false}
              onChangeText={setSearchQuery}
              placeholder="Search family"
              placeholderTextColor={colors.ink3}
              returnKeyType="search"
              style={styles.searchInput}
              testID="roster-search-input"
              value={searchQuery}
            />
            {searchQuery.length > 0 ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setSearchQuery('')}
                style={styles.searchClearBtn}
                testID="roster-search-clear"
              >
                <Text style={styles.searchClearText}>✕</Text>
              </Pressable>
            ) : null}
          </View>

          <ScrollView
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            style={styles.scroll}
            testID="roster-member-list"
          >
            {filteredMembers.length > 0 ? (
              <>
                <Text style={styles.sectionLabel}>FAMILY</Text>
                {filteredMembers.map((member) => (
                  <RosterRow
                    isDisabled={!selectedMemberIds.includes(member.id) && atLimit}
                    isSelected={selectedMemberIds.includes(member.id)}
                    key={member.id}
                    member={member}
                    onPress={() => onToggleMember(member.id)}
                  />
                ))}
              </>
            ) : null}

            {hasNoFamilyMembers ? (
              <Text style={styles.emptyText}>Add family members before tagging memories.</Text>
            ) : null}

            {hasNoResults ? (
              <Text style={styles.emptyText}>No family members match “{searchQuery}”</Text>
            ) : null}
          </ScrollView>

          {/* Done button */}
          <Pressable
            accessibilityRole="button"
            onPress={handleClose}
            style={({ pressed }) => [styles.doneBtn, pressed && styles.doneBtnPressed]}
            testID="roster-done-btn"
          >
            <Text style={styles.doneBtnText}>
              {taggedCount > 0 ? `Done · ${taggedCount} tagged` : 'Done'}
            </Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(44, 36, 24, 0.4)',
  },
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    maxHeight: '78%',
    overflow: 'hidden',
    paddingTop: spacing.sm,
  },
  handle: {
    alignSelf: 'center',
    backgroundColor: colors.borderStrong,
    borderRadius: 2,
    height: 4,
    marginBottom: spacing.md,
    width: 36,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  headerTitle: {
    color: colors.ink,
    fontFamily: fonts.sansBold,
    fontSize: 17,
  },
  headerCount: {
    color: colors.ink3,
    fontFamily: fonts.sans,
    fontSize: 14,
  },
  searchWrap: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    marginBottom: spacing.xs,
    marginHorizontal: spacing.lg,
    paddingHorizontal: spacing.md,
  },
  searchInput: {
    color: colors.ink,
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 15,
    paddingVertical: 10,
  },
  searchClearBtn: {
    paddingLeft: spacing.sm,
    paddingVertical: 10,
  },
  searchClearText: {
    color: colors.ink3,
    fontSize: 13,
  },
  scroll: {
    flexGrow: 0,
    flexShrink: 1,
    minHeight: 0,
  },
  scrollContent: {
    paddingBottom: spacing.xs,
  },
  sectionLabel: {
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 0.8,
    paddingBottom: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    textTransform: 'uppercase',
  },
  emptyText: {
    color: colors.ink3,
    fontFamily: fonts.sans,
    fontSize: 14,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xl,
    textAlign: 'center',
  },
  doneBtn: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    paddingVertical: 14,
  },
  doneBtnPressed: { opacity: 0.85 },
  doneBtnText: {
    color: colors.white,
    fontFamily: fonts.sansBold,
    fontSize: 16,
  },
});
