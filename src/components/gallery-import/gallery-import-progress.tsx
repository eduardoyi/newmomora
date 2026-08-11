// Gallery import -- the staged progress/waiting screen (design: gi-progress.jsx
// GIProgressScreen + GI_STAGE, gi-shared.jsx's progress/checklist/safe-to-close
// primitives). Rebuilt per the approved gallery-import fix plan: real counts
// from the runner's live progress instead of a hard-coded 44/72/100% bar, the
// full 4-step checklist and workbench visual, a designed Stop-confirm sheet
// instead of a native Alert, a cellular-confirm sheet that resumes the
// runner in place -- the "Use cellular data instead" choice no longer bounces
// through the entry screen and loses itself -- and a "pending start" render
// path (gallery-import-pending-start.ts) so this screen can mount and show a
// live scanning stage the instant permission is granted, before a run id
// exists at all. The whole screen is wrapped in KeyboardStickyShell (safe
// area + real scrolling + a solid sticky footer) exactly like the entry
// screen, instead of a bare View with an absolutely-positioned action bar.
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

import { KeyboardStickyShell } from '@/components/keyboard-sticky-shell';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useBilling } from '@/hooks/use-billing';
import { useFamily } from '@/hooks/use-family';
import { useIsOnline } from '@/lib/connectivity';
import { newMemoryRoute } from '@/lib/routes';
import { cancelGalleryImportRun, getGalleryImportRun, type GalleryImportRun } from '@/services/gallery-import';
import {
  GalleryImportEmptyLibraryError,
  GalleryImportServiceRequestError,
  GalleryImportWaitingForWifiError,
  resumeGalleryImportRunner,
  type GalleryImportRunnerProgress,
} from '@/services/gallery-import-runner';
import { trackEvent } from '@/services/analytics';
import { clearGalleryImportCheckpoint, clearGalleryImportPreviewCache } from '@/utils/gallery-import-checkpoint';
import { getGalleryImportE2eAdapter } from '@/utils/gallery-import-e2e-adapter';
import {
  clearGalleryImportLiveProgress,
  getLatestGalleryImportLiveProgress,
  isGalleryImportRunnerActive,
  markGalleryImportRunnerActive,
  markGalleryImportRunnerInactive,
  publishGalleryImportLiveProgress,
  subscribeGalleryImportLiveProgress,
} from '@/utils/gallery-import-live-progress';
import {
  getGalleryImportPendingStart,
  subscribeGalleryImportPendingStart,
  type GalleryImportPendingStartState,
} from '@/utils/gallery-import-pending-start';
import { beginGalleryImportPipeline } from '@/utils/gallery-import-pipeline';
import { deriveGalleryImportComingIndicator, type GalleryImportComingIndicator } from '@/utils/gallery-import-deck';
import {
  deriveGalleryImportProgressOutcome,
  type GalleryImportStageKey,
} from '@/utils/gallery-import-progress-stage';
import { createExpoGalleryMediaLibraryAdapter } from '@/utils/gallery-import-scanner';
import { canEditFamilyContent } from '@/utils/roles';

import { GalleryImportEmptyOutcome } from './gallery-import-empty';
import { GalleryImportExceptionScreen } from './gallery-import-exception';
import {
  DeviceBoundNotice,
  GalleryImportFact,
  GalleryImportProgressBar,
  GalleryImportReassure,
  GalleryImportSheet,
  GalleryImportTopBar,
  PrimaryButton,
  SecondaryButton,
  gi,
  useRunCheckpoint,
} from './gallery-import-shared';

const GI_STEPS = ['Looking through your photos', 'Preparing small previews', 'Writing the drafts', 'Ready to review'];

// Device-tested finding: users thought they had to sit on this exact screen
// and watch the bar. Folded onto the end of the stage hint (rendered inside
// the existing safe-to-close card) for every stage that keeps working while
// Momora stays open -- scanning/preparing/uploading/processing -- never the
// waiting/terminal stages, where the card already says something more
// specific. Deliberately silent about closing the *app*: that distinction is
// the title/hint's job (see describeStage below), and this line only says
// you don't have to watch *this screen*, so the two never contradict.
const GALLERY_IMPORT_LEAVE_HINT = 'Feel free to check your journal while it works.';

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

function daysUntil(iso: string | null | undefined, now: Date = new Date()): number | null {
  if (!iso) return null;
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return null;
  return Math.ceil((target - now.getTime()) / (24 * 60 * 60 * 1000));
}

function formatBytesApprox(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return 'under 1 MB';
  return `about ${Math.max(1, Math.round(mb))} MB`;
}

interface StageMeta {
  step: number;
  eyebrow: string;
  tone: 'primary' | 'sun' | 'error';
  title: string;
  body: string;
  stat: string;
  indeterminate: boolean;
  done: boolean;
  paused: boolean;
  safeToClose: boolean;
  hint: string;
  actions?: Array<{ label: string; kind: 'primary' | 'secondary'; onPress: () => void }>;
}

interface StageContext {
  ready: number;
  value: number | null;
  total: number | null;
  scannedAssetCount: number | null;
  reviewDaysLeft: number | null;
  /** Round 4: server truth (run status + pendingClusters), never the local
   * checkpoint plan -- see gallery-import-deck.ts's
   * deriveGalleryImportComingIndicator. The run flips to 'reviewing' the
   * moment the first chunk lands, so this is the only honest way for the
   * 'ready' stage to know whether "all done looking" is true yet
   * (device-tested finding: 10 candidates staged, 51 clusters still
   * processing, screen falsely claimed every step was complete -- and later,
   * round 4: the local plan itself went stale after a resume and showed a
   * phantom "+51 coming" that never resolved). */
  coming: GalleryImportComingIndicator;
  onUseCellular: () => void;
  onTryAgain: () => void;
  onLookAgain: () => void;
  onGoToJournal: () => void;
}

/** design: gi-progress.jsx GI_STAGE, translated to real (never fixture)
 * counts. `paused` (a user-initiated "carry on later" stop, distinct from
 * `waitingWifi`) has no trigger in this codebase -- there is no standalone
 * pause feature, only the Wi-Fi wait -- so it is defined for completeness but
 * never emitted by deriveGalleryImportProgressOutcome. */
