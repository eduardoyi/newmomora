// Gallery import -- the staged progress/waiting screen. Rewritten per
// docs/plans/gallery-import-continuous.md I4a step 6 (continuous model): one
// number-led layout for every stage instead of a per-stage checklist/
// workbench, and this screen no longer drives the runner itself -- the
// app-root driver (gallery-import-driver.ts, mounted via
// useGalleryImportDriver() in app/(app)/_layout.tsx) is the only thing that
// calls resumeGalleryImportRunner now. This screen only OBSERVES (driver
// state, the live-progress bus, and its own ~8s run poll) and KICKS the
// driver for out-of-cycle attempts (retry, cellular confirm). The
// pre-run-id "pending start" bridge (gallery-import-pending-start.ts) is
// unchanged in spirit: this screen can still render the instant permission
// is granted, before a run id exists at all.
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { KeyboardStickyShell } from '@/components/keyboard-sticky-shell';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useBilling } from '@/hooks/use-billing';
import { useFamily } from '@/hooks/use-family';
import { useIsOnline } from '@/lib/connectivity';
import { newMemoryRoute } from '@/lib/routes';
import { cancelGalleryImportRun, getGalleryImportRun, type GalleryImportRun } from '@/services/gallery-import';
import {
  getGalleryImportDriverState,
  kickGalleryImportDriver,
  setGalleryImportAutoContinue,
  subscribeGalleryImportDriver,
  type GalleryImportDriverState,
} from '@/services/gallery-import-driver';
import {
  GalleryImportEmptyLibraryError,
  GalleryImportServiceRequestError,
  type GalleryImportRunnerProgress,
} from '@/services/gallery-import-runner';
import { trackEvent } from '@/services/analytics';
import { clearGalleryImportCheckpoint, clearGalleryImportPreviewCache, updateGalleryImportCheckpoint as persistCheckpointPatch } from '@/utils/gallery-import-checkpoint';
import { getGalleryImportE2eAdapter } from '@/utils/gallery-import-e2e-adapter';
import {
  clearGalleryImportLiveProgress,
  getLatestGalleryImportLiveProgress,
  subscribeGalleryImportLiveProgress,
} from '@/utils/gallery-import-live-progress';
import {
  getGalleryImportPendingStart,
  subscribeGalleryImportPendingStart,
  type GalleryImportPendingStartState,
} from '@/utils/gallery-import-pending-start';
import { beginGalleryImportPipeline } from '@/utils/gallery-import-pipeline';
import { deriveGalleryImportComingIndicator } from '@/utils/gallery-import-deck';
import { loadGalleryImportFrontier, type GalleryImportFrontier } from '@/utils/gallery-import-frontier';
import {
  deriveGalleryImportProgressOutcome,
  type GalleryImportStageKey,
} from '@/utils/gallery-import-progress-stage';
import { createExpoGalleryMediaLibraryAdapter } from '@/utils/gallery-import-scanner';
import { canEditFamilyContent } from '@/utils/roles';

import { GalleryImportEmptyOutcome } from './gallery-import-empty';
import { GalleryImportExceptionScreen } from './gallery-import-exception';
import {
  exitGalleryImportToTimeline,
  DeviceBoundNotice,
  GalleryImportProgressBar,
  GalleryImportSheet,
  GalleryImportTopBar,
  PrimaryButton,
  SecondaryButton,
  gi,
  useRunCheckpoint,
} from './gallery-import-shared';

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

function daysUntil(iso: string | null | undefined, now: Date = new Date()): number | null {
  if (!iso) return null;
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return null;
  return Math.ceil((target - now.getTime()) / (24 * 60 * 60 * 1000));
}

function formatCellularSubtitle(bytes: number | null): string {
  if (!bytes) return 'A small amount of previews.';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return 'Under 1 MB of previews.';
  return `About ${Math.max(1, Math.round(mb))} MB of previews.`;
}

