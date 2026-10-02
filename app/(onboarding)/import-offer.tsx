// S18 -- Gallery-import offer (2026-10-02). Reached from the last portrait
// reveal (S17's "Take me to the journal") when gallery import is enabled. A
// family fresh out of onboarding has one memory at the start of its trial;
// the photos already on the phone are the fastest way to a journal (and,
// later, a book or a monthly film) that feels like theirs. Strictly
// optional: "Maybe later" goes to the journal, where the timeline's own
// import card stays available until dismissed.
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { OnbButton } from '@/components/onboarding/onb-button';
import { OnbIllustration } from '@/components/onboarding/onb-illustration';
import { OnbShell } from '@/components/onboarding/onb-shell';
import { OnbBody, OnbDisplay, OnbScript } from '@/components/onboarding/onb-typography';
import { colors, fonts } from '@/constants/theme';
import { useOnboardingKidPossessive } from '@/hooks/use-onboarding-kid-possessive';
import { timelineRoute } from '@/lib/routes';
import { capitalizeFragment, journalPossessive } from '@/utils/onboarding-copy';

export const GALLERY_IMPORT_FROM_ONBOARDING = {
  pathname: '/(app)/gallery-import',
  params: { surface: 'onboarding' },
} as const;

export default function ImportOfferScreen() {
  const resolvedPossessive = useOnboardingKidPossessive();
  const journalOwner = capitalizeFragment(journalPossessive(resolvedPossessive));

  // The journal goes underneath, so leaving the import flow ("Not now",
  // or finishing) lands on the timeline rather than back in onboarding.
  const handleImport = () => {
    router.replace(timelineRoute);
    router.push(GALLERY_IMPORT_FROM_ONBOARDING as never);
  };

  return (
    <OnbShell
      footer={
        <View>
          <OnbButton
            label="Look through my photos"
            onPress={handleImport}
            style={styles.fullWidthButton}
            testID="onb-import-offer-start-button"
          />
          <Pressable
            accessibilityRole="button"
            onPress={() => router.replace(timelineRoute)}
            style={styles.laterLink}
            testID="onb-import-offer-later-link"
          >
            <Text style={styles.laterText}>Maybe later</Text>
          </Pressable>
        </View>
      }
      testID="onb-import-offer-screen"
    >
      <View style={styles.container}>
        <View style={styles.nestWrap}>
          <OnbIllustration slot="family-nest" style={styles.nestImage} testID="onb-import-offer-illustration" />
        </View>
        <OnbScript color={colors.primary} size={24} style={styles.accent}>
          one more thing
        </OnbScript>
        <OnbDisplay size={32}>{`${journalOwner} journal doesn’t have to start with one page.`}</OnbDisplay>
        <OnbBody muted size={15.5} style={styles.body}>
          Momora can look through the photos on your phone and turn the moments worth keeping into memories. You
          choose what stays. Nothing in your camera roll changes.
        </OnbBody>
      </View>
    </OnbShell>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 30,
  },
  nestWrap: {
    width: 92,
    height: 92,
    marginBottom: 20,
    transform: [{ rotate: '-3deg' }],
  },
  nestImage: {
    width: '100%',
    height: '100%',
  },
  accent: {
    marginBottom: 12,
    transform: [{ rotate: '-2deg' }],
  },
  body: {
    marginTop: 16,
  },
  fullWidthButton: {
    width: '100%',
  },
  laterLink: {
    alignItems: 'center',
    paddingTop: 12,
  },
  laterText: {
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    fontSize: 13.5,
  },
});
