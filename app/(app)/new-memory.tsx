import { navigateBack } from '@/lib/navigation';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import {
  ArtworkScanButton,
  ArtworkScanNotice,
  type ArtworkScanButtonHandle,
} from '@/components/artwork-scan-button';
import { PhotosIcon } from '@/components/icons/composer-icons';
import { MemoryComposerForm, type MemoryComposerTypeBadge } from '@/components/memory-composer-form';
import {
  MemoryMediaPicker,
  type MediaAttachment,
  type MemoryMediaPickerHandle,
} from '@/components/memory-media-picker';
import { VoiceSpeakItModal, type VoiceKeptClip } from '@/components/voice-speak-it-modal';
import { BringInSoundSheet } from '@/components/audio/bring-in-sound-sheet';
import { ClipChip } from '@/components/audio/clip-chip';
import { TrimSheet } from '@/components/audio/trim-sheet';
import { colors, fonts, spacing } from '@/constants/theme';
import { pickJournalingPrompt } from '@/constants/journaling-prompts';
import { useAudioClipPlayback } from '@/hooks/useAudioClipPlayback';
import { useAutoMemoryTags } from '@/hooks/useAutoMemoryTags';
import { useAuth } from '@/hooks/use-auth';
import { useBilling } from '@/hooks/use-billing';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useMemoryMutations } from '@/hooks/useMemories';
import { usePendingMemoryUploads } from '@/hooks/use-pending-memory-uploads';
import {
  SHARE_PHOTOS_REFUSED_SOUND_COPY,
  useComposerAudioClip,
} from '@/hooks/use-composer-audio-clip';
import { useIncomingMemoryShare } from '@/hooks/use-incoming-memory-share';
import { useSuggestedMemoryDate } from '@/hooks/use-suggested-memory-date';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useIsOnline } from '@/lib/connectivity';
import { parseNewMemoryAction } from '@/lib/routes';
import { trackEvent, type AnalyticsEventMap } from '@/services/analytics';
import { canEditFamilyContent } from '@/utils/roles';
import { deleteArtworkScanFile } from '@/utils/artwork-scan-custody';
import { sanitizeWaveform } from '@/utils/audio-waveform';
import { isDocumentPickerAvailable, pickAudioDocument } from '@/utils/document-picker';
import type { PrepareSharedMediaResult } from '@/utils/prepare-shared-media';
import { deleteShareCopies } from '@/utils/shared-file-cleanup';
import {
  clearNewMemoryDraft,
  isEmptyDraft,
  loadNewMemoryDraft,
  saveNewMemoryDraft,
} from '@/utils/new-memory-draft';
import {
  deriveMemoryType,
  MAX_ILLUSTRATION_MEMBERS,
  MAX_MEMORY_MEDIA_ASSETS,
  validateMemoryContent,
  validateMemoryDate,
} from '@/utils/memories';

import * as MomoraAudio from '../../modules/momora-audio';

// Incoming OS share while scanned artwork is attached (counterpart of
// SHARE_PHOTOS_REFUSED_SOUND_COPY in use-composer-audio-clip.ts).
const SHARE_PHOTOS_REFUSED_ARTWORK_COPY = 'This memory is artwork. Save it first, then share photos.';

// Debounced draft-autosave write delay -- long enough to coalesce
// keystrokes, short enough that an interruption rarely loses more than
// half a second of typing.
const DRAFT_SAVE_DEBOUNCE_MS = 500;

// Upper bound on waiting for the modal's `transitionEnd` before app-shortcut
// actions run anyway (the event may never fire on Android or without animation).
const PRESENTATION_SETTLE_FALLBACK_MS = 700;

function createMemoryId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

// `memory_saved.source` (docs/plans/analytics-tracking.md Tier 2) --
// normalizes the `source` route param (see `newMemoryRoute` in
// src/lib/routes.ts) into the event's closed union, defaulting to `'other'`
// for a bare open (no param) or anything unrecognized (e.g. a stale deep
// link from an older build).
function normalizeMemorySavedSource(raw: string | undefined): AnalyticsEventMap['memory_saved']['source'] {
  switch (raw) {
    case 'fab_timeline':
    case 'fab_calendar':
    case 'share_sheet':
    case 'notification':
    case 'shortcut_text':
    case 'shortcut_photo':
    case 'shortcut_voice':
    case 'shortcut_scan':
      return raw;
    default:
      return 'other';
  }
}

const TYPE_CONFIGS = {
  text_illustration: { label: 'Illustrated', color: colors.primary, bg: colors.primaryTint, border: colors.primarySoft },
  text_only:         { label: 'Text only',   color: colors.ink2,    bg: colors.surface,     border: colors.border },
  media_photo:       { label: 'Photo',        color: colors.ink2,    bg: colors.surface,     border: colors.border },
  media_video:       { label: 'Video',        color: colors.ink2,    bg: colors.surface,     border: colors.border },
  media_mixed:       { label: 'Media',        color: colors.ink2,    bg: colors.surface,     border: colors.border },
  media_artwork:     { label: 'Artwork',      color: colors.ink2,    bg: colors.surface,     border: colors.border },
  audio:             { label: 'Sound',        color: colors.seaInk,  bg: colors.seaSoft,     border: colors.sea },
} as const;

// `memory_saved` / `audio_memory_saved`'s duration bucketing (docs/plans/
// audio-memories-v1.md P2.6) -- kept coarse and non-identifying, same spirit
// as every other analytics property in this file.
function bucketAudioDurationMs(durationMs: number): AnalyticsEventMap['audio_memory_saved']['duration_bucket'] {
  const seconds = durationMs / 1000;
  if (seconds <= 15) return '0_15s';
  if (seconds <= 30) return '15_30s';
  if (seconds <= 60) return '30_60s';
  if (seconds <= 90) return '60_90s';
  if (seconds <= 120) return '90_120s';
  return '120_300s';
}

/** A tiny deterministic hash -- only used to pick a stable SoundTrace seed for an unsaved clip's local URI. */
function seedFromUri(uri: string): number {
  let hash = 0;
  for (let i = 0; i < uri.length; i += 1) {
    hash = (hash * 31 + uri.charCodeAt(i)) % 233280;
  }
  return Math.abs(hash) || 1;
}

