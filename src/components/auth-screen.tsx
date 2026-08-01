// Editorial auth shell (Claude Design handoff, src/screens/auth.jsx
// `LoginA`) -- matches app/(auth)/login.tsx's wordmark + headline +
// spacer-pinned-footer composition (docs/plans/onboarding-design-brief.md
// for copy rules) so verify-otp, password and signup share login's visual
// language instead of the old generic "Momora / title / subtitle" header.
// login.tsx renders through this component too -- see that file's header --
// so there is exactly one implementation of both the composition and the
// keyboard-avoidance mechanism it's built on
// (`src/components/keyboard-sticky-shell.tsx`, extracted from
// `src/components/onboarding/onb-shell.tsx`; read that file's header for
// the full keyboard-covers-the-CTA incident history this fixes here too).
//
// `AuthField`, `AuthInput`, `AuthButton` and `AuthErrorMessage` below are
// unchanged by this restyle -- eight other screens under app/(app)/ import
// them directly and must keep rendering exactly as before.
import { ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';

import { KeyboardStickyShell } from '@/components/keyboard-sticky-shell';
import { OnbBody, OnbDisplay } from '@/components/onboarding/onb-typography';
import { Wordmark } from '@/components/wordmark';
import { colors, spacing } from '@/constants/theme';

interface AuthScreenProps {
  /** Newsreader headline -- supports an embedded "\n" for a two-line break like login's "Welcome\nback.". */
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
  /** login.tsx keeps its pre-existing `login-screen-scroll` testID instead of the shared default. */
  scrollTestID?: string;
  /** login.tsx keeps its pre-existing `login-wordmark` testID; the other three screens don't need one. */
  wordmarkTestID?: string;
}

export function AuthScreen({
  title,
  subtitle,
  children,
  footer,
  scrollTestID = 'auth-screen-scroll',
  wordmarkTestID,
}: AuthScreenProps) {
  return (
    <KeyboardStickyShell
      contentContainerStyle={styles.content}
      footer={footer}
      footerStyle={styles.footer}
      safeAreaStyle={styles.safeArea}
      scrollTestID={scrollTestID}
    >
      <Wordmark size={26} testID={wordmarkTestID} />

      <View style={styles.headlineBlock}>
        <OnbDisplay size={44}>{title}</OnbDisplay>
        <OnbBody muted size={15}>
          {subtitle}
        </OnbBody>
      </View>

      <View style={styles.form}>{children}</View>
    </KeyboardStickyShell>
  );
}

interface AuthFieldProps {
  label: string;
  children: ReactNode;
}

export function AuthField({ label, children }: AuthFieldProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

export function AuthInput(props: TextInputProps) {
  return (
    <TextInput
      {...props}
      style={[styles.input, props.style]}
      placeholderTextColor={colors.textMuted}
    />
  );
}

interface AuthButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
  variant?: 'primary' | 'ghost';
}

export function AuthButton({
  label,
  onPress,
  disabled = false,
  testID,
  variant = 'primary',
}: AuthButtonProps) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variant === 'ghost' && styles.buttonGhost,
        disabled && styles.buttonDisabled,
        pressed && !disabled && styles.buttonPressed,
      ]}
      testID={testID}
    >
      <Text style={[styles.buttonText, variant === 'ghost' && styles.buttonGhostText]}>{label}</Text>
    </Pressable>
  );
}

export function AuthErrorMessage({ message }: { message: string }) {
  if (!message) {
    return null;
  }

  return (
    <Text accessibilityRole="alert" style={styles.error}>
      {message}
    </Text>
  );
}

const styles = StyleSheet.create({
  // Editorial shell chrome -- matches app/(auth)/login.tsx's `content` /
  // `headlineBlock` / `bottomBlock` tokens exactly (see that file) so all
  // four auth screens share one visual system.
  safeArea: {
    backgroundColor: colors.bg,
    flex: 1,
  },
  content: {
    flexGrow: 1,
    paddingBottom: 32,
    paddingHorizontal: 28,
    paddingTop: 88,
  },
  headlineBlock: {
    gap: 8,
    marginTop: 48,
  },
  form: {
    gap: spacing.md,
    marginTop: 36,
  },
  footer: {
    gap: 12,
    paddingHorizontal: 28,
  },
  // Field/input/button/error styling below is unchanged by the restyle --
  // AuthField, AuthInput, AuthButton and AuthErrorMessage render identically
  // for their eight other app/(app)/ consumers.
  field: {
    gap: spacing.sm,
  },
  label: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 1,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
  },
  button: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: 12,
    marginTop: spacing.sm,
    paddingVertical: 16,
  },
  buttonGhost: {
    backgroundColor: 'transparent',
    marginTop: 0,
    paddingVertical: spacing.sm,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonPressed: {
    backgroundColor: colors.primaryDark,
  },
  buttonText: {
    color: colors.white,
    fontSize: 16,
    fontWeight: '700',
  },
  buttonGhostText: {
    color: colors.primary,
  },
  error: {
    color: colors.error,
    fontSize: 14,
    lineHeight: 20,
  },
});
