// S16 -- In-trial, immediately after: portrait kickoff (docs/plans/onboarding-design-brief.md,
// WP3, extended by WP6, WP7-A). Unlike S13-S15, this screen is fully wired: it
// reuses the real photo-picking helpers and kicks off a real portrait
// generation against the child row `commitOnboarding`
// (src/services/onboarding.ts) already created. Generation is async and
// never blocks -- "painting" state offers an immediate escape hatch to the
// journal in every sub-state.
//
// WP6: "painting" now reads the real portrait status for the target member
// (via usePortraitVersions, which already polls -- see
// src/utils/portrait-versions.ts's shouldPollPortraitVersions) instead of
// rendering a purely decorative pulse forever. `ready` hands off to S17's
// reveal; `failed` surfaces honestly with a retry. This screen also now
// accepts a `memberId` search param so S17's sibling chain can re-enter it
// for a specific next kid, falling back to the pre-existing draft-derived
// (or, once the draft is cleared post-commit, real-data-derived) target
// when no param is passed.
//
// WP7-A: the first-portrait-of-a-multi-kid-family case (no `memberId` param
// yet -- resolution falls through to the ambiguous `hasNoPortraitYet`
// search) is now pinned once resolved. Without the pin, the moment
// `createVersion`'s own invalidation lands (`usePortraitVersions` ->
// `invalidatePortraitConsumers`), the chosen kid gains a portrait version,
// stops matching `hasNoPortraitYet`, and `targetMember`'s memo silently
// retargets to an untouched sibling mid-flight -- while this screen's
// `usePortraitVersions` call and the ready-effect below are both keyed off
// whatever `targetMember` resolves to on that render. See
// `resolveTargetMember`'s doc comment for the fixed priority order.
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ArrowRight, Image as ImageIcon } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, View } from 'react-native';

import { GeneratingVisualOverlay } from '@/components/generating-visual-overlay';
import { OnbButton } from '@/components/onboarding/onb-button';
import { OnbBody, OnbDisplay, OnbScript, OnbTitle } from '@/components/onboarding/onb-typography';
import { OnbShell } from '@/components/onboarding/onb-shell';
import { colors } from '@/constants/theme';
import { onboardingPortraitPairs } from '@/constants/onboarding-portrait-pairs';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { usePortraitVersions } from '@/hooks/usePortraitVersions';
import { onboardingRevealRoute } from '@/lib/onboarding-routes';
import { timelineRoute } from '@/lib/routes';
import type { FamilyMember } from '@/services/family-members';
import {
  getPortraitStatusLabel,
  hasNoPortraitYet,
  isPortraitInProgress,
  type IllustratedProfileStatus,
} from '@/utils/family-members';
import { possessive } from '@/utils/onboarding-copy';
import type { OnboardingDraft } from '@/utils/onboarding-progress';
import {
  parsePendingPickerResult,
  pickFamilyProfilePhotoFromLibrary,
  type FamilyProfilePhotoPickResult,
} from '@/utils/family-profile-photo-picker';

const GENERIC_PHOTO_ERROR = 'Could not start the portrait. Please try again.';
const NOT_READY_ERROR = "We're still getting things ready. Try again in a moment.";
const RETRY_ERROR = "Could not retry the portrait. Please try again.";

/**
 * "Start with the kid tagged in the first memory, else the first-entered
 * name" (plan WP3, S16) -- mirrors the tagging fallback
 * src/services/onboarding.ts's `commitOnboarding` already applied when it
 * tagged the first memory, since that result doesn't expose per-kid member
 * ids back to this screen. Only ever populated in the brief window before
 * S12B's code.tsx clears the local draft (`finishAfterCommit`'s `clear()`
 * runs before routing into S13-S16, so the layout's `committedFamilyId`
 * backstop doesn't trap the post-commit trust/paywall/portrait arc) --
 * `resolveTargetMember` below falls back to real server data once this
 * comes back blank.
 */
function resolveTargetKidName(draft: OnboardingDraft): string {
  const taggedIndexes = draft.capture?.taggedKidIndexes ?? [];
  const taggedName = taggedIndexes.length > 0 ? draft.kidNames[taggedIndexes[0]] : undefined;
  return (taggedName ?? draft.kidNames[0] ?? '').trim();
}