export default function NewMemoryScreen() {
  const { source: rawSource, action: rawAction, actionId } = useLocalSearchParams<{
    source?: string;
    action?: string;
    actionId?: string;
  }>();
  const memorySavedSource = useMemo(() => normalizeMemorySavedSource(rawSource), [rawSource]);
  const { user } = useAuth();
  const { role, familyId } = useFamily();
  const { status: billingStatus, isLoading: isBillingLoading } = useBilling();
  const { members, isLoading: isLoadingMembers } = useFamilyMembers();
  const { createMemory, isCreating } = useMemoryMutations();
  const { enqueue: enqueuePendingMemoryUpload } = usePendingMemoryUploads();
  const { updateProfile } = useUserProfile();
  const [placeholderPrompt] = useState(() => pickJournalingPrompt());
  const isOnline = useIsOnline();

  useEffect(() => {
    if (
      !familyId ||
      !canEditFamilyContent(role) ||
      isBillingLoading ||
      !billingStatus ||
      billingStatus.has_write_access ||
      role !== 'owner' ||
      billingStatus.owner_user_id !== user?.id
    ) {
      return;
    }

    router.replace({
      pathname: '/(onboarding)/paywall',
      params: { mode: 'resubscribe', source: 'new_memory_bounce' },
    });
  }, [billingStatus, familyId, isBillingLoading, role, user?.id]);

  // Subscription ownership belongs to the family owner. A manager must never
  // be sent to a purchase screen or charged for an owner's lapsed access.
  // Keep the manager in the journal/read-only surface until the owner renews.
  useEffect(() => {
    if (
      !familyId ||
      role !== 'manager' ||
      isBillingLoading ||
      !billingStatus ||
      billingStatus.has_write_access
    ) {
      return;
    }
    navigateBack();
  }, [billingStatus, familyId, isBillingLoading, role]);

  // Guard on mount: viewers reaching this route directly (FAB is hidden for
  // them) get bounced back rather than seeing a form whose save would be
  // RLS-rejected.
  useEffect(() => {
    if (!canEditFamilyContent(role)) {
      navigateBack();
    }
  }, [role]);
  const [content, setContent] = useState('');
  const [attachedMedia, setAttachedMedia] = useState<MediaAttachment[]>([]);
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [illustrationEnabled, setIllustrationEnabled] = useState(true);
  const [showVoiceModal, setShowVoiceModal] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // Refs mirror the latest values of fields that async work (the draft
  // restore below, and the audio clip's trim / import completions) must read
  // live instead of through a stale closure. Synced in an effect (not during
  // render) to avoid mutating a ref as a render side effect;
  // handleContentChange also writes `contentRef` eagerly so a read that lands
  // before the next render still sees the keystroke.
  const contentRef = useRef(content);
  const attachedMediaRef = useRef(attachedMedia);
  // Mirrors `audio.isImporting` (hook state) for the artwork scan re-check.
  const audioImportingRef = useRef(false);

  // `memory_saved.used_voice` -- set once the Speak It modal ever hands back
  // a result, even if the user edits the transcribed text afterward. Imported
  // voice notes don't set it. Not reset on save (a fresh mount is a fresh
  // composer instance).
  const usedVoiceRef = useRef(false);

  const tagMembers = useMemo(
    () => members.map((m) => ({ id: m.id, name: m.name, nicknames: m.nicknames })),
    [members],
  );

  const handleSelectedMemberIdsChange = useCallback((memberIds: string[]) => {
    if (memberIds.length > MAX_ILLUSTRATION_MEMBERS) {
      setIllustrationEnabled(false);
    }
  }, []);

  const { selectedMemberIds, suppressedMemberIds, applyForContent, toggleMember, applyVoiceResult, initializeTags } = useAutoMemoryTags({
    members: tagMembers,
    enabled: true,
    onSelectedMemberIdsChange: handleSelectedMemberIdsChange,
  });

  const voiceMembers = useMemo(
    () => members.map((m) => ({ id: m.id, name: m.name, nicknames: m.nicknames ?? [], is_user_profile: m.is_user_profile })),
    [members],
  );

  // ── Bring-in-a-sound sheet (docs/plans/audio-trim-import.md "Modal hand-offs") ──
  // iOS won't present a Modal while another is still dismissing, so "Choose
  // from Files" closes the sheet, waits for its onDismissed, and only then
  // opens the system picker. The gate lets the must-trim sheet wait on the
  // same dismissal.
  const [isBringInVisible, setIsBringInVisible] = useState(false);
  const isBringInVisibleRef = useRef(false);
  const wantsFilePickRef = useRef(false);
  const bringInDismissGateRef = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);

  const closeBringInSheet = useCallback(() => {
    if (!isBringInVisibleRef.current) {
      return;
    }
    if (!bringInDismissGateRef.current) {
      let resolve!: () => void;
      const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
      });
      bringInDismissGateRef.current = { promise, resolve };
    }
    isBringInVisibleRef.current = false;
    setIsBringInVisible(false);
  }, []);

  const awaitModalsSettled = useCallback(
    () => bringInDismissGateRef.current?.promise ?? Promise.resolve(),
    [],
  );

  // ── Audio memories (docs/plans/audio-memories-v1.md P2.3, audio-trim-import.md) ──
  // A kept (or imported) clip makes this an emergent `audio` composer:
  // media/AI illustration hide, and `content` becomes the (optional)
  // description. The clip state machine -- keep, trim, import, the "user text
  // beats the AI caption" ratchet, file ownership -- lives in the hook.
  // Removing the clip is an Undo affordance (audioClipRemoved), never a type
  // flip.
  const audio = useComposerAudioClip({
    contentRef,
    attachedMediaRef,
    setContent,
    setErrorMessage,
    applyVoiceResult,
    members,
    voiceMembers,
    familyId,
    usedVoiceRef,
    awaitModalsSettled,
  });
  const {
    audioClip,
    audioClipRef,
    audioClipRemoved,
    audioNoteGenerating,
    importAudio,
    isAudio,
  } = audio;
  const { memoryDate, setMemoryDate, dateSource, suggestionKind } = useSuggestedMemoryDate({
    attachments: attachedMedia,
    audioCapturedAtIso: audio.suggestedDateIso,
  });
  const audioClipPlayback = useAudioClipPlayback(audioClip?.localUri ?? null);

  // Enqueueing a media post returns instantly, so React Query's isPending
  // can't guard the Save button like it did for the old inline mutation. The
  // ref blocks synchronous double-taps that land before the state re-render.
  const [isPostingMedia, setIsPostingMedia] = useState(false);
  const hasEnqueuedMediaRef = useRef(false);
  const handleIncomingSharePrepared = useCallback((result: PrepareSharedMediaResult) => {
    // Share copies still in the composer that this share is about to replace
    // (or clear) have nowhere else to go; a re-shared same-named file reuses
    // its path, so a copy the new set keeps is left alone.
    const releaseReplacedShareCopies = (keepUris: readonly string[]) => {
      void deleteShareCopies(
        attachedMediaRef.current
          .filter((attachment) => attachment.isShareCopy && !keepUris.includes(attachment.uri))
          .map((attachment) => attachment.uri),
      );
    };
    if (result.kind === 'audio') {
      // Routed into the same import pipeline as the in-app picker. The share
      // hook reports "preparing" until this callback returns; the import
      // flag it raises synchronously takes over, so a stored draft never
      // wins over a shared voice note.
      void importAudio({
        uri: result.uri,
        fileName: result.fileName,
        mimeType: result.mimeType,
        sizeBytes: result.sizeBytes,
        entry: 'share',
      });
      return;
    }
    // Scanned artwork can't be recovered once dropped, so an incoming share
    // never replaces it (same refuse stance as a kept sound, below). Checked
    // against the live attachments (a ref), not a render-time value.
    const scansAttached = attachedMediaRef.current.some((attachment) => attachment.source === 'scan');
    if (result.kind === 'error') {
      // A failed share must not wipe attached scans (their files would leak).
      if (!scansAttached) {
        releaseReplacedShareCopies([]);
        setAttachedMedia([]);
      }
      setErrorMessage(result.errorMessage);
      return;
    }
    if (scansAttached) {
      setErrorMessage(SHARE_PHOTOS_REFUSED_ARTWORK_COPY);
      return;
    }
    // A sound memory is a single clip with no mixed media: refuse photos
    // instead of silently dropping the clip or the photos. Checked against
    // the live clip (a ref), not a render-time value.
    if (audioClipRef.current) {
      // The refused photos / videos are never attached, so their copies are
      // deleted here.
      void deleteShareCopies(result.attachments.map((attachment) => attachment.uri));
      setErrorMessage(SHARE_PHOTOS_REFUSED_SOUND_COPY);
      return;
    }
    releaseReplacedShareCopies(result.attachments.map((attachment) => attachment.uri));
    setAttachedMedia(result.attachments);
    setErrorMessage(result.errorMessage ?? '');
  }, [audioClipRef, importAudio]);
  const isPreparingIncomingShare = useIncomingMemoryShare({
    onPrepared: handleIncomingSharePrepared,
  });

  const pickSoundFile = useCallback(async () => {
    const picked = await pickAudioDocument();
    if (!picked) {
      return;
    }
    await importAudio({
      uri: picked.uri,
      fileName: picked.name,
      mimeType: picked.mimeType,
      sizeBytes: picked.size,
      entry: 'picker',
    });
  }, [importAudio]);

  const handleBringInDismissed = useCallback(() => {
    const gate = bringInDismissGateRef.current;
    bringInDismissGateRef.current = null;
    gate?.resolve();
    if (wantsFilePickRef.current) {
      wantsFilePickRef.current = false;
      void pickSoundFile();
    }
  }, [pickSoundFile]);

  const handleOpenBringIn = useCallback(() => {
    isBringInVisibleRef.current = true;
    setIsBringInVisible(true);
  }, []);

  const handleChooseSoundFile = useCallback(() => {
    wantsFilePickRef.current = true;
    closeBringInSheet();
  }, [closeBringInSheet]);

  const handleCloseBringIn = useCallback(() => {
    wantsFilePickRef.current = false;
    closeBringInSheet();
  }, [closeBringInSheet]);

  const handleOpenTrim = useCallback(() => {
    // Whatever the chip is playing stops while the sheet is open (the sheet's
    // own preview claims the single playback slot when it plays).
    if (audioClipPlayback.playing) {
      void audioClipPlayback.toggle();
    }
    audio.openTrim();
  }, [audio, audioClipPlayback]);

  useEffect(() => {
    contentRef.current = content;
    attachedMediaRef.current = attachedMedia;
    audioImportingRef.current = audio.isImporting;
  });
  const selectedMemberIdsRef = useRef(selectedMemberIds);
  useEffect(() => {
    selectedMemberIdsRef.current = selectedMemberIds;
  });

  // ── Artwork scanning (docs/plans/artwork-scanning.md 3.4; feature doc
  // docs/features/artwork.md) ──
  // Scanned pages carry `source: 'scan'` and live in app-owned storage
  // (`artwork-scans/`), so unlike library picks they exist nowhere else: this
  // composer must delete the files it discards (removed tile, refused scan,
  // cancel/unmount without save). After a successful enqueue the pending
  // upload queue owns them (use-pending-memory-uploads.tsx).
  const hasArtwork = attachedMedia.some((attachment) => attachment.source === 'scan');
  const [scanNotice, setScanNotice] = useState('');

  const deleteScanFiles = useCallback((attachments: MediaAttachment[]) => {
    for (const attachment of attachments) {
      if (attachment.source === 'scan') {
        void deleteArtworkScanFile(attachment.uri);
      }
    }
  }, []);

  // A scan resolves long after it was started. Re-check the composer's
  // CURRENT state through refs (never this render's closure): if a sound was
  // kept (or is being imported), or non-scan media was attached meanwhile,
  // the pages can't join -- discard them (and their files) with an inline
  // explanation. The import side re-checks `attachedMediaRef` at its own
  // completion, so exactly one of the two wins.
  const handleArtworkScanned = useCallback(
    (scanned: MediaAttachment[]) => {
      const current = attachedMediaRef.current;
      const hasSound = audioClipRef.current !== null || audioImportingRef.current;
      if (hasSound || current.some((attachment) => attachment.source !== 'scan')) {
        deleteScanFiles(scanned);
        setScanNotice(
          hasSound
            ? 'This memory is a sound, so the scanned pages were discarded.'
            : 'This memory already has photos, so the scanned pages were discarded.',
        );
        return;
      }

      const room = Math.max(0, MAX_MEMORY_MEDIA_ASSETS - current.length);
      deleteScanFiles(scanned.slice(room));
      setErrorMessage('');
      setAttachedMedia((existing) => [...existing, ...scanned.slice(0, room)]);
    },
    [audioClipRef, deleteScanFiles],
  );

  // Leaving the composer without a successful enqueue (Cancel, system back,
  // swipe-down) abandons the scans. `hasEnqueuedMediaRef` stays true after a
  // successful enqueue, when the queue owns the files.
  useEffect(() => {
    return () => {
      if (hasEnqueuedMediaRef.current) {
        return;
      }
      deleteScanFiles(attachedMediaRef.current);
    };
  }, [deleteScanFiles]);

  // Photos / videos shared INTO Momora are private copies the app must delete
  // (src/utils/shared-file-cleanup.ts). Once the media save has been enqueued
  // the upload queue owns them; until then every way out of the composer
  // (Cancel, swipe-down, back, route replace) deletes whatever is still here.
  const releaseSharedAttachments = useCallback(() => {
    if (hasEnqueuedMediaRef.current) {
      return;
    }
    void deleteShareCopies(
      attachedMediaRef.current
        .filter((attachment) => attachment.isShareCopy)
        .map((attachment) => attachment.uri),
    );
  }, []);
  useEffect(() => releaseSharedAttachments, [releaseSharedAttachments]);

  const hasAttemptedDraftRestoreRef = useRef(false);
  const [isDraftRestoreReady, setIsDraftRestoreReady] = useState(false);

  // Restore a saved draft once per mount. Deferred while an incoming share
  // is still being prepared (`isPreparingIncomingShare`) or an imported voice
  // note is still coming in (`isImportingAudio`: reading, waiting on the
  // must-trim sheet, or rendering the cut) so a share/voice prefill always
  // wins -- a stored draft is only ever applied to an otherwise-empty form.
  // Media is never restored (see new-memory-draft.ts).
  const isImportingAudio = audio.isImporting;
  const isAudioBusy = audio.isProcessing;
  useEffect(() => {
    if (hasAttemptedDraftRestoreRef.current || isPreparingIncomingShare || isAudioBusy) {
      return;
    }
    if (!user?.id || !familyId) {
      return;
    }
    hasAttemptedDraftRestoreRef.current = true;

    let cancelled = false;
    void (async () => {
      try {
        const draft = await loadNewMemoryDraft(user.id, familyId);
        if (cancelled || !draft) {
          return;
        }

        const formIsEmpty =
          contentRef.current.trim().length === 0 &&
          selectedMemberIdsRef.current.length === 0 &&
          attachedMediaRef.current.length === 0 &&
          audioClipRef.current === null;
        if (!formIsEmpty) {
          return;
        }

        setContent(draft.content);
        if (draft.taggedMemberIds.length > 0) {
          initializeTags(draft.taggedMemberIds);
        }
        if (draft.memoryDate) {
          setMemoryDate(draft.memoryDate);
        }
        setIllustrationEnabled(draft.illustrationEnabled);
      } finally {
        if (!cancelled) {
          setIsDraftRestoreReady(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isPreparingIncomingShare, isAudioBusy, user?.id, familyId, initializeTags, setMemoryDate, audioClipRef]);

  // Auto-tag the sole family member so onboarding users can't save an
  // untagged memory (docs/plans/onboarding-illustration-reliability.md WS1).
  // Fires at most once per mount (hasSeededRef) and strictly after draft
  // restore has settled -- seeding first would make the form non-empty and
  // make the restore effect above silently discard a real draft. A draft
  // that already tagged someone, or a manual untag (suppressedMemberIds),
  // takes priority and this effect stays a no-op.
  const hasSeededRef = useRef(false);
  const seededMemberIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (hasSeededRef.current || isLoadingMembers || members.length !== 1) {
      return;
    }
    if (!isDraftRestoreReady) {
      return;
    }
    if (selectedMemberIds.length > 0 || suppressedMemberIds.length > 0) {
      return;
    }

    hasSeededRef.current = true;
    seededMemberIdRef.current = members[0].id;
    initializeTags([members[0].id]);
  }, [isLoadingMembers, members, isDraftRestoreReady, selectedMemberIds, suppressedMemberIds, initializeTags]);

  // Debounced write on any change to the persisted fields, once restore has
  // had its chance to run (avoids a premature empty-state save racing the
  // async read above).
  useEffect(() => {
    if (!isDraftRestoreReady || !user?.id || !familyId) {
      return;
    }

    const timeoutId = setTimeout(() => {
      const userId = user.id;
      const draft = { content, taggedMemberIds: selectedMemberIds, memoryDate, illustrationEnabled };
      // An untouched mount-time seed (no typing, no media, tags still
      // exactly the seeded member) isn't a real draft -- persisting it
      // would resurrect a stale single-member tag even after a second
      // member joins the family.
      const isUntouchedSeed =
        content.trim().length === 0 &&
        attachedMedia.length === 0 &&
        seededMemberIdRef.current !== null &&
        selectedMemberIds.length === 1 &&
        selectedMemberIds[0] === seededMemberIdRef.current;
      if (isEmptyDraft(draft) || isUntouchedSeed) {
        void clearNewMemoryDraft(userId, familyId);
      } else {
        void saveNewMemoryDraft(userId, familyId, draft);
      }
    }, DRAFT_SAVE_DEBOUNCE_MS);

    return () => clearTimeout(timeoutId);
  }, [isDraftRestoreReady, user?.id, familyId, content, selectedMemberIds, memoryDate, illustrationEnabled, attachedMedia]);

  const isIllustrationOverLimit = selectedMemberIds.length > MAX_ILLUSTRATION_MEMBERS;
  const isIllustrationEnabled = illustrationEnabled && !isIllustrationOverLimit;

  const memoryType = deriveMemoryType({
    hasAttachedMedia: attachedMedia.length > 0,
    illustrationEnabled: isIllustrationEnabled,
  });

  const typeKey =
    isAudio ? 'audio' :
    hasArtwork ? 'media_artwork' :
    attachedMedia.length > 1 ? 'media_mixed' :
    attachedMedia[0]?.contentType?.startsWith('video/') ? 'media_video' :
    attachedMedia.length > 0 ? 'media_photo' :
    memoryType === 'text_illustration' ? 'text_illustration' : 'text_only';
  const typeCfg = TYPE_CONFIGS[typeKey];

  const isSaving = isCreating || isPostingMedia;
  // An audio memory's description is optional (like a media caption) --
  // Save is gated on the clip being present, not on any text. Removing the
  // clip (Undo pending) disables Save until it's restored.
  //
  // A trim render or an import in flight also gates Save: a save landing
  // mid-render would hand the queue a clip that is about to be replaced (or,
  // mid-import, save a text memory the incoming sound should have joined).
  const canSave =
    !audio.isProcessing &&
    (isAudio
      ? !audioClipRemoved
      : memoryType === 'media' ? attachedMedia.length > 0 : content.trim().length > 0);

  // ── App shortcut action (docs/features/app-shortcuts.md) ──
  // `QuickActionRouter` hands over `action` + `actionId` as route params. Run
  // each actionId at most once -- back navigation, re-renders, resume and
  // remounting with the same params must never reopen the camera/recorder.
  // Waits until the screen will not bounce (billing / role) and the draft
  // restore has settled (it only applies to an otherwise-empty form).
  const mediaPickerRef = useRef<MemoryMediaPickerHandle>(null);
  const scanButtonRef = useRef<ArtworkScanButtonHandle>(null);
  const consumedActionIdRef = useRef<string | null>(null);
  const shortcutAction = parseNewMemoryAction(rawAction);
  // The route is a native modal: presenting the camera, scanner or recorder
  // while it is still animating in fails silently on iOS. Settle on the
  // stack's `transitionEnd` (fallback timer for Android / no animation) and
  // stay settled, so an action set on an already-open composer fires at once.
  const navigation = useNavigation();
  const [isPresentationSettled, setIsPresentationSettled] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setIsPresentationSettled(true), PRESENTATION_SETTLE_FALLBACK_MS);
    const unsubscribe = navigation.addListener(
      'transitionEnd' as never,
      ((event: { data?: { closing?: boolean } }) => {
        if (!event.data?.closing) setIsPresentationSettled(true);
      }) as never,
    );
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [navigation]);
  const isShortcutReady =
    isPresentationSettled &&
    canEditFamilyContent(role) &&
    !isBillingLoading &&
    billingStatus?.has_write_access === true &&
    !isLoadingMembers &&
    isDraftRestoreReady;
  useEffect(() => {
    if (!shortcutAction || !actionId || !isShortcutReady) return;
    if (consumedActionIdRef.current === actionId) return;
    consumedActionIdRef.current = actionId;

    if (shortcutAction === 'voice') {
      if (!(isSaving || audio.isProcessing)) setShowVoiceModal(true);
    } else if (shortcutAction === 'photo') {
      mediaPickerRef.current?.takePhoto();
    } else if (shortcutAction === 'scan') {
      scanButtonRef.current?.startScan();
    }
    router.setParams({ action: undefined, actionId: undefined });
  }, [shortcutAction, actionId, isShortcutReady, isSaving, audio.isProcessing]);

  const handleContentChange = (text: string) => {
    contentRef.current = text;
    setContent(text);
    applyForContent(text);
    // Once the user has typed anything, an AI-generated audio description
    // that arrives later must never clobber it (docs/plans/
    // audio-memories-v1.md P2.3 "user text always beats the AI caption").
    audio.markNoteTyped();
  };

  const handleKeepSound = (clip: VoiceKeptClip) => {
    audio.keepRecordedSound(clip);
    setShowVoiceModal(false);
  };

  const appendMedia = (attachments: MediaAttachment[]) => {
    setErrorMessage('');
    setAttachedMedia((current) => [...current, ...attachments].slice(0, MAX_MEMORY_MEDIA_ASSETS));
  };

  const moveMedia = (fromIndex: number, toIndex: number) => {
    setAttachedMedia((current) => {
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      if (!moved) {
        return current;
      }
      next.splice(toIndex, 0, moved);
      return next;
    });
  };

  const removeMedia = (attachmentId: string) => {
    const removed = attachedMedia.find((attachment) => attachment.id === attachmentId);
    if (removed) {
      deleteScanFiles([removed]);
    }
    if (removed?.isShareCopy) {
      void deleteShareCopies([removed.uri]);
    }
    setScanNotice('');
    setAttachedMedia((current) => current.filter((attachment) => attachment.id !== attachmentId));
    setSelectedMediaId((current) => (current === attachmentId ? null : current));
  };

  const finishSave = () => {
    void updateProfile({ hasCompletedOnboarding: true });
    navigateBack();
  };

  const handleSaveAudio = async () => {
    if (!audioClip || audioClipRemoved) {
      // Defensive -- canSave already gates the Save button on this.
      setErrorMessage('Keep a sound, or undo removing it, before saving.');
      trackEvent('memory_save_failed', { code: 'validation_error' });
      return;
    }
    const dateError = validateMemoryDate(memoryDate);
    if (dateError) {
      setErrorMessage(dateError);
      trackEvent('memory_save_failed', { code: 'validation_error' });
      return;
    }
    if (hasEnqueuedMediaRef.current) { return; }
    hasEnqueuedMediaRef.current = true;
    setIsPostingMedia(true);

    try {
      // A recording's waveform analysis may still be running; wait for it
      // briefly (<= 1.5 s) rather than save a seeded trace for a clip that
      // would have had a real one. Everything below is read AFTER the wait,
      // from live refs: the note, tags and transcript can change meanwhile.
      const clip = await audio.settleForSave();
      if (!clip) {
        hasEnqueuedMediaRef.current = false;
        setIsPostingMedia(false);
        return;
      }
      const memoryId = createMemoryId();
      const trimmedContent = contentRef.current.trim();
      const normalizedContent = trimmedContent.length > 0 ? trimmedContent : null;
      const transcript = audio.audioTranscriptRef.current;
      const normalizedTranscript = transcript && transcript.trim().length > 0 ? transcript.trim() : null;
      const pendingTranscription = audio.pendingTranscriptionRef.current;
      const taggedMemberIds = selectedMemberIdsRef.current;

      // Deferred posting, same as media -- the composer closes immediately
      // while the clip uploads in the background (docs/plans/
      // audio-memories-v1.md P2.3 seam contract). If transcription is still
      // in flight, the promise itself is handed to the queue rather than
      // patched here directly: the memories row isn't created until this
      // deferred post's insert completes, which typically finishes AFTER
      // transcription resolves -- a caller-side patch racing that insert
      // would silently no-op (a zero-row Supabase UPDATE succeeds with no
      // error), permanently losing the description/transcript in the
      // common fast-save case. use-pending-memory-uploads.tsx fires the
      // backfill only once the insert has actually succeeded.
      enqueuePendingMemoryUpload({
        kind: 'audio',
        memoryId,
        memoryDate: memoryDate.trim(),
        content: normalizedContent,
        taggedMemberIds,
        audioTranscript: normalizedTranscript,
        clip: {
          fileUri: clip.localUri,
          durationMs: clip.durationMs,
          contentType: 'audio/mp4',
          // The save path re-sanitizes; null (analysis missing/late/NaN)
          // keeps the seeded trace until a backfill re-run.
          waveform: sanitizeWaveform(clip.waveform),
        },
        pendingTranscription: pendingTranscription ?? undefined,
      });
      // The queue owns clip.localUri from here (retries re-read it). Only the
      // untrimmed-away original may go, and only if it is a different file.
      audio.markSaved(clip.localUri);

      trackEvent('memory_saved', {
        memory_type: 'audio',
        // Only a recording is the parent's own voice; an import is not.
        used_voice: clip.source === 'recorded',
        has_media: false,
        tagged_count: taggedMemberIds.length,
        illustration_enabled: false,
        is_artwork: false,
        source: memorySavedSource,
      });
      trackEvent('audio_memory_saved', {
        duration_bucket: bucketAudioDurationMs(clip.durationMs),
        has_description: normalizedContent !== null,
        source: clip.source,
        trimmed: clip.trimmed,
      });

      if (user?.id && familyId) {
        void clearNewMemoryDraft(user.id, familyId);
      }
      finishSave();
    } catch (error) {
      hasEnqueuedMediaRef.current = false;
      setIsPostingMedia(false);
      trackEvent('memory_save_failed', { code: 'network_error' });
      setErrorMessage(
        !isOnline
          ? "You're offline — your draft is safe; try again when you're back"
          : error instanceof Error ? error.message : 'Could not save memory',
      );
    }
  };

  const handleSave = async () => {
    setErrorMessage('');

    if (isAudio) {
      await handleSaveAudio();
      return;
    }

    const contentError = validateMemoryContent(content, memoryType);
    if (contentError) {
      setErrorMessage(contentError);
      trackEvent('memory_save_failed', { code: 'validation_error' });
      return;
    }
    const dateError = validateMemoryDate(memoryDate);
    if (dateError) {
      setErrorMessage(dateError);
      trackEvent('memory_save_failed', { code: 'validation_error' });
      return;
    }

    // Media memories never carry an AI illustration (deriveMemoryType routes
    // any attached media to 'media' regardless of the toggle) -- only
    // 'text_illustration' actually triggers generation.
    const illustrationEnabledForEvent = memoryType === 'text_illustration';

    try {
      if (memoryType === 'media') {
        if (attachedMedia.length === 0) {
          setErrorMessage('Attach a photo or video before saving.');
          trackEvent('memory_save_failed', { code: 'validation_error' });
          return;
        }
        if (hasEnqueuedMediaRef.current) { return; }
        hasEnqueuedMediaRef.current = true;
        setIsPostingMedia(true);
        // Media posting is deferred: the pending-uploads queue compresses and
        // uploads in the background while the user returns to the timeline,
        // which shows per-memory progress (Instagram-style).
        enqueuePendingMemoryUpload({
          memoryId: createMemoryId(),
          mediaAssets: attachedMedia.map((attachment) => ({
            fileUri: attachment.uri,
            mediaAssetId: attachment.id,
            contentType: attachment.contentType,
            durationMs: attachment.durationMs,
            aspectRatio: attachment.aspectRatio,
            // The queue deletes the share copy after a successful upload.
            ...(attachment.isShareCopy ? { deleteAfterUpload: true } : {}),
          })),
          content: content.trim() || undefined,
          memoryDate: memoryDate.trim(),
          taggedMemberIds: selectedMemberIds,
          // Scanned pages make this an artwork memory (immutable after
          // insert; the DB only allows images on it).
          mediaVariant: hasArtwork ? 'artwork' : undefined,
        });
        // `memory_saved` means the save gesture completed -- the media path
        // enqueues here and uploads in the background; a background upload
        // failure reports its own `memory_save_failed
        // {code:'media_upload_failed'}` from the queue's terminal-failure
        // transition (use-pending-memory-uploads.tsx), not here.
        trackEvent('memory_saved', {
          memory_type: memoryType,
          used_voice: usedVoiceRef.current,
          has_media: true,
          tagged_count: selectedMemberIds.length,
          illustration_enabled: illustrationEnabledForEvent,
          is_artwork: hasArtwork,
          source: memorySavedSource,
        });
      } else {
        await createMemory({
          content: content.trim(),
          memoryDate: memoryDate.trim(),
          taggedMemberIds: selectedMemberIds,
          memoryType,
        });
        trackEvent('memory_saved', {
          memory_type: memoryType,
          used_voice: usedVoiceRef.current,
          has_media: false,
          tagged_count: selectedMemberIds.length,
          illustration_enabled: illustrationEnabledForEvent,
          is_artwork: false,
          source: memorySavedSource,
        });
      }
      // Both paths are considered "posted" here: the media path enqueues
      // synchronously above (upload itself continues in the background),
      // and the text path just awaited its DB insert -- either way the
      // draft's job is done. Clear it now rather than waiting on upload
      // completion.
      if (user?.id && familyId) {
        void clearNewMemoryDraft(user.id, familyId);
      }
      finishSave();
    } catch (error) {
      hasEnqueuedMediaRef.current = false;
      setIsPostingMedia(false);
      trackEvent('memory_save_failed', { code: 'network_error' });
      // O6 (docs/plans/offline-awareness-and-share-cards.md): the text path
      // above awaits createMemory, a react-query mutation now pinned to
      // networkMode 'always' (see query-client.ts) -- offline, that fails
      // fast with a generic network error rather than the friendlier,
      // draft-reassuring copy this surface wants. Draft autosave already
      // protects the content; there's no queuing of text posts in this pass.
      setErrorMessage(
        !isOnline
          ? "You're offline — your draft is safe; try again when you're back"
          : error instanceof Error ? error.message : 'Could not save memory',
      );
    }
  };

  const hasMediaRegion = attachedMedia.length > 0 || isAudio;
  const dateAccessorySlot = dateSource === 'media' ? (
    // The accessibility announcement lives on the DatePickerField's
    // accessibilityHint below; this visible label is hidden from the
    // accessibility tree so screen readers don't announce it twice.
    <Text
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.dateSourceHint}
      testID="new-memory-date-source"
    >
      {suggestionKind === 'audio' ? 'From the voice note' : 'From media'}
    </Text>
  ) : null;

  // In sound mode the field doubles as the (optional) description, and
  // while Momora is still writing one from the recording it's replaced by
  // the generating placeholder (contentSlot) instead of the field itself.
  const contentSlot = isAudio && audioNoteGenerating && content.trim().length === 0 ? (
    <View style={styles.audioNoteGenerating} testID="new-memory-audio-note-generating">
      <View style={styles.audioNoteGeneratingLines}>
        <View style={[styles.audioNoteGeneratingBar, styles.audioNoteGeneratingBarWide]} />
        <View style={[styles.audioNoteGeneratingBar, styles.audioNoteGeneratingBarShort]} />
      </View>
      <Text style={styles.audioNoteGeneratingLabel}>
        {audioClip?.source === 'imported'
          ? 'Writing a note about this sound…'
          : 'Writing a note from what you said…'}
      </Text>
      <Pressable
        accessibilityLabel="Write my own note"
        accessibilityRole="button"
        onPress={audio.skipNoteGeneration}
        style={styles.audioNoteSkipBtn}
        testID="new-memory-audio-note-skip"
      >
        <SymbolView
          name={{ ios: 'pencil', android: 'edit' }}
          size={15}
          tintColor={colors.ink2}
          fallback={<Text style={styles.audioNoteSkipFallback}>✎</Text>}
        />
      </Pressable>
    </View>
  ) : undefined;

  // The clip -- its own compact height, not the photo slot's. Removing it
  // is Undo, never a type flip (docs/plans/audio-memories-v1.md P2.3).
  const noticeSlot = isAudio && audioClip ? (
    <View style={styles.audioClipWrap}>
      {!audioClipRemoved ? (
        <ClipChip
          durationSeconds={audioClip.durationMs / 1000}
          emotion={null}
          onRemove={audio.removeClip}
          // The scissors only exists with the native module and a loaded
          // analysis; while a render runs the chip shows its spinner and
          // locks remove (`processing`).
          onTrim={audio.canTrim ? handleOpenTrim : undefined}
          onToggle={() => { void audioClipPlayback.toggle(); }}
          playing={audioClipPlayback.playing}
          positionSeconds={audioClipPlayback.position}
          processing={audio.isRendering}
          progress={audioClipPlayback.progress}
          seed={seedFromUri(audioClip.localUri)}
          testID="new-memory-audio-clip"
          waveform={audioClip.waveform}
        />
      ) : (
        <View style={styles.audioClipRemovedRow} testID="new-memory-audio-clip-removed">
          <Text style={styles.audioClipRemovedText}>The sound is gone from this memory.</Text>
          <Pressable onPress={audio.undoRemoveClip} testID="new-memory-audio-clip-undo">
            <Text style={styles.audioClipUndoText}>Undo</Text>
          </Pressable>
        </View>
      )}
    </View>
  ) : undefined;

  return (
    <MemoryComposerForm
      attachments={attachedMedia}
      belowErrorSlot={(
        <>
          {scanNotice ? <ArtworkScanNotice message={scanNotice} testID="new-memory-scan-notice" /> : null}
          {isPreparingIncomingShare ? (
            <View style={styles.sharedMediaLoading} testID="new-memory-shared-media-loading">
              <ActivityIndicator color={colors.primary} size="small" />
              <Text style={styles.sharedMediaLoadingText}>Preparing shared media…</Text>
            </View>
          ) : isImportingAudio ? (
            <View style={styles.sharedMediaLoading} testID="new-memory-audio-import-loading">
              <ActivityIndicator color={colors.primary} size="small" />
              <Text style={styles.sharedMediaLoadingText}>Bringing in your sound…</Text>
            </View>
          ) : null}
        </>
      )}
      canSave={canSave}
      cancelTestID="new-memory-cancel"
      contentKey={isAudio ? 'audio-note' : 'text-note'}
      contentPlaceholder={isAudio ? 'Add a note about this sound' : placeholderPrompt}
      contentSlot={contentSlot}
      contentTestID="new-memory-content"
      contentValue={content}
      dateAccessibilityHint={
        dateSource === 'media'
          ? suggestionKind === 'audio'
            ? "Suggested from the voice note's date"
            : 'Suggested from media date'
          : undefined
      }
      dateAccessorySlot={dateAccessorySlot}
      datePlaceholder="Today"
      dateTestID="new-memory-date"
      dateValue={memoryDate}
      errorMessage={errorMessage || undefined}
      hasMediaRegion={hasMediaRegion}
      isSaving={isSaving}
      maxSelectedMembers={undefined}
      mediaHeaderLabel={hasArtwork ? 'Artwork' : undefined}
      members={members}
      noticeSlot={noticeSlot}
      onAddMediaPress={undefined}
      onCancel={() => {
        // The whole composer session is being abandoned -- any locally
        // claimed clip (kept, or currently hidden behind Undo), its original
        // and any import waiting on the trim sheet have nowhere else to go
        // and must not linger on disk. A render still reading the original
        // discards it itself once it finishes (see the hook).
        audio.abandon();
        releaseSharedAttachments();
        navigateBack();
      }}
      onContentChange={handleContentChange}
      onDateChange={setMemoryDate}
      onMoveMedia={moveMedia}
      onRemoveMedia={removeMedia}
      onSave={handleSave}
      onSelectMedia={setSelectedMediaId}
      onToggleMember={toggleMember}
      onVoicePress={() => setShowVoiceModal(true)}
      saveTestID="new-memory-save"
      selectedMediaId={selectedMediaId}
      selectedMemberIds={selectedMemberIds}
      toolbarMediaButton={(
        <>
          {!isAudio ? (
            <MemoryMediaPicker
              ref={mediaPickerRef}
              compact
              disabled={
                isSaving ||
                hasArtwork ||
                attachedMedia.length >= MAX_MEMORY_MEDIA_ASSETS ||
                isImportingAudio
              }
              includeCaptureDate
              onError={setErrorMessage}
              // "A sound or voice note" only when it can work: nothing attached
              // (a sound is single-clip, no mixed media -- scanned artwork
              // counts as attached media), the native module is in this
              // binary, and so is the document picker. Older binaries
              // receiving this JS by OTA simply don't get the option.
              onPickSound={
                attachedMedia.length === 0 && MomoraAudio.isAvailable() && isDocumentPickerAvailable()
                  ? handleOpenBringIn
                  : undefined
              }
              onSelect={appendMedia}
              remainingSlots={MAX_MEMORY_MEDIA_ASSETS - attachedMedia.length}
            />
          ) : (
            // Attach -- a sound memory is exclusive (single clip, no mixed
            // media), so this is inert while isAudio rather than a real picker
            // (docs/plans/audio-memories-v1.md P2.3 "media picker ... hidden").
            <View style={[styles.toolbarIconBtn, styles.toolbarIconBtnDisabled]}>
              <PhotosIcon disabled />
            </View>
          )}
          {/* Same element in both branches (stable position in the
              fragment) so a scan still in flight when a sound is kept
              keeps its mounted button and reaches handleArtworkScanned's
              refs re-check instead of being silently dropped. Scanning and
              library media are mutually exclusive; sound is too -- including
              while a sound is being imported or its trim is rendering
              (`audio.isProcessing`). */}
          <ArtworkScanButton
            ref={scanButtonRef}
            disabled={
              isSaving ||
              isAudio ||
              audio.isProcessing ||
              (attachedMedia.length > 0 && !hasArtwork) ||
              attachedMedia.length >= MAX_MEMORY_MEDIA_ASSETS
            }
            onError={setErrorMessage}
            onNotice={setScanNotice}
            onScanned={handleArtworkScanned}
            remainingSlots={MAX_MEMORY_MEDIA_ASSETS - attachedMedia.length}
            testID="new-memory-scan-artwork"
          />
        </>
      )}
      toolbarTrailingSlot={isAudio ? (
        <Text style={styles.audioToolbarHint}>Recording again replaces this sound.</Text>
      ) : !hasMediaRegion ? (
        <View style={styles.toggleRow}>
          <View style={styles.toggleCopy} testID="new-memory-ai-toggle-copy">
            <Text style={[styles.toggleLabel, !isIllustrationEnabled && styles.toggleLabelOff]}>
              AI illustration
            </Text>
            <Text style={styles.toggleHint}>
              {isIllustrationOverLimit
                ? `Up to ${MAX_ILLUSTRATION_MEMBERS} people per illustration`
                : illustrationEnabled
                  ? 'On — runs after save'
                  : 'Off — text only'}
            </Text>
          </View>
          <Switch
            accessibilityLabel="Generate AI illustration"
            disabled={isIllustrationOverLimit}
            onValueChange={setIllustrationEnabled}
            value={isIllustrationEnabled}
            trackColor={{ false: colors.border, true: colors.primary }}
            testID="new-memory-ai-toggle"
          />
        </View>
      ) : null}
      typeBadge={typeCfg as MemoryComposerTypeBadge}
      voiceDisabled={isSaving || audio.isProcessing}
      voiceModalSlot={(
        <>
        <VoiceSpeakItModal
          // Artwork can't carry a kept sound, so the mic only dictates the
          // caption there (no fork).
          captureMode={isAudio ? 'keepOnly' : hasArtwork ? 'dictate' : 'fork'}
          familyMembers={voiceMembers}
          onDismiss={() => setShowVoiceModal(false)}
          onKeepSound={handleKeepSound}
          onResult={(result) => {
            usedVoiceRef.current = true;
            audio.markNoteTyped();
            contentRef.current = result.cleanedText;
            setContent(result.cleanedText);
            // applyVoiceResult overwrites selectedMemberIds with the mention
            // match. With no name mentioned ("she took her first steps
            // today") and a single-member family, the match is empty and
            // would wipe an existing tag -- fall back to the sole member,
            // same as the mount-time seed above. Kept at the call site (not
            // in the hook) since the hook has no member-count policy.
            const mentionedMemberIds =
              result.mentionedMemberIds.length === 0 && members.length === 1
                ? [members[0].id]
                : result.mentionedMemberIds;
            applyVoiceResult({ ...result, mentionedMemberIds });
            setShowVoiceModal(false);
          }}
          visible={showVoiceModal}
        />
        <BringInSoundSheet
          onChooseFile={handleChooseSoundFile}
          onClose={handleCloseBringIn}
          onDismissed={handleBringInDismissed}
          testID="new-memory-bring-in-sound"
          visible={isBringInVisible}
        />
        {/* Mounted only while a trim session exists (the sheet owns an audio
            player) and unmounted once its Modal has fully dismissed. */}
        {audio.trimSheet.config ? (
          <TrimSheet
            durationMs={audio.trimSheet.config.durationMs}
            energies={audio.trimSheet.config.energies}
            bucketMs={audio.trimSheet.config.bucketMs}
            hasUserNote={audio.trimSheet.config.hasUserNote}
            initialRange={audio.trimSheet.config.initialRange}
            maxSelectionMs={audio.trimSheet.config.maxSelectionMs}
            mustTrim={audio.trimSheet.config.mustTrim}
            onCancel={audio.handleTrimCancel}
            onDismissed={audio.handleTrimSheetDismissed}
            onDone={audio.handleTrimDone}
            sourceUri={audio.trimSheet.config.sourceUri}
            suggested={audio.trimSheet.config.suggested}
            testID="new-memory-trim-sheet"
            visible={audio.trimSheet.visible}
          />
        ) : null}
        </>
      )}
      voiceTestID="new-memory-voice-trigger"
    />
  );
}

