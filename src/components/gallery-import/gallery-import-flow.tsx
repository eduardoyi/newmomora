import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { KeyboardStickyShell } from '@/components/keyboard-sticky-shell';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import {
  beginGalleryImportApproval,
  cancelGalleryImportRun,
  completeGalleryImportRun,
  finalizeGalleryImportCandidate,
  getGalleryImportCandidates,
  getGalleryImportRun,
  getGalleryImportApprovalUploadUrl,
  recordGalleryImportApprovalUpload,
  setGalleryImportCandidateSkip,
  updateGalleryImportCandidate,
  type GalleryImportCandidate,
} from '@/services/gallery-import';
import {
  GalleryImportWaitingForWifiError,
  galleryImportRunnerErrorMessage,
  resumeGalleryImportRunner,
  startGalleryImportRunner,
  type GalleryImportRunnerProgress,
} from '@/services/gallery-import-runner';
import { uploadToPresignedUrl } from '@/services/media';
import { trackEvent } from '@/services/analytics';
import {
  clearGalleryImportCheckpoint,
  clearGalleryImportPreviewCache,
  loadLatestGalleryImportCheckpoint,
  loadGalleryImportCheckpoint,
  updateGalleryImportCheckpoint,
  type GalleryImportApprovalOutboxItem,
  type GalleryImportCheckpoint,
} from '@/utils/gallery-import-checkpoint';
import { getGalleryImportOriginalUpload } from '@/utils/gallery-import-original';
import { getGalleryImportE2eAdapter } from '@/utils/gallery-import-e2e-adapter';
import {
  createExpoGalleryMediaLibraryAdapter,
  getGalleryPhotoPermissionState,
  type GalleryMediaLibraryAdapter,
  type GalleryPhotoPermissionState,
} from '@/utils/gallery-import-scanner';
import { canEditFamilyContent } from '@/utils/roles';

const CONSENT_COPY = 'Momora reads photo dates on this device, then sends small private previews to Momora and its AI partner to suggest moments. Full-size photos are uploaded only when you keep a memory. Momora never changes your camera roll.';
const GALLERY_IMPORT_CAPTION_MAX_LENGTH = 1_000;
export const GALLERY_IMPORT_APPROVAL_STEP_TIMEOUT_MS = 30_000;
export const GALLERY_IMPORT_APPROVAL_BUDGET_MS = 2 * 60_000;

class GalleryImportApprovalTimeoutError extends Error {
  constructor() {
    super('Saving this memory paused before it could finish. Check your connection and try again.');
  }
}

type GalleryImportApprovalStage = 'Preparing selected photo' | 'Securing approval' | 'Secure upload request' | 'Uploading selected photo' | 'Confirming secure upload' | 'Finishing memory';

function galleryImportApprovalStageError(stage: GalleryImportApprovalStage | null, error: unknown): string {
  const message = humanError(error);
  return stage ? `${stage}: ${message}` : message;
}

async function withGalleryImportApprovalDeadline<T>(
  operation: () => Promise<T>,
  deadlineAtMs: number,
): Promise<T> {
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) throw new GalleryImportApprovalTimeoutError();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new GalleryImportApprovalTimeoutError()),
          Math.min(GALLERY_IMPORT_APPROVAL_STEP_TIMEOUT_MS, remainingMs),
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isValidCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function humanError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Something went wrong. Please try again.';
}

function Header({ title, onBack }: { title: string; onBack?: () => void }) {
  return (
    <View style={styles.header}>
      <Pressable accessibilityLabel="Go back" accessibilityRole="button" hitSlop={12} onPress={onBack ?? (() => router.back())} testID="gallery-import-back">
        <Text style={styles.back}>‹</Text>
      </Pressable>
      <Text style={styles.headerTitle}>{title}</Text>
      <View style={styles.headerSpacer} />
    </View>
  );
}

function PrimaryButton({ label, onPress, disabled, testID }: { label: string; onPress: () => void; disabled?: boolean; testID: string }) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.primaryButton, (disabled || pressed) && styles.buttonPressed]} testID={testID}><Text style={styles.primaryButtonText}>{label}</Text></Pressable>;
}

function SecondaryButton({ label, onPress, testID, disabled }: { label: string; onPress: () => void; testID: string; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.secondaryButton, (disabled || pressed) && styles.buttonPressed]} testID={testID}><Text style={styles.secondaryButtonText}>{label}</Text></Pressable>;
}