/**
 * Resolves which family member this screen targets, in priority order:
 * 1. An explicit `memberId` search param -- S17's sibling chain re-enters
 *    this screen for a specific next kid. Always deterministic, and always
 *    wins over a pin from a previous target (see the component's own
 *    effect that clears `pinnedMemberId` whenever this is present).
 * 2. `pinnedMemberId` -- WP7-A: once priority 3 below has resolved a target
 *    for THIS screen instance, the component pins it (see the `useEffect`
 *    in `PortraitScreen`) so this function keeps returning the same member
 *    on every later call, even after `members` changes shape. Without this,
 *    a multi-kid family's first portrait would retarget mid-flight: the
 *    moment `createVersion` succeeds, its own cache invalidation
 *    (`usePortraitVersions` -> `invalidatePortraitConsumers`) refetches
 *    `family-members`/`portrait-versions`, the chosen kid's
 *    `hasNoPortraitYet` flips to `false`, and priority 4 below would
 *    silently hand the target to an untouched sibling.
 * 3. The device-local draft's tagged/first-entered kid name (see
 *    `resolveTargetKidName`'s doc comment on when this is actually populated).
 *    Deterministic (a name match, not an ambiguous search), so it's safe to
 *    check ahead of the pin -- in practice this is moot post-commit, since
 *    the draft is already empty by the time this screen normally renders.
 * 4. Real server data: the first member (in `useFamilyMembers`' tag-count-
 *    then-created-at order, from `fetchFamilyMembers`) who has never had a
 *    photo picked. This is what resolves it once the draft is empty, and
 *    happens to reproduce "start with the kid tagged in the first memory"
 *    for free -- a kid tagged on the first memory has a tag count of 1 and
 *    sorts ahead of untagged siblings. This is the priority whose result
 *    gets pinned once resolved -- it's the only one that can drift.
 */
function resolveTargetMember(
  members: FamilyMember[],
  draft: OnboardingDraft,
  requestedMemberId: string | undefined,
  pinnedMemberId: string | null,
): FamilyMember | undefined {
  if (requestedMemberId) {
    const requested = members.find((member) => member.id === requestedMemberId);
    if (requested) {
      return requested;
    }
  }

  if (pinnedMemberId) {
    const pinned = members.find((member) => member.id === pinnedMemberId);
    if (pinned) {
      return pinned;
    }
  }

  const draftName = resolveTargetKidName(draft);
  if (draftName) {
    const matched = members.find((member) => member.name.trim().toLowerCase() === draftName.toLowerCase());
    if (matched) {
      return matched;
    }
  }

  return members.find(hasNoPortraitYet) ?? members[0];
}

// Halved after device testing: at 4s a viewer only ever saw two of the eight
// pairs before moving on, which read as a static illustration rather than a
// demonstration of the photo -> portrait transformation.
export const PORTRAIT_ROTATION_INTERVAL_MS = 2000;
export const PORTRAIT_CROSSFADE_DURATION_MS = 500;

/**
 * S16's "pick a photo" before/after demo (task brief PROBLEM 1 /
 * docs/features/onboarding.md). Rotates through real photo -> illustrated
 * portrait pairs from the demo account instead of pairing an empty
 * placeholder with one fixed finished portrait, which read as "this is
 * what YOUR child's illustration will look like" (or worse, "is") rather
 * than demonstrating the transformation in general --
 * src/constants/onboarding-portrait-pairs.ts has the full rationale and how
 * to re-extract the bundled assets.
 *
 * Cross-fades on every advance via expo-image's own `transition` (not a
 * hard cut), and mirrors year.tsx's reduce-motion + focus gating exactly:
 * hold on one pair when AccessibilityInfo.isReduceMotionEnabled(), and stop
 * the interval whenever this screen isn't the focused route -- the
 * onboarding Stack keeps S16 mounted underneath S17/the journal, so an
 * unmount-only cleanup would leak a running timer.
 */