function describeStage(stage: GalleryImportStageKey, ctx: StageContext): StageMeta {
  switch (stage) {
    case 'scanning':
      return {
        step: 0, eyebrow: 'Step 1 of 3', tone: 'primary',
        title: 'Looking through\nyour photos.',
        body: 'Reading dates and grouping photos into events. This part happens entirely on your phone.',
        stat: ctx.scannedAssetCount ? `${ctx.scannedAssetCount} photos so far` : 'Getting started',
        indeterminate: true, done: false, paused: false, safeToClose: false,
        hint: `Keep Momora open for another moment; this part needs the app awake. ${GALLERY_IMPORT_LEAVE_HINT}`,
      };
    case 'preparing':
      return {
        step: 1, eyebrow: 'Step 2 of 3', tone: 'primary',
        title: 'Preparing small\npreviews.',
        body: 'Making thumbnail-sized copies of the photos Momora is considering. Your originals are untouched.',
        stat: ctx.total ? `${ctx.value ?? 0} of ${ctx.total} previews ready` : 'Getting the previews ready',
        indeterminate: !ctx.total, done: false, paused: false, safeToClose: false,
        hint: `This is the part that uses your battery. A minute or two, usually. ${GALLERY_IMPORT_LEAVE_HINT}`,
      };
    case 'waitingWifi':
      return {
        step: 1, eyebrow: 'Waiting', tone: 'sun',
        title: 'Waiting for\nWi-Fi.',
        body: 'The previews are ready and waiting. Momora sends them on Wi-Fi by default to keep off your data plan.',
        stat: 'Ready to send whenever you are',
        indeterminate: false, done: false, paused: true, safeToClose: true,
        hint: 'It will carry on by itself the moment you are on Wi-Fi.',
        actions: [{ label: 'Use cellular data instead', kind: 'secondary', onPress: ctx.onUseCellular }],
      };
    case 'uploading':
      return {
        step: 1, eyebrow: 'Step 2 of 3', tone: 'primary',
        title: 'Sending the\npreviews.',
        body: 'Small copies are on their way to Momora. Full-size photos stay here.',
        stat: ctx.total ? `${ctx.value ?? 0} of ${ctx.total} previews sent` : 'Sending previews',
        indeterminate: !ctx.total, done: false, paused: false, safeToClose: true,
        hint: `It picks up right where it left off. ${GALLERY_IMPORT_LEAVE_HINT}`,
      };
    case 'processing':
      return {
        step: 2, eyebrow: 'Step 3 of 3', tone: 'primary',
        title: 'Writing the\ndrafts.',
        body: 'Momora is choosing which photos tell each story and writing a caption for you to edit.',
        stat: ctx.ready > 0 ? `${ctx.ready} ${pluralize(ctx.ready, 'suggestion')} ready so far` : 'Working on the first suggestions',
        indeterminate: true, done: false, paused: false, safeToClose: true,
        hint: `The rest will be waiting when you open it again. ${GALLERY_IMPORT_LEAVE_HINT}`,
      };
    case 'interrupted':
      return {
        step: 2, eyebrow: 'Picked up again', tone: 'primary',
        title: 'Carrying on\nwhere it stopped.',
        body: 'Momora closed before this finished. Nothing was lost; it started again from the last event it completed.',
        stat: `${ctx.ready} ${pluralize(ctx.ready, 'suggestion')} safe so far`,
        indeterminate: true, done: false, paused: false, safeToClose: true,
        hint: 'Closing the app, restarting your phone, losing signal: all fine. Your place is always saved.',
      };
    case 'ready': {
      // Candidates stream progressively -- the server marks the run
      // 'reviewing' the instant the *first* chunk finishes, while later
      // chunks can still be minutes of AI processing away. `stillComing > 0`
      // means this is only a partial result: "All done looking" and a fully
      // ticked checklist (including "Writing the drafts") would be false.
      // "Writing the drafts" is shown as the current step (bold ring, not a
      // check) via `step: 2` below -- reusing StepRow's existing
      // done/active states rather than inventing a third visual -- and
      // "Ready to review" stays an untouched future step, since the run as a
      // whole has not actually finished looking yet.
      const partial = ctx.coming.kind !== 'none';
      // ready === 0 only reaches this stage when the run is terminal and
      // everything was reviewed (non-terminal zero-ready maps to
      // 'processing' in deriveGalleryImportProgressOutcome) -- "0 moments,
      // ready for you." is never an honest headline (device-observed).
      if (ctx.ready === 0) {
        return {
          step: 3, eyebrow: 'All done looking', tone: 'primary',
          title: 'All caught\nup.',
          body: 'You have looked at every suggestion from this pass. Kept memories are in your journal.',
          stat: 'Nothing left to review',
          indeterminate: false, done: true, paused: false, safeToClose: false,
          hint: '',
          actions: [{ label: 'Go to my journal', kind: 'primary', onPress: ctx.onGoToJournal }],
        };
      }
      return {
        step: partial ? 2 : 3,
        eyebrow: partial ? 'First moments are ready' : 'All done looking',
        tone: 'primary',
        title: `${ctx.ready} ${pluralize(ctx.ready, 'moment')},\nready for you.`,
        body: partial
          ? 'Nothing has been added to your journal yet. Keep the ones you want, set the rest aside, and more will keep arriving while you do.'
          : 'Nothing has been added to your journal yet. Keep the ones you want; set the rest aside.',
        stat: ctx.reviewDaysLeft && ctx.reviewDaysLeft > 0
          ? `Yours to review for the next ${ctx.reviewDaysLeft} ${pluralize(ctx.reviewDaysLeft, 'day')}`
          : 'Yours to review, no rush',
        indeterminate: partial, done: !partial, paused: false, safeToClose: true,
        hint: partial
          ? 'The rest will keep arriving while you review. Nothing to wait for.'
          : 'No rush. Your place is saved between visits.',
      };
    }
    case 'paused':
      return {
        step: 1, eyebrow: 'Paused', tone: 'sun',
        title: 'Paused.',
        body: 'Nothing is happening until you say so.',
        stat: 'Waiting',
        indeterminate: false, done: false, paused: true, safeToClose: true,
        hint: 'Your camera roll is untouched, as always.',
      };
    case 'failed':
      return {
        step: 2, eyebrow: 'Something did not finish', tone: 'sun',
        title: 'That did not\nfinish.',
        body: 'Momora could not finish the last few events. The suggestions it already made are safe and ready to review.',
        stat: `${ctx.ready} ${pluralize(ctx.ready, 'suggestion')} ready`,
        indeterminate: false, done: false, paused: false, safeToClose: true,
        hint: 'Nothing was added to your journal, and your camera roll is untouched.',
        actions: [{ label: 'Try the rest again', kind: 'secondary', onPress: ctx.onTryAgain }],
      };
    case 'cancelled':
      return {
        step: 0, eyebrow: 'Stopped', tone: 'primary',
        title: 'Stopped, and\ncleared.',
        body: 'Momora stopped looking. The previews it had made were cleared, and the drafts are gone. Anything you already kept is still in your journal.',
        stat: 'Everything else cleared',
        indeterminate: false, done: true, paused: false, safeToClose: true,
        hint: 'Your camera roll was never changed.',
      };
    case 'expired':
    default:
      return {
        step: 3, eyebrow: 'Review period ended', tone: 'primary',
        title: 'These have\ncleared.',
        body: 'Suggestions clear automatically after their review window. Anything you kept is in your journal.',
        stat: 'Cleared',
        indeterminate: false, done: true, paused: false, safeToClose: true,
        hint: 'You can look through your photos again whenever you like.',
        actions: [{ label: 'Look through my photos again', kind: 'secondary', onPress: ctx.onLookAgain }],
      };
  }
}

