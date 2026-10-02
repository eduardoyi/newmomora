// S15b -- Paused at the paywall. Where S15's close sheet "Leave" lands
// (2026-10-02). It used to sign the owner out, which did keep an unpaid owner
// out of the journal but cost them the whole OTP round trip (and, if they
// tapped "Start" instead of "Log in", the whole story again) just to see the
// price a second time. The session now stays: this screen is the "out", and
// the next cold launch resumes the paywall through the front door's
// paywall marker (resolvePostAuthDestination). Still never the journal.
//
// The card is their own aha (S10) memory, via the same OnbMemoryCard: the
// thing they saved is what greets them when they step away from the price.
// S12B clears the local draft before the trust screens, so a new owner's
// card comes from the server (the family's newest memory, which for them is
// the onboarding one); a returning owner whose capture is still pending
// (captureCommitted false) uses the draft. No card -- loading, error, or an
// empty family -- falls back to the illustration.
import { useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { OnbButton } from '@/components/onboarding/onb-button';
import { OnbIllustration } from '@/components/onboarding/onb-illustration';
import { OnbMemoryCard } from '@/components/onboarding/onb-memory-card';
import { OnbShell } from '@/components/onboarding/onb-shell';
import { OnbBody, OnbDisplay, OnbScript } from '@/components/onboarding/onb-typography';
import { colors, fonts } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { useOnboardingKidPossessive } from '@/hooks/use-onboarding-kid-possessive';
import { useMediaUrl } from '@/hooks/useMediaUrls';
import { useAttachmentPreviewUri } from '@/hooks/useVideoThumbnail';
import { onboardingIncludedRoute, onboardingPaywallRouteForMode, onboardingWelcomeRoute } from '@/lib/onboarding-routes';
import { fetchMemoriesPage, type MemoryWithTags } from '@/services/memories';
import { DEFAULT_MEDIA_ASPECT_RATIO } from '@/utils/media-aspect';
import { isVideoContentType } from '@/utils/media-validation';
import { formatDisplayDate } from '@/utils/memories';
import { capitalizeFragment, journalPossessive } from '@/utils/onboarding-copy';
import { getLocalTodayIso } from '@/utils/portrait-versions';

const CARD_TEXT_LINES = 4;

interface FirstPage {
  text: string;
  mediaUri: string | null;
  mediaContentType: string | null;
  mediaDurationMs: number | null;
  taggedNames: string[];
  dayLabel: string;
}

function firstPageFromMemory(memory: MemoryWithTags, mediaUrl: string | null): FirstPage {
  const asset = memory.mediaAssets[0];
  return {
    text: memory.content ?? '',
    mediaUri: asset ? mediaUrl : null,
    mediaContentType: asset?.content_type ?? null,
    mediaDurationMs: asset?.duration_ms ?? null,
    taggedNames: memory.taggedMembers.map((member) => member.name),
    dayLabel: formatDisplayDate(memory.memory_date),
  };
}

/** The aha memory: the pending draft capture if there is one, else the family's newest saved memory. */
function useFirstPage(): { page: FirstPage | null; hasMedia: boolean } {
  const { draft } = useOnboardingFlow();
  const { familyId } = useFamily();
  const capture = draft.capture;

  const memoryQuery = useQuery({
    queryKey: ['onboarding-paused-first-page', familyId],
    enabled: !capture && Boolean(familyId),
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await fetchMemoriesPage(familyId as string, { limit: 1 });
      if (error) {
        throw new Error(error.message);
      }
      return data?.memories[0] ?? null;
    },
  });

  const memory = capture ? null : memoryQuery.data ?? null;
  const asset = memory?.mediaAssets[0];
  // Videos have no preview key; their first frame comes from the signed URL.
  const assetKey = asset
    ? isVideoContentType(asset.content_type)
      ? asset.object_key
      : asset.preview_object_key ?? asset.object_key
    : null;
  const { url: mediaUrl } = useMediaUrl(assetKey);

  if (capture) {
    return {
      hasMedia: Boolean(capture.mediaUri),
      page: {
        text: capture.text,
        mediaUri: capture.mediaUri ?? null,
        mediaContentType: capture.mediaContentType ?? null,
        mediaDurationMs: capture.mediaDurationMs ?? null,
        taggedNames: capture.taggedKidIndexes
          .map((index) => draft.kidNames[index])
          .filter((name): name is string => Boolean(name)),
        dayLabel: formatDisplayDate(getLocalTodayIso()),
      },
    };
  }

  return memory ? { hasMedia: Boolean(asset), page: firstPageFromMemory(memory, mediaUrl ?? null) } : { hasMedia: false, page: null };
}