const styles = StyleSheet.create({
  dateSourceHint: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.ink3,
  },
  toggleRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    justifyContent: 'flex-end',
  },
  toggleCopy: {
    alignItems: 'flex-end',
    gap: 2,
    // RN's default flexShrink is 0. With the scan button added to the
    // toolbar (mic + photo + scan = 3 x 46 + gaps) the row is ~56pt
    // narrower, so the copy must shrink/wrap rather than push the Switch
    // off-screen at 360-375pt widths.
    flexShrink: 1,
  },
  toggleLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 12.5,
    color: colors.ink,
    textAlign: 'right',
  },
  toggleLabelOff: {
    color: colors.ink3,
  },
  toggleHint: {
    fontFamily: fonts.sans,
    fontSize: 11,
    color: colors.ink3,
    textAlign: 'right',
  },
  sharedMediaLoading: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  sharedMediaLoadingText: {
    color: colors.ink2,
    fontFamily: fonts.sans,
    fontSize: 13,
  },
  toolbarIconBtn: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolbarIconBtnDisabled: {
    opacity: 0.4,
  },
  audioNoteGenerating: {
    minHeight: 96,
    marginBottom: spacing.md,
  },
  audioNoteGeneratingLines: {
    gap: 14,
    paddingRight: 48,
    paddingTop: 4,
  },
  audioNoteGeneratingBar: {
    height: 18,
    borderRadius: 999,
    backgroundColor: colors.surface2,
  },
  audioNoteGeneratingBarWide: {
    width: '96%',
  },
  audioNoteGeneratingBarShort: {
    width: '58%',
  },
  audioNoteGeneratingLabel: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.ink3,
    marginTop: 12,
  },
  audioNoteSkipBtn: {
    position: 'absolute',
    top: -4,
    right: 0,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  audioNoteSkipFallback: {
    fontSize: 15,
    color: colors.ink2,
  },
  audioClipWrap: {
    marginBottom: spacing.md,
  },
  audioClipRemovedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.borderStrong,
    borderRadius: 18,
    paddingVertical: 16,
    paddingHorizontal: 18,
  },
  audioClipRemovedText: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.ink3,
  },
  audioClipUndoText: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    color: colors.primary,
  },
  audioToolbarHint: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 11,
    color: colors.ink3,
    textAlign: 'right',
    lineHeight: 14,
  },
});