/** A quiet visual of prints being sorted (design: gi-progress.jsx GIWorkbench)
 * -- theme-tinted placeholder blocks, no photo content (none exists yet at
 * this stage). Breathes gently while work is active; sits still once done. */
function ProgressWorkbench({ idle }: { idle: boolean }) {
  // One shared breathe value drives every block -- same opacity-breathe
  // primitive as import-drawer.tsx's IndeterminateBar and this file's own
  // GalleryImportProgressBar (this repo's reanimated Jest mock has no
  // `interpolate`/`withSequence`, so a translating sweep is not available).
  const opacity = useSharedValue(idle ? 1 : 0.55);
  useEffect(() => {
    if (idle) { opacity.value = 1; return; }
    opacity.value = withRepeat(withTiming(1, { duration: 900 }), -1, true);
  }, [idle, opacity]);
  const animatedStyle = useAnimatedStyle(() => ({ opacity: idle ? 1 : opacity.value }));
  const heights = [40, 54, 66, 48, 36, 30];
  const tints = [colors.primaryTint, colors.seaSoft, colors.sunSoft, colors.primaryTint, colors.seaSoft, colors.sunSoft];
  return (
    <View style={pg.workbench} testID="gallery-import-progress-workbench">
      {heights.map((height, index) => (
        <Animated.View
          key={index}
          style={[
            pg.workbenchBlock,
            { height, backgroundColor: tints[index % tints.length], transform: [{ rotate: `${(index % 2 ? 1 : -1) * (idle ? 0 : 1.2)}deg` }] },
            animatedStyle,
          ]}
        />
      ))}
    </View>
  );
}

function StepRow({ label, done, active, isLast }: { label: string; done: boolean; active: boolean; isLast: boolean }) {
  return (
    <View style={pg.stepRow}>
      <View style={pg.stepMarkerColumn}>
        <View style={[pg.stepDot, done && pg.stepDotDone, active && !done && pg.stepDotActive]}>
          {done ? <Text style={pg.stepDotCheck}>✓</Text> : null}
        </View>
        {!isLast ? <View style={[pg.stepConnector, done && pg.stepConnectorDone]} /> : null}
      </View>
      <Text style={[pg.stepLabel, done && pg.stepLabelDone, active && !done && pg.stepLabelActive]}>{label}</Text>
    </View>
  );
}

interface StageScreenProps {
  stage: GalleryImportStageKey;
  meta: StageMeta;
  progressValue: number | null;
  progressTotal: number | null;
  showStop: boolean;
  onStop: () => void;
  onClose: () => void;
  onOpenPrivacy: () => void;
  hasTransientError: boolean;
  footer: ReactNode;
  scrollTestID: string;
  topBarTestID: string;
}

/** The whole scrollable body + sticky footer for a single stage, shared by
 * both the pending-start (no run id yet) and normal (run id known) render
 * paths so they stay visually identical. Wrapped in KeyboardStickyShell for
 * real top/bottom safe-area handling and actual scrolling on a short
 * viewport -- the previous bare `View` + absolutely-positioned action bar
 * let the Stop button clip under the status bar and made tall content
 * unreachable (device-tested finding). */