export default function PausedScreen() {
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const paywallMode = mode === 'resubscribe' ? 'resubscribe' : 'new-owner';
  const resolvedPossessive = useOnboardingKidPossessive();
  const { signOut } = useAuth();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const journalOwner = capitalizeFragment(journalPossessive(resolvedPossessive));
  const { page: firstPage, hasMedia } = useFirstPage();
  const { isVideo, previewUri } = useAttachmentPreviewUri(firstPage?.mediaUri, firstPage?.mediaContentType);
  const showCard = Boolean(firstPage && (firstPage.text || hasMedia));

  // A first-time owner who stepped away gets the whole pitch again, not just
  // the price: S14 ("what's included") -> S13 (free week, when eligible) ->
  // S15. A lapsed owner already knows the product and goes straight back to
  // the resubscribe paywall.
  const handleKeepGoing = () => {
    router.replace(paywallMode === 'new-owner' ? onboardingIncludedRoute : onboardingPaywallRouteForMode(paywallMode));
  };

  const handleLogOut = async () => {
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    setErrorMessage('');
    try {
      // The paywall marker stays in device storage, so signing back in
      // resumes the purchase step (same as the old Leave behavior).
      await signOut();
      router.replace(onboardingWelcomeRoute);
    } catch {
      setIsLoggingOut(false);
      setErrorMessage('Could not log you out. Please try again.');
    }
  };

  return (
    <OnbShell
      footer={
        <View>
          <OnbButton
            disabled={isLoggingOut}
            label="Keep going"
            onPress={handleKeepGoing}
            style={styles.fullWidthButton}
            testID="onb-paused-keep-going-button"
          />
          <Pressable
            accessibilityRole="button"
            disabled={isLoggingOut}
            onPress={() => void handleLogOut()}
            style={styles.logOutLink}
            testID="onb-paused-log-out-link"
          >
            <Text style={styles.logOutText}>Log out</Text>
          </Pressable>
          {errorMessage ? (
            <OnbBody size={13} style={styles.errorText} testID="onb-paused-error">
              {errorMessage}
            </OnbBody>
          ) : null}
        </View>
      }
      testID="onb-paused-screen"
    >
      <View style={styles.container}>
        {showCard && firstPage ? null : (
          <View style={styles.nestWrap}>
            <OnbIllustration slot="family-nest" style={styles.nestImage} testID="onb-paused-illustration" />
          </View>
        )}
        <OnbScript color={colors.primary} size={24} style={styles.accent}>
          no rush
        </OnbScript>
        <OnbDisplay size={32}>{`${journalOwner} journal is waiting for you.`}</OnbDisplay>
        {showCard && firstPage ? (
          <View style={styles.cardWrap}>
            <OnbMemoryCard
              dayLabel={firstPage.dayLabel}
              hasMedia={hasMedia}
              imageUri={previewUri}
              isVideo={isVideo}
              liked
              mediaAspectRatio={DEFAULT_MEDIA_ASPECT_RATIO}
              mediaDurationMs={firstPage.mediaDurationMs}
              taggedNames={firstPage.taggedNames}
              testIDPrefix="onb-paused-memory"
              text={firstPage.text}
              textNumberOfLines={CARD_TEXT_LINES}
            />
            <OnbScript color={colors.ink3} size={17} style={styles.savedCaption}>
              your first page, safe and sound
            </OnbScript>
          </View>
        ) : null}
        <OnbBody muted size={15.5} style={styles.body}>
          Come back whenever you&rsquo;re ready. Next time you open Momora, you&rsquo;ll pick up right where you left off.
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
  cardWrap: {
    marginTop: 22,
    transform: [{ rotate: '-1.5deg' }],
  },
  savedCaption: {
    marginTop: 6,
    textAlign: 'right',
  },
  fullWidthButton: {
    width: '100%',
  },
  logOutLink: {
    alignItems: 'center',
    paddingTop: 12,
  },
  logOutText: {
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    fontSize: 13.5,
  },
  errorText: {
    color: colors.error,
    marginTop: 10,
    textAlign: 'center',
  },
});
