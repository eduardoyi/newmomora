// Gallery import -- the "keep" step. This IS the app's memory composer
// (docs/design/gallery-import/README.md's approved clarification, and
// gi-notes.jsx: "the keep step IS the composer, not a copy of it") --
// literally the same shared form new-memory.tsx and edit.tsx render (see
// src/components/memory-composer-form.tsx), not a lookalike fork. See
// docs/design/gallery-import/README.md and the handoff's gi-approve.jsx for
// the design this mirrors.
//
// The async approval/upload/finalize pipeline below (resolveApprovalOriginal,
// completeApprovalOutbox, markApprovalFailed, runApprovalOutbox,
// recoverOrphanedApproval, submit) is carried over unchanged from the former
// gallery-import-flow.tsx -- this file wires the shared composer form and its
// own kept-confirmation screen; it is presentation only, not persistence.
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { MemoryComposerForm, type MemoryComposerTypeBadge } from '@/components/memory-composer-form';
import { MemoryMediaPicker, type MediaAttachment } from '@/components/memory-media-picker';
import { VoiceSpeakItModal } from '@/components/voice-speak-it-modal';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import type { VoiceFamilyMemberPayload } from '@/services/ai';
import {
  beginGalleryImportApproval,
  finalizeGalleryImportCandidate,
  getGalleryImportApprovalUploadUrl,
  getGalleryImportCandidates,
  getGalleryImportRun,
  recordGalleryImportApprovalUpload,
  updateGalleryImportCandidate,
  type GalleryImportCandidate,
} from '@/services/gallery-import';
import { uploadToPresignedUrl } from '@/services/media';
import { trackEvent } from '@/services/analytics';
import { type GalleryImportApprovalOutboxItem } from '@/utils/gallery-import-checkpoint';
import { getGalleryImportOriginalUpload } from '@/utils/gallery-import-original';
import { getGalleryImportE2eAdapter } from '@/utils/gallery-import-e2e-adapter';
import {
  createExpoGalleryMediaLibraryAdapter,
  type GalleryMediaLibraryAdapter,
} from '@/utils/gallery-import-scanner';
import { formatDisplayDate } from '@/utils/memories';

import { type GalleryImportChosenPhoto } from './gallery-import-review-sheets';
import { Header, PrimaryButton, exitGalleryImportToTimeline, gi, humanError, useRunCheckpoint } from './gallery-import-shared';

/**
 * What the day-pool photo-chooser sheet needs from the composer: the
 * candidate (its original selection defines the server-side cluster), the
 * current ordered selection, and a setter that replaces it wholesale. The
 * route that renders the composer opens the sheet with this context -- see
 * app/(app)/gallery-import/approve.tsx.
 */
export interface GalleryImportAddPhotosContext {
  candidate: Pick<GalleryImportCandidate, 'id' | 'memoryDate' | 'selectedAssetTokens' | 'previewUrls'>;
  selectedAssetTokens: string[];
  setPhotos: (photos: GalleryImportChosenPhoto[]) => void;
}

const GALLERY_IMPORT_CAPTION_MAX_LENGTH = 1_000;
const GALLERY_IMPORT_MAX_PHOTOS = 10;
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

interface GalleryImportSavedResult {
  caption: string;
  memoryDate: string;
  previewUri?: string;
  assetCount: number;
  /** Real ready-to-review count from the run, never the deck's own
   * cursor/total (that also counts set-aside cards, which are not "left" to
   * review). `null` when the count could not be read -- the confirmation
   * screen hides the number rather than showing a wrong one. */
  remaining: number | null;
}

