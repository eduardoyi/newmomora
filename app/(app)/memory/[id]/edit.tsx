import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { seedFromKey } from '@/components/audio/audio-seed';
import { ClipChip } from '@/components/audio/clip-chip';
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
import { useMemory, useMemoryMutations } from '@/hooks/useMemories';
import { useMediaUrl, useMediaUrls } from '@/hooks/useMediaUrls';
import { mediaImageSource } from '@/utils/media-image-source';
import { isKnownMemoryType, MAX_ILLUSTRATION_MEMBERS } from '@/utils/memories';
import { canEditFamilyContent } from '@/utils/roles';

const TYPE_CONFIGS = {
  text_illustration: { label: 'Illustrated', color: colors.primary, bg: colors.primaryTint, border: colors.primarySoft },
  text_only:         { label: 'Text only',   color: colors.ink2,    bg: colors.surface,     border: colors.border },
  media_photo:       { label: 'Photo',        color: colors.ink2,    bg: colors.surface,     border: colors.border },
  media_video:       { label: 'Video',        color: colors.ink2,    bg: colors.surface,     border: colors.border },
  media_mixed:       { label: 'Media',        color: colors.ink2,    bg: colors.surface,     border: colors.border },
  audio:             { label: 'Sound',        color: colors.seaInk,  bg: colors.seaSoft,     border: colors.sea },
} as const;

const EMPTY_MEDIA_URLS: Record<string, string> = {};

export default function EditMemoryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { role } = useFamily();
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
  // Audio is exclusive and immutable (docs/plans/audio-memories-v1.md P3.2):
  // description/date/tags are editable, the clip itself never is -- no media
  // picker, no AI-illustration toggle, mic disabled.
  const isAudio = memory?.memory_type === 'audio';
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
  const audioClipPlayback = useAudioClipPlayback(audioClipUrl);
  const audioDurationSeconds = (audioClipAsset?.duration_ms ?? 0) / 1000;

  const typeKey =
    memory?.memory_type === 'media' && attachedMedia.length > 1
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
  const canSave = isMedia ? attachedMedia.length > 0 : isAudio ? true : content.trim().length > 0;

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
    setAttachedMedia((current) => [...current, ...attachments].slice(0, 10));
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

    setAttachedMedia((current) => current.filter((attachment) => attachment.id !== attachmentId));
    setSelectedMediaId((current) => (current === attachmentId ? null : current));
  };

  const handleSave = async () => {
    setErrorMessage('');
    if (!id) return;
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
        // Never sent for audio -- the clip is immutable post-save (P3.2);
        // updateMemory rejects a mediaAssets write for any non-media type.
        mediaAssets: isMedia
          ? attachedMedia.map((attachment) => ({
              objectKey: attachment.objectKey,
              fileUri: attachment.objectKey ? undefined : attachment.uri,
              mediaAssetId: attachment.id,
              contentType: attachment.contentType,
              durationMs: attachment.durationMs,
              aspectRatio: attachment.aspectRatio,
            }))
          : undefined,
      });
      router.back();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not update memory');
    }
  };

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

  // The clip -- read-only, recessed, no remove control (P3.2). Only the
  // description/tags/date are editable for an audio memory.
  const noticeSlot = isAudio ? (
    <View style={styles.audioClipWrap}>
      <ClipChip
        durationSeconds={audioDurationSeconds}
        emotion={memory.emotion}
        onToggle={() => void audioClipPlayback.toggle()}
        playing={audioClipPlayback.playing}
        positionSeconds={audioClipPlayback.position}
        progress={audioClipPlayback.progress}
        recessed
        seed={seedFromKey(memory.id)}
        testID="edit-memory-audio-clip"
      />
      <Text style={styles.audioClipCaption}>Kept as recorded</Text>
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
      hasMediaRegion={hasAttachment}
      illustrationSlot={illustrationSlot}
      isSaving={isUpdating}
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
      toolbarMediaButton={isMedia ? (
        <MemoryMediaPicker
          compact
          disabled={isUpdating || attachedMedia.length >= 10}
          onError={setErrorMessage}
          onSelect={appendMedia}
          remainingSlots={10 - attachedMedia.length}
        />
      ) : (
        <View style={[styles.toolbarIconBtn, styles.toolbarIconBtnDisabled]}>
          <SymbolView
            name={{ ios: 'photo', android: 'photo_library' }}
            size={20}
            tintColor={colors.ink3}
            fallback={<Text style={styles.toolbarIconFallback}>▣</Text>}
          />
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
  toolbarIconFallback: {
    fontSize: 20,
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