export function GalleryImportEntry({ surface = 'settings' }: { surface?: 'offer' | 'settings' | 'timeline' | 'glyph' }) {
  const { user } = useAuth();
  const { familyId, role } = useFamily();
  const [permission, setPermission] = useState<GalleryPhotoPermissionState | null>(null);
  const [progress, setProgress] = useState<GalleryImportRunnerProgress | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [useCellular, setUseCellular] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resumableRunId, setResumableRunId] = useState<string | null>(null);
  const canStart = canEditFamilyContent(role);

  useEffect(() => { trackEvent('gallery_import_opened', { surface }); }, [surface]);
  useEffect(() => {
    if (!canStart) return;
    const adapter = getGalleryImportE2eAdapter() ?? createExpoGalleryMediaLibraryAdapter();
    void adapter.getPermission().then((response) => setPermission(getGalleryPhotoPermissionState(response))).catch(() => undefined);
  }, [canStart]);
  useEffect(() => {
    if (!user?.id || !familyId || !canStart) return;
    void loadLatestGalleryImportCheckpoint(user.id, familyId)
      .then((checkpoint) => setResumableRunId(checkpoint?.runId ?? null));
  }, [canStart, familyId, user?.id]);

  const chooseMorePhotos = useCallback(async () => {
    const adapter = getGalleryImportE2eAdapter() ?? createExpoGalleryMediaLibraryAdapter();
    await adapter.presentPermissionPicker?.();
    const response = await adapter.getPermission();
    setPermission(getGalleryPhotoPermissionState(response));
  }, []);
  const openDeviceSettings = useCallback(() => { void Linking.openSettings(); }, []);

  const requestPermissionThenStart = useCallback(async () => {
    if (!user || !familyId || !canStart || isStarting) return;
    if (resumableRunId) {
      router.replace({ pathname: '/(app)/gallery-import/progress' as never, params: { runId: resumableRunId } });
      return;
    }
    setError(null);
    setIsStarting(true);
    try {
      const adapter = getGalleryImportE2eAdapter() ?? createExpoGalleryMediaLibraryAdapter();
      let response = await adapter.getPermission();
      let state = getGalleryPhotoPermissionState(response);
      if (state === 'denied') {
        response = await adapter.requestPermission();
        state = getGalleryPhotoPermissionState(response);
      }
      setPermission(state);
      trackEvent('gallery_import_permission_resolved', { outcome: state });
      if (state === 'blocked') {
        setError('Photo access is off for Momora. You can change it in your device settings, then try again.');
        return;
      }
      if (state === 'denied') {
        setError('Photo access was not granted. Momora cannot look through your photos without it.');
        return;
      }
      const result = await startGalleryImportRunner({
        userId: user.id,
        familyId,
        useCellular,
        adapter,
        onProgress: setProgress,
      });
      trackEvent('gallery_import_run_started', {
        permission_mode: state,
        scanned_asset_count: result.scannedAssetCount,
        cluster_count: result.clusterCount,
      });
      router.replace({ pathname: '/(app)/gallery-import/progress' as never, params: { runId: result.runId } });
    } catch (caught) {
      if (caught instanceof GalleryImportWaitingForWifiError) {
        setError(caught.message);
        setUseCellular(true);
      } else {
        setError(galleryImportRunnerErrorMessage(caught));
      }
    } finally {
      setIsStarting(false);
    }
  }, [canStart, familyId, isStarting, resumableRunId, useCellular, user]);

  const stageCopy = progress ? {
    scanning: ['Looking through your photos.', 'Reading dates and gently grouping events on this phone.'],
    preparing: ['Preparing small previews.', 'Making small copies; your originals stay untouched.'],
    uploading: ['Sending the previews.', 'Small copies are going to Momora and its AI partner.'],
    dispatching: ['Writing the drafts.', 'Momora is selecting moments worth your time.'],
  }[progress.stage] : null;

  return (
    <KeyboardStickyShell
      safeAreaStyle={styles.screen}
      contentContainerStyle={styles.entryContent}
      footer={<View style={styles.footerStack}>
        <PrimaryButton label={isStarting ? 'Working…' : resumableRunId ? 'Continue import' : useCellular ? 'Use cellular data' : 'Look through my photos'} onPress={() => void requestPermissionThenStart()} disabled={!canStart || isStarting} testID="gallery-import-start" />
        <Pressable accessibilityRole="button" onPress={() => router.back()} testID="gallery-import-not-now"><Text style={styles.ghostButton}>Maybe later</Text></Pressable>
        <Text style={styles.footerHint}>You can start this any time from Settings.</Text>
      </View>}
      footerTestID="gallery-import-entry-footer"
      scrollTestID="gallery-import-entry-scroll"
      testID="gallery-import-entry"
    >
      <Header title="From your photos" />
      <Text style={styles.eyebrow}>Before you start writing</Text>
      <Text style={styles.display}>Some of it is{`\n`}already on{`\n`}<Text style={styles.displayAccent}>your phone.</Text></Text>
      <Text style={styles.body}>Momora can look through the photos you already have and suggest a handful of moments worth keeping. You decide which ones become memories.</Text>
      <View style={styles.printStack} accessibilityLabel="A stack of family photo prints">
        <View style={[styles.print, styles.printBackOne]} />
        <View style={[styles.print, styles.printBackTwo]} />
        <View style={styles.printFront}><View style={styles.photoPlaceholder}><Text style={styles.placeholderSun}>✦</Text></View><View style={styles.thumbRow}>{[0, 1, 2, 3].map((index) => <View key={index} style={styles.thumb} />)}</View></View>
      </View>
      <Fact title="It looks for events, not good photos" body="Days with a lot going on, grouped the way you would remember them." />
      <Fact title="Nothing is deleted or tidied up" body="Momora only reads your library. Your camera roll stays exactly as it is." />
      <Fact title="Nothing is added without you" body="You look at each suggestion and keep only the ones you want." />
      <View style={styles.consent}><Text style={styles.consentTitle}>What Momora sends</Text><Text style={styles.consentBody}>{CONSENT_COPY}</Text><Text style={styles.consentBody}>Momora suggests photos only for now.</Text></View>
      {stageCopy ? <View style={styles.statusCard}><ActivityIndicator color={colors.sea} /><Text style={styles.statusEyebrow}>{progress?.stage === 'dispatching' ? 'Step 3 of 3' : 'Working'}</Text><Text style={styles.statusTitle}>{stageCopy[0]}</Text><Text style={styles.statusBody}>{stageCopy[1]}</Text><Text style={styles.statusBody}>{progress?.completed} of {progress?.total}</Text></View> : null}
      {permission === 'limited' ? <Text style={styles.note}>Momora will only look at the photos you allowed. You can choose more for a future import.</Text> : null}
      {permission === 'limited' ? <Pressable accessibilityRole="button" onPress={() => void chooseMorePhotos()} testID="gallery-import-choose-more"><Text style={styles.managePhotos}>Choose more photos</Text></Pressable> : null}
      {permission === 'blocked' ? <Pressable accessibilityRole="button" onPress={openDeviceSettings} testID="gallery-import-open-settings"><Text style={styles.managePhotos}>Open device settings</Text></Pressable> : null}
      {!canStart ? <Text style={styles.error}>Only a family owner or manager can start a gallery import.</Text> : null}
      {error ? <View style={styles.errorCard}><Text style={styles.error}>{error}</Text></View> : null}
    </KeyboardStickyShell>
  );
}

function Fact({ title, body }: { title: string; body: string }) {
  return <View style={styles.fact}><View style={styles.factMark}><Text style={styles.factMarkText}>✓</Text></View><View style={styles.factCopy}><Text style={styles.factTitle}>{title}</Text><Text style={styles.factBody}>{body}</Text></View></View>;
}

