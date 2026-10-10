import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { seedFromKey } from '@/components/audio/audio-seed';
import { ArtworkScanButton, ArtworkScanNotice } from '@/components/artwork-scan-button';
import { PhotosIcon, ScanArtIcon } from '@/components/icons/composer-icons';
import { ClipChip } from '@/components/audio/clip-chip';
import { TrimSheet } from '@/components/audio/trim-sheet';
import { MemoryComposerForm, type MemoryComposerTypeBadge } from '@/components/memory-composer-form';
import {
  MemoryMediaPicker,
  type MediaAttachment,
} from '@/components/memory-media-picker';
import { VoiceSpeakItModal } from '@/components/voice-speak-it-modal';
import { colors, fonts, spacing } from '@/constants/theme';
import { useAudioClipPlayback } from '@/hooks/useAudioClipPlayback';
import { useAutoMemoryTags } from '@/hooks/useAutoMemoryTags';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { bucketSavedTrimRemovedMs, useSavedAudioTrim } from '@/hooks/use-saved-audio-trim';
import { useMemory, useMemoryMutations, type MediaAssetUploadPhase } from '@/hooks/useMemories';
import { useMediaUrl, useMediaUrls } from '@/hooks/useMediaUrls';
import { isArtworkScannerAvailable } from '@/services/artwork-scanner';
import { useIsOnline } from '@/lib/connectivity';
import { trackEvent } from '@/services/analytics';
import { patchAudioDescriptionIfEmpty } from '@/services/memories';
import { MediaAssetUploadError } from '@/services/memory-posting';
import { transcribeClip } from '@/services/voice-transcription';
import { deleteArtworkScanFile } from '@/utils/artwork-scan-custody';
import { discardAudioClip } from '@/utils/audio-clip-custody';
import { mediaImageSource } from '@/utils/media-image-source';
import {
  describeEditSaveError,
  summarizeMediaSaveProgress,
  type MediaSaveProgressEntry,
} from '@/utils/media-save-progress';
import { isVideoContentType } from '@/utils/media-validation';
import {
  isArtworkMemory,
  isKnownMemoryType,
  MAX_ILLUSTRATION_MEMBERS,
  MAX_MEMORY_MEDIA_ASSETS,
} from '@/utils/memories';
import { canEditFamilyContent } from '@/utils/roles';

import * as MomoraAudio from '../../../../modules/momora-audio';

const TYPE_CONFIGS = {
  text_illustration: { label: 'Illustrated', color: colors.primary, bg: colors.primaryTint, border: colors.primarySoft },
  text_only:         { label: 'Text only',   color: colors.ink2,    bg: colors.surface,     border: colors.border },
  media_photo:       { label: 'Photo',        color: colors.ink2,    bg: colors.surface,     border: colors.border },
  media_video:       { label: 'Video',        color: colors.ink2,    bg: colors.surface,     border: colors.border },
  media_mixed:       { label: 'Media',        color: colors.ink2,    bg: colors.surface,     border: colors.border },
  media_artwork:     { label: 'Artwork',      color: colors.ink2,    bg: colors.surface,     border: colors.border },
  audio:             { label: 'Sound',        color: colors.seaInk,  bg: colors.seaSoft,     border: colors.sea },
} as const;

const EMPTY_MEDIA_URLS: Record<string, string> = {};