function PortraitPairShowcase() {
  const [pairIndex, setPairIndex] = useState(0);
  const [reduceMotionEnabled, setReduceMotionEnabled] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopRotation = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const startRotation = useCallback(() => {
    stopRotation();
    if (onboardingPortraitPairs.length <= 1) {
      return;
    }
    intervalRef.current = setInterval(() => {
      setPairIndex((index) => (index + 1) % onboardingPortraitPairs.length);
    }, PORTRAIT_ROTATION_INTERVAL_MS);
  }, [stopRotation]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;

      void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
        if (cancelled) return;
        setReduceMotionEnabled(enabled);
        if (!enabled) {
          startRotation();
        }
      });

      const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
        setReduceMotionEnabled(enabled);
        if (enabled) {
          stopRotation();
        } else {
          startRotation();
        }
      });

      return () => {
        cancelled = true;
        subscription.remove();
        stopRotation();
      };
    }, [startRotation, stopRotation]),
  );

  const pair = onboardingPortraitPairs[pairIndex % onboardingPortraitPairs.length];
  const transition = reduceMotionEnabled ? null : PORTRAIT_CROSSFADE_DURATION_MS;

  return (
    <View style={styles.cardsRow}>
      <View style={[styles.photoCard, styles.beforeCard]} testID="onb-portrait-before-card">
        <Image
          accessibilityLabel="A real photo, before illustration"
          contentFit="cover"
          source={pair.photo}
          style={styles.cardImage}
          testID="onb-portrait-before-image"
          transition={transition}
        />
      </View>
      <ArrowRight color={colors.ink3} size={20} style={styles.arrow} />
      <View style={[styles.photoCard, styles.afterCard]} testID="onb-portrait-after-card">
        <Image
          accessibilityLabel="The same photo, illustrated in Momora's style"
          contentFit="cover"
          source={pair.portrait}
          style={styles.cardImage}
          testID="onb-portrait-after-image"
          transition={transition}
        />
      </View>
    </View>
  );
}

/** Static "paused" frame for the `failed` state -- deliberately not
 * animated, so it reads as "paused," not "still working" (the generating
 * sub-state above uses `GeneratingVisualOverlay` instead, task brief
 * PROBLEM 2). Deliberately does NOT render any finished illustration --
 * pairing a real child's finished portrait with "That one didn't come out
 * right" would contradict the copy (it visibly *did* come out) and repeats
 * the exact identity-confusion problem this task removed from the pick
 * state, arguably worse here. Reuses the pick state's neutral "before card"
 * empty-placeholder treatment (a bare icon in the same bordered frame) so
 * the visual language stays consistent across all three of this screen's
 * sub-states without asserting any result. Reports the real status
 * (`getPortraitStatusLabel`) to screen readers as a single accessible
 * node. */
function StillFrame({ accessibilityLabel }: { accessibilityLabel: string }) {
  return (
    <View accessibilityLabel={accessibilityLabel} accessible style={styles.paintingFrame} testID="onb-portrait-failed-frame">
      <ImageIcon color={colors.ink3} size={32} strokeWidth={1.5} />
    </View>
  );
}

type PortraitScreenState = 'pick' | 'painting';