function useRunCheckpoint(runId: string | undefined) {
  const { user } = useAuth();
  const { familyId } = useFamily();
  const userId = user?.id ?? null;
  const [checkpoint, setCheckpoint] = useState<GalleryImportCheckpoint | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const refresh = useCallback(async () => {
    if (!userId || !familyId || !runId) { setCheckpoint(null); setIsLoading(false); return null; }
    setIsLoading(true);
    const next = await loadGalleryImportCheckpoint(userId, familyId, runId);
    setCheckpoint(next);
    setIsLoading(false);
    return next;
  }, [familyId, runId, userId]);
  const update = useCallback(async (updater: (current: GalleryImportCheckpoint) => GalleryImportCheckpoint) => {
    if (!userId || !familyId || !runId) return null;
    const next = await updateGalleryImportCheckpoint(userId, familyId, runId, updater);
    if (next) setCheckpoint(next);
    return next;
  }, [familyId, runId, userId]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { checkpoint, isLoading, refresh, update, userId, familyId };
}

export function GalleryImportProgress({ runId }: { runId?: string }) {
  const { checkpoint, isLoading, userId, familyId } = useRunCheckpoint(runId);
  const [serverStatus, setServerStatus] = useState<string | null>(null);
  const [readyCount, setReadyCount] = useState(0);
  const [isCancelling, setIsCancelling] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const refreshStatus = useCallback(async () => {
    if (!isMountedRef.current || !checkpoint || !runId) return;
    const response = await getGalleryImportRun({ runId, runCapability: checkpoint.runCapability });
    if (!isMountedRef.current) return;
    if (response.error) { setStatusError(response.error.message); return; }
    setServerStatus(response.data?.status ?? null);
    setReadyCount(response.data?.readyCandidates ?? 0);
  }, [checkpoint, runId]);
  useEffect(() => { void refreshStatus(); const timer = setInterval(() => void refreshStatus(), 10_000); return () => clearInterval(timer); }, [refreshStatus]);
  useEffect(() => {
    if (!checkpoint || !runId || !userId || !familyId || checkpoint.chunks.every((chunk) => chunk.status === 'dispatched')) return;
    void resumeGalleryImportRunner({ userId, familyId, runId })
      .then(() => void refreshStatus())
      .catch((caught) => setStatusError(humanError(caught)));
  }, [checkpoint, familyId, runId, userId, refreshStatus]);

  const cancel = async () => {
    if (!checkpoint || !runId || !userId || !familyId) return;
    setIsCancelling(true);
    try {
      const result = await cancelGalleryImportRun({ runId, capability: checkpoint.runCapability });
      if (result.error) throw new Error(result.error.message);
      trackEvent('gallery_import_run_cancelled', { stage: checkpoint.status === 'scanning' ? 'scanning' : checkpoint.status === 'paused' ? 'processing' : 'reviewing' });
      await Promise.all([clearGalleryImportCheckpoint(userId, familyId, runId), clearGalleryImportPreviewCache(runId)]);
      router.replace('/(app)/(tabs)/timeline');
    } catch (caught) { setStatusError(humanError(caught)); } finally { setIsCancelling(false); }
  };
  if (isLoading) return <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>;
  if (!checkpoint) return <DeviceBoundNotice />;
  if (serverStatus === 'expired') return <TerminalImportNotice title="This review window has closed." body="The small previews and unfinished suggestions have been cleared. Your camera roll was never changed." testID="gallery-import-expired-back" />;
  if (serverStatus === 'failed') return <TerminalImportNotice title="This import is no longer available." body="Your family access or import eligibility changed before it finished. Nothing was added to your journal." testID="gallery-import-access-lost-back" />;
  const isReady = readyCount > 0 || serverStatus === 'reviewing';
  const isWaiting = checkpoint.status === 'paused';
  return <SafeAreaView style={styles.screen}><Header title="From your photos" /><ScrollView contentContainerStyle={[styles.progressContent, { paddingBottom: insets.bottom + 124 }]}><Text style={styles.eyebrow}>{isReady ? 'Ready when you are' : isWaiting ? 'Waiting for Wi‑Fi' : 'Step 3 of 3'}</Text><Text style={styles.display}>{isReady ? 'Moments,\nready for you.' : isWaiting ? 'Waiting for\nWi‑Fi.' : 'Writing the\ndrafts.'}</Text><Text style={styles.body}>{isReady ? 'Nothing has been added to your journal yet. Keep the moments you want; set the rest aside.' : isWaiting ? 'Previews are checkpointed. Choose cellular data on this device to continue.' : 'Momora is selecting a small set of moments and drafting captions. You can come back to this screen.'}</Text><View style={styles.progressTrack}><View style={[styles.progressFill, { width: isReady ? '100%' : isWaiting ? '44%' : '72%' }]} /></View><View style={styles.safeCard}><Text style={styles.safeTitle}>{checkpoint.status === 'scanning' ? 'Please keep Momora open' : 'Your place is saved'}</Text><Text style={styles.safeText}>{checkpoint.status === 'scanning' ? 'Photo scanning runs in the foreground. If Momora closes, it can resume from a checkpoint.' : 'Closing Momora pauses this work safely. It does not promise that uploads or scanning continue after the app is killed.'}</Text></View>{statusError ? <Text style={styles.error}>{statusError}</Text> : null}</ScrollView><View style={[styles.fixedActions, { paddingBottom: insets.bottom + spacing.sm }]}>{isReady ? <PrimaryButton label={`Review suggestions${readyCount ? ` · ${readyCount} ready` : ''}`} onPress={() => router.push({ pathname: '/(app)/gallery-import/review' as never, params: { runId } })} testID="gallery-import-review" /> : isWaiting ? <PrimaryButton label="Use cellular data" onPress={() => router.replace('/(app)/gallery-import' as never)} testID="gallery-import-use-cellular" /> : <SecondaryButton label="Check again" onPress={() => void refreshStatus()} testID="gallery-import-refresh" />}<Pressable onPress={() => Alert.alert('Stop looking through your photos?', 'Drafts and small previews will be cleared. Your camera roll and any kept memories are untouched.', [{ text: 'Keep going', style: 'cancel' }, { text: isCancelling ? 'Stopping…' : 'Stop and clear drafts', style: 'destructive', onPress: () => void cancel() }])} testID="gallery-import-cancel"><Text style={styles.ghostButton}>Stop this import</Text></Pressable></View></SafeAreaView>;
}

function DeviceBoundNotice() { return <SafeAreaView style={styles.screen}><Header title="From your photos" /><View style={styles.empty}><Text style={styles.displaySmall}>Open this on the device that started it.</Text><Text style={styles.body}>Suggestions stay connected to the originals in that device’s photo library, so another device cannot review or approve them.</Text><PrimaryButton label="Back to my journal" onPress={() => router.replace('/(app)/(tabs)/timeline')} testID="gallery-import-device-bound-back" /></View></SafeAreaView>; }

function TerminalImportNotice({ title, body, testID }: { title: string; body: string; testID: string }) { return <SafeAreaView style={styles.screen}><Header title="From your photos" /><View style={styles.empty}><Text style={styles.displaySmall}>{title}</Text><Text style={styles.body}>{body}</Text><PrimaryButton label="Back to my journal" onPress={() => router.replace('/(app)/(tabs)/timeline')} testID={testID} /></View></SafeAreaView>; }

export function GalleryImportReview({ runId }: { runId?: string }) {
  const { checkpoint, isLoading, update: updateCheckpoint, userId, familyId } = useRunCheckpoint(runId);
  const [candidates, setCandidates] = useState<GalleryImportCandidate[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isActioning, setIsActioning] = useState(false);
  const actionInFlightRef = useRef(false);
  const redirectedApprovalLeaseRef = useRef<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const pendingApproval = checkpoint?.approvalOutbox[0] ?? null;
  const orphanedApproval = pendingApproval ? null : candidates.find((candidate) => candidate.status === 'approving') ?? null;
  const activeCandidates = candidates.filter((candidate) => candidate.status === 'ready');
  const setAside = candidates.filter((candidate) => candidate.status === 'skipped');
  // The server returns candidates in deterministic run order. Treat ready
  // cards as a queue: when the head changes status, the next head advances
  // without indexing into an already-shrinking filtered array.
  const current = activeCandidates[0] ?? null;
  const deckTotal = Math.max(checkpoint?.deckTotal ?? 0, candidates.length, 1);
  const deckPosition = Math.min((checkpoint?.deckCursor ?? 0) + 1, deckTotal);
  useEffect(() => {
    if (!pendingApproval || !runId || redirectedApprovalLeaseRef.current === pendingApproval.leaseId) return;
    redirectedApprovalLeaseRef.current = pendingApproval.leaseId;
    router.replace({ pathname: '/(app)/gallery-import/approve' as never, params: { runId, candidateId: pendingApproval.candidateId } });
  }, [pendingApproval, runId]);
  useEffect(() => {
    if (!orphanedApproval || !runId) return;
    router.replace({ pathname: '/(app)/gallery-import/approve' as never, params: { runId, candidateId: orphanedApproval.id } });
  }, [orphanedApproval, runId]);
  const refresh = useCallback(async () => {
    if (!checkpoint || !runId || pendingApproval) return;
    setIsRefreshing(true);
    try {
      const response = await getGalleryImportCandidates({ runId, capability: checkpoint.runCapability });
      if (response.error) throw new Error(response.error.message);
      const nextCandidates = response.data?.candidates ?? [];
      const skippedCount = nextCandidates.filter((candidate) => candidate.status === 'skipped').length;
      await updateCheckpoint((currentCheckpoint) => ({
        ...currentCheckpoint,
        // Approved cards are omitted by get-candidates. Skipped cards are not,
        // so subtract them from the cursor before inferring the unique total.
        deckTotal: Math.max(
          currentCheckpoint.deckTotal ?? 0,
          nextCandidates.length + Math.max(0, currentCheckpoint.deckCursor - skippedCount),
        ),
      }));
      setCandidates(nextCandidates);
      setActionError(null);
    } catch (caught) {
      setActionError(humanError(caught));
    } finally {
      setIsRefreshing(false);
    }
  }, [checkpoint?.runCapability, pendingApproval, runId, updateCheckpoint]);
  useEffect(() => { void refresh(); }, [refresh]);

  const changeSkip = async (candidate: GalleryImportCandidate, skip: boolean) => {
    if (!checkpoint || !runId || actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setIsActioning(true);
    setActionError(null);
    try {
      const result = await setGalleryImportCandidateSkip({ candidateId: candidate.id, capability: checkpoint.runCapability, skip });
      if (result.error || !result.data) { setActionError(result.error?.message ?? 'Could not update this suggestion.'); return; }
      await updateCheckpoint((currentCheckpoint) => ({
        ...currentCheckpoint,
        deckCursor: Math.max(0, currentCheckpoint.deckCursor + (skip ? 1 : -1)),
      }));
      trackEvent('gallery_import_candidate_actioned', { action: skip ? 'skip' : 'restore' });
      setCandidates((items) => items.map((item) => item.id === candidate.id ? result.data!.candidate : item));
    } catch (caught) {
      setActionError(humanError(caught));
    } finally {
      actionInFlightRef.current = false;
      setIsActioning(false);
    }
  };
  const finish = async () => {
    if (!checkpoint || !runId || !userId || !familyId) return;
    const result = await completeGalleryImportRun({ runId, capability: checkpoint.runCapability });
    if (result.error) { setActionError(result.error.message); return; }
    await Promise.all([clearGalleryImportCheckpoint(userId, familyId, runId), clearGalleryImportPreviewCache(runId)]);
    router.replace('/(app)/(tabs)/timeline');
  };
  if (isLoading) return <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>;
  if (!checkpoint) return <DeviceBoundNotice />;
  if (pendingApproval || orphanedApproval) return <View style={styles.center} testID="gallery-import-outbox-redirect"><ActivityIndicator color={colors.primary} /></View>;
  if (!current) return <SafeAreaView style={styles.screen}><Header title="From your photos" /><View style={styles.empty}><Text style={styles.displaySmall}>{isRefreshing ? 'Writing drafts.' : 'All caught up.'}</Text><Text style={styles.body}>{isRefreshing ? 'Suggestions appear here as they finish.' : 'The moments you kept are in your journal. Set-aside suggestions are not resurfaced in a future import.'}</Text>{setAside.length > 0 ? <SetAsideList candidates={setAside} isActioning={isActioning} onRestore={changeSkip} /> : null}<PrimaryButton label={isRefreshing ? 'Check again' : 'Back to my journal'} onPress={() => isRefreshing ? void refresh() : void finish()} testID="gallery-import-complete" /></View></SafeAreaView>;
  return <SafeAreaView style={styles.screen}><Header title="From your photos" /><View accessibilityLabel={`Moment ${deckPosition} of ${deckTotal}`} style={styles.deckProgress} testID="gallery-import-deck-progress"><View style={[styles.deckProgressFill, { width: `${Math.max(8, (deckPosition / deckTotal) * 100)}%` }]} /></View><View style={styles.deck}><View style={styles.deckBack} /><View style={styles.deckCard}>{current.previewUrls?.[0] ? <Image source={{ uri: current.previewUrls[0] }} style={styles.heroImage} contentFit="cover" /> : <View style={styles.heroImageFallback}><Text style={styles.placeholderSun}>✦</Text></View>}<View style={styles.previewStrip}>{current.previewUrls?.slice(1, 4).map((uri) => <Image key={uri} source={{ uri }} style={styles.previewThumb} contentFit="cover" />)}</View><Text style={styles.deckDate}>{current.memoryDate}</Text><Text style={styles.deckCaption}>{current.caption}</Text></View></View><View style={styles.deckActions}><SecondaryButton disabled={isActioning} label="Set aside" onPress={() => void changeSkip(current, true)} testID="gallery-import-set-aside" /><PrimaryButton disabled={isActioning} label="Keep this" onPress={() => { trackEvent('gallery_import_candidate_actioned', { action: 'keep' }); router.push({ pathname: '/(app)/gallery-import/approve' as never, params: { runId, candidateId: current.id } }); }} testID="gallery-import-keep" /><Text style={styles.deckHint}>Keeping opens the memory so you can change the words, photos, date and who is in it before it is saved.</Text>{setAside.length > 0 ? <SetAsideList candidates={setAside} isActioning={isActioning} onRestore={changeSkip} /> : null}{actionError ? <Text style={styles.error}>{actionError}</Text> : null}</View></SafeAreaView>;
}

function SetAsideList({ candidates, isActioning, onRestore }: { candidates: GalleryImportCandidate[]; isActioning: boolean; onRestore: (candidate: GalleryImportCandidate, skip: boolean) => Promise<void> }) { return <View style={styles.asideList}><Text style={styles.asideTitle}>Set aside · {candidates.length}</Text><FlatList data={candidates} initialNumToRender={6} keyboardShouldPersistTaps="handled" keyExtractor={(candidate) => candidate.id} nestedScrollEnabled renderItem={({ item: candidate }) => <Pressable accessibilityRole="button" disabled={isActioning} onPress={() => void onRestore(candidate, false)} style={styles.asideRow} testID={`gallery-import-restore-${candidate.id}`}><Text numberOfLines={1} style={styles.asideCaption}>{candidate.caption}</Text><Text style={styles.restore}>Restore</Text></Pressable>} style={styles.asideScroll} testID="gallery-import-set-aside-scroll" windowSize={5} /></View>; }

export function GalleryImportApproval({ runId, candidateId }: { runId?: string; candidateId?: string }) {
  const { checkpoint, isLoading, update: updateCheckpoint, userId, familyId } = useRunCheckpoint(runId);
  const { members } = useFamilyMembers();
  const [candidate, setCandidate] = useState<GalleryImportCandidate | null>(null);
  const [caption, setCaption] = useState('');
  const [memoryDate, setMemoryDate] = useState('');
  const [assetTokens, setAssetTokens] = useState<string[]>([]);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [approvalProgress, setApprovalProgress] = useState<string | null>(null);
  const [isOrphanRecoveryFailed, setIsOrphanRecoveryFailed] = useState(false);
  const resumedLeaseRef = useRef<string | null>(null);
  const recoveredCandidateRef = useRef<string | null>(null);
  const approvalActionInFlightRef = useRef(false);
  const approvalStageRef = useRef<GalleryImportApprovalStage | null>(null);
  const setApprovalStage = useCallback((stage: GalleryImportApprovalStage, progress: string) => {
    approvalStageRef.current = stage;
    setApprovalProgress(progress);
  }, []);
  const clearApprovalStage = useCallback(() => {
    approvalStageRef.current = null;
    setApprovalProgress(null);
  }, []);
  const pendingApproval = checkpoint?.approvalOutbox.find((item) => item.candidateId === candidateId) ?? null;
  const refresh = useCallback(async () => {
    if (!checkpoint || !runId || !candidateId) return;
    const response = await getGalleryImportCandidates({ runId, capability: checkpoint.runCapability });
    const found = response.data?.candidates.find((item) => item.id === candidateId) ?? null;
    if (response.error || (!found && !pendingApproval)) { setError(response.error?.message ?? 'This suggestion is no longer available.'); return; }
    if (!found) return;
    setCandidate(found); setCaption(found.caption); setMemoryDate(found.memoryDate); setAssetTokens(found.selectedAssetTokens); setMemberIds(found.familyMemberIds);
  }, [candidateId, checkpoint?.runCapability, pendingApproval, runId]);
  useEffect(() => { void refresh(); }, [refresh]);

  type ResolvedApprovalOriginal = { assetToken: string; uri: string; original: Awaited<ReturnType<typeof getGalleryImportOriginalUpload>> };

  const resolveApprovalOriginal = useCallback(async (
    adapter: GalleryMediaLibraryAdapter,
    assetToken: string,
    deadlineAtMs: number,
  ): Promise<ResolvedApprovalOriginal> => {
    if (!checkpoint) throw new Error('This approval is no longer available on this device.');
    const localAsset = checkpoint.assetByToken[assetToken];
    if (!localAsset) throw new Error('A selected photo is no longer available on this device.');
    return withGalleryImportApprovalDeadline(async () => {
      // Approval is an explicit request for the selected original. Unlike
      // discovery previews, allow PhotoKit to retrieve an iCloud-backed asset;
      // the surrounding deadline keeps that foreground request bounded.
      const uri = await adapter.resolveAssetUri(localAsset.osAssetId);
      const filename = await adapter.getAssetFilename?.(localAsset.osAssetId);
      const original = await getGalleryImportOriginalUpload({ uri, filename, width: localAsset.width, height: localAsset.height });
      return { assetToken, uri, original };
    }, deadlineAtMs);
  }, [checkpoint]);

  const completeApprovalOutbox = useCallback(async (
    pending: GalleryImportApprovalOutboxItem,
    deadlineAtMs: number,
    resolvedOriginals?: ResolvedApprovalOriginal[],
  ) => {
    if (!checkpoint || !runId || !candidateId) throw new Error('This approval is no longer available on this device.');
    if (pending.status !== 'finalizing') {
      const originals = resolvedOriginals ?? [];
      if (!resolvedOriginals) {
        const adapter = getGalleryImportE2eAdapter() ?? createExpoGalleryMediaLibraryAdapter();
        for (let index = 0; index < pending.assetTokens.length; index += 1) {
          setApprovalStage('Preparing selected photo', `Preparing photo ${index + 1} of ${pending.assetTokens.length}…`);
          originals.push(await resolveApprovalOriginal(adapter, pending.assetTokens[index], deadlineAtMs));
        }
      }
      for (let index = 0; index < originals.length; index += 1) {
        const { assetToken, uri, original } = originals[index];
        setApprovalStage('Secure upload request', `Requesting secure upload ${index + 1} of ${originals.length}…`);
        const uploadUrl = await withGalleryImportApprovalDeadline(
          () => getGalleryImportApprovalUploadUrl({ candidateId, capability: checkpoint.runCapability, leaseId: pending.leaseId, assetToken, contentType: original.contentType, byteLength: original.byteLength }),
          deadlineAtMs,
        );
        if (!uploadUrl.data || uploadUrl.error) throw new Error(uploadUrl.error?.message ?? 'Could not resume the photo upload.');
        setApprovalStage('Uploading selected photo', `Uploading photo ${index + 1} of ${originals.length}…`);
        const upload = await withGalleryImportApprovalDeadline(
          () => uploadToPresignedUrl(uploadUrl.data!.uploadUrl, uri, original.contentType, uploadUrl.data!.requiredHeaders),
          deadlineAtMs,
        );
        if (upload.error) throw new Error(upload.error.message);
        setApprovalStage('Confirming secure upload', `Confirming photo ${index + 1} of ${originals.length}…`);
        const recorded = await withGalleryImportApprovalDeadline(
          () => recordGalleryImportApprovalUpload({ candidateId, capability: checkpoint.runCapability, leaseId: pending.leaseId, assetToken, contentType: original.contentType, byteLength: original.byteLength, aspectRatio: original.aspectRatio }),
          deadlineAtMs,
        );
        if (recorded.error || recorded.data?.recorded !== true) throw new Error(recorded.error?.message ?? 'Could not confirm the photo upload.');
      }
      await updateCheckpoint((current) => ({
        ...current,
        approvalOutbox: current.approvalOutbox.map((item) => item.candidateId === candidateId ? { ...item, status: 'finalizing', errorCode: undefined } : item),
      }));
    }
    setApprovalStage('Finishing memory', 'Finishing memory…');
    const finalized = await withGalleryImportApprovalDeadline(
      () => finalizeGalleryImportCandidate({ candidateId, capability: checkpoint.runCapability }),
      deadlineAtMs,
    );
    if (!finalized.data || finalized.error) throw new Error(finalized.error?.message ?? 'Could not save this memory.');
    trackEvent('gallery_import_candidate_approved', { asset_count: pending.assetTokens.length, tagged_count: candidate?.familyMemberIds.length ?? 0 });
    await updateCheckpoint((current) => {
      if (!current.approvalOutbox.some((item) => item.candidateId === candidateId)) return current;
      return {
        ...current,
        approvalOutbox: current.approvalOutbox.filter((item) => item.candidateId !== candidateId),
        deckCursor: current.deckCursor + 1,
      };
    });
    router.replace({ pathname: '/(app)/gallery-import/review' as never, params: { runId } });
  }, [candidate?.familyMemberIds.length, candidateId, checkpoint, resolveApprovalOriginal, runId, setApprovalStage, updateCheckpoint]);

  const markApprovalFailed = useCallback(async () => {
    await updateCheckpoint((current) => ({
      ...current,
      approvalOutbox: current.approvalOutbox.map((item) => item.candidateId === candidateId
        ? { ...item, status: 'failed', errorCode: item.status === 'finalizing' ? 'client_retryable_finalizing' : 'client_retryable' }
        : item),
    }));
  }, [candidateId, updateCheckpoint]);

  const runApprovalOutbox = useCallback(async (pending: GalleryImportApprovalOutboxItem) => {
    if (!checkpoint || !runId || !candidateId || !userId || !familyId || approvalActionInFlightRef.current) return;
    approvalActionInFlightRef.current = true;
    resumedLeaseRef.current = pending.leaseId;
    setIsSaving(true);
    clearApprovalStage();
    setError(null);
    const deadlineAtMs = Date.now() + GALLERY_IMPORT_APPROVAL_BUDGET_MS;
    try {
      const retryPending = pending.status === 'failed'
        ? {
            ...pending,
            status: pending.errorCode === 'client_retryable_finalizing' ? 'finalizing' as const : 'uploading' as const,
            errorCode: undefined,
          }
        : pending;
      if (pending.status === 'failed') {
        await updateCheckpoint((current) => ({
          ...current,
          approvalOutbox: current.approvalOutbox.map((item) => item.candidateId === candidateId ? retryPending : item),
        }));
      }
      await completeApprovalOutbox(retryPending, deadlineAtMs);
    } catch (caught) {
      setError(galleryImportApprovalStageError(approvalStageRef.current, caught));
      await markApprovalFailed();
    } finally {
      approvalActionInFlightRef.current = false;
      setIsSaving(false);
      setApprovalProgress(null);
    }
  }, [candidateId, checkpoint, clearApprovalStage, completeApprovalOutbox, familyId, markApprovalFailed, runId, updateCheckpoint, userId]);

  const recoverOrphanedApproval = useCallback(async () => {
    if (!checkpoint || !candidate || candidate.status !== 'approving' || !runId || !candidateId || !userId || !familyId || approvalActionInFlightRef.current) return;
    approvalActionInFlightRef.current = true;
    setIsSaving(true);
    clearApprovalStage();
    setError(null);
    setIsOrphanRecoveryFailed(false);
    const deadlineAtMs = Date.now() + GALLERY_IMPORT_APPROVAL_BUDGET_MS;
    try {
      const adapter = getGalleryImportE2eAdapter() ?? createExpoGalleryMediaLibraryAdapter();
      const originals: ResolvedApprovalOriginal[] = [];
      for (let index = 0; index < candidate.selectedAssetTokens.length; index += 1) {
        setApprovalStage('Preparing selected photo', `Preparing photo ${index + 1} of ${candidate.selectedAssetTokens.length}…`);
        originals.push(await resolveApprovalOriginal(adapter, candidate.selectedAssetTokens[index], deadlineAtMs));
      }
      setApprovalStage('Securing approval', 'Securing this memory…');
      const lease = await withGalleryImportApprovalDeadline(
        () => beginGalleryImportApproval({
          candidateId,
          capability: checkpoint.runCapability,
          assets: originals.map(({ assetToken, original }) => ({ assetToken, contentType: original.contentType })),
        }),
        deadlineAtMs,
      );
      if (!lease.data || lease.error) throw new Error(lease.error?.message ?? 'Could not resume this memory.');
      const recoveredOutbox: GalleryImportApprovalOutboxItem = {
        candidateId,
        leaseId: lease.data.leaseId,
        memoryId: lease.data.memoryId,
        assetTokens: candidate.selectedAssetTokens,
        status: 'uploading',
      };
      resumedLeaseRef.current = recoveredOutbox.leaseId;
      await updateCheckpoint((current) => ({
        ...current,
        approvalOutbox: [...current.approvalOutbox.filter((item) => item.candidateId !== candidateId), recoveredOutbox],
      }));
      await completeApprovalOutbox(recoveredOutbox, deadlineAtMs, originals);
    } catch (caught) {
      setError(galleryImportApprovalStageError(approvalStageRef.current, caught));
      setIsOrphanRecoveryFailed(true);
    } finally {
      approvalActionInFlightRef.current = false;
      setIsSaving(false);
      setApprovalProgress(null);
    }
  }, [candidate, candidateId, checkpoint, clearApprovalStage, completeApprovalOutbox, familyId, resolveApprovalOriginal, runId, setApprovalStage, updateCheckpoint, userId]);

  const submit = async () => {
    if (!checkpoint || !candidate || !runId || !candidateId || !userId || !familyId || approvalActionInFlightRef.current) return;
    const trimmedCaption = caption.trim();
    if (!trimmedCaption) { setError('Add a caption before saving this memory.'); return; }
    if (trimmedCaption.length > GALLERY_IMPORT_CAPTION_MAX_LENGTH) { setError('Keep the caption to 1,000 characters or fewer.'); return; }
    if (!isValidCalendarDate(memoryDate)) { setError('Enter a real date in YYYY-MM-DD format.'); return; }
    if (assetTokens.length === 0) { setError('Choose at least one photo.'); return; }
    approvalActionInFlightRef.current = true;
    setIsSaving(true); setError(null);
    clearApprovalStage();
    const deadlineAtMs = Date.now() + GALLERY_IMPORT_APPROVAL_BUDGET_MS;
    let createdOutbox: GalleryImportApprovalOutboxItem | null = null;
    try {
      const adapter = getGalleryImportE2eAdapter() ?? createExpoGalleryMediaLibraryAdapter();
      const originals: ResolvedApprovalOriginal[] = [];
      for (let index = 0; index < assetTokens.length; index += 1) {
        const assetToken = assetTokens[index];
        setApprovalStage('Preparing selected photo', `Preparing photo ${index + 1} of ${assetTokens.length}…`);
        try {
          originals.push(await resolveApprovalOriginal(adapter, assetToken, deadlineAtMs));
        } catch (caught) {
          if (caught instanceof GalleryImportApprovalTimeoutError) throw caught;
          // It may have been removed from the camera roll since review. Do not
          // open an approval lease for an original this device cannot upload.
        }
      }
      if (originals.length === 0) throw new Error('The selected photos are no longer available on this device. Return to the suggestion and choose another photo.');
      const survivingTokens = originals.map(({ assetToken }) => assetToken);
      setApprovalStage('Securing approval', 'Securing this memory…');
      const updated = await withGalleryImportApprovalDeadline(
        () => updateGalleryImportCandidate({ candidateId, capability: checkpoint.runCapability, caption: trimmedCaption, memoryDate, assetTokens: survivingTokens, familyMemberIds: memberIds }),
        deadlineAtMs,
      );
      if (updated.error) throw new Error(updated.error.message);
      const lease = await withGalleryImportApprovalDeadline(
        () => beginGalleryImportApproval({ candidateId, capability: checkpoint.runCapability, assets: originals.map(({ assetToken, original }) => ({ assetToken, contentType: original.contentType })) }),
        deadlineAtMs,
      );
      if (!lease.data || lease.error) throw new Error(lease.error?.message ?? 'Could not prepare this memory.');
      createdOutbox = { candidateId, leaseId: lease.data.leaseId, memoryId: lease.data.memoryId, assetTokens: survivingTokens, status: 'uploading' };
      resumedLeaseRef.current = createdOutbox.leaseId;
      await updateCheckpoint((current) => ({
        ...current,
        approvalOutbox: [...current.approvalOutbox.filter((item) => item.candidateId !== candidateId), createdOutbox!],
      }));
      await completeApprovalOutbox(createdOutbox, deadlineAtMs, originals);
    } catch (caught) {
      setError(galleryImportApprovalStageError(approvalStageRef.current, caught));
      if (createdOutbox) await markApprovalFailed();
    } finally {
      approvalActionInFlightRef.current = false;
      setIsSaving(false);
      setApprovalProgress(null);
    }
  };

  useEffect(() => {
    if (!pendingApproval || pendingApproval.status === 'failed' || resumedLeaseRef.current === pendingApproval.leaseId) return;
    resumedLeaseRef.current = pendingApproval.leaseId;
    void runApprovalOutbox(pendingApproval);
  }, [pendingApproval, runApprovalOutbox]);
  useEffect(() => {
    if (!candidate || candidate.status !== 'approving' || pendingApproval || isOrphanRecoveryFailed || recoveredCandidateRef.current === candidate.id) return;
    recoveredCandidateRef.current = candidate.id;
    void recoverOrphanedApproval();
  }, [candidate, isOrphanRecoveryFailed, pendingApproval, recoverOrphanedApproval]);
  if (isLoading || (!candidate && !pendingApproval)) return <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>;
  if (!candidate && pendingApproval) {
    const canRetry = pendingApproval.status === 'failed';
    return <SafeAreaView style={styles.screen}><Header title="Make it yours" /><View style={styles.empty}><Text style={styles.displaySmall}>Finishing your memory.</Text><Text style={styles.body}>Your save is still connected to this device. Momora will reuse it instead of creating another memory.</Text>{canRetry ? <PrimaryButton label={isSaving ? 'Saving…' : 'Retry saving'} onPress={() => void runApprovalOutbox(pendingApproval)} disabled={isSaving} testID="gallery-import-approval-retry" /> : <ActivityIndicator color={colors.primary} testID="gallery-import-approval-recovery" />}{approvalProgress ? <Text style={styles.footerHint} testID="gallery-import-approval-progress">{approvalProgress}</Text> : null}{error ? <Text style={styles.error} testID="gallery-import-approval-error">{error}</Text> : null}</View></SafeAreaView>;
  }
  if (!candidate) return null;
  const isApprovalLocked = Boolean(pendingApproval) || candidate.status === 'approving';
  const isRetry = pendingApproval?.status === 'failed' || isOrphanRecoveryFailed;
  const buttonLabel = isSaving ? 'Saving…' : isRetry ? 'Retry saving' : pendingApproval || candidate.status === 'approving' ? 'Continue saving' : 'Add to my journal';
  const buttonTestID = isRetry ? 'gallery-import-approval-retry' : 'gallery-import-approve';
  return <KeyboardStickyShell safeAreaStyle={styles.screen} contentContainerStyle={styles.composerContent} fixedFooterTestID="gallery-import-approval-fixed-footer" footer={<View style={styles.footerStack}><PrimaryButton label={buttonLabel} onPress={() => pendingApproval ? void runApprovalOutbox(pendingApproval) : candidate.status === 'approving' ? void recoverOrphanedApproval() : void submit()} disabled={isSaving} testID={buttonTestID} /><Text style={styles.footerHint} testID="gallery-import-approval-progress">{approvalProgress ?? (isRetry ? 'Your existing save is safe to retry. Momora will not create a second memory.' : 'Full-size photos are uploaded only when you add this memory.')}</Text></View>} footerKeyboardSticky={!isApprovalLocked} footerTestID="gallery-import-approval-footer" testID="gallery-import-approval"><Header title="Make it yours" /><Text style={styles.eyebrow}>From your photos</Text><Text style={styles.displaySmall}>A moment, ready for your words.</Text><Text style={styles.fieldLabel}>Caption</Text><TextInput editable={!isApprovalLocked} maxLength={GALLERY_IMPORT_CAPTION_MAX_LENGTH} multiline onChangeText={setCaption} style={styles.captionInput} testID="gallery-import-caption" value={caption} /><Text style={styles.fieldLabel}>Date</Text><TextInput autoCapitalize="none" editable={!isApprovalLocked} onChangeText={setMemoryDate} style={styles.dateInput} testID="gallery-import-date" value={memoryDate} /><Text style={styles.fieldLabel}>Photos</Text><View style={styles.approvalPhotos}>{candidate.previewUrls?.map((uri, index) => { const token = candidate.selectedAssetTokens[index]; const selected = token ? assetTokens.includes(token) : false; return <Pressable key={`${uri}-${token}`} accessibilityLabel={selected ? 'Remove photo' : 'Add photo'} accessibilityRole="checkbox" accessibilityState={{ checked: selected, disabled: isApprovalLocked }} disabled={isApprovalLocked} onPress={() => token && setAssetTokens((tokens) => selected ? tokens.filter((item) => item !== token) : [...tokens, token])} style={[styles.approvalPhoto, selected && styles.approvalPhotoSelected]} testID={`gallery-import-photo-${index}`}><Image source={{ uri }} style={styles.approvalImage} contentFit="cover" /><View style={styles.photoCheck}><Text style={styles.photoCheckText}>{selected ? '✓' : '+'}</Text></View></Pressable>; })}</View><Text style={styles.fieldLabel}>Who was there?</Text><View style={styles.memberChips}>{members.map((member) => { const selected = memberIds.includes(member.id); return <Pressable key={member.id} accessibilityRole="checkbox" accessibilityState={{ checked: selected, disabled: isApprovalLocked }} disabled={isApprovalLocked} onPress={() => setMemberIds((ids) => selected ? ids.filter((id) => id !== member.id) : [...ids, member.id])} style={[styles.memberChip, selected && styles.memberChipSelected]} testID={`gallery-import-member-${member.id}`}><Text style={[styles.memberChipText, selected && styles.memberChipTextSelected]}>{member.name}</Text></Pressable>; })}</View>{error ? <Text style={styles.error} testID="gallery-import-approval-error">{error}</Text> : null}</KeyboardStickyShell>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg }, center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }, header: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', minHeight: 54, paddingHorizontal: spacing.lg }, back: { color: colors.ink, fontFamily: fonts.display, fontSize: 34, lineHeight: 34 }, headerTitle: { color: colors.ink2, fontFamily: fonts.sansBold, fontSize: 13 }, headerSpacer: { width: 22 }, entryContent: { paddingBottom: spacing.xxl, paddingHorizontal: spacing.lg }, eyebrow: { color: colors.ink3, fontFamily: fonts.sansBold, fontSize: 10, letterSpacing: 1.4, textTransform: 'uppercase' }, display: { color: colors.ink, fontFamily: fonts.display, fontSize: 38, letterSpacing: -0.7, lineHeight: 39, marginTop: 11 }, displayAccent: { color: colors.primary, fontFamily: fonts.displayItalic }, displaySmall: { color: colors.ink, fontFamily: fonts.display, fontSize: 31, lineHeight: 34, marginTop: 12 }, body: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 14.5, lineHeight: 23, marginTop: 16 }, printStack: { height: 208, marginTop: 26, position: 'relative' }, print: { backgroundColor: colors.white, borderColor: colors.border, borderRadius: radius.lg, borderWidth: 1, bottom: 18, left: 18, position: 'absolute', right: 18, top: 12 }, printBackOne: { transform: [{ rotate: '-4deg' }] }, printBackTwo: { left: 10, right: 10, top: 7, transform: [{ rotate: '2deg' }] }, printFront: { backgroundColor: colors.white, borderColor: colors.border, borderRadius: radius.lg, borderWidth: 1, bottom: 13, left: 0, padding: 12, position: 'absolute', right: 0, top: 0, transform: [{ rotate: '-1deg' }] }, photoPlaceholder: { alignItems: 'center', backgroundColor: colors.primaryTint, borderRadius: radius.md, height: 118, justifyContent: 'center' }, placeholderSun: { color: colors.primary, fontSize: 34 }, thumbRow: { flexDirection: 'row', gap: 6, marginTop: 10 }, thumb: { backgroundColor: colors.seaSoft, borderRadius: 6, flex: 1, height: 34 }, fact: { alignItems: 'flex-start', flexDirection: 'row', gap: 12, marginTop: 17 }, factMark: { alignItems: 'center', backgroundColor: colors.primaryTint, borderRadius: 12, height: 32, justifyContent: 'center', width: 32 }, factMarkText: { color: colors.primary, fontFamily: fonts.sansBold }, factCopy: { flex: 1 }, factTitle: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 14 }, factBody: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 19, marginTop: 3 }, consent: { backgroundColor: colors.surface, borderRadius: radius.md, marginTop: spacing.lg, padding: 14 }, consentTitle: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 13 }, consentBody: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18, marginTop: 5 }, footerStack: { gap: 10, paddingHorizontal: spacing.lg }, primaryButton: { alignItems: 'center', backgroundColor: colors.primary, borderRadius: radius.pill, minHeight: 52, justifyContent: 'center', paddingHorizontal: spacing.lg }, primaryButtonText: { color: colors.white, fontFamily: fonts.sansBold, fontSize: 15 }, secondaryButton: { alignItems: 'center', backgroundColor: colors.white, borderColor: colors.borderStrong, borderRadius: radius.pill, borderWidth: 1, flex: 1, minHeight: 52, justifyContent: 'center', paddingHorizontal: spacing.md }, secondaryButtonText: { color: colors.ink2, fontFamily: fonts.sansBold, fontSize: 14 }, buttonPressed: { opacity: 0.55 }, ghostButton: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 13, padding: 8, textAlign: 'center' }, footerHint: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 11.5, lineHeight: 16, textAlign: 'center' }, error: { color: colors.error, fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 18, marginTop: spacing.md }, errorCard: { backgroundColor: colors.errorSoft, borderRadius: radius.md, marginTop: spacing.md, padding: 12 }, note: { color: colors.seaInk, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18, marginTop: spacing.md }, managePhotos: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 12.5, marginTop: spacing.sm }, statusCard: { backgroundColor: colors.white, borderColor: colors.border, borderRadius: radius.lg, borderWidth: 1, gap: 7, marginTop: spacing.lg, padding: spacing.md }, statusEyebrow: { color: colors.seaInk, fontFamily: fonts.sansBold, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' }, statusTitle: { color: colors.ink, fontFamily: fonts.display, fontSize: 23 }, statusBody: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 12.5 }, progressContent: { padding: spacing.lg }, progressTrack: { backgroundColor: colors.border, borderRadius: 999, height: 5, marginTop: spacing.xl, overflow: 'hidden' }, progressFill: { backgroundColor: colors.primary, borderRadius: 999, height: '100%' }, safeCard: { backgroundColor: colors.seaSoft, borderRadius: radius.lg, marginTop: spacing.xl, padding: spacing.md }, safeTitle: { color: colors.seaInk, fontFamily: fonts.sansBold, fontSize: 13 }, safeText: { color: colors.seaInk, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18, marginTop: 4 }, fixedActions: { backgroundColor: colors.bg, borderTopColor: colors.border, borderTopWidth: 1, gap: 8, paddingHorizontal: spacing.lg, paddingTop: spacing.sm }, empty: { flex: 1, gap: spacing.md, justifyContent: 'center', padding: spacing.lg }, deckProgress: { backgroundColor: colors.border, height: 3, marginHorizontal: spacing.lg, overflow: 'hidden' }, deckProgressFill: { backgroundColor: colors.primary, height: '100%' }, deck: { flex: 1, margin: spacing.lg, minHeight: 300, position: 'relative' }, deckBack: { backgroundColor: colors.white, borderColor: colors.border, borderRadius: radius.xl, borderWidth: 1, bottom: 2, left: 10, position: 'absolute', right: 10, top: 8, transform: [{ rotate: '-1.2deg' }] }, deckCard: { backgroundColor: colors.white, borderColor: colors.border, borderRadius: radius.xl, borderWidth: 1, flex: 1, padding: 12 }, heroImage: { backgroundColor: colors.primaryTint, borderRadius: radius.md, flex: 1, minHeight: 180, width: '100%' }, heroImageFallback: { alignItems: 'center', backgroundColor: colors.primaryTint, borderRadius: radius.md, flex: 1, justifyContent: 'center', minHeight: 180 }, previewStrip: { flexDirection: 'row', gap: 5, marginTop: 9 }, previewThumb: { backgroundColor: colors.surface, borderRadius: 6, height: 36, width: 36 }, deckDate: { color: colors.ink3, fontFamily: fonts.sansBold, fontSize: 10, letterSpacing: 1, marginTop: 13, textTransform: 'uppercase' }, deckCaption: { color: colors.ink, fontFamily: fonts.display, fontSize: 20, lineHeight: 27, marginTop: 7 }, deckActions: { alignItems: 'stretch', flexDirection: 'row', flexWrap: 'wrap', gap: 10, padding: spacing.lg, paddingTop: 0 }, deckHint: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 11.5, lineHeight: 16, textAlign: 'center', width: '100%' }, asideList: { backgroundColor: colors.surface, borderRadius: radius.md, marginTop: 4, overflow: 'hidden', width: '100%' }, asideScroll: { maxHeight: 168 }, asideTitle: { color: colors.ink2, fontFamily: fonts.sansBold, fontSize: 12, padding: 12 }, asideRow: { alignItems: 'center', borderTopColor: colors.border, borderTopWidth: 1, flexDirection: 'row', gap: 8, minHeight: 48, padding: 12 }, asideCaption: { color: colors.ink2, flex: 1, fontFamily: fonts.sans, fontSize: 12 }, restore: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 12 }, composerContent: { gap: 11, padding: spacing.lg }, fieldLabel: { color: colors.ink2, fontFamily: fonts.sansBold, fontSize: 12, marginTop: 7 }, captionInput: { backgroundColor: colors.white, borderColor: colors.border, borderRadius: radius.md, borderWidth: 1, color: colors.ink, fontFamily: fonts.sans, fontSize: 15, lineHeight: 22, minHeight: 110, padding: 12, textAlignVertical: 'top' }, dateInput: { backgroundColor: colors.white, borderColor: colors.border, borderRadius: radius.md, borderWidth: 1, color: colors.ink, fontFamily: fonts.sans, fontSize: 15, padding: 12 }, approvalPhotos: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, approvalPhoto: { borderColor: colors.border, borderRadius: radius.sm, borderWidth: 2, height: 84, overflow: 'hidden', position: 'relative', width: 84 }, approvalPhotoSelected: { borderColor: colors.primary }, approvalImage: { height: '100%', width: '100%' }, photoCheck: { alignItems: 'center', backgroundColor: colors.white, borderRadius: 12, height: 24, justifyContent: 'center', position: 'absolute', right: 5, top: 5, width: 24 }, photoCheckText: { color: colors.primary, fontFamily: fonts.sansBold }, memberChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, memberChip: { backgroundColor: colors.white, borderColor: colors.borderStrong, borderRadius: radius.pill, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 }, memberChipSelected: { backgroundColor: colors.primaryTint, borderColor: colors.primary }, memberChipText: { color: colors.ink2, fontFamily: fonts.sansBold, fontSize: 12 }, memberChipTextSelected: { color: colors.primary },
});
