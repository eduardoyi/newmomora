// Kid chip primitive (docs/plans/onboarding-implementation.md WP0 §0.1).
// Initial-letter avatar in an emotion tint + name, with two optional modes
// layered on the same base look:
//  - `onRemove` -- a deletable chip (S6 kids.tsx: typed names become chips).
//  - `onPress`/`selected` -- a selectable chip (S9 capture.tsx: multi-kid
//    families pick who a memory is about). Visual states for this mode
//    mirror the handoff's inline S9 selector (onboarding-capture.jsx).
// A chip using neither is a plain, non-interactive display chip (S6's
// static look, src/screens/onboarding-story.jsx KidChip).
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, emotionColors, fonts, radius } from '@/constants/theme';
import { kidTint } from '@/components/onboarding/onb-illustration';

const AVATAR_SIZE = 24;

interface KidChipProps {
  name: string;
  /** Drives tint cycling (kidTint) -- entry order in the kid list. @default 0 */
  index?: number;
  /** Selectable mode: current selection state. Ignored without `onPress`. */
  selected?: boolean;
  /** Present -> chip is a selectable Pressable (S9). */
  onPress?: () => void;
  /** Present -> chip shows a remove (x) affordance (S6). */
  onRemove?: () => void;
  style?: StyleProp<ViewStyle>;
  testID: string;
}

export function KidChip({ name, index = 0, selected = false, onPress, onRemove, style, testID }: KidChipProps) {
  const tint = kidTint(index);
  const emo = emotionColors[tint];
  const isSelectable = Boolean(onPress);
  const isOn = isSelectable && selected;

  const body = (
    <View
      style={[
        styles.chip,
        isSelectable ? (isOn ? styles.chipSelected : styles.chipUnselected) : styles.chipDefault,
        style,
      ]}
    >
      <View style={[styles.avatar, { backgroundColor: emo.soft }]}>
        <Text style={[styles.avatarInitial, { color: emo.ink }]}>{name.charAt(0).toUpperCase()}</Text>
      </View>
      <Text
        numberOfLines={1}
        style={[styles.name, isSelectable && (isOn ? styles.nameSelected : styles.nameUnselected)]}
      >
        {name}
      </Text>
      {onRemove ? (
        <Pressable
          accessibilityLabel={`Remove ${name}`}
          accessibilityRole="button"
          hitSlop={8}
          onPress={onRemove}
          style={styles.removeButton}
          testID={`${testID}-remove`}
        >
          <Text style={styles.removeGlyph}>×</Text>
        </Pressable>
      ) : null}
    </View>
  );

  if (isSelectable) {
    return (
      <Pressable
        accessibilityLabel={name}
        accessibilityRole="button"
        accessibilityState={{ selected: isOn }}
        onPress={onPress}
        testID={testID}
      >
        {body}
      </Pressable>
    );
  }

  return (
    <View testID={testID}>
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.white,
  },
  chipDefault: {
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 5,
    paddingLeft: 5,
    paddingRight: 9,
  },
  chipUnselected: {
    borderWidth: 1.5,
    borderColor: colors.border,
    paddingVertical: 4,
    paddingLeft: 4,
    paddingRight: 11,
  },
  chipSelected: {
    borderWidth: 1.5,
    borderColor: colors.primary,
    backgroundColor: colors.primaryTint,
    paddingVertical: 4,
    paddingLeft: 4,
    paddingRight: 11,
  },
  avatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontFamily: fonts.sansBold,
    fontSize: AVATAR_SIZE * 0.42,
  },
  name: {
    fontFamily: fonts.sansBold,
    fontSize: 14,
    color: colors.ink,
    maxWidth: 140,
  },
  nameUnselected: {
    color: colors.ink2,
  },
  nameSelected: {
    color: colors.primaryDark,
  },
  removeButton: {
    width: 17,
    height: 17,
    borderRadius: 17 / 2,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeGlyph: {
    fontSize: 12,
    lineHeight: 14,
    color: colors.ink3,
  },
});