export default function PortraitScreen() {
  const { draft, patch } = useOnboardingFlow();
  const params = useLocalSearchParams<{ memberId?: string }>();
  const { members, isLoading: isLoadingMembers } = useFamilyMembers();
  const [screenState, setScreenState] = useState<PortraitScreenState>('pick');
  const [errorMessage, setErrorMessage] = useState('');
  const [activeVersionId, setActiveVersionId] = useState<string | null>(null);

  useEffect(() => {
    patch({ step: 'portrait' });
  }, [patch]);

  // WP7-A pin -- see resolveTargetMember's doc comment for the full story.
  // Only ever needed for the ambiguous "no explicit memberId" resolution
  // path; an explicit param is already deterministic and always overrides
  // it (the effect below clears a stale pin the moment a param arrives, so
  // S17's sibling chain re-entering this screen for a specific next kid is
  // never blocked by whatever this instance had previously locked onto).
  const [pinnedMemberId, setPinnedMemberId] = useState<string | null>(null);

  useEffect(() => {
    if (params.memberId) {
      setPinnedMemberId(null);
    }
  }, [params.memberId]);

  const targetMember = useMemo(
    () => resolveTargetMember(members, draft, params.memberId, pinnedMemberId),
    [members, draft, params.memberId, pinnedMemberId],
  );

  // Pin the very first target this screen instance resolves (absent an
  // explicit param), so every later render keeps returning that same
  // member regardless of how `members`/portrait-version data changes
  // afterward. A no-op once already pinned, or while nothing has resolved
  // yet (members still loading).
  useEffect(() => {
    if (!params.memberId && !pinnedMemberId && targetMember) {
      setPinnedMemberId(targetMember.id);
    }
  }, [params.memberId, pinnedMemberId, targetMember]);

  const targetName = targetMember?.name ?? resolveTargetKidName(draft);
  const hasMultipleKids = members.length > 1;

  // targetMember.id is the pinned id once resolved (resolveTargetMember's
  // priority 2 above), so this stays keyed to the kid this screen actually
  // started painting even after members/portrait-versions refetch --
  // retryVersion below inherits the same stability, since it only ever
  // retries a version already scoped to this call's memberId.
  const { createVersion, isCreating, versions = [], retryVersion } = usePortraitVersions(targetMember?.id ?? '');

  const activeVersion = useMemo(
    () => versions.find((version) => version.id === activeVersionId) ?? versions[0] ?? null,
    [versions, activeVersionId],
  );
  const portraitStatus: IllustratedProfileStatus = activeVersion?.illustrated_profile_status ?? 'pending';
  const isInProgress = isPortraitInProgress(portraitStatus);
  const isFailed = !isInProgress && portraitStatus === 'failed';

  // Never block: the moment the real status flips to ready, hand off to
  // S17's reveal for this exact member -- targetMember.id is the pinned id,
  // so this can't fire for whichever sibling the memo would have otherwise
  // drifted to. If the user has already left this screen (isn't watching it
  // re-render), that's fine too -- generation continues server-side and the
  // portrait simply shows up ready wherever they look next (the family tab,
  // the cast card, etc.).
  useEffect(() => {
    if (screenState === 'painting' && targetMember && portraitStatus === 'ready') {
      router.replace(onboardingRevealRoute(targetMember.id));
    }
  }, [screenState, targetMember, portraitStatus]);

  const applyPhotoSelection = useCallback(
    async (result: FamilyProfilePhotoPickResult) => {
      if (result.error) {
        setErrorMessage(result.error);
        return;
      }

      if (!result.selection) {
        // User cancelled the picker -- nothing to do, no error to show.
        return;
      }

      if (!targetMember) {
        setErrorMessage(NOT_READY_ERROR);
        return;
      }

      setErrorMessage('');

      try {
        const version = await createVersion({
          photoUri: result.selection.uri,
          photoContentType: result.selection.contentType,
          referenceDate: result.selection.referenceDate,
          dateSource: result.selection.dateSource,
          dateOfBirth: targetMember.date_of_birth,
        });
        setActiveVersionId(version.id);
        setScreenState('painting');
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : GENERIC_PHOTO_ERROR);
      }
    },
    [createVersion, targetMember],
  );

  const handleRetry = useCallback(async () => {
    if (!activeVersion) {
      return;
    }

    setErrorMessage('');

    try {
      await retryVersion(activeVersion.id);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : RETRY_ERROR);
    }
  }, [activeVersion, retryVersion]);

  const choosePhoto = useCallback(async () => {
    setErrorMessage('');
    await applyPhotoSelection(await pickFamilyProfilePhotoFromLibrary());
  }, [applyPhotoSelection]);

  // Android can recycle the picker's host activity while the library is
  // open, losing the in-memory pick -- recover it the same way
  // app/(app)/add-family-member.tsx does (its ~137-158) so the photo isn't
  // lost. iOS never destroys the activity, so this effect is a no-op there.
  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }

    let isMounted = true;

    const recoverPendingPhoto = async () => {
      try {
        const pending = await ImagePicker.getPendingResultAsync();
        if (isMounted && pending) {
          await applyPhotoSelection(parsePendingPickerResult(pending));
        }
      } catch {
        if (isMounted) {
          setErrorMessage('Could not recover the selected photo.');
        }
      }
    };

    void recoverPendingPhoto();

    return () => {
      isMounted = false;
    };
  }, [applyPhotoSelection]);

  const goToJournal = () => router.replace(timelineRoute);

  if (screenState === 'painting') {
    return (
      <OnbShell testID="onb-portrait-screen">
        <View style={styles.paintingContainer}>
          {isFailed ? (
            <>
              <StillFrame accessibilityLabel={getPortraitStatusLabel(portraitStatus)} />
              <OnbScript size={22} style={styles.paintingScript} testID="onb-portrait-failed-script">
                let&rsquo;s try that again
              </OnbScript>
              <OnbTitle size={22} style={styles.paintingTitle} testID="onb-portrait-failed-title">
                That one didn&rsquo;t come out right.
              </OnbTitle>
              <OnbBody muted size={14.5} style={styles.paintingBody}>
                {"No worries, it happens. Give it another go whenever you're ready -- same photo, fresh try."}
              </OnbBody>
              <OnbButton
                label="Try again"
                onPress={() => void handleRetry()}
                size="md"
                style={styles.retryButton}
                testID="onb-portrait-retry-button"
              />
              {errorMessage ? (
                <OnbBody size={13} style={styles.errorText} testID="onb-portrait-retry-error">
                  {errorMessage}
                </OnbBody>
              ) : null}
            </>
          ) : (
            <>
              <View style={styles.paintingFrame} testID="onb-portrait-painting-frame">
                <GeneratingVisualOverlay label={getPortraitStatusLabel(portraitStatus)} variant="inline" />
              </View>
              <OnbScript size={22} style={styles.paintingScript}>
                painting…
              </OnbScript>
              <OnbTitle size={22} style={styles.paintingTitle}>
                {"We're painting."}
              </OnbTitle>
              <OnbBody muted size={14.5} style={styles.paintingBody}>
                {"This takes less than a minute. Stick around and watch, or wander off and it'll be waiting."}
              </OnbBody>
            </>
          )}
          <OnbButton
            label="Take me to the journal"
            onPress={goToJournal}
            size="md"
            style={styles.journalButton}
            testID="onb-portrait-journal-button"
            variant="secondary"
          />
        </View>
      </OnbShell>
    );
  }

  return (
    <OnbShell
      footer={
        <View>
          <OnbButton
            disabled={isLoadingMembers || !targetMember || isCreating}
            icon={<ImageIcon color={colors.white} size={18} strokeWidth={2} />}
            label="Choose a photo"
            onPress={choosePhoto}
            style={styles.fullWidthButton}
            testID="onb-portrait-choose-photo-button"
          />
          {hasMultipleKids ? (
            <OnbBody muted size={13} style={styles.multiKidNote} testID="onb-portrait-multi-kid-note">
              The others get their turn next, promise.
            </OnbBody>
          ) : null}
          {errorMessage ? (
            <OnbBody size={13} style={styles.errorText} testID="onb-portrait-error">
              {errorMessage}
            </OnbBody>
          ) : null}
        </View>
      }
      testID="onb-portrait-screen"
    >
      <View style={styles.pickContainer}>
        <PortraitPairShowcase />
        <OnbDisplay size={32}>{`Let's make ${possessive(targetName)} portrait.`}</OnbDisplay>
        <OnbBody muted size={15} style={styles.pickBody}>
          {`Pick a photo you love. We'll illustrate ${targetName} in Momora's style.`}
        </OnbBody>
      </View>
    </OnbShell>
  );
}

