import { ReactNode, useRef } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, spacing } from '@/constants/theme';
import { useFormScrollContext } from '@/components/keyboard-aware-form-screen';

interface AuthScreenProps {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function AuthScreen({ title, subtitle, children, footer }: AuthScreenProps) {
  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <Text style={styles.brand}>Momora</Text>
            <Text style={styles.title}>{title}</Text>
            <Text style={styles.subtitle}>{subtitle}</Text>
          </View>

          <View style={styles.form}>{children}</View>

          {footer ? <View style={styles.footer}>{footer}</View> : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
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

export function AuthInput({ onFocus, ...props }: TextInputProps) {
  const formScroll = useFormScrollContext();
  const inputWrapperRef = useRef<View>(null);

  const handleFocus: TextInputProps['onFocus'] = (event) => {
    onFocus?.(event);

    if (formScroll) {
      formScroll.scrollInputIntoView(inputWrapperRef);
    }
  };

  return (
    <View ref={inputWrapperRef} collapsable={false}>
      <TextInput
        {...props}
        onFocus={handleFocus}
        style={[styles.input, props.style]}
        placeholderTextColor={colors.textMuted}
      />
    </View>
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
      accessibilityRole="button"
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
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  flex: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    padding: spacing.lg,
    justifyContent: 'center',
  },
  header: {
    marginBottom: spacing.xl,
  },
  brand: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
  },
  title: {
    color: colors.text,
    fontSize: 32,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 16,
    lineHeight: 24,
  },
  form: {
    gap: spacing.md,
  },
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
  footer: {
    alignItems: 'center',
    marginTop: spacing.lg,
  },
});