function StageScreen({ stage, meta, progressValue, progressTotal, showStop, onStop, onClose, onOpenPrivacy, hasTransientError, footer, scrollTestID, topBarTestID }: StageScreenProps) {
  const toneColor = meta.tone === 'sun' ? colors.sunInk : meta.tone === 'error' ? colors.error : colors.primary;
  // USER DECISION: the "Safe to close Momora" card no longer appears on the
  // ready stage (partial or fully done) -- once there is something to
  // review, "safe to close" reads as filler, not information. It still
  // appears on every in-progress stage (scanning/preparing/uploading/
  // processing/etc.), where it is the only place that reassurance lives.
  const showSafeCard = stage !== 'ready';
  return (
    <KeyboardStickyShell
      contentContainerStyle={pg.scrollContent}
      footer={footer}
      footerStyle={[gi.stickyFooterSurface, pg.actionBar]}
      footerTestID="gallery-import-progress-footer"
      header={(
        <GalleryImportTopBar
          left="Close"
          onLeft={onClose}
          right={showStop ? (
            <Text onPress={onStop} style={pg.stopButton} testID="gallery-import-stop">Stop</Text>
          ) : undefined}
          testID={topBarTestID}
        />
      )}
      safeAreaStyle={pg.screen}
      scrollTestID={scrollTestID}
      testID="gallery-import-progress"
    >
      <View style={pg.header}>
        <Text style={[pg.eyebrow, { color: toneColor }]}>{meta.eyebrow}</Text>
        <Text style={pg.title}>{meta.title}</Text>
        <Text style={pg.body}>{meta.body}</Text>
      </View>

      <ProgressWorkbench idle={meta.done || meta.paused} />

      <View style={pg.statWrap}>
        <Text style={pg.stat}>{meta.stat}</Text>
        {!meta.done && !meta.paused ? (
          <GalleryImportProgressBar indeterminate={meta.indeterminate} tone={toneColor} total={progressTotal ?? undefined} value={progressValue ?? undefined} />
        ) : null}
        {meta.paused ? <View style={pg.pausedTrack} /> : null}
      </View>

      <View style={pg.steps}>
        {GI_STEPS.map((label, index) => (
          <StepRow active={index === meta.step && !meta.done} done={index < meta.step || meta.done} isLast={index === GI_STEPS.length - 1} key={label} label={label} />
        ))}
      </View>

      <View style={pg.safeSection}>
        {showSafeCard ? (
          <View style={[pg.safeCard, { backgroundColor: meta.safeToClose ? colors.seaSoft : colors.surface }]}>
            <Text style={[pg.safeTitle, { color: meta.safeToClose ? colors.seaInk : colors.ink }]}>
              {meta.safeToClose ? 'Safe to close Momora. Your place is saved.' : 'Please keep Momora open'}
            </Text>
            <Text style={[pg.safeBody, { color: meta.safeToClose ? colors.seaInk : colors.ink2 }]}>{meta.hint}</Text>
          </View>
        ) : null}
        {/* The camera-roll reassure line was removed from this screen by user
            decision (2026-08-11) -- the trust explainer already carries it. */}
        {/* design: gi-progress.jsx ~L184-187 -- grouped with the safe-to-close/
            reassure cluster, styled as a clearly-tappable row (not dangling
            underlined text at the very bottom of the screen). */}
        <Pressable
          accessibilityRole="button"
          hitSlop={4}
          onPress={onOpenPrivacy}
          style={pg.privacyLinkRow}
          testID="gallery-import-privacy-link"
        >
          <Text style={pg.privacyLinkText}>What Momora sends, and for how long</Text>
          <Text style={pg.privacyLinkChevron}>›</Text>
        </Pressable>
        {hasTransientError ? <Text style={pg.error} testID="gallery-import-transient-error">That last step did not go through. Your place is saved, and this is worth trying again.</Text> : null}
      </View>
    </KeyboardStickyShell>
  );
}

function stageActionBar({ stage, meta, readyCount, onReview, onBackToJournal }: {
  stage: GalleryImportStageKey;
  meta: StageMeta;
  readyCount: number;
  onReview: () => void;
  onBackToJournal: () => void;
}): ReactNode {
  const showActionBar = stage === 'ready' || Boolean(meta.actions?.length) || meta.done;
  if (!showActionBar) return undefined;
  return (
    <>
      {stage === 'ready' ? (
        <PrimaryButton
          label={readyCount > 0 ? `Start reviewing · ${readyCount} ready` : 'Review your suggestions'}
          onPress={onReview}
          testID="gallery-import-review"
        />
      ) : stage === 'failed' && readyCount > 0 ? (
        // Round 4 audit finding: a partial failure with real ready
        // candidates had only "Try the rest again" -- no way to reach the
        // suggestions already sitting in the deck from this screen (the
        // drawer's own CTA already routes straight to the deck whenever
        // readyCandidates > 0, but this screen is reachable on its own too,
        // e.g. a run that fails while already being watched here).
        <PrimaryButton label={`Review ${readyCount} ${pluralize(readyCount, 'suggestion')}`} onPress={onReview} testID="gallery-import-review" />
      ) : meta.done && !meta.actions?.length ? (
        <PrimaryButton label="Back to my journal" onPress={onBackToJournal} testID="gallery-import-back-to-journal" />
      ) : null}
      {(meta.actions ?? []).map((action) => (
        action.kind === 'primary'
          ? <PrimaryButton key={action.label} label={action.label} onPress={action.onPress} testID={`gallery-import-stage-action-${action.label}`} />
          : <SecondaryButton key={action.label} label={action.label} onPress={action.onPress} testID={`gallery-import-stage-action-${action.label}`} />
      ))}
    </>
  );
}

function resolveAdapter() {
  return getGalleryImportE2eAdapter() ?? createExpoGalleryMediaLibraryAdapter();
}