const styles = StyleSheet.create({
  pickContainer: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 26,
  },
  cardsRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 12,
    marginBottom: 26,
  },
  photoCard: {
    width: 108,
    height: 128,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 6,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.ink,
    shadowOpacity: 0.09,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
    elevation: 3,
  },
  beforeCard: {
    transform: [{ rotate: '-4deg' }],
  },
  afterCard: {
    transform: [{ rotate: '3deg' }],
  },
  cardImage: {
    width: '100%',
    height: '100%',
  },
  arrow: {
    marginBottom: 50,
  },
  pickBody: {
    marginTop: 12,
  },
  fullWidthButton: {
    width: '100%',
  },
  multiKidNote: {
    marginTop: 12,
    textAlign: 'center',
  },
  errorText: {
    marginTop: 10,
    textAlign: 'center',
    color: colors.error,
  },
  paintingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 26,
  },
  paintingFrame: {
    width: 148,
    height: 176,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: 7,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '-2deg' }],
    shadowColor: colors.ink,
    shadowOpacity: 0.1,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 12 },
    elevation: 4,
  },
  paintingScript: {
    marginTop: 16,
    transform: [{ rotate: '-2deg' }],
  },
  paintingTitle: {
    marginTop: 20,
  },
  paintingBody: {
    marginTop: 10,
    maxWidth: 280,
    textAlign: 'center',
  },
  journalButton: {
    marginTop: 26,
  },
  retryButton: {
    marginTop: 10,
    width: 220,
  },
});