interface StageDisplay {
  eyebrow: string;
  /** The one number this stage leads with. */
  title: string;
  /** A short line under the title explaining what is happening right now.
   * Only set for a few stages (scanning, sending, processing) -- see
   * describeStage. */
  context?: string;
  /** A bar shows only for the "in progress" family of stages. */
  bar: { indeterminate: boolean; value: number | null; total: number | null } | null;
  pill: 'keepOpen' | 'safeToClose' | null;
  /** True once nothing further can happen to this run. */
  terminal: boolean;
}

/** One line explaining what the pill above it means -- derived from the pill
 * kind itself rather than repeated per stage. */
function pillNoteFor(pill: StageDisplay['pill']): string | null {
  if (pill === 'keepOpen') return 'This step needs the app on screen. Your progress is saved if you leave.';
  if (pill === 'safeToClose') return 'We keep working on our own. Come back anytime.';
  return null;
}

interface StageContext {
  ready: number;
  value: number | null;
  total: number | null;
  scannedAssetCount: number | null;
  batchesWritten: number;
  batchesTotal: number;
}

function describeStage(stage: GalleryImportStageKey, ctx: StageContext): StageDisplay {
  switch (stage) {
    case 'scanning':
      return {
        eyebrow: 'Looking through your photos',
        title: ctx.scannedAssetCount ? `${ctx.scannedAssetCount} photos read` : 'Getting started',
        context: "We're grouping your photos into moments. Nothing has left your phone yet.",
        bar: { indeterminate: true, value: null, total: null },
        pill: 'keepOpen',
        terminal: false,
      };
    case 'waitingWifi':
      return {
        eyebrow: 'Waiting',
        title: 'Waiting for Wi-Fi',
        bar: null,
        pill: 'safeToClose',
        terminal: false,
      };
    // Merges the runner's former separate 'preparing' and 'uploading'
    // stages into one monotonic stage: the runner works chunk by chunk
    // (prepare chunk N, upload chunk N, prepare chunk N+1), so keeping them
    // distinct flip-flopped the screen between two eyebrows/pills every few
    // seconds. This whole stage needs the app in the foreground (native
    // preview preparation is foreground-only), so it stays 'keepOpen' for
    // its entire duration -- unlike the old 'uploading' stage, which was
    // (incorrectly) 'safeToClose'.
    case 'sending':
      return {
        eyebrow: 'Getting your suggestions ready',
        title: ctx.total ? `${ctx.value ?? 0} of ${ctx.total} previews sent` : 'Getting the previews ready',
        context: "We're receiving small photo previews so we can write captions for you. This happens in batches, you can start reviewing memories before it finishes completely.",
        bar: { indeterminate: !ctx.total, value: ctx.value, total: ctx.total },
        pill: 'keepOpen',
        terminal: false,
      };
    case 'processing':
      return {
        eyebrow: 'Writing the drafts',
        title: ctx.batchesTotal > 0
          ? `${ctx.batchesWritten} of ${ctx.batchesTotal} ${pluralize(ctx.batchesTotal, 'batch', 'batches')} written${ctx.ready > 0 ? ` · ${ctx.ready} ready` : ''}`
          : ctx.ready > 0 ? `${ctx.ready} ${pluralize(ctx.ready, 'suggestion')} ready so far` : 'Writing the first drafts',
        context: "We have your photo previews. We'll start suggesting memories to review in a bit.",
        bar: null,
        pill: 'safeToClose',
        terminal: false,
      };
    case 'interrupted':
      return {
        eyebrow: 'Picked up again',
        title: `${ctx.ready} ${pluralize(ctx.ready, 'suggestion')} ready so far`,
        bar: null,
        pill: 'safeToClose',
        terminal: false,
      };
    case 'ready':
      return {
        eyebrow: ctx.ready > 0 ? 'Ready to review' : 'All done looking',
        title: ctx.ready > 0 ? `${ctx.ready} ready to review` : 'All caught up',
        bar: null,
        pill: 'safeToClose',
        terminal: ctx.ready === 0,
      };
    case 'pausedFairUse':
      return {
        eyebrow: 'Paused for today',
        title: 'Momora will keep looking tomorrow',
        bar: null,
        pill: 'safeToClose',
        terminal: false,
      };
    case 'doneLookingMoreHistory':
      return {
        eyebrow: 'Looking further back',
        title: 'Nothing new right now',
        bar: null,
        pill: 'safeToClose',
        terminal: false,
      };
    case 'failed':
      return {
        eyebrow: 'Some of it did not finish',
        title: `${ctx.ready} ${pluralize(ctx.ready, 'suggestion')} ready`,
        bar: null,
        pill: 'safeToClose',
        terminal: false,
      };
    case 'cancelled':
      return {
        eyebrow: 'Stopped',
        title: 'Stopped and cleared',
        bar: null,
        pill: null,
        terminal: true,
      };
    case 'expired':
    default:
      return {
        eyebrow: 'Review period ended',
        title: 'These have cleared',
        bar: null,
        pill: null,
        terminal: true,
      };
  }
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
  const [hasTransientError, setHasTransientError] = useState(false);
  const [live, setLive] = useState<GalleryImportRunnerProgress | null>(routeRunId ? getLatestGalleryImportLiveProgress(routeRunId) : null);
  const [driverState, setDriverState] = useState<GalleryImportDriverState>(getGalleryImportDriverState);
  const [openSheet, setOpenSheet] = useState<'stop' | 'cellular' | null>(null);
  const [hasStoppedLookingForMore, setHasStoppedLookingForMore] = useState(false);
  const [frontier, setFrontier] = useState<GalleryImportFrontier | null>(null);
  const isMountedRef = useRef(true);

  const [pendingStart, setPendingStart] = useState<GalleryImportPendingStartState | null>(
    () => (routeRunId ? null : getGalleryImportPendingStart()),
  );
  useEffect(() => {
    if (routeRunId) return;
    setPendingStart(getGalleryImportPendingStart());
    return subscribeGalleryImportPendingStart(setPendingStart);
  }, [routeRunId]);
  useEffect(() => {
    if (!routeRunId && pendingStart?.status === 'started' && pendingStart.runId) {
      router.setParams({ runId: pendingStart.runId });
    }
  }, [routeRunId, pendingStart]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  useEffect(() => subscribeGalleryImportDriver(setDriverState), []);

  useEffect(() => {
    if (!routeRunId) { setLive(null); return; }
    setLive(getLatestGalleryImportLiveProgress(routeRunId));
    return subscribeGalleryImportLiveProgress(routeRunId, setLive);
  }, [routeRunId]);

  useEffect(() => {
    if (!userId || !familyId) { setFrontier(null); return; }
    let cancelled = false;
    void loadGalleryImportFrontier(userId, familyId).then((next) => {
      if (!cancelled) setFrontier(next);
    });
    return () => { cancelled = true; };
  }, [userId, familyId]);

  // Polls this run's own status every ~8s while mounted -- unchanged from
  // before, this is how the screen ever notices the server moved past
  // 'processing'. It no longer triggers a resume itself; the driver reacts
  // to its own tick/AppState/NetInfo signals independently.
  const refreshStatus = useCallback(async () => {
    if (!isMountedRef.current || !checkpoint || !routeRunId) return;
    const response = await getGalleryImportRun({ runId: routeRunId, runCapability: checkpoint.runCapability });
    if (!isMountedRef.current) return;
    if (response.error) { setHasTransientError(true); return; }
    setRun(response.data);
    setHasTransientError(false);
    const mappedStatus = response.data?.status === 'reviewing' ? 'reviewing' as const
      : response.data?.status === 'processing' ? 'processing' as const
      : response.data?.status === 'scanning' ? 'scanning' as const
      : null;
    if (mappedStatus && checkpoint.status !== mappedStatus && checkpoint.status !== 'paused') {
      void update((current) => (current.status === 'paused' ? current : { ...current, status: mappedStatus }));
    }
  }, [checkpoint, routeRunId, update]);
  useEffect(() => { void refreshStatus(); const timer = setInterval(() => void refreshStatus(), 8_000); return () => clearInterval(timer); }, [refreshStatus]);

  // A kick when this screen mounts on an existing run -- the driver is
  // single-flight and coalesces overlapping kicks, so this is safe even if
  // AppState/NetInfo/the tick already have one in flight.
  useEffect(() => {
    if (routeRunId) kickGalleryImportDriver('progress-screen-mount');
  }, [routeRunId]);

  const cancel = useCallback(async () => {
    if (!checkpoint || !routeRunId || !userId || !familyId) return;
    setIsCancelling(true);
    try {
      const result = await cancelGalleryImportRun({ runId: routeRunId, capability: checkpoint.runCapability });
      if (result.error) throw new Error(result.error.message);
      trackEvent('gallery_import_run_cancelled', { stage: checkpoint.status === 'scanning' ? 'scanning' : checkpoint.status === 'processing' ? 'processing' : 'reviewing' });
      await Promise.all([clearGalleryImportCheckpoint(userId, familyId, routeRunId), clearGalleryImportPreviewCache(routeRunId)]);
      clearGalleryImportLiveProgress(routeRunId);
      exitGalleryImportToTimeline();
    } catch {
      setHasTransientError(true);
    } finally {
      setIsCancelling(false);
      setOpenSheet(null);
    }
  }, [checkpoint, familyId, routeRunId, userId]);

  const stopLookingForMore = useCallback(() => {
    if (!userId || !familyId) return;
    void setGalleryImportAutoContinue(userId, familyId, false);
    setHasStoppedLookingForMore(true);
    setFrontier((current) => (current ? { ...current, autoContinue: false } : current));
  }, [familyId, userId]);
  // The persisted frontier is the source of truth across relaunches; the
  // local flag only makes the tap feel instant.
  const isStoppedLookingForMore = hasStoppedLookingForMore || frontier?.autoContinue === false;
  const keepLooking = useCallback(() => {
    if (!userId || !familyId) return;
    void setGalleryImportAutoContinue(userId, familyId, true).then(() => kickGalleryImportDriver('keep-looking'));
    setHasStoppedLookingForMore(false);
    setFrontier((current) => (current ? { ...current, autoContinue: true } : current));
  }, [familyId, userId]);

  const confirmCellular = useCallback(async () => {
    setOpenSheet(null);
    if (routeRunId) {
      // An existing checkpoint: persist the choice so the driver's own
      // later kicks (AppState/NetInfo/tick) also honor it, then ask it to
      // try again right away instead of waiting for the next automatic kick.
      if (!checkpoint || !userId || !familyId) return;
      await persistCheckpointPatch(userId, familyId, routeRunId, (current) => ({ ...current, allowCellular: true, status: current.status === 'paused' ? 'processing' : current.status }));
      kickGalleryImportDriver('cellular', { allowCellular: true });
      return;
    }
    // No run yet (the pre-run-id Wi-Fi wait): retry the whole start with
    // cellular allowed, exactly like the entry screen's own first attempt --
    // there is no checkpoint to persist this onto yet.
    if (!userId || !familyId) return;
    beginGalleryImportPipeline({ userId, familyId, useCellular: true, adapter: resolveAdapter(), permissionMode: pendingStart?.permissionMode ?? 'full' });
  }, [checkpoint, familyId, pendingStart?.permissionMode, routeRunId, userId]);

  const retry = useCallback(() => {
    setHasTransientError(false);
    kickGalleryImportDriver('retry');
  }, []);

  const retryPendingStart = useCallback(() => {
    if (!userId || !familyId) return;
    beginGalleryImportPipeline({ userId, familyId, useCellular: false, adapter: resolveAdapter(), permissionMode: pendingStart?.permissionMode ?? 'full' });
  }, [familyId, pendingStart?.permissionMode, userId]);

  // See gallery-import-shared.tsx's useRunCheckpoint doc comment -- a loaded
  // checkpoint's familyId is guaranteed to equal the *active* family at load
  // time; this only guards the active family changing later.
  const isSameFamilyContext = checkpoint?.familyId === activeFamilyId;
  const isDemoted = isSameFamilyContext && !isFamilyLoading && !canEditFamilyContent(activeRole);
  const hasWriteAccess = isSameFamilyContext ? (billing.status ? billing.status.has_write_access : null) : null;

  const readyCount = run?.readyCandidates ?? 0;
  const reviewDaysLeft = daysUntil(run?.reviewExpiresAt ?? null);

  const uploadedByteSizes = checkpoint ? checkpoint.chunks.flatMap((chunk) => chunk.previewUploads.map((upload) => upload.byteLength)) : [];
  const averageBytes = uploadedByteSizes.length > 0 ? uploadedByteSizes.reduce((sum, value) => sum + value, 0) / uploadedByteSizes.length : null;
  const pendingAssetCount = checkpoint ? Math.max(0, Object.keys(checkpoint.assetByToken).length - checkpoint.uploadedAssetTokens.length) : 0;
  const cellularSizeBytes = averageBytes && pendingAssetCount > 0 ? averageBytes * pendingAssetCount : null;

  const localPlannedClusters = checkpoint
    ? checkpoint.chunks.reduce((sum, chunk) => sum + (chunk.status === 'dispatched' || chunk.status === 'abandoned' ? 0 : chunk.clusters.length), 0)
    : 0;
  // Only chunks that never reached the server count as "couldn't be sent":
  // an abandoned chunk that already has a chunkId was registered (and
  // usually dispatched) server-side, where the reconciliation cron owns its
  // fate -- device-observed 2026-08-23 after a transient dispatch outage.
  const abandonedChunks = checkpoint ? checkpoint.chunks.filter((chunk) => chunk.status === 'abandoned' && !chunk.chunkId).length : 0;
  const batchesWritten = checkpoint ? checkpoint.chunks.filter((chunk) => chunk.status === 'dispatched').length : 0;
  const batchesTotal = checkpoint ? checkpoint.chunks.length : 0;
  const comingIndicator = deriveGalleryImportComingIndicator(run, checkpoint, frontier);
  const moreHistory = comingIndicator.kind === 'none' ? false : comingIndicator.moreHistory;
  // The driver being actively at work on THIS run, with candidates already
  // ready, is this screen's only signal that a relaunch "picked up again"
  // rather than starting fresh -- it no longer runs its own resume to know
  // that directly.
  const isResuming = driverState.isActive && driverState.runId === routeRunId;

  const cellularSheet = openSheet === 'cellular' ? (
    <GalleryImportSheet
      closeLabel="Cancel"
      footer={<View style={pg.sheetFooterStack}>
        <PrimaryButton label="Use cellular data" onPress={() => void confirmCellular()} testID="gallery-import-confirm-cellular" />
        <Text onPress={() => setOpenSheet(null)} style={pg.sheetGhostButton} testID="gallery-import-wait-for-wifi">Wait for Wi-Fi</Text>
      </View>}
      onClose={() => setOpenSheet(null)}
      subtitle={formatCellularSubtitle(cellularSizeBytes)}
      testID="gallery-import-cellular-sheet"
      title="Send over cellular data?"
    >
      <View />
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
            onClose={() => exitGalleryImportToTimeline()}
            onPrimary={() => exitGalleryImportToTimeline()}
            testID="gallery-import-progress-empty-emptyLibrary"
          />
        );
      }
      const isCapped = error instanceof GalleryImportServiceRequestError && error.code === 'not_available';
      return (
        <GalleryImportExceptionScreen
          kind={isCapped ? 'capped' : 'errorRecoverable'}
          onClose={() => exitGalleryImportToTimeline()}
          onPrimary={() => (isCapped ? exitGalleryImportToTimeline() : retryPendingStart())}
          onSecondary={() => exitGalleryImportToTimeline()}
          testID={`gallery-import-progress-exception-${isCapped ? 'capped' : 'errorRecoverable'}`}
        />
      );
    }

    const stage: GalleryImportStageKey = pendingStart.status === 'waitingWifi' ? 'waitingWifi' : 'scanning';
    const meta = describeStage(stage, {
      ready: 0, value: null, total: null,
      scannedAssetCount: pendingStart.scannedAssetCount ?? null,
      batchesWritten: 0, batchesTotal: 0,
    });
    return (
      <>
        <StageScreen
          footer={<PendingStartFooter onGoToJournal={() => exitGalleryImportToTimeline()} stage={stage} />}
          meta={meta}
          onClose={() => exitGalleryImportToTimeline()}
          onStop={undefined}
          onUseCellular={stage === 'waitingWifi' ? () => setOpenSheet('cellular') : undefined}
          scrollTestID="gallery-import-progress-scroll"
        />
        {cellularSheet}
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
    localPlannedClusters,
    abandonedChunks,
    driverPhase: driverState.phase,
    pausedUntil: checkpoint.pausedUntil ?? null,
    moreHistory,
  });

  if (outcome.kind === 'exception') {
    return (
      <GalleryImportExceptionScreen
        kind={outcome.exception}
        onClose={() => exitGalleryImportToTimeline()}
        onPrimary={() => {
          if (outcome.exception === 'lapsed') {
            router.push(billing.status?.has_ever_had_access ? { pathname: '/(onboarding)/paywall', params: { mode: 'resubscribe' } } : '/(onboarding)/paywall');
            return;
          }
          if (outcome.exception === 'errorRecoverable') { retry(); return; }
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
          exitGalleryImportToTimeline();
        }}
        onSecondary={() => exitGalleryImportToTimeline()}
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
        onClose={() => exitGalleryImportToTimeline()}
        onPrimary={() => outcome.empty === 'limitedNothing' ? router.replace('/(app)/gallery-import' as never) : router.push(newMemoryRoute())}
        onSecondary={() => exitGalleryImportToTimeline()}
        testID={`gallery-import-progress-empty-${outcome.empty}`}
      />
    );
  }

  const stage = outcome.stage;
  const meta = describeStage(stage, {
    ready: outcome.ready,
    value: outcome.value,
    total: outcome.total,
    scannedAssetCount: outcome.scannedAssetCount,
    batchesWritten,
    batchesTotal,
  });

  return (
    <>
      <StageScreen
        footer={
          <MainFooter
            hasStoppedLookingForMore={isStoppedLookingForMore}
            onKeepLooking={keepLooking}
            onBackToJournal={() => exitGalleryImportToTimeline()}
            onLookAgain={() => router.replace('/(app)/gallery-import' as never)}
            onReview={() => router.push({ pathname: '/(app)/gallery-import/review' as never, params: { runId: routeRunId } })}
            onStopLookingForMore={stopLookingForMore}
            readyCount={readyCount}
            stage={stage}
            terminal={meta.terminal}
          />
        }
        meta={meta}
        onClose={() => exitGalleryImportToTimeline()}
        onStop={meta.terminal ? undefined : () => setOpenSheet('stop')}
        onUseCellular={stage === 'waitingWifi' ? () => setOpenSheet('cellular') : undefined}
        scrollTestID="gallery-import-progress-scroll"
      >
        {abandonedChunks > 0 ? (
          <Text style={pg.abandonedLine} testID="gallery-import-abandoned-count">
            {abandonedChunks} {pluralize(abandonedChunks, 'batch', 'batches')} couldn’t be sent
          </Text>
        ) : null}
        {hasTransientError ? <Text style={pg.error} testID="gallery-import-transient-error">That last step did not go through. Worth trying again.</Text> : null}
      </StageScreen>

      {openSheet === 'stop' ? (
        <GalleryImportSheet
          closeLabel="Keep going"
          footer={<View style={pg.sheetFooterStack}>
            <SecondaryButton disabled={isCancelling} label={isCancelling ? 'Stopping…' : 'Stop and clear'} onPress={() => void cancel()} testID="gallery-import-confirm-stop" />
            <Text onPress={() => setOpenSheet(null)} style={pg.sheetGhostButton} testID="gallery-import-keep-going">Keep going</Text>
          </View>}
          onClose={() => setOpenSheet(null)}
          subtitle="Drafts clear. Kept memories stay."
          testID="gallery-import-stop-sheet"
          title="Stop looking through your photos?"
        >
          <View />
        </GalleryImportSheet>
      ) : null}

      {cellularSheet}
    </>
  );
}