export function GalleryImportProgress({ runId: routeRunId }: { runId?: string }) {
  const { checkpoint, isLoading, update, userId, familyId } = useRunCheckpoint(routeRunId);
  const { role: activeRole, familyId: activeFamilyId, isLoading: isFamilyLoading } = useFamily();
  const billing = useBilling();
  const isOffline = !useIsOnline();

  const [run, setRun] = useState<GalleryImportRun | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const [hasTransientError, setHasTransientError] = useState(false);
  const [live, setLive] = useState<GalleryImportRunnerProgress | null>(routeRunId ? getLatestGalleryImportLiveProgress(routeRunId) : null);
  const [openSheet, setOpenSheet] = useState<'stop' | 'cellular' | 'privacy' | null>(null);
  const isMountedRef = useRef(true);
  const autoResumeAttemptedForRunIdRef = useRef<string | null>(null);

  // A run that was asked to start but has no id yet -- see
  // gallery-import-pending-start.ts and gallery-import-entry.tsx, which
  // navigates here the instant permission is granted, before any of
  // scan/Wi-Fi-check/createGalleryImportRun has finished.
  const [pendingStart, setPendingStart] = useState<GalleryImportPendingStartState | null>(
    () => (routeRunId ? null : getGalleryImportPendingStart()),
  );
  useEffect(() => {
    if (routeRunId) return;
    setPendingStart(getGalleryImportPendingStart());
    return subscribeGalleryImportPendingStart(setPendingStart);
  }, [routeRunId]);
  // Adopt a freshly-known run id into the route the moment one exists, so a
  // relaunch/resume/back-navigation behaves exactly like any other run --
  // this component keeps rendering the pending-start bridge view below until
  // `routeRunId` itself updates on the next render.
  useEffect(() => {
    if (!routeRunId && pendingStart?.status === 'started' && pendingStart.runId) {
      router.setParams({ runId: pendingStart.runId });
    }
  }, [routeRunId, pendingStart]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Live scanning/preparing/uploading/dispatching counts, published by
  // whichever call (entry's start pipeline, or this screen's own resume) is
  // actually driving the runner right now -- see gallery-import-live-progress.ts.
  useEffect(() => {
    if (!routeRunId) { setLive(null); return; }
    setLive(getLatestGalleryImportLiveProgress(routeRunId));
    return subscribeGalleryImportLiveProgress(routeRunId, setLive);
  }, [routeRunId]);

  // Polls this run's own status every ~8s while mounted -- this is the
  // mechanism that lets the screen ever notice the server moved past
  // 'processing' (device-bound: the run's own capability, same call
  // useGalleryImportEntryStatus's glyph/drawer polling makes, just on this
  // screen's own tighter interval instead of that hook's on-focus staleTime).
  // Root cause of the "never transitions to ready" bug was NOT a missing
  // poll -- this effect already ran -- it was deriveGalleryImportProgressOutcome
  // checking a stale `live.stage === 'dispatching'` snapshot before ever
  // looking at the (correctly updating) server status; see
  // gallery-import-progress-stage.ts for the fix.
  const refreshStatus = useCallback(async () => {
    if (!isMountedRef.current || !checkpoint || !routeRunId) return;
    const response = await getGalleryImportRun({ runId: routeRunId, runCapability: checkpoint.runCapability });
    if (!isMountedRef.current) return;
    if (response.error) { setHasTransientError(true); return; }
    setRun(response.data);
    setHasTransientError(false);
    // Keep the local checkpoint's own status field in step with what the
    // server just confirmed, so other consumers of the checkpoint (the
    // Timeline glyph/drawer's resume-vs-ready branch, this screen's own
    // Stop-sheet analytics label, a later resume) agree with what this
    // screen is showing instead of reading a value frozen at run creation.
    const mappedStatus = response.data?.status === 'reviewing' ? 'reviewing' as const
      : response.data?.status === 'processing' ? 'processing' as const
      : response.data?.status === 'scanning' ? 'scanning' as const
      : null;
    if (mappedStatus && checkpoint.status !== mappedStatus && checkpoint.status !== 'paused') {
      void update((current) => (current.status === 'paused' ? current : { ...current, status: mappedStatus }));
    }
  }, [checkpoint, routeRunId, update]);
  useEffect(() => { void refreshStatus(); const timer = setInterval(() => void refreshStatus(), 8_000); return () => clearInterval(timer); }, [refreshStatus]);

  // Auto-resume after a relaunch. Deliberately keyed off *whether a
  // checkpoint has loaded yet*, not the checkpoint object itself: the resume
  // mutates the checkpoint dozens of times as it runs, and re-running this
  // effect on every one of those mutations would tear down and re-queue the
  // in-flight promise's cleanup, silently dropping its eventual result. The
  // `autoResumeAttemptedForRunIdRef` guard additionally makes this a true
  // once-per-runId attempt even across unrelated re-renders.
  const hasCheckpoint = Boolean(checkpoint);
  useEffect(() => {
    if (!checkpoint || !routeRunId || !userId || !familyId) return;
    if (checkpoint.status === 'paused') return;
    if (checkpoint.chunks.every((chunk) => chunk.status === 'dispatched')) return;
    if (autoResumeAttemptedForRunIdRef.current === routeRunId) return;
    if (isGalleryImportRunnerActive(routeRunId)) return;
    autoResumeAttemptedForRunIdRef.current = routeRunId;
    let cancelled = false;
    setIsResuming(true);
    markGalleryImportRunnerActive(routeRunId);
    resumeGalleryImportRunner({
      userId, familyId, runId: routeRunId,
      onProgress: (progress) => publishGalleryImportLiveProgress(routeRunId, progress),
    })
      .then(() => { if (cancelled) return; setHasTransientError(false); void refreshStatus(); })
      .catch((caught) => {
        if (cancelled) return;
        if (caught instanceof GalleryImportWaitingForWifiError) void update((current) => ({ ...current, status: 'paused' }));
        else setHasTransientError(true);
      })
      .finally(() => { markGalleryImportRunnerInactive(routeRunId); if (!cancelled) setIsResuming(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above: intentionally not keyed to `checkpoint`/`refreshStatus`/`update` identities.
  }, [hasCheckpoint, routeRunId, userId, familyId]);

  const cancel = useCallback(async () => {
    if (!checkpoint || !routeRunId || !userId || !familyId) return;
    setIsCancelling(true);
    try {
      const result = await cancelGalleryImportRun({ runId: routeRunId, capability: checkpoint.runCapability });
      if (result.error) throw new Error(result.error.message);
      trackEvent('gallery_import_run_cancelled', { stage: checkpoint.status === 'scanning' ? 'scanning' : checkpoint.status === 'processing' ? 'processing' : 'reviewing' });
      await Promise.all([clearGalleryImportCheckpoint(userId, familyId, routeRunId), clearGalleryImportPreviewCache(routeRunId)]);
      clearGalleryImportLiveProgress(routeRunId);
      router.replace('/(app)/(tabs)/timeline');
    } catch {
      setHasTransientError(true);
    } finally {
      setIsCancelling(false);
      setOpenSheet(null);
    }
  }, [checkpoint, familyId, routeRunId, userId]);

  const confirmCellular = useCallback(async () => {
    setOpenSheet(null);
    if (routeRunId) {
      // A run already exists: resume it in place with cellular allowed.
      if (!checkpoint || !userId || !familyId) return;
      await update((current) => ({ ...current, status: 'processing' }));
      setIsResuming(true);
      markGalleryImportRunnerActive(routeRunId);
      try {
        await resumeGalleryImportRunner({
          userId, familyId, runId: routeRunId, allowCellular: true,
          onProgress: (progress) => publishGalleryImportLiveProgress(routeRunId, progress),
        });
        setHasTransientError(false);
        await refreshStatus();
      } catch (caught) {
        if (caught instanceof GalleryImportWaitingForWifiError) await update((current) => ({ ...current, status: 'paused' }));
        else setHasTransientError(true);
      } finally {
        markGalleryImportRunnerInactive(routeRunId);
        setIsResuming(false);
      }
      return;
    }
    // No run yet (the pre-run-id Wi-Fi wait): retry the whole start with
    // cellular allowed, exactly like the entry screen's own first attempt.
    if (!userId || !familyId) return;
    beginGalleryImportPipeline({ userId, familyId, useCellular: true, adapter: resolveAdapter(), permissionMode: pendingStart?.permissionMode ?? 'full' });
  }, [checkpoint, familyId, pendingStart?.permissionMode, refreshStatus, routeRunId, update, userId]);

  const retryFailed = useCallback(() => {
    autoResumeAttemptedForRunIdRef.current = null;
    setHasTransientError(false);
    void refreshStatus();
  }, [refreshStatus]);

  const retryPendingStart = useCallback(() => {
    if (!userId || !familyId) return;
    beginGalleryImportPipeline({ userId, familyId, useCellular: false, adapter: resolveAdapter(), permissionMode: pendingStart?.permissionMode ?? 'full' });
  }, [familyId, pendingStart?.permissionMode, userId]);

  // A loaded checkpoint's own `.familyId` is guaranteed to equal the *active*
  // family: useRunCheckpoint (gallery-import-shared.tsx) loads it from
  // AsyncStorage keyed by the current useFamily().familyId in the first
  // place, so a checkpoint saved under a different (or since-lost) family
  // simply never loads here at all -- it renders DeviceBoundNotice instead,
  // before any of this runs. That also means a true "removed from this run's
  // family" case can't be distinguished from "wrong device"/"no checkpoint"
  // this way; there is no separate `removed` branch below for that reason
  // (see the design's GI_STATES.removed, which this screen cannot reach).
  // `isSameFamilyContext` only guards the rarer case of the *active* family
  // changing later, while this checkpoint (already in React state) still
  // refers to the family it was loaded under.
  const isSameFamilyContext = checkpoint?.familyId === activeFamilyId;
  const isDemoted = isSameFamilyContext && !isFamilyLoading && !canEditFamilyContent(activeRole);
  const hasWriteAccess = isSameFamilyContext ? (billing.status ? billing.status.has_write_access : null) : null;

  const readyCount = run?.readyCandidates ?? 0;
  const reviewDaysLeft = daysUntil(run?.reviewExpiresAt ?? null);

  const uploadedByteSizes = checkpoint ? checkpoint.chunks.flatMap((chunk) => chunk.previewUploads.map((upload) => upload.byteLength)) : [];
  const averageBytes = uploadedByteSizes.length > 0 ? uploadedByteSizes.reduce((sum, value) => sum + value, 0) / uploadedByteSizes.length : null;
  const pendingAssetCount = checkpoint ? Math.max(0, Object.keys(checkpoint.assetByToken).length - checkpoint.uploadedAssetTokens.length) : 0;
  const cellularSizeEstimate = averageBytes && pendingAssetCount > 0 ? formatBytesApprox(averageBytes * pendingAssetCount) : null;

  const cellularSheet = openSheet === 'cellular' ? (
    <GalleryImportSheet
      closeLabel="Cancel"
      footer={<View style={pg.sheetFooterStack}>
        <PrimaryButton label="Use cellular data" onPress={() => void confirmCellular()} testID="gallery-import-confirm-cellular" />
        <Text onPress={() => setOpenSheet(null)} style={pg.sheetGhostButton} testID="gallery-import-wait-for-wifi">Wait for Wi-Fi</Text>
      </View>}
      onClose={() => setOpenSheet(null)}
      subtitle={cellularSizeEstimate ? `${cellularSizeEstimate}, roughly a couple of photos.` : 'A small amount of data, roughly a couple of photos.'}
      testID="gallery-import-cellular-sheet"
      title="Send over cellular data?"
    >
      <View style={pg.sheetBody}>
        <Text style={pg.sheetParagraph}>
          Momora waits for Wi-Fi by default so a large first look never eats your data plan. If you would rather not wait, it will send now and remember this choice for now.
        </Text>
        <View style={pg.reassureWrap}>
          <GalleryImportReassure>Only the small previews are sent. Full-size photos are only sent for memories you keep.</GalleryImportReassure>
        </View>
      </View>
    </GalleryImportSheet>
  ) : null;

  const privacySheet = openSheet === 'privacy' ? (
    <GalleryImportSheet onClose={() => setOpenSheet(null)} testID="gallery-import-privacy-sheet" title="What Momora sends">
      <View style={pg.sheetFacts}>
        <GalleryImportFact icon="image" title="Small previews, now">Thumbnail-sized copies go to Momora’s private storage, which we’ll use to write captions for your memories.</GalleryImportFact>
        <GalleryImportFact icon="check" title="Full-size photos, only when you keep one">Nothing full-size is sent until you approve a suggestion.</GalleryImportFact>
        <GalleryImportFact icon="trash" title="Cleared automatically">Sooner if you finish or stop. Location data is stripped from anything saved.</GalleryImportFact>
        <GalleryImportFact icon="x" title="Never sent">Names, ages, relationships, location, file names, or anything already written in Momora.</GalleryImportFact>
      </View>
    </GalleryImportSheet>
  ) : null;

  if (isLoading) return <View style={pg.center}><ActivityIndicator color={colors.primary} /></View>;

  // ── Pending-start: no run id in the route yet ──────────────────────
  if (!routeRunId) {
    if (!pendingStart) {
      return <DeviceBoundNotice extraAction={{ label: 'Look through this phone’s photos', onPress: () => router.replace('/(app)/gallery-import' as never) }} />;
    }

    if (pendingStart.status === 'failed') {
      const error = pendingStart.error;
      if (error instanceof GalleryImportEmptyLibraryError) {
        return (
          <GalleryImportEmptyOutcome
            kind="emptyLibrary"
            onClose={() => router.replace('/(app)/(tabs)/timeline')}
            onPrimary={() => router.replace('/(app)/(tabs)/timeline')}
            testID="gallery-import-progress-empty-emptyLibrary"
          />
        );
      }
      const isCapped = error instanceof GalleryImportServiceRequestError && error.code === 'not_available';
      return (
        <GalleryImportExceptionScreen
          kind={isCapped ? 'capped' : 'errorRecoverable'}
          onClose={() => router.replace('/(app)/(tabs)/timeline')}
          onPrimary={() => (isCapped ? router.replace('/(app)/(tabs)/timeline') : retryPendingStart())}
          onSecondary={() => router.replace('/(app)/(tabs)/timeline')}
          testID={`gallery-import-progress-exception-${isCapped ? 'capped' : 'errorRecoverable'}`}
        />
      );
    }

    // 'starting' (fresh scan, no run yet), 'waitingWifi' (pre-run-id Wi-Fi
    // wait), and the brief 'started' bridge (waiting for `routeRunId` itself
    // to catch up via router.setParams) all render the same staged screen a
    // real run would -- the design's own `scanning`/`waitingWifi` stages.
    const stage: GalleryImportStageKey = pendingStart.status === 'waitingWifi' ? 'waitingWifi' : 'scanning';
    const meta = describeStage(stage, {
      ready: 0, value: null, total: null,
      scannedAssetCount: pendingStart.scannedAssetCount ?? null,
      reviewDaysLeft: null,
      // Neither 'scanning' nor 'waitingWifi' (the only stages reachable
      // here, before a run id even exists) reads `coming`.
      coming: { kind: 'unknown' },
      onUseCellular: () => setOpenSheet('cellular'),
      onTryAgain: () => undefined,
      onLookAgain: () => undefined,
      onGoToJournal: () => undefined,
    });
    return (
      <>
        <StageScreen
          footer={stageActionBar({ stage, meta, readyCount: 0, onReview: () => undefined, onBackToJournal: () => router.replace('/(app)/(tabs)/timeline') })}
          hasTransientError={false}
          meta={meta}
          onClose={() => router.replace('/(app)/(tabs)/timeline')}
          onOpenPrivacy={() => setOpenSheet('privacy')}
          onStop={() => undefined}
          progressTotal={null}
          progressValue={null}
          scrollTestID="gallery-import-progress-scroll"
          showStop={false}
          stage={stage}
          topBarTestID="gallery-import-progress-close"
        />
        {cellularSheet}
        {privacySheet}
      </>
    );
  }

  if (!checkpoint) {
    return <DeviceBoundNotice extraAction={{ label: 'Look through this phone’s photos', onPress: () => router.replace('/(app)/gallery-import' as never) }} />;
  }

  const outcome = deriveGalleryImportProgressOutcome({
    checkpointStatus: checkpoint.status,
    deckCursor: checkpoint.deckCursor,
    serverStatus: run?.status ?? null,
    readyCount,
    hasWriteAccess,
    isDemoted,
    isOffline,
    live,
    isResuming,
    permissionMode: checkpoint.permissionMode ?? null,
    hasTransientError,
  });

  if (outcome.kind === 'exception') {
    return (
      <GalleryImportExceptionScreen
        kind={outcome.exception}
        onClose={() => router.replace('/(app)/(tabs)/timeline')}
        onPrimary={() => {
          if (outcome.exception === 'lapsed') {
            router.push(billing.status?.has_ever_had_access ? { pathname: '/(onboarding)/paywall', params: { mode: 'resubscribe' } } : '/(onboarding)/paywall');
            return;
          }
          if (outcome.exception === 'errorRecoverable') { retryFailed(); return; }
          if (outcome.exception === 'errorFinal') {
            void (async () => {
              if (userId && familyId && routeRunId) {
                await Promise.all([clearGalleryImportCheckpoint(userId, familyId, routeRunId), clearGalleryImportPreviewCache(routeRunId)]);
                clearGalleryImportLiveProgress(routeRunId);
              }
              router.replace('/(app)/gallery-import' as never);
            })();
            return;
          }
          router.replace('/(app)/(tabs)/timeline');
        }}
        onSecondary={() => router.replace('/(app)/(tabs)/timeline')}
        readyCount={readyCount}
        reviewDaysLeft={reviewDaysLeft}
        testID={`gallery-import-progress-exception-${outcome.exception}`}
      />
    );
  }

  if (outcome.kind === 'empty') {
    return (
      <GalleryImportEmptyOutcome
        kind={outcome.empty}
        onClose={() => router.replace('/(app)/(tabs)/timeline')}
        onPrimary={() => outcome.empty === 'limitedNothing' ? router.replace('/(app)/gallery-import' as never) : router.push(newMemoryRoute())}
        onSecondary={() => router.replace('/(app)/(tabs)/timeline')}
        testID={`gallery-import-progress-empty-${outcome.empty}`}
      />
    );
  }

  const stage = outcome.stage;
  // Round 4: server truth, not the local checkpoint plan -- see the
  // GalleryImportComingIndicator field doc above.
  const coming = deriveGalleryImportComingIndicator(run);
  const meta = describeStage(stage, {
    ready: outcome.ready,
    value: outcome.value,
    total: outcome.total,
    scannedAssetCount: outcome.scannedAssetCount,
    reviewDaysLeft,
    coming,
    onUseCellular: () => setOpenSheet('cellular'),
    onTryAgain: retryFailed,
    onLookAgain: () => router.replace('/(app)/gallery-import' as never),
    onGoToJournal: () => router.replace('/(app)/(tabs)/timeline' as never),
  });

  return (
    <>
      <StageScreen
        footer={stageActionBar({
          stage, meta, readyCount,
          onReview: () => router.push({ pathname: '/(app)/gallery-import/review' as never, params: { runId: routeRunId } }),
          onBackToJournal: () => router.replace('/(app)/(tabs)/timeline'),
        })}
        hasTransientError={hasTransientError}
        meta={meta}
        onClose={() => router.replace('/(app)/(tabs)/timeline')}
        onOpenPrivacy={() => setOpenSheet('privacy')}
        onStop={() => setOpenSheet('stop')}
        progressTotal={outcome.total}
        progressValue={outcome.value}
        scrollTestID="gallery-import-progress-scroll"
        showStop={!meta.done}
        stage={stage}
        topBarTestID="gallery-import-progress-close"
      />

      {openSheet === 'stop' ? (
        <GalleryImportSheet
          closeLabel="Keep going"
          footer={<View style={pg.sheetFooterStack}>
            <SecondaryButton disabled={isCancelling} label={isCancelling ? 'Stopping…' : 'Stop and clear the drafts'} onPress={() => void cancel()} testID="gallery-import-confirm-stop" />
            <Text onPress={() => setOpenSheet(null)} style={pg.sheetGhostButton} testID="gallery-import-keep-going">Keep going</Text>
          </View>}
          onClose={() => setOpenSheet(null)}
          subtitle="Nothing you have already kept is affected."
          testID="gallery-import-stop-sheet"
          title="Stop looking through your photos?"
        >
          <View style={pg.sheetFacts}>
            <GalleryImportFact icon="check" title="Kept memories stay">Anything you have already kept remains in your journal.</GalleryImportFact>
            <GalleryImportFact icon="trash" title="Drafts and previews are cleared">Every preview Momora made is removed from its storage.</GalleryImportFact>
            <GalleryImportFact icon="image" title="Your camera roll is untouched">It always was. Stopping changes nothing about your photos.</GalleryImportFact>
            <GalleryImportFact icon="refresh" title="You can start again later">A new look through your photos will not re-suggest anything you set aside.</GalleryImportFact>
          </View>
        </GalleryImportSheet>
      ) : null}

      {cellularSheet}
      {privacySheet}
    </>
  );
}

const pg = StyleSheet.create({
  screen: { backgroundColor: colors.bg, flex: 1 },
  center: { alignItems: 'center', backgroundColor: colors.bg, flex: 1, justifyContent: 'center' },
  // Real bottom padding beyond this is computed by KeyboardStickyShell itself
  // (from the footer's measured height) -- this is only the resting cushion
  // below the last content block once the scroll reaches its end.
  scrollContent: { paddingBottom: spacing.lg, paddingTop: 4 },
  stopButton: { color: colors.ink3, fontFamily: fonts.sansBold, fontSize: 14, paddingVertical: 10 },
  header: { paddingHorizontal: spacing.lg, paddingTop: 8 },
  eyebrow: { fontFamily: fonts.sansBold, fontSize: 10, letterSpacing: 1.4, textTransform: 'uppercase' },
  // Reserved to the tallest realistic case (3 rendered lines) so switching
  // stages -- titles alternate between explicit 2-line strings that word-wrap
  // to 2 or 3 rendered lines depending on device width -- never shifts the
  // rest of the screen vertically (device-tested finding).
  title: { color: colors.ink, fontFamily: fonts.display, fontSize: 34, lineHeight: 38, marginTop: 12, minHeight: 38 * 3 },
  body: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 14.5, lineHeight: 22, marginTop: 14, minHeight: 22 * 3 },
  workbench: { alignItems: 'flex-end', backgroundColor: colors.white, borderColor: colors.border, borderRadius: radius.xl, borderWidth: 1, flexDirection: 'row', gap: 7, marginHorizontal: spacing.lg, marginTop: 22, overflow: 'hidden', padding: 14 },
  workbenchBlock: { borderRadius: 8, flex: 1 },
  statWrap: { paddingHorizontal: spacing.lg, paddingTop: 18 },
  stat: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 13, marginBottom: 9 },
  pausedTrack: { backgroundColor: colors.border, borderRadius: 999, height: 6 },
  steps: { paddingHorizontal: spacing.lg, paddingTop: 22 },
  stepRow: { flexDirection: 'row', gap: 12, paddingBottom: 14 },
  stepMarkerColumn: { alignItems: 'center', flexShrink: 0 },
  stepDot: { alignItems: 'center', backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 9, borderWidth: 1.5, height: 18, justifyContent: 'center', width: 18 },
  stepDotDone: { backgroundColor: colors.primary, borderWidth: 0 },
  stepDotActive: { backgroundColor: colors.white, borderColor: colors.primary },
  stepDotCheck: { color: colors.white, fontSize: 10, fontWeight: '700' },
  stepConnector: { backgroundColor: colors.border, flex: 1, marginTop: 3, minHeight: 16, width: 1.5 },
  stepConnectorDone: { backgroundColor: colors.primarySoft },
  stepLabel: { color: colors.ink3, fontFamily: fonts.sansMedium, fontSize: 13.5, marginTop: -1 },
  stepLabelDone: { color: colors.ink2 },
  stepLabelActive: { color: colors.ink, fontFamily: fonts.sansBold },
  safeSection: { paddingHorizontal: spacing.lg, paddingTop: 6 },
  safeCard: { borderRadius: radius.lg, padding: 14 },
  safeTitle: { fontFamily: fonts.sansBold, fontSize: 13 },
  safeBody: { fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 18, marginTop: 3, opacity: 0.9 },
  reassureWrap: { marginTop: 14 },
  // A clearly-tappable row (background card + trailing chevron), grouped
  // right after the safe-to-close/reassure cluster -- not underlined text
  // dangling alone at the bottom of the screen.
  privacyLinkRow: {
    alignItems: 'center', backgroundColor: colors.surface, borderRadius: radius.md, flexDirection: 'row',
    justifyContent: 'space-between', marginTop: 14, minHeight: 44, paddingHorizontal: 14, paddingVertical: 12,
  },
  privacyLinkText: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 12.5 },
  privacyLinkChevron: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 16 },
  error: { color: colors.error, fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 18, marginTop: 12 },
  // The solid background + hairline top border live in the shared
  // `gi.stickyFooterSurface` (composed in via `footerStyle` above) -- this
  // is only the element spacing within the footer stack.
  actionBar: { gap: 8 },
  sheetFooterStack: { gap: 8 },
  sheetGhostButton: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 13, paddingVertical: 8, textAlign: 'center' },
  sheetFacts: { gap: 14, paddingBottom: 20, paddingHorizontal: spacing.lg, paddingTop: 16 },
  sheetBody: { paddingBottom: 20, paddingHorizontal: spacing.lg, paddingTop: 16 },
  sheetParagraph: { color: colors.ink, fontFamily: fonts.sans, fontSize: 14, lineHeight: 22 },
});