export default function EditMemoryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { role, familyId } = useFamily();
  const isOnline = useIsOnline();
  // isPlaceholderData: useMemory seeds from the timeline list cache for an
  // instant detail paint, but the edit form must only initialize from
  // server-fresh data -- initializing from a stale cached copy and saving
  // would silently overwrite edits made on another device.
  const { data: memory, isLoading, isPlaceholderData } = useMemory(id);
  const { members } = useFamilyMembers();
  const { updateMemory, isUpdating } = useMemoryMutations();

  // Guard on mount: viewers reaching this route via a deep link or stale
  // navigation state get bounced back rather than seeing an edit form whose
  // save would be RLS-rejected.
  useEffect(() => {
    if (!canEditFamilyContent(role)) {
      router.back();
    }
  }, [role]);
  const { url: illustrationUrl } = useMediaUrl(
    memory?.illustration_key ?? null,
    memory?.updated_at,
  );
  const { url: mediaUrl } = useMediaUrl(
    memory?.memory_type === 'media' ? (memory.media_key ?? null) : null,
    memory?.updated_at,
  );
  const mediaKeys = useMemo(
    () => memory?.mediaAssets.map((asset) => asset.object_key) ?? [],
    [memory?.mediaAssets],
  );
  const { data: mediaUrlData } = useMediaUrls(mediaKeys, memory?.updated_at);
  const mediaUrls = mediaUrlData ?? EMPTY_MEDIA_URLS;

  const [content, setContent] = useState('');
  const [memoryDate, setMemoryDate] = useState('');
  const [attachedMedia, setAttachedMedia] = useState<MediaAttachment[]>([]);
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [hasEditedContent, setHasEditedContent] = useState(false);
  const [illustrationEnabled, setIllustrationEnabled] = useState(false);
  const [showVoiceModal, setShowVoiceModal] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [scanNotice, setScanNotice] = useState('');
  // Scanned pages appended to an artwork memory live in app-owned storage
  // (`artwork-scans/`) until the save below uploads them. Delete the files we
  // discard: removed tiles, and everything on leaving without a save.
  const attachedMediaRef = useRef(attachedMedia);
  const hasSavedRef = useRef(false);
  useEffect(() => {
    attachedMediaRef.current = attachedMedia;
  });
  useEffect(() => {
    return () => {
      if (hasSavedRef.current) {
        return;
      }
      for (const attachment of attachedMediaRef.current) {
        if (attachment.source === 'scan') {
          void deleteArtworkScanFile(attachment.uri);
        }
      }
    };
  }, []);
  // Keyed by index into the attachedMedia array being saved; only newly added
  // (not yet uploaded) assets get an entry. Null when no upload is running.
  const [uploadProgress, setUploadProgress] = useState<Record<number, MediaSaveProgressEntry> | null>(null);
  const lastReportedProgressRef = useRef<Record<number, string>>({});

  const tagMembers = useMemo(
    () => members.map((m) => ({ id: m.id, name: m.name, nicknames: m.nicknames })),
    [members],
  );

  const handleSelectedMemberIdsChange = useCallback((memberIds: string[]) => {
    if (memberIds.length > MAX_ILLUSTRATION_MEMBERS) {
      setIllustrationEnabled(false);
    }
  }, []);

  const { selectedMemberIds, initializeTags, applyForContent, toggleMember, applyVoiceResult } =
    useAutoMemoryTags({
      members: tagMembers,
      enabled: hasEditedContent,
      onSelectedMemberIdsChange: handleSelectedMemberIdsChange,
    });

  useEffect(() => {
    if (memory && !isPlaceholderData && !isInitialized) {
      setContent(memory.content ?? '');
      setMemoryDate(memory.memory_date);
      setAttachedMedia(
        memory.mediaAssets.map((asset) => ({
          id: asset.id,
          uri: mediaUrls[asset.object_key] ?? mediaUrl ?? '',
          objectKey: asset.object_key,
          contentType: asset.content_type,
          durationMs: asset.duration_ms ?? undefined,
          aspectRatio: asset.aspect_ratio ?? undefined,
          sizeBytes: 1,
        })),
      );
      initializeTags(memory.taggedMembers.map((m) => m.id));
      setIllustrationEnabled(memory.memory_type === 'text_illustration');
      setIsInitialized(true);
    }
  }, [memory, isPlaceholderData, mediaUrls, mediaUrl, isInitialized, initializeTags]);

  useEffect(() => {
    if (!isInitialized) {
      return;
    }

    setAttachedMedia((current) => {
      let hasUrlChange = false;
      const next = current.map((attachment) => {
        if (!attachment.objectKey) {
          return attachment;
        }

        const nextUrl = mediaUrls[attachment.objectKey];
        if (!nextUrl || nextUrl === attachment.uri) {
          return attachment;
        }

        hasUrlChange = true;
        return { ...attachment, uri: nextUrl };
      });

      return hasUrlChange ? next : current;
    });
  }, [isInitialized, mediaUrls]);

  const isMedia = memory?.memory_type === 'media';
  // Audio is exclusive: description/date/tags are editable and the clip can
  // only be TRIMMED (never replaced or re-recorded) -- no media picker, no
  // AI-illustration toggle, mic disabled.
  const isAudio = memory?.memory_type === 'audio';
  // Artwork is derived from the memory row, never from attachment `source`
  // (a loaded memory's assets carry none). Library photos/videos can't be
  // added to a scanned-artwork memory -- docs/plans/artwork-scanning.md,
  // decision 5.
  const isArtwork = memory ? isArtworkMemory(memory) : false;
  const isIllustrationOverLimit = selectedMemberIds.length > MAX_ILLUSTRATION_MEMBERS;
  const isIllustrationEnabled = illustrationEnabled && !isIllustrationOverLimit;
  const hasRetainedIllustration = Boolean(memory?.illustration_key);
  const isIllustrationJobInProgress = ['pending', 'generating'].includes(
    memory?.illustration_status ?? '',
  );
  const hasIllustrationHistory = Boolean(
    memory?.illustration_key ||
      (memory?.illustration_status && memory.illustration_status !== 'none'),
  );

  const audioClipAsset = isAudio ? memory?.mediaAssets[0] ?? null : null;
  const audioClipKey = audioClipAsset?.object_key ?? memory?.media_key ?? null;
  const { url: audioClipUrl } = useMediaUrl(isAudio ? audioClipKey : null, memory?.updated_at);
  // Post-save trim (docs/plans/audio-trim-import.md addendum): a pending trim
  // is a local render held until Save; the chip previews it in the meantime.
  const contentRef = useRef(content);
  useEffect(() => {
    contentRef.current = content;
  }, [content]);
  const hasUserNote = useCallback(() => contentRef.current.trim().length > 0, []);
  const trim = useSavedAudioTrim({
    audioClipUrl,
    isOnline,
    hasUserNote,
    setErrorMessage,
  });
  const pendingTrim = isAudio ? trim.pending : null;
  const audioClipPlayback = useAudioClipPlayback(pendingTrim?.localUri ?? audioClipUrl);
  const audioDurationSeconds = pendingTrim
    ? pendingTrim.durationMs / 1000
    : (audioClipAsset?.duration_ms ?? 0) / 1000;
  const canShowTrim =
    isAudio &&
    canEditFamilyContent(role) &&
    MomoraAudio.isAvailable() &&
    !isUpdating &&
    (isOnline || trim.isBusy);

  const typeKey =
    isArtwork
      ? 'media_artwork'
      : memory?.memory_type === 'media' && attachedMedia.length > 1
      ? 'media_mixed'
      : memory?.memory_type === 'media' && memory.media_content_type?.startsWith('video/')
      ? 'media_video'
      : memory?.memory_type === 'media'
      ? 'media_photo'
      : isAudio
      ? 'audio'
      : isIllustrationEnabled
      ? 'text_illustration'
      : 'text_only';
  const typeCfg = TYPE_CONFIGS[typeKey];

  const hasAttachment =
    isMedia ||
    isAudio ||
    (isIllustrationEnabled && (hasRetainedIllustration || isIllustrationJobInProgress));
  const canSave = isMedia
    ? attachedMedia.length > 0
    : isAudio
      ? !trim.isBusy
      : content.trim().length > 0;

  const voiceMembers = useMemo(
    () => members.map((m) => ({ id: m.id, name: m.name, nicknames: m.nicknames ?? [], is_user_profile: m.is_user_profile })),
    [members],
  );

  const handleContentChange = (text: string) => {
    setHasEditedContent(true);
    setContent(text);
    applyForContent(text);
  };

  const appendMedia = (attachments: MediaAttachment[]) => {
    setErrorMessage('');
    setAttachedMedia((current) => [...current, ...attachments].slice(0, MAX_MEMORY_MEDIA_ASSETS));
  };

  // Scanned pages joining an artwork memory (docs/plans/artwork-scanning.md
  // 3.6). Resolves long after the tap, so room is computed from the ref.
  const handleArtworkScanned = (scanned: MediaAttachment[]) => {
    const room = Math.max(0, MAX_MEMORY_MEDIA_ASSETS - attachedMediaRef.current.length);
    for (const overflow of scanned.slice(room)) {
      void deleteArtworkScanFile(overflow.uri);
    }
    appendMedia(scanned.slice(0, room));
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
    if (attachedMedia.length <= 1) {
      setErrorMessage('Media memories need at least one photo or video.');
      return;
    }

    const removed = attachedMedia.find((attachment) => attachment.id === attachmentId);
    if (removed?.source === 'scan') {
      void deleteArtworkScanFile(removed.uri);
    }
    setScanNotice('');
    setAttachedMedia((current) => current.filter((attachment) => attachment.id !== attachmentId));
    setSelectedMediaId((current) => (current === attachmentId ? null : current));
  };

  const reportMediaProgress = useCallback(
    (index: number, phase: MediaAssetUploadPhase, fraction: number) => {
      // Native progress callbacks fire per chunk/frame -- only re-render when
      // the phase changes or the visible percentage moves.
      const key = `${phase}:${Math.floor(fraction * 100)}`;
      if (lastReportedProgressRef.current[index] === key) {
        return;
      }
      lastReportedProgressRef.current[index] = key;
      setUploadProgress((current) =>
        current?.[index] ? { ...current, [index]: { ...current[index], phase, fraction } } : current,
      );
    },
    [],
  );

  const confirmingTrimRef = useRef(false);

  const handleSave = () => {
    if (!id) return;
    if (!pendingTrim) {
      void performSave();
      return;
    }
    // A saved trim is permanent (the old clip is deleted), so confirm first.
    if (confirmingTrimRef.current) return;
    confirmingTrimRef.current = true;
    Alert.alert(
      'Trim this sound?',
      'The part you cut will be gone for good.',
      [
        {
          text: 'Cancel',
          style: 'cancel',
          onPress: () => {
            confirmingTrimRef.current = false;
          },
        },
        {
          text: 'Trim and save',
          onPress: () => {
            confirmingTrimRef.current = false;
            void performSave();
          },
        },
      ],
      {
        cancelable: true,
        onDismiss: () => {
          confirmingTrimRef.current = false;
        },
      },
    );
  };

  const performSave = async () => {
    setErrorMessage('');
    if (!id) return;
    const savingMedia = attachedMedia;
    const savingTrim = pendingTrim;
    if (isMedia) {
      const newEntries: Record<number, MediaSaveProgressEntry> = {};
      savingMedia.forEach((attachment, index) => {
        if (!attachment.objectKey) {
          newEntries[index] = {
            isVideo: isVideoContentType(attachment.contentType),
            phase: 'waiting',
            fraction: 0,
          };
        }
      });
      lastReportedProgressRef.current = {};
      setUploadProgress(Object.keys(newEntries).length > 0 ? newEntries : null);
    }
    try {
      // Always send content -- `undefined` means "unchanged" to updateMemory,
      // so mapping an emptied caption to undefined would silently keep the
      // old caption. An empty string clears it (media memories allow empty;
      // text memories can't reach here empty because canSave blocks them).
      await updateMemory({
        memoryId: id,
        content: content.trim(),
        memoryDate: memoryDate.trim(),
        taggedMemberIds: selectedMemberIds,
        memoryType: isMedia
          ? 'media'
          : isAudio
            ? 'audio'
            : isIllustrationEnabled
              ? 'text_illustration'
              : 'text_only',
        // Never sent for audio: a trimmed clip travels as `audioClip` below
        // (its own upload path), never as photo/video `mediaAssets`.
        mediaAssets: isMedia
          ? savingMedia.map((attachment) => ({
              objectKey: attachment.objectKey,
              fileUri: attachment.objectKey ? undefined : attachment.uri,
              mediaAssetId: attachment.id,
              contentType: attachment.contentType,
              durationMs: attachment.durationMs,
              aspectRatio: attachment.aspectRatio,
            }))
          : undefined,
        audioClip: savingTrim
          ? {
              fileUri: savingTrim.localUri,
              durationMs: savingTrim.durationMs,
              waveform: savingTrim.waveform,
            }
          : undefined,
        onMediaProgress: isMedia ? reportMediaProgress : undefined,
      });
      // Uploaded: the scanned pages now live in R2.
      hasSavedRef.current = true;
      for (const attachment of savingMedia) {
        if (attachment.source === 'scan') {
          void deleteArtworkScanFile(attachment.uri);
        }
      }
      if (savingTrim) {
        finishTrimmedSave(id, savingTrim);
      }
      router.back();
    } catch (error) {
      const failedAttachment =
        error instanceof MediaAssetUploadError ? savingMedia[error.assetIndex] : undefined;
      setErrorMessage(
        describeEditSaveError(
          error,
          failedAttachment && error instanceof MediaAssetUploadError
            ? { position: error.assetIndex + 1, contentType: failedAttachment.contentType }
            : undefined,
        ),
      );
    } finally {
      setUploadProgress(null);
    }
  };

  // After a successful trimmed save: tell analytics, then rebuild the hidden
  // transcript (and an empty description) from the NEW clip in the background.
  // The local files must outlive the transcription (it reads the render), so
  // they are deleted only once it settles. Never blocks navigation.
  const finishTrimmedSave = (memoryId: string, savedTrim: NonNullable<typeof pendingTrim>) => {
    trackEvent('audio_trim_applied', {
      source: 'saved',
      removed_bucket: bucketSavedTrimRemovedMs(savedTrim.removedMs),
    });
    const handedOff = trim.handOffFiles();
    const files = handedOff?.uris ?? [savedTrim.localUri];
    void transcribeClip(savedTrim.localUri, voiceMembers, familyId, {
      durationMs: savedTrim.durationMs,
      sizeBytes: savedTrim.sizeBytes,
    })
      .then(async (result) => {
        if (!result) return;
        await patchAudioDescriptionIfEmpty(memoryId, {
          description: result.description.trim() || null,
          transcript: result.cleanedText.trim() || null,
        });
      })
      .catch(() => {})
      .finally(() => {
        for (const uri of files) {
          void discardAudioClip(uri);
        }
      });
  };

  const uploadSummary = uploadProgress
    ? summarizeMediaSaveProgress(Object.values(uploadProgress))
    : null;

  if (isLoading || isPlaceholderData || !isInitialized) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.centered}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (!memory) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.centered}>
          <Text style={styles.errorText}>Memory not found</Text>
        </View>
      </SafeAreaView>
    );
  }

  // Forward-compat fallback (P0.1): a `memory_type` this build doesn't
  // recognize yet (a hypothetical future type -- 'audio' itself is now
  // known and editable, see the `isAudio` branch below) previously opened
  // as a misleadingly-empty "Text only" note -- saving couldn't corrupt the
  // row (updateMemory's `memoryType` write is always one of the four known
  // types), but the form itself was misleading. Read-only instead: no
  // type-editing affordances, Save disabled.
  if (!isKnownMemoryType(memory.memory_type)) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.headerTextBtn} testID="edit-memory-cancel">
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
          <View style={styles.headerSpacer} />
          <Pressable disabled style={styles.headerTextBtn} testID="edit-memory-save-btn">
            <Text style={[styles.saveText, styles.saveTextDisabled]}>Save</Text>
          </Pressable>
        </View>
        <View style={styles.centered}>
          <Text style={styles.unavailableNotice} testID="edit-memory-unavailable-notice">
            This memory needs a newer version of Momora to edit.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const illustrationSlot = isIllustrationEnabled && (hasRetainedIllustration || isIllustrationJobInProgress) ? (
    illustrationUrl ? (
      <Image
        source={mediaImageSource(illustrationUrl, memory?.illustration_key)}
        style={styles.attachmentImage}
        contentFit="cover"
        accessibilityLabel="Memory illustration"
      />
    ) : (
      <View style={styles.attachmentPlaceholder}>
        <Text style={styles.placeholderIcon}>✦</Text>
        <Text style={styles.placeholderText}>Illustration generating…</Text>
      </View>
    )
  ) : null;

  // The clip -- recessed, no remove control. Description/tags/date are
  // editable; the scissors (when the native module, permission and network
  // allow) cut the clip down, saved with the memory.
  const noticeSlot = isAudio ? (
    <View style={styles.audioClipWrap}>
      <ClipChip
        durationSeconds={audioDurationSeconds}
        emotion={memory.emotion}
        onToggle={() => void audioClipPlayback.toggle()}
        onTrim={canShowTrim ? () => void trim.openTrim() : undefined}
        playing={audioClipPlayback.playing}
        positionSeconds={audioClipPlayback.position}
        processing={trim.isBusy}
        progress={audioClipPlayback.progress}
        recessed
        seed={seedFromKey(memory.id)}
        testID="edit-memory-audio-clip"
        waveform={pendingTrim ? pendingTrim.waveform : (audioClipAsset?.waveform ?? null)}
      />
      <Text style={styles.audioClipCaption} testID="edit-memory-audio-caption">
        {pendingTrim ? 'Trimmed — saves when you tap Save' : 'Kept as recorded'}
      </Text>
    </View>
  ) : undefined;

  return (
    <MemoryComposerForm
      attachments={attachedMedia}
      canSave={canSave}
      cancelTestID="edit-memory-cancel"
      contentPlaceholder="What happened on this day?"
      contentTestID="edit-memory-content"
      contentValue={content}
      dateTestID="edit-memory-date"
      dateValue={memoryDate}
      errorMessage={errorMessage || undefined}
      errorTestID="edit-memory-error"
      belowErrorSlot={(
        <>
          {scanNotice ? <ArtworkScanNotice message={scanNotice} testID="edit-memory-scan-notice" /> : null}
          {uploadSummary ? (
            <View
              accessibilityLabel={uploadSummary.label}
              accessibilityLiveRegion="polite"
              style={styles.uploadProgress}
              testID="edit-memory-upload-progress"
            >
              <Text style={styles.uploadProgressLabel}>{uploadSummary.label}</Text>
              <View style={styles.uploadProgressTrack}>
                <View
                  style={[
                    styles.uploadProgressFill,
                    // Never sit at 0 -- a sliver reads as "working".
                    { width: `${Math.max(uploadSummary.fraction, 0.03) * 100}%` },
                  ]}
                />
              </View>
            </View>
          ) : null}
        </>
      )}
      hasMediaRegion={hasAttachment}
      illustrationSlot={illustrationSlot}
      isSaving={isUpdating}
      mediaDisabled={isUpdating}
      mediaHeaderLabel={isArtwork ? 'Artwork' : undefined}
      maxSelectedMembers={isIllustrationEnabled && hasIllustrationHistory ? MAX_ILLUSTRATION_MEMBERS : undefined}
      members={members}
      noticeSlot={noticeSlot}
      onCancel={() => router.back()}
      onContentChange={handleContentChange}
      onDateChange={setMemoryDate}
      onMoveMedia={moveMedia}
      onRemoveMedia={removeMedia}
      onSave={handleSave}
      onSelectMedia={setSelectedMediaId}
      onToggleMember={toggleMember}
      onVoicePress={() => setShowVoiceModal(true)}
      saveTestID="edit-memory-save-btn"
      selectedMediaId={selectedMediaId}
      selectedMemberIds={selectedMemberIds}
      toolbarMediaButton={isArtwork ? (
        // No MemoryMediaPicker on artwork. Binaries with the native scanner
        // get the live scan button (pages append to this memory and upload
        // through the normal edit save); OTA-only runtimes without it get a
        // disabled placeholder.
        isArtworkScannerAvailable() ? (
          <ArtworkScanButton
            disabled={isUpdating || attachedMedia.length >= MAX_MEMORY_MEDIA_ASSETS}
            onError={setErrorMessage}
            onNotice={setScanNotice}
            onScanned={handleArtworkScanned}
            remainingSlots={MAX_MEMORY_MEDIA_ASSETS - attachedMedia.length}
            testID="edit-memory-scan-artwork"
          />
        ) : (
          <View
            accessibilityHint="Update the app to scan more artwork"
            accessibilityLabel="Scan artwork"
            accessibilityRole="button"
            accessibilityState={{ disabled: true }}
            accessible
            style={[styles.toolbarIconBtn, styles.toolbarIconBtnDisabled]}
            testID="edit-memory-scan-artwork-disabled"
          >
            <ScanArtIcon disabled />
          </View>
        )
      ) : isMedia ? (
        <MemoryMediaPicker
          compact
          disabled={isUpdating || attachedMedia.length >= MAX_MEMORY_MEDIA_ASSETS}
          onError={setErrorMessage}
          onSelect={appendMedia}
          remainingSlots={MAX_MEMORY_MEDIA_ASSETS - attachedMedia.length}
        />
      ) : (
        <View style={[styles.toolbarIconBtn, styles.toolbarIconBtnDisabled]}>
          <PhotosIcon disabled />
        </View>
      )}
      toolbarTrailingSlot={isAudio ? (
        <Text style={styles.audioToolbarHint}>This sound cannot be re-recorded.</Text>
      ) : !isMedia ? (
        <View style={styles.toggleRow}>
          <View style={styles.toggleCopy}>
            <Text style={[styles.toggleLabel, !isIllustrationEnabled && styles.toggleLabelOff]}>
              AI illustration
            </Text>
            <Text style={styles.toggleHint}>
              {isIllustrationOverLimit
                ? `Up to ${MAX_ILLUSTRATION_MEMBERS} people per illustration`
                : isIllustrationEnabled
                  ? hasRetainedIllustration
                    ? 'On — existing illustration'
                    : isIllustrationJobInProgress
                      ? 'On — generating'
                      : 'On — runs after save'
                  : 'Off — text only'}
            </Text>
          </View>
          <Switch
            accessibilityLabel="Generate AI illustration"
            disabled={isIllustrationOverLimit}
            onValueChange={setIllustrationEnabled}
            testID="edit-memory-ai-toggle"
            value={isIllustrationEnabled}
            trackColor={{ false: colors.border, true: colors.primary }}
          />
        </View>
      ) : null}
      typeBadge={typeCfg as MemoryComposerTypeBadge}
      voiceDisabled={isUpdating || isAudio}
      voiceModalSlot={(
        <>
          <VoiceSpeakItModal
            familyMembers={voiceMembers}
            onDismiss={() => setShowVoiceModal(false)}
            onResult={(result) => {
              setHasEditedContent(true);
              setContent(result.cleanedText);
              applyVoiceResult(result);
              setShowVoiceModal(false);
            }}
            visible={showVoiceModal}
          />
          {/* Mounted only while a trim session exists (the sheet owns an audio
              player) and unmounted once its Modal has fully dismissed. */}
          {trim.trimSheet.config ? (
            <TrimSheet
              bucketMs={trim.trimSheet.config.bucketMs}
              durationMs={trim.trimSheet.config.durationMs}
              energies={trim.trimSheet.config.energies}
              hasUserNote={trim.trimSheet.config.hasUserNote}
              initialRange={trim.trimSheet.config.initialRange}
              maxSelectionMs={trim.trimSheet.config.maxSelectionMs}
              mustTrim={trim.trimSheet.config.mustTrim}
              onCancel={trim.handleTrimCancel}
              onDismissed={trim.handleTrimSheetDismissed}
              onDone={trim.handleTrimDone}
              sourceUri={trim.trimSheet.config.sourceUri}
              suggested={trim.trimSheet.config.suggested}
              testID="edit-memory-trim-sheet"
              visible={trim.trimSheet.visible}
            />
          ) : null}
        </>
      )}
      voiceTestID="edit-memory-voice-trigger"
    />
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 0,
  },
  headerTextBtn: {
    padding: 4,
    minWidth: 48,
    alignItems: 'center',
  },
  headerSpacer: {
    flex: 1,
  },
  cancelText: {
    fontFamily: fonts.sansBold,
    fontSize: 16,
    color: colors.primary,
  },
  saveText: {
    fontFamily: fonts.sansBold,
    fontSize: 16,
    color: colors.primary,
  },
  saveTextDisabled: {
    color: colors.ink3,
  },
  attachmentImage: {
    flex: 1,
    borderRadius: 16,
    backgroundColor: colors.surface,
    minHeight: 140,
  },
  attachmentPlaceholder: {
    flex: 1,
    minHeight: 140,
    borderRadius: 16,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  placeholderIcon: {
    fontSize: 28,
    color: colors.primary,
  },
  placeholderText: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.ink3,
  },
  audioClipWrap: {
    marginBottom: spacing.md,
    gap: 8,
  },
  audioClipCaption: {
    alignSelf: 'flex-start',
    fontFamily: fonts.sansMedium,
    fontSize: 11.5,
    color: colors.ink3,
  },
  audioToolbarHint: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 11,
    color: colors.ink3,
    textAlign: 'right',
    lineHeight: 14,
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
  },
  toggleLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 12.5,
    color: colors.ink,
  },
  toggleLabelOff: {
    color: colors.ink3,
  },
  toggleHint: {
    fontFamily: fonts.sans,
    fontSize: 11,
    color: colors.ink3,
  },
  errorText: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.error,
  },
  uploadProgress: {
    gap: 6,
    marginTop: spacing.sm,
  },
  uploadProgressLabel: {
    fontFamily: fonts.sansMedium,
    fontSize: 12.5,
    color: colors.ink2,
  },
  uploadProgressTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  uploadProgressFill: {
    height: '100%',
    borderRadius: 2,
    backgroundColor: colors.primary,
  },
  unavailableNotice: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    color: colors.ink3,
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    marginHorizontal: 20,
    padding: spacing.lg,
    textAlign: 'center',
  },
});