// ── Footers ────────────────────────────────────────────────────────────
function PendingStartFooter({ stage, onGoToJournal }: { stage: GalleryImportStageKey; onGoToJournal: () => void }) {
  if (stage === 'waitingWifi') return null;
  return <SecondaryButton label="Back to my journal" onPress={onGoToJournal} testID="gallery-import-pending-back" />;
}

function MainFooter({
  stage, terminal, readyCount, hasStoppedLookingForMore,
  onReview, onBackToJournal, onLookAgain, onStopLookingForMore, onKeepLooking,
}: {
  stage: GalleryImportStageKey;
  terminal: boolean;
  readyCount: number;
  hasStoppedLookingForMore: boolean;
  onReview: () => void;
  onBackToJournal: () => void;
  onLookAgain: () => void;
  onStopLookingForMore: () => void;
  onKeepLooking: () => void;
}) {
  return (
    <>
      {readyCount > 0 ? (
        <PrimaryButton label={`Review ${readyCount} ${pluralize(readyCount, 'suggestion')}`} onPress={onReview} testID="gallery-import-review" />
      ) : terminal ? (
        <PrimaryButton
          label={stage === 'expired' ? 'Look through my photos again' : 'Back to my journal'}
          onPress={stage === 'expired' ? onLookAgain : onBackToJournal}
          testID={stage === 'expired' ? 'gallery-import-look-again' : 'gallery-import-back-to-journal'}
        />
      ) : null}
      {!terminal ? (
        hasStoppedLookingForMore ? (
          <>
            <Text style={pg.stoppedLine} testID="gallery-import-stopped-looking-note">Momora will finish what it has and stop there.</Text>
            <Pressable accessibilityRole="button" onPress={onKeepLooking} testID="gallery-import-keep-looking">
              <Text style={pg.ghostLink}>Keep looking</Text>
            </Pressable>
          </>
        ) : (
          <Pressable accessibilityRole="button" onPress={onStopLookingForMore} testID="gallery-import-stop-looking-for-more">
            <Text style={pg.ghostLink}>Stop looking for more</Text>
          </Pressable>
        )
      ) : null}
    </>
  );
}

