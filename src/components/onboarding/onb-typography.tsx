// Onboarding typography primitives (docs/plans/onboarding-implementation.md
// WP0 §0.1), styled from theme tokens (src/constants/theme.ts) to match the
// design handoff's `src/primitives.jsx` (Display/Title/Body/Script/Eyebrow)
// visual output. Every full-screen onboarding step composes these instead
// of raw `<Text>`.
import type { ReactNode } from 'react';
import { StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';

import { colors, fonts } from '@/constants/theme';

interface OnbTextProps {
  children: ReactNode;
  style?: StyleProp<TextStyle>;
  testID?: string;
  numberOfLines?: number;
}

interface OnbDisplayProps extends OnbTextProps {
  /** @default 32 */
  size?: number;
}

/** Newsreader headline. The handoff's primary hero/headline treatment. */
export function OnbDisplay({ children, size = 32, style, testID, numberOfLines }: OnbDisplayProps) {
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[
        {
          fontFamily: fonts.display,
          fontSize: size,
          lineHeight: size * 1.0,
          letterSpacing: size * -0.018,
          color: colors.ink,
        },
        style,
      ]}
      testID={testID}
    >
      {children}
    </Text>
  );
}

interface OnbTitleProps extends OnbTextProps {
  /** @default 28 */
  size?: number;
}

/** Newsreader medium -- a step down from OnbDisplay for card/section titles. */
export function OnbTitle({ children, size = 28, style, testID, numberOfLines }: OnbTitleProps) {
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[
        {
          fontFamily: fonts.displayMedium,
          fontSize: size,
          lineHeight: size * 1.08,
          letterSpacing: size * -0.012,
          color: colors.ink,
        },
        style,
      ]}
      testID={testID}
    >
      {children}
    </Text>
  );
}

interface OnbBodyProps extends OnbTextProps {
  /** @default 16 */
  size?: number;
  /** Muted (`colors.ink2`) instead of full-contrast ink. */
  muted?: boolean;
}

/** Plus Jakarta Sans body copy. */
export function OnbBody({ children, muted = false, size = 16, style, testID, numberOfLines }: OnbBodyProps) {
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[
        {
          fontFamily: fonts.sans,
          fontSize: size,
          lineHeight: size * 1.5,
          color: muted ? colors.ink2 : colors.ink,
        },
        style,
      ]}
      testID={testID}
    >
      {children}
    </Text>
  );
}

interface OnbScriptProps extends OnbTextProps {
  /** @default 28 */
  size?: number;
  /** @default colors.primary */
  color?: string;
}

/** Caveat hand-touch accent (captions, signatures, asides). */
export function OnbScript({ children, size = 28, color = colors.primary, style, testID, numberOfLines }: OnbScriptProps) {
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[
        {
          fontFamily: fonts.script,
          fontSize: size,
          lineHeight: size,
          color,
        },
        style,
      ]}
      testID={testID}
    >
      {children}
    </Text>
  );
}

interface OnbEyebrowProps extends OnbTextProps {
  /** @default colors.primary */
  color?: string;
}

/** Small uppercase label -- section kickers, quiet status lines. */
export function OnbEyebrow({ children, color = colors.primary, style, testID, numberOfLines }: OnbEyebrowProps) {
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[styles.eyebrow, { color }, style]}
      testID={testID}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  eyebrow: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 11 * 0.14,
    textTransform: 'uppercase',
  },
});