export function GalleryImportApproval({
  runId,
  candidateId,
  onAddPhotos,
  readyCount,
}: {
  runId?: string;
  candidateId?: string;
  // The day-pool photo-chooser seam: when present, the composer shows its
  // dashed "Add" tile and toolbar camera button, and calls this with the
  // current selection context so the parent can open the chooser sheet.
  onAddPhotos?: (context: GalleryImportAddPhotosContext) => void;
  /** Optional: a fresher ready-to-review count than this screen could fetch
   * itself (e.g. one the review deck already has in hand). When absent, the
   * kept-confirmation screen fetches the run's own `readyCandidates`. */
  readyCount?: number;
}) {
  const { checkpoint, isLoading, update: updateCheckpoint, userId, familyId } = useRunCheckpoint(runId);
  const { members } = useFamilyMembers();
  const [candidate, setCandidate] = useState<GalleryImportCandidate | null>(null);
  const [caption, setCaption] = useState('');
  const [isCaptionEdited, setIsCaptionEdited] = useState(false);
  const [memoryDate, setMemoryDate] = useState('');
  const [assetTokens, setAssetTokens] = useState<string[]>([]);
  // Display URIs for day-pool photos added beyond the candidate's server
  // previews. Local-only state; these device URIs are never persisted or
  // sent anywhere -- originals still upload through submit()'s lease path.
  const [localPhotoUris, setLocalPhotoUris] = useState<Record<string, string>>({});
  const [unavailableTokens, setUnavailableTokens] = useState<Record<string, boolean>>({});
  // Long-press-to-select-then-drag state for the shared composer's media
  // grid (src/components/memory-media-preview.tsx) -- unused by this screen
  // otherwise, matching how new-memory.tsx/edit.tsx track it.
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [approvalProgress, setApprovalProgress] = useState<string | null>(null);
  const [isOrphanRecoveryFailed, setIsOrphanRecoveryFailed] = useState(false);
  const [showVoiceModal, setShowVoiceModal] = useState(false);
  const [savedResult, setSavedResult] = useState<GalleryImportSavedResult | null>(null);
  const resumedLeaseRef = useRef<string | null>(null);
  const recoveredCandidateRef = useRef<string | null>(null);
  const approvalActionInFlightRef = useRef(false);
  // Best-effort "latest candidate" mirror, read by runApprovalOutbox's
  // showSaved snapshot below as a fast path before falling back to a direct
  // fetch. runApprovalOutbox is triggered by an effect keyed on a leaseId
  // ref guard (resumedLeaseRef) rather than on `candidate` itself, so an
  // auto-resume on mount (an already-pending outbox) can race refresh()'s
  // first load; the fallback fetch there is what actually guarantees
  // correctness, not this mirror.
  const candidateRef = useRef<GalleryImportCandidate | null>(null);
  useEffect(() => { candidateRef.current = candidate; }, [candidate]);
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
  // Primitive identity for effects: the checkpoint is re-read from storage
  // whenever the app-root driver writes it (every preview upload of the
  // background sweep), so `pendingApproval`'s object identity churns
  // constantly. Keying `refresh` on the object re-fetched the candidate
  // mid-save, captured its transient 'approving' status, and -- once the
  // outbox cleared after finalization -- tripped orphan recovery into a
  // second `begin` that the server rightly refused (device-observed
  // 2026-08-23: a successful save shown as "not available").
  const pendingApprovalKey = pendingApproval ? `${pendingApproval.leaseId}:${pendingApproval.status}` : null;
  const refresh = useCallback(async () => {
    if (!checkpoint || !runId || !candidateId || savedResult || approvalActionInFlightRef.current) return;
    const response = await getGalleryImportCandidates({ runId, capability: checkpoint.runCapability });
    const found = response.data?.candidates.find((item) => item.id === candidateId) ?? null;
    if (response.error || (!found && !pendingApproval)) { setError(response.error?.message ?? 'This suggestion is no longer available.'); return; }
    if (!found) return;
    setCandidate(found); setCaption(found.caption); setIsCaptionEdited(false); setMemoryDate(found.memoryDate); setAssetTokens(found.selectedAssetTokens); setMemberIds(found.familyMemberIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `pendingApprovalKey` stands in for `pendingApproval` (see above).
  }, [candidateId, checkpoint?.runCapability, pendingApprovalKey, runId, savedResult]);
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
          setApprovalStage('Preparing selected photo', `Saving photo ${index + 1} of ${pending.assetTokens.length}…`);
          originals.push(await resolveApprovalOriginal(adapter, pending.assetTokens[index], deadlineAtMs));
        }
      }
      for (let index = 0; index < originals.length; index += 1) {
        const { assetToken, uri, original } = originals[index];
        // The three sub-steps below (request/upload/confirm) share one
        // simplified progress line -- the user sees one continuous "Saving
        // photo i of n..." for this photo rather than three different
        // sentences flashing by; the distinct stage identifiers survive only
        // for the error-prefix in galleryImportApprovalStageError.
        setApprovalStage('Secure upload request', `Saving photo ${index + 1} of ${originals.length}…`);
        const uploadUrl = await withGalleryImportApprovalDeadline(
          () => getGalleryImportApprovalUploadUrl({ candidateId, capability: checkpoint.runCapability, leaseId: pending.leaseId, assetToken, contentType: original.contentType, byteLength: original.byteLength }),
          deadlineAtMs,
        );
        if (!uploadUrl.data || uploadUrl.error) throw new Error(uploadUrl.error?.message ?? 'Could not resume the photo upload.');
        setApprovalStage('Uploading selected photo', `Saving photo ${index + 1} of ${originals.length}…`);
        const upload = await withGalleryImportApprovalDeadline(
          () => uploadToPresignedUrl(uploadUrl.data!.uploadUrl, uri, original.contentType, uploadUrl.data!.requiredHeaders),
          deadlineAtMs,
        );
        if (upload.error) throw new Error(upload.error.message);
        setApprovalStage('Confirming secure upload', `Saving photo ${index + 1} of ${originals.length}…`);
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
    setApprovalStage('Finishing memory', 'Finishing…');
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
    // Presentation change from the former flow.tsx: rather than navigating
    // straight back to the deck, show the designed kept-confirmation
    // (GIApproveSuccess, gi-approve.jsx:200-247) and let the two buttons
    // there decide where to go next. Persistence above is unchanged.
  }, [candidate?.familyMemberIds.length, candidateId, checkpoint, resolveApprovalOriginal, runId, setApprovalStage, updateCheckpoint]);

  const markApprovalFailed = useCallback(async () => {
    await updateCheckpoint((current) => ({
      ...current,
      approvalOutbox: current.approvalOutbox.map((item) => item.candidateId === candidateId
        ? { ...item, status: 'failed', errorCode: item.status === 'finalizing' ? 'client_retryable_finalizing' : 'client_retryable' }
        : item),
    }));
  }, [candidateId, updateCheckpoint]);

  // Bumped on every showSaved call and captured per-call below, so a
  // background readyCandidates fetch from a stale call (or one that outlives
  // this component) can never clobber a newer saved result or update state
  // after unmount.
  const savedResultTokenRef = useRef(0);
  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  const showSaved = useCallback((source: GalleryImportCandidate, submittedCaption: string, submittedDate: string, assetCount: number) => {
    // The kept-confirmation must render the instant the save finishes --
    // saving already took several seconds of uploads, so this cannot also
    // wait on a network round-trip. Show it immediately with whatever count
    // is already known (or none), then fill in the real count in the
    // background.
    const token = ++savedResultTokenRef.current;
    // The deck's own cursor/total also count set-aside cards, so they can
    // never stand in for "how many suggestions are left to review" -- read
    // the run's own readyCandidates instead (a caller-supplied readyCount
    // wins when present and skips the fetch entirely; see the prop doc above).
    const initialRemaining: number | null = typeof readyCount === 'number' ? readyCount : null;
    setSavedResult({
      caption: submittedCaption,
      memoryDate: submittedDate,
      previewUri: source.previewUrls?.[0],
      assetCount,
      remaining: initialRemaining,
    });
    const capturedRunId = checkpoint?.runId;
    const capturedRunCapability = checkpoint?.runCapability;
    if (initialRemaining === null && capturedRunId && capturedRunCapability) {
      void getGalleryImportRun({ runId: capturedRunId, runCapability: capturedRunCapability }).then((response) => {
        if (!isMountedRef.current || savedResultTokenRef.current !== token) return;
        if (response.error || typeof response.data?.readyCandidates !== 'number') return;
        const remaining = response.data.readyCandidates;
        setSavedResult((current) => (current ? { ...current, remaining } : current));
      });
    }
  }, [checkpoint?.runId, checkpoint?.runCapability, readyCount]);

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
      // Snapshot the candidate's display data (caption/date/preview) for the
      // kept-confirmation screen *before* finalizing -- get-candidates omits
      // approved cards, so it must be captured while the candidate is still
      // 'ready'/'approving', not re-fetched afterward. This effect can auto-
      // trigger on mount (an already-pending outbox resumed from checkpoint)
      // before the refresh() effect has populated `candidate` state, so fall
      // back to a direct fetch rather than silently skipping the screen.
      const displayCandidate = candidateRef.current
        ?? (await getGalleryImportCandidates({ runId, capability: checkpoint.runCapability })).data?.candidates.find((item) => item.id === candidateId)
        ?? null;
      await completeApprovalOutbox(retryPending, deadlineAtMs);
      if (displayCandidate) showSaved(displayCandidate, displayCandidate.caption, displayCandidate.memoryDate, retryPending.assetTokens.length);
    } catch (caught) {
      setError(galleryImportApprovalStageError(approvalStageRef.current, caught));
      await markApprovalFailed();
    } finally {
      approvalActionInFlightRef.current = false;
      setIsSaving(false);
      setApprovalProgress(null);
    }
  }, [candidateId, checkpoint, clearApprovalStage, completeApprovalOutbox, familyId, markApprovalFailed, runId, showSaved, updateCheckpoint, userId]);

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
        setApprovalStage('Preparing selected photo', `Saving photo ${index + 1} of ${candidate.selectedAssetTokens.length}…`);
        originals.push(await resolveApprovalOriginal(adapter, candidate.selectedAssetTokens[index], deadlineAtMs));
      }
      setApprovalStage('Securing approval', `Saving photo 1 of ${candidate.selectedAssetTokens.length}…`);
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
      showSaved(candidate, candidate.caption, candidate.memoryDate, recoveredOutbox.assetTokens.length);
    } catch (caught) {
      setError(galleryImportApprovalStageError(approvalStageRef.current, caught));
      setIsOrphanRecoveryFailed(true);
    } finally {
      approvalActionInFlightRef.current = false;
      setIsSaving(false);
      setApprovalProgress(null);
    }
  }, [candidate, candidateId, checkpoint, clearApprovalStage, completeApprovalOutbox, familyId, resolveApprovalOriginal, runId, setApprovalStage, showSaved, updateCheckpoint, userId]);

  const submit = async () => {
    if (!checkpoint || !candidate || !runId || !candidateId || !userId || !familyId || approvalActionInFlightRef.current) return;
    const trimmedCaption = caption.trim();
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
        setApprovalStage('Preparing selected photo', `Saving photo ${index + 1} of ${assetTokens.length}…`);
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
      setApprovalStage('Securing approval', `Saving photo 1 of ${assetTokens.length}…`);
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
      showSaved(candidate, trimmedCaption, memoryDate, survivingTokens.length);
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
    if (savedResult || approvalActionInFlightRef.current) return;
    if (!candidate || candidate.status !== 'approving' || pendingApproval || isOrphanRecoveryFailed || recoveredCandidateRef.current === candidate.id) return;
    recoveredCandidateRef.current = candidate.id;
    void recoverOrphanedApproval();
  }, [candidate, isOrphanRecoveryFailed, pendingApproval, recoverOrphanedApproval, savedResult]);

  const removePhoto = useCallback((token: string) => {
    setAssetTokens((current) => current.filter((item) => item !== token));
  }, []);
  // Reorder support -- the shared composer's media grid allows long-press
  // drag like new-memory.tsx/edit.tsx; only the selection order (numbering)
  // is affected, not what gets committed.
  const moveMedia = useCallback((fromIndex: number, toIndex: number) => {
    setAssetTokens((current) => {
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      if (!moved) return current;
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, []);
  const applyChosenPhotos = useCallback((photos: GalleryImportChosenPhoto[]) => {
    setAssetTokens(photos.map((photo) => photo.assetToken).slice(0, GALLERY_IMPORT_MAX_PHOTOS));
    setLocalPhotoUris((current) => {
      const next = { ...current };
      for (const photo of photos) if (photo.uri) next[photo.assetToken] = photo.uri;
      return next;
    });
    setUnavailableTokens({});
  }, []);
  const openAddPhotos = useCallback(() => {
    if (!onAddPhotos || !candidate) return;
    onAddPhotos({ candidate, selectedAssetTokens: assetTokens, setPhotos: applyChosenPhotos });
  }, [applyChosenPhotos, assetTokens, candidate, onAddPhotos]);
  const markPhotoUnavailable = useCallback((token: string) => {
    setUnavailableTokens((current) => (current[token] ? current : { ...current, [token]: true }));
  }, []);
  const restoreDraft = useCallback(() => {
    if (!candidate) return;
    setCaption(candidate.caption);
    setIsCaptionEdited(false);
  }, [candidate]);

  const voiceMembers: VoiceFamilyMemberPayload[] = members.map((m) => ({ id: m.id, name: m.name, nicknames: m.nicknames ?? [], is_user_profile: m.is_user_profile }));
  const toggleMember = useCallback((memberId: string) => {
    setMemberIds((current) => current.includes(memberId) ? current.filter((id) => id !== memberId) : [...current, memberId]);
  }, []);

  if (isLoading || (!candidate && !pendingApproval && !savedResult)) return <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>;

  if (savedResult) {
    return (
      <GalleryImportApproveSuccess
        result={savedResult}
        onNext={() => { setSavedResult(null); router.replace({ pathname: '/(app)/gallery-import/review' as never, params: { runId } }); }}
        onStop={() => { setSavedResult(null); exitGalleryImportToTimeline(); }}
      />
    );
  }

  if (!candidate && pendingApproval) {
    const canRetry = pendingApproval.status === 'failed';
    return <SafeAreaView style={styles.screen}><Header title="Make it yours" /><View style={styles.empty}><Text style={styles.displaySmall}>Finishing your memory.</Text><Text style={styles.body}>Your save is still connected to this device. Momora will reuse it instead of creating another memory.</Text>{canRetry ? <PrimaryButton label={isSaving ? 'Saving…' : 'Retry saving'} onPress={() => void runApprovalOutbox(pendingApproval)} disabled={isSaving} testID="gallery-import-approval-retry" /> : <ActivityIndicator color={colors.primary} testID="gallery-import-approval-recovery" />}{approvalProgress ? <Text style={styles.footerHint} testID="gallery-import-approval-progress">{approvalProgress}</Text> : null}{error ? <Text style={styles.error} testID="gallery-import-approval-error">{error}</Text> : null}</View></SafeAreaView>;
  }
  if (!candidate) return null;

  const isApprovalLocked = Boolean(pendingApproval) || candidate.status === 'approving';
  const isRetry = pendingApproval?.status === 'failed' || isOrphanRecoveryFailed;
  const saveLabel = isRetry ? 'Retry saving' : (pendingApproval || candidate.status === 'approving') ? 'Continue saving' : 'Save';
  const saveTestID = isRetry ? 'gallery-import-approval-retry' : 'gallery-import-approve';
  // Synthesized as MediaAttachment so the shared composer's real media grid
  // (MemoryMediaPreview) can render these -- contentType/sizeBytes are
  // placeholders the grid never inspects for a non-video attachment. A
  // token with no resolvable uri (missing server preview and no local
  // day-pool uri yet) is proactively unavailable rather than waiting on an
  // Image onError round-trip.
  const items: MediaAttachment[] = assetTokens.map((token) => {
    const previewIndex = candidate.selectedAssetTokens.indexOf(token);
    const uri = (previewIndex >= 0 ? candidate.previewUrls?.[previewIndex] : undefined) ?? localPhotoUris[token] ?? '';
    return { id: token, uri, contentType: 'image/jpeg', sizeBytes: 0 };
  });
  const mediaUnavailableIds = items.filter((item) => !item.uri || unavailableTokens[item.id]).map((item) => item.id);
  const allPhotosUnavailable = items.length > 0 && mediaUnavailableIds.length === items.length;
  const canSave = isApprovalLocked || !allPhotosUnavailable;
  const formattedDate = memoryDate ? formatDisplayDate(memoryDate) : '';
  const typeBadge: MemoryComposerTypeBadge = { label: items.length === 1 ? 'Photo' : 'Photos', color: colors.ink2, bg: colors.surface, border: colors.border };

  const onSavePress = () => {
    if (pendingApproval) { void runApprovalOutbox(pendingApproval); return; }
    if (candidate.status === 'approving') { void recoverOrphanedApproval(); return; }
    void submit();
  };

  return (
    <MemoryComposerForm
      attachments={items}
      canSave={canSave}
      cancelTestID="gallery-import-approval-cancel"
      contentEditable={!isApprovalLocked}
      contentMaxLength={GALLERY_IMPORT_CAPTION_MAX_LENGTH}
      contentBelowSlot={isCaptionEdited ? (
        <Pressable disabled={isApprovalLocked} onPress={restoreDraft} testID="gallery-import-restore-draft">
          <Text style={styles.restoreDraftText}>Restore Momora’s draft</Text>
        </Pressable>
      ) : (
        <Text style={styles.captionHint}>Momora wrote this from the photos. Change anything.</Text>
      )}
      contentPlaceholder="What happened?"
      contentTestID="gallery-import-caption"
      contentValue={caption}
      dateAccessorySlot={(
        <View style={styles.fromPhotosPill}>
          <Text style={styles.fromPhotosPillText}>From the photos</Text>
        </View>
      )}
      dateLocked={isApprovalLocked}
      dateTestID="gallery-import-date"
      dateValue={memoryDate}
      errorMessage={error || undefined}
      errorTestID="gallery-import-approval-error"
      hasMediaRegion
      isSaving={isSaving}
      maxSelectedMembers={undefined}
      mediaDisabled={isApprovalLocked}
      mediaUnavailableIds={mediaUnavailableIds}
      members={members}
      noticeSlot={allPhotosUnavailable ? (
        <Text style={styles.error} testID="gallery-import-photos-unavailable">
          None of these photos could be shown here. Check your connection, or go back and choose different photos.
        </Text>
      ) : null}
      onAddMediaPress={onAddPhotos ? openAddPhotos : undefined}
      onCancel={() => router.back()}
      onContentChange={(text) => { setCaption(text); setIsCaptionEdited(true); }}
      onDateChange={setMemoryDate}
      onMediaImageError={markPhotoUnavailable}
      onMoveMedia={moveMedia}
      onRemoveMedia={removePhoto}
      onSave={onSavePress}
      onSelectMedia={setSelectedMediaId}
      onToggleMember={toggleMember}
      onVoicePress={() => setShowVoiceModal(true)}
      saveLabel={saveLabel}
      saveTestID={saveTestID}
      selectedMediaId={selectedMediaId}
      selectedMemberIds={memberIds}
      tagsLocked={isApprovalLocked}
      toolbarMediaButton={onAddPhotos ? (
        <MemoryMediaPicker
          compact
          disabled={isApprovalLocked || isSaving}
          onError={() => {}}
          onPress={openAddPhotos}
          onSelect={() => {}}
          testID="gallery-import-add-photos-trigger"
        />
      ) : undefined}
      toolbarTrailingSlot={(
        <Text style={styles.footerLine} testID="gallery-import-approval-progress">
          {approvalProgress ?? (isRetry ? 'Your existing save is safe to retry. Momora will not create a second memory.' : `Saves on ${formattedDate}, at full size.`)}
        </Text>
      )}
      typeBadge={typeBadge}
      voiceDisabled={isApprovalLocked || isSaving}
      voiceModalSlot={(
        <VoiceSpeakItModal
          familyMembers={voiceMembers}
          onDismiss={() => setShowVoiceModal(false)}
          onResult={(result) => {
            setCaption(result.cleanedText);
            setIsCaptionEdited(true);
            if (result.mentionedMemberIds.length > 0) {
              setMemberIds((current) => Array.from(new Set([...current, ...result.mentionedMemberIds])));
            }
            setShowVoiceModal(false);
          }}
          visible={showVoiceModal}
        />
      )}
      voiceTestID="gallery-import-voice-trigger"
    />
  );
}

// ── Saved -- gi-approve.jsx:200-247 ("GIApproveSuccess") ────────────────
function GalleryImportApproveSuccess({
  result,
  onNext,
  onStop,
}: {
  result: GalleryImportSavedResult;
  onNext: () => void;
  onStop: () => void;
}) {
  const formattedDate = result.memoryDate ? formatDisplayDate(result.memoryDate) : '';
  // The action stack is absolutely positioned, so the SafeAreaView's bottom
  // padding does not reach it (Yoga anchors absolute children to the border
  // box) -- pad the live system inset directly or the ghost action renders
  // behind the Android gesture/nav bar. This screen does not use
  // KeyboardStickyShell (its footer never needs to dodge a keyboard), so
  // unlike gallery-import-entry.tsx's shell-computed footer padding, the
  // inset is read directly here -- same math as the shell's own
  // getStickyFooterBottomPadding intent (top the design's usual gap up to a
  // floor, never double-counting the native inset since nothing else on
  // this absolutely-positioned view reserves it).
  const insets = useSafeAreaInsets();
  return (
    <SafeAreaView style={styles.screen} testID="gallery-import-approval-success">
      <ScrollView contentContainerStyle={styles.successContent}>
        <Pressable accessibilityLabel="Close" accessibilityRole="button" onPress={onStop} testID="gallery-import-approval-close">
          <Text style={styles.cancelText}>Close</Text>
        </Pressable>
        <Text style={styles.eyebrow}>Kept</Text>
        <Text style={styles.displaySmall}>It is in your{`\n`}journal now.</Text>
        <View style={styles.savedCard}>
          {result.previewUri ? (
            <Image contentFit="cover" source={{ uri: result.previewUri }} style={styles.savedCardImage} />
          ) : (
            <View style={styles.savedCardImageFallback}><Text style={styles.placeholderSun}>✦</Text></View>
          )}
          <Text style={styles.savedCardCaption}>{result.caption}</Text>
          <Text style={styles.savedCardMeta}>{formattedDate} · {result.assetCount} {result.assetCount === 1 ? 'photo' : 'photos'}</Text>
        </View>
      </ScrollView>
      <View
        style={[gi.stickyFooterSurface, styles.successActions, { paddingBottom: Math.max(spacing.xl, spacing.md + insets.bottom) }]}
        testID="gallery-import-approval-success-actions"
      >
        <PrimaryButton label={typeof result.remaining === 'number' ? `Next suggestion · ${result.remaining} left` : 'Next suggestion'} onPress={onNext} testID="gallery-import-approval-next" />
        <Pressable accessibilityRole="button" onPress={onStop} testID="gallery-import-approval-stop">
          <Text style={styles.ghostButton}>That is enough for now</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  empty: { flex: 1, gap: spacing.md, justifyContent: 'center', padding: spacing.lg },
  displaySmall: { color: colors.ink, fontFamily: fonts.display, fontSize: 31, lineHeight: 34, marginTop: 12 },
  body: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 14.5, lineHeight: 23, marginTop: 16 },
  footerHint: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 11.5, lineHeight: 16, textAlign: 'center' },
  error: { color: colors.error, fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 18, marginTop: spacing.md },
  cancelText: { fontFamily: fonts.sansBold, fontSize: 16, color: colors.primary },

  fromPhotosPill: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 5,
  },
  fromPhotosPillText: { fontFamily: fonts.sansBold, fontSize: 11, color: colors.ink2 },
  captionHint: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 11.5, lineHeight: 17 },
  restoreDraftText: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 12, paddingVertical: 2 },
  footerLine: { flex: 1, textAlign: 'right', color: colors.ink3, fontFamily: fonts.sans, fontSize: 11, lineHeight: 15 },

  eyebrow: { color: colors.ink3, fontFamily: fonts.sansBold, fontSize: 10, letterSpacing: 1.4, textTransform: 'uppercase', marginTop: spacing.md },
  successContent: { padding: spacing.lg, paddingBottom: 180 },
  savedCard: {
    marginTop: spacing.xl,
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: 12,
  },
  savedCardImage: { width: '100%', height: 168, borderRadius: radius.md, backgroundColor: colors.primaryTint },
  savedCardImageFallback: { width: '100%', height: 168, borderRadius: radius.md, backgroundColor: colors.primaryTint, alignItems: 'center', justifyContent: 'center' },
  placeholderSun: { color: colors.primary, fontSize: 34 },
  savedCardCaption: { color: colors.ink, fontFamily: fonts.display, fontSize: 18, lineHeight: 25, marginTop: 12 },
  savedCardMeta: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 12, marginTop: 9 },
  successActions: {
    // Visual surface (solid background + hairline top border) and
    // horizontal/top padding come from the composed gi.stickyFooterSurface;
    // this is only the positioning and the button-stack gap.
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    gap: 10,
  },
  ghostButton: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 13, padding: 8, textAlign: 'center' },
});
