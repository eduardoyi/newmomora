// Onboarding button primitive (docs/plans/onboarding-implementation.md
// WP0 §0.1), matching the handoff's `Button` (src/primitives.jsx) visual
// output: pill radius, three variants, three sizes, pressed state ->
// `colors.primaryDark`. `Pressable`, never Touchables, per project rule.
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { colors, fonts, radius } from '@/constants/theme';

export type OnbButtonVariant = 'primary' | 'secondary' | 'ghost';
export type OnbButtonSize = 'lg' | 'md' | 'sm';

interface OnbButtonProps {
  label: string;
  onPress: () => void;
  /** @default 'primary' */
  variant?: OnbButtonVariant;
  /** @default 'lg' */
  size?: OnbButtonSize;
  disabled?: boolean;
  /** Leading icon, e.g. S16's "Choose a photo" camera glyph. */
  icon?: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID: string;
}

const SIZE_STYLES: Record<OnbButtonSize, ViewStyle> = {
  lg: { paddingVertical: 16, paddingHorizontal: 22 },
  md: { paddingVertical: 12, paddingHorizontal: 18 },
  sm: { paddingVertical: 8, paddingHorizontal: 14 },
};

const LABEL_FONT_SIZES: Record<OnbButtonSize, number> = {
  lg: 16,
  md: 15,
  sm: 13,
};

export function OnbButton({
  label,
  onPress,
  variant = 'primary',
  size = 'lg',
  disabled = false,
  icon,
  style,
  testID,
}: OnbButtonProps) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        SIZE_STYLES[size],
        VARIANT_CONTAINER_STYLES[variant],
        pressed && !disabled && VARIANT_PRESSED_STYLES[variant],
        disabled && styles.disabled,
        style,
      ]}
      testID={testID}
    >
      {icon}
      <Text style={[styles.label, { fontSize: LABEL_FONT_SIZES[size] }, VARIANT_LABEL_STYLES[variant]]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: radius.pill,
  },
  label: {
    fontFamily: fonts.sansBold,
  },
  disabled: {
    opacity: 0.6,
  },
  primary: {
    backgroundColor: colors.primary,
  },
  primaryPressed: {
    backgroundColor: colors.primaryDark,
  },
  secondary: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
  },
  secondaryPressed: {
    backgroundColor: colors.surface,
  },
  ghost: {
    backgroundColor: 'transparent',
  },
  ghostPressed: {
    opacity: 0.7,
  },
});

const labelStyles = StyleSheet.create({
  primary: {
    color: colors.white,
  },
  secondary: {
    color: colors.ink,
  },
  ghost: {
    color: colors.primary,
  },
});

const VARIANT_CONTAINER_STYLES: Record<OnbButtonVariant, ViewStyle> = {
  primary: styles.primary,
  secondary: styles.secondary,
  ghost: styles.ghost,
};

const VARIANT_PRESSED_STYLES: Record<OnbButtonVariant, ViewStyle> = {
  primary: styles.primaryPressed,
  secondary: styles.secondaryPressed,
  ghost: styles.ghostPressed,
};

const VARIANT_LABEL_STYLES: Record<OnbButtonVariant, TextStyle> = {
  primary: labelStyles.primary,
  secondary: labelStyles.secondary,
  ghost: labelStyles.ghost,
};
