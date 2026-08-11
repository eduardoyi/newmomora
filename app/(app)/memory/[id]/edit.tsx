import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MemoryComposerForm, type MemoryComposerTypeBadge } from '@/components/memory-composer-form';
import {
  MemoryMediaPicker,
  type MediaAttachment,
} from '@/components/memory-media-picker';
import { VoiceSpeakItModal } from '@/components/voice-speak-it-modal';
import { colors, fonts, spacing } from '@/constants/theme';
import { useAutoMemoryTags } from '@/hooks/useAutoMemoryTags';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useMemory, useMemoryMutations } from '@/hooks/useMemories';
import { useMediaUrl, useMediaUrls } from '@/hooks/useMediaUrls';
import { mediaImageSource } from '@/utils/media-image-source';
import { MAX_ILLUSTRATION_MEMBERS } from '@/utils/memories';
import { canEditFamilyContent } from '@/utils/roles';

const TYPE_CONFIGS = {
  text_illustration: { label: 'Illustrated', color: colors.primary, bg: colors.primaryTint, border: colors.primarySoft },
  text_only:         { label: 'Text only',   color: colors.ink2,    bg: colors.surface,     border: colors.border },
  media_photo:       { label: 'Photo',        color: colors.ink2,    bg: colors.surface,     border: colors.border },
  media_video:       { label: 'Video',        color: colors.ink2,    bg: colors.surface,     border: colors.border },
  media_mixed:       { label: 'Media',        color: colors.ink2,    bg: colors.surface,     border: colors.border },
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

  const typeKey =
    memory?.memory_type === 'media' && attachedMedia.length > 1
      ? 'media_mixed'
      : memory?.memory_type === 'media' && memory.media_content_type?.startsWith('video/')
      ? 'media_video'
      : memory?.memory_type === 'media'
      ? 'media_photo'
      : isIllustrationEnabled
      ? 'text_illustration'
      : 'text_only';
  const typeCfg = TYPE_CONFIGS[typeKey];

  const hasAttachment =
    isMedia ||
    (isIllustrationEnabled && (hasRetainedIllustration || isIllustrationJobInProgress));
  const canSave = isMedia ? attachedMedia.length > 0 : content.trim().length > 0;

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
          : isIllustrationEnabled
            ? 'text_illustration'
            : 'text_only',
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
      toolbarTrailingSlot={!isMedia ? (
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
      voiceDisabled={isUpdating}
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
});
