import { Link, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { AuthButton, AuthErrorMessage, AuthScreen } from '@/components/auth-screen';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';

const CODE_LENGTH = 6;
const RESEND_COOLDOWN_SECONDS = 60;

export default function VerifyOtpScreen() {
  const params = useLocalSearchParams<{ email?: string; mode?: string; name?: string }>();
  const email = (params.email ?? '').trim();
  const mode = params.mode === 'signup' ? 'signup' : 'signin';
  const name = params.name ?? '';

  const { verifyOtp, requestSignInOtp, requestSignUpOtp } = useAuth();

  const [code, setCode] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [resendMessage, setResendMessage] = useState('');
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS);

  // No email to verify (e.g. deep-linked directly) — bounce back to where a code can be requested.
  useEffect(() => {
    if (!email) {
      router.replace(mode === 'signup' ? '/(auth)/signup' : '/(auth)/login');
    }
  }, [email, mode]);

  useEffect(() => {
    if (cooldown <= 0) {
      return;
    }

    const timer = setTimeout(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const handleVerify = async (candidate: string) => {
    if (candidate.length !== CODE_LENGTH || !email) {
      return;
    }

    setErrorMessage('');
    setIsVerifying(true);

    const { error } = await verifyOtp({ email, token: candidate });

    setIsVerifying(false);

    if (error) {
      setErrorMessage(error.message);
      return;
    }

    router.replace('/(app)/(tabs)/timeline');
  };

  const handleChangeCode = (text: string) => {
    const digitsOnly = text.replace(/[^0-9]/g, '').slice(0, CODE_LENGTH);
    setCode(digitsOnly);
    setErrorMessage('');

    if (digitsOnly.length === CODE_LENGTH) {
      void handleVerify(digitsOnly);
    }
  };

  const handleResend = async () => {
    if (cooldown > 0 || !email) {
      return;
    }

    setErrorMessage('');
    setResendMessage('');
    setIsResending(true);

    const { error } =
      mode === 'signup' ? await requestSignUpOtp({ name, email }) : await requestSignInOtp(email);

    setIsResending(false);

    if (error) {
      setErrorMessage(error.message);
      return;
    }

    setCode('');
    setResendMessage('New code sent.');
    setCooldown(RESEND_COOLDOWN_SECONDS);
  };

  const digits = Array.from({ length: CODE_LENGTH }, (_, index) => code[index] ?? '');

  return (
    <AuthScreen
      footer={
        <Text style={styles.footerText}>
          Wrong email?{' '}
          <Link href={mode === 'signup' ? '/(auth)/signup' : '/(auth)/login'} style={styles.link}>
            Go back
          </Link>
        </Text>
      }
      subtitle={email ? `Enter the 6-digit code we sent to ${email}.` : 'Enter your 6-digit code.'}
      title="Check your email"
    >
      <View style={styles.codeInputWrap}>
        <View pointerEvents="none" style={styles.codeRow}>
          {digits.map((digit, index) => (
            <View
              key={index}
              style={[
                styles.codeBox,
                digit ? styles.codeBoxFilled : null,
                code.length === index && styles.codeBoxActive,
              ]}
            >
              <Text style={styles.codeDigit}>{digit}</Text>
            </View>
          ))}
        </View>

        <TextInput
          autoFocus
          keyboardType="number-pad"
          maxLength={CODE_LENGTH}
          onChangeText={handleChangeCode}
          style={styles.hiddenInput}
          testID="verify-otp-code-input"
          textContentType="oneTimeCode"
          value={code}
        />
      </View>

      <AuthErrorMessage message={errorMessage} />

      {resendMessage ? <Text style={styles.resendMessage}>{resendMessage}</Text> : null}

      {isVerifying ? <Text style={styles.hint}>Verifying…</Text> : null}

      <AuthButton
        disabled={isResending || cooldown > 0}
        label={isResending ? 'Sending…' : cooldown > 0 ? `Resend code (${cooldown}s)` : 'Resend code'}
        onPress={handleResend}
        testID="verify-otp-resend-button"
        variant="ghost"
      />
    </AuthScreen>
  );
}

const styles = StyleSheet.create({
  codeInputWrap: {
    position: 'relative',
  },
  codeRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'center',
  },
  codeBox: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    height: 52,
    justifyContent: 'center',
    width: 44,
  },
  codeBoxFilled: {
    borderColor: colors.borderStrong,
  },
  codeBoxActive: {
    borderColor: colors.primary,
  },
  codeDigit: {
    color: colors.text,
    fontFamily: fonts.sansBold,
    fontSize: 22,
  },
  hiddenInput: {
    bottom: 0,
    left: 0,
    opacity: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  hint: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
  },
  resendMessage: {
    color: colors.text,
    fontSize: 14,
    textAlign: 'center',
  },
  footerText: {
    color: colors.textMuted,
    fontSize: 15,
  },
  link: {
    color: colors.primary,
    fontWeight: '700',
  },
});