// ── Shared stage chrome ──────────────────────────────────────────────────
interface StageScreenProps {
  meta: StageDisplay;
  footer: ReactNode;
  onClose: () => void;
  onStop: (() => void) | undefined;
  onUseCellular: (() => void) | undefined;
  scrollTestID: string;
  children?: ReactNode;
}

function StageScreen({ meta, footer, onClose, onStop, onUseCellular, scrollTestID, children }: StageScreenProps) {
  return (
    <KeyboardStickyShell
      contentContainerStyle={pg.scrollContent}
      footer={<View style={pg.footerStack}>{footer}</View>}
      footerStyle={[gi.stickyFooterSurface, pg.actionBar]}
      footerTestID="gallery-import-progress-footer"
      header={(
        <GalleryImportTopBar
          left="Close"
          onLeft={onClose}
          right={onStop ? (
            <Text onPress={onStop} style={pg.stopButton} testID="gallery-import-stop">Stop</Text>
          ) : undefined}
          testID="gallery-import-progress-close"
        />
      )}
      safeAreaStyle={pg.screen}
      scrollTestID={scrollTestID}
      testID="gallery-import-progress"
    >
      <View style={pg.header}>
        <Text style={pg.eyebrow}>{meta.eyebrow}</Text>
        <Text style={pg.title}>{meta.title}</Text>
        {meta.context ? <Text style={pg.context}>{meta.context}</Text> : null}
      </View>

      {meta.bar ? (
        <View style={pg.barWrap}>
          <GalleryImportProgressBar indeterminate={meta.bar.indeterminate} total={meta.bar.total ?? undefined} value={meta.bar.value ?? undefined} />
        </View>
      ) : null}

      {meta.pill ? (
        <>
          <View style={[pg.pill, meta.pill === 'keepOpen' ? pg.pillKeepOpen : pg.pillSafe]}>
            <Text style={[pg.pillText, meta.pill === 'keepOpen' ? pg.pillTextKeepOpen : pg.pillTextSafe]}>
              {meta.pill === 'keepOpen' ? 'Keep Momora open' : 'Safe to close'}
            </Text>
          </View>
          {pillNoteFor(meta.pill) ? <Text style={pg.pillNote}>{pillNoteFor(meta.pill)}</Text> : null}
        </>
      ) : null}

      {onUseCellular ? (
        <Pressable accessibilityRole="button" onPress={onUseCellular} testID="gallery-import-stage-action-Use cellular data instead">
          <Text style={pg.ghostLink}>Use cellular data instead</Text>
        </Pressable>
      ) : null}

      {children}
    </KeyboardStickyShell>
  );
}

