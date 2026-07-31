// S12A -- Account, email entry (docs/plans/onboarding-design-brief.md S12,
// docs/plans/onboarding-implementation.md WP2). The routing gate fires after
// S12B's OTP verify, not here -- this screen only collects the email and
// requests the code. `requestSignUpOtp` (shouldCreateUser: true) works
// whether this is a genuinely new owner or a returning owner who habit-
// tapped through onboarding again (decision 18) -- Supabase's OTP sign-in
// treats both the same way, so the client never has to guess which.
import { Image } from 'expo-image';
import { router, type Href } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { OnbButton } from '@/components/onboarding/onb-button';
import { OnbShell } from '@/components/onboarding/onb-shell';
import { OnbBody, OnbDisplay, OnbScript } from '@/components/onboarding/onb-typography';
import { colors, emotionColors, fonts, radius, spacing } from '@/constants/theme';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { useAuth } from '@/hooks/use-auth';
import { discardAnonymousSession } from '@/lib/anonymous-session';
import { possessive } from '@/utils/onboarding-copy';

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export default function OnboardingEmailScreen() {
  const { draft } = useOnboardingFlow();
  const { requestSignUpOtp } = useAuth();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const taggedNames = (draft.capture?.taggedKidIndexes ?? [])
    .map((index) => draft.kidNames[index])
    .filter((name): name is string => Boolean(name));
  const memoryOwner = taggedNames.length === 1 ? possessive(taggedNames[0]) : 'their';

  const handleSend = async () => {
    setErrorMessage('');
    const trimmedName = name.trim();
    const trimmedEmail = normalizeEmail(email);

    if (!trimmedName || !trimmedEmail) {
      return;
    }

    setIsSubmitting(true);
    // The anonymous session (S9's voice pipeline) must never linger once
    // the real OTP sign-in starts -- see src/lib/anonymous-session.ts.
    await discardAnonymousSession();
    // WP6: the owner's own display name was previously sent blank here,
    // leaving user_profiles.name empty -- the name that shows next to their
    // comments/memories. This is the owner-path equivalent of J3's "What
    // should the family call you?" (join/name.tsx), just collected on this
    // existing screen instead of a new one (owner decision).
    const { error } = await requestSignUpOtp({ name: trimmedName, email: trimmedEmail });
    setIsSubmitting(false);

    if (error) {
      setErrorMessage(error.message);
      return;
    }

    // Object-pathname routes only satisfy expo-router's generated Href union
    // once .expo/types has been regenerated for a route -- same double-cast
    // src/lib/onboarding-routes.ts already establishes for onboardingStoryRoute.
    router.push({ pathname: '/(onboarding)/code', params: { email: trimmedEmail } } as unknown as Href);
  };

  return (
    <OnbShell
      keyboardBottomOffset={spacing.xxl * 5 + spacing.md}
      footer={
        <>
          <OnbButton
            disabled={isSubmitting || !name.trim() || !email.trim()}
            label={isSubmitting ? 'Sending code…' : 'Send my code'}
            onPress={() => void handleSend()}
            style={styles.fullWidthButton}
            testID="onboarding-email-send"
          />
          <OnbBody muted size={12.5} style={styles.reassurance}>
            The memory is already saved on this phone either way.
          </OnbBody>
        </>
      }
    >
      <View style={styles.body}>
        <View style={styles.thumbnailRow}>
          <View style={styles.thumbnailFrame}>
            {draft.capture?.mediaUri ? (
              <Image
                accessibilityLabel="Your captured memory"
                contentFit="cover"
                source={{ uri: draft.capture.mediaUri }}
                style={styles.thumbnailImage}
              />
            ) : (
              <View style={[styles.thumbnailWash, { backgroundColor: emotionColors.joy.soft }]} />
            )}
          </View>
          <OnbScript color={colors.ink3} size={19}>your first page, safe and sound</OnbScript>
        </View>

        <OnbDisplay size={31} style={styles.headline}>
          {`Let's put ${memoryOwner} first memory somewhere safe.`}
        </OnbDisplay>
        <OnbBody muted size={15} style={styles.subhead}>Email in, code back. No passwords, ever.</OnbBody>

        <View style={styles.fieldsGroup}>
          <View>
            <OnbBody muted size={13} style={styles.fieldLabel}>Your name</OnbBody>
            <TextInput
              autoCapitalize="words"
              autoComplete="name"
              onChangeText={setName}
              placeholder="Grandma Ana, Uncle Rob, Dad…"
              placeholderTextColor={colors.ink3}
              style={styles.input}
              testID="onboarding-email-name-input"
              textContentType="name"
              value={name}
            />
          </View>

          <TextInput
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            onChangeText={setEmail}
            placeholder="you@email.com"
            placeholderTextColor={colors.ink3}
            style={styles.input}
            testID="onboarding-email-input"
            textContentType="emailAddress"
            value={email}
          />
        </View>

        {errorMessage ? (
          <OnbBody size={13} style={styles.errorText} testID="onboarding-email-error">
            {errorMessage}
          </OnbBody>
        ) : null}
      </View>
    </OnbShell>
  );
}

const styles = StyleSheet.create({
  body: {
    paddingHorizontal: 26,
    paddingTop: 24,
  },
  thumbnailRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    marginBottom: 24,
  },
  thumbnailFrame: {
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    height: 54,
    padding: 4,
    transform: [{ rotate: '-3deg' }],
    width: 54,
  },
  thumbnailImage: {
    borderRadius: radius.sm - 3,
    height: '100%',
    width: '100%',
  },
  thumbnailWash: {
    borderRadius: radius.sm - 3,
    height: '100%',
    width: '100%',
  },
  headline: {
    marginBottom: 12,
  },
  subhead: {
    marginBottom: 24,
  },
  fieldsGroup: {
    gap: 20,
  },
  fieldLabel: {
    marginBottom: 6,
  },
  input: {
    borderBottomColor: colors.border,
    borderBottomWidth: 1.5,
    color: colors.ink,
    fontFamily: fonts.sans,
    fontSize: 17,
    paddingVertical: 10,
  },
  errorText: {
    color: colors.error,
    marginTop: 12,
  },
  reassurance: {
    textAlign: 'center',
  },
  fullWidthButton: {
    width: '100%',
  },
});