const pg = StyleSheet.create({
  screen: { backgroundColor: colors.bg, flex: 1 },
  center: { alignItems: 'center', backgroundColor: colors.bg, flex: 1, justifyContent: 'center' },
  scrollContent: { paddingBottom: spacing.xl, paddingTop: 4 },
  stopButton: { color: colors.ink3, fontFamily: fonts.sansBold, fontSize: 14, paddingVertical: 10 },
  header: { paddingHorizontal: spacing.lg, paddingTop: 24 },
  eyebrow: { color: colors.ink3, fontFamily: fonts.sansBold, fontSize: 11, letterSpacing: 1.4, textTransform: 'uppercase' },
  title: { color: colors.ink, fontFamily: fonts.display, fontSize: 34, lineHeight: 38, marginTop: 10 },
  context: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 14.5, lineHeight: 22, marginTop: 12 },
  barWrap: { paddingHorizontal: spacing.lg, paddingTop: 24 },
  pill: { alignSelf: 'flex-start', borderRadius: radius.pill, marginHorizontal: spacing.lg, marginTop: 20, paddingHorizontal: 14, paddingVertical: 8 },
  pillKeepOpen: { backgroundColor: colors.sunSoft },
  pillSafe: { backgroundColor: colors.seaSoft },
  pillText: { fontFamily: fonts.sansBold, fontSize: 12.5 },
  pillTextKeepOpen: { color: colors.sunInk },
  pillTextSafe: { color: colors.seaInk },
  pillNote: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 12, marginHorizontal: spacing.lg, marginTop: 6 },
  ghostLink: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 13.5, marginTop: 20, paddingHorizontal: spacing.lg, textAlign: 'center' },
  abandonedLine: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 12.5, marginTop: 20, paddingHorizontal: spacing.lg, textAlign: 'center' },
  error: { color: colors.error, fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 18, marginTop: 12, paddingHorizontal: spacing.lg },
  footerStack: { gap: 8 },
  stoppedLine: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 12.5, textAlign: 'center' },
  actionBar: { gap: 8 },
  sheetFooterStack: { gap: 8 },
  sheetGhostButton: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 13, paddingVertical: 8, textAlign: 'center' },
});
