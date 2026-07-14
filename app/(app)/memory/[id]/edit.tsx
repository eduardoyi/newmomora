import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { DatePickerField } from '@/components/date-picker-field';
import {
  MemoryMediaPicker,
  type MediaAttachment,
} from '@/components/memory-media-picker';
import { MemoryMediaPreview } from '@/components/memory-media-preview';
import { MemoryTagPicker } from '@/components/memory-tag-picker';
import { VoiceSpeakItModal } from '@/components/voice-speak-it-modal';
import { colors, fonts, spacing } from '@/constants/theme';
import { useAutoMemoryTags } from '@/hooks/useAutoMemoryTags';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useMemory, useMemoryMutations } from '@/hooks/useMemories';
import { useMediaUrl, useMediaUrls } from '@/hooks/useMediaUrls';
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
  const wordCount = content.trim().split(/\s+/).filter(Boolean).length;
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
      await updateMemory({
        memoryId: id,
        content: content.trim() || undefined,
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

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      {/* ── Header ── */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.headerTextBtn} testID="edit-memory-cancel">
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>

        <View style={[styles.typePill, { backgroundColor: typeCfg.bg, borderColor: typeCfg.border }]}>
          <Text style={[styles.typePillText, { color: typeCfg.color }]}>· {typeCfg.label}</Text>
        </View>

        <Pressable
          onPress={handleSave}
          disabled={isUpdating || !canSave}
          style={styles.headerTextBtn}
          testID="edit-memory-save-btn"
        >
          {isUpdating ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Text style={[styles.saveText, !canSave && styles.saveTextDisabled]}>Save</Text>
          )}
        </Pressable>
      </View>

      {/* ── Body ── */}
      <KeyboardAvoidingView behavior="padding" style={styles.body}>
        {/* Date pill */}
        <View style={styles.datePillWrap}>
          <DatePickerField
            onChange={setMemoryDate}
            value={memoryDate}
            testID="edit-memory-date"
          />
        </View>

        {/* Text area */}
        <TextInput
          multiline
          value={content}
          onChangeText={handleContentChange}
          placeholder="What happened on this day?"
          placeholderTextColor={colors.ink3}
          style={[styles.textarea, hasAttachment ? styles.textareaCaption : null]}
          testID="edit-memory-content"
        />
        {!hasAttachment && (
          <Text style={styles.wordCount}>{wordCount} {wordCount === 1 ? 'word' : 'words'}</Text>
        )}

        {/* Illustration (read-only) */}
        {isIllustrationEnabled && (hasRetainedIllustration || isIllustrationJobInProgress) && (
          <View style={styles.mediaWrap}>
            {illustrationUrl ? (
              <Image
                source={{ uri: illustrationUrl }}
                style={styles.attachmentImage}
                contentFit="cover"
                accessibilityLabel="Memory illustration"
              />
            ) : (
              <View style={styles.attachmentPlaceholder}>
                <Text style={styles.placeholderIcon}>✦</Text>
                <Text style={styles.placeholderText}>Illustration generating…</Text>
              </View>
            )}
          </View>
        )}

        {/* Media (read-only) */}
        {memory.memory_type === 'media' && (
          <View style={styles.mediaWrap}>
            <MemoryMediaPreview
              attachments={attachedMedia}
              onMove={moveMedia}
              onRemove={removeMedia}
              onSelect={setSelectedMediaId}
              selectedId={selectedMediaId}
            />
          </View>
        )}

        {/* Tag picker */}
        <MemoryTagPicker
          members={members}
          maxSelected={isIllustrationEnabled && hasIllustrationHistory
            ? MAX_ILLUSTRATION_MEMBERS
            : undefined}
          onToggleMember={toggleMember}
          selectedMemberIds={selectedMemberIds}
        />

        {errorMessage ? (
          <Text style={styles.errorText}>{errorMessage}</Text>
        ) : null}
      </KeyboardAvoidingView>

      {/* ── Bottom toolbar ── */}
      <View style={styles.toolbar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Record voice memory"
          disabled={isUpdating}
          onPress={() => setShowVoiceModal(true)}
          style={({ pressed }) => [
            styles.toolbarIconBtn,
            isUpdating && styles.toolbarIconBtnDisabled,
            pressed && !isUpdating && styles.toolbarIconBtnPressed,
          ]}
          testID="edit-memory-voice-trigger"
        >
          <SymbolView
            name={{ ios: 'mic', android: 'mic' }}
            size={20}
            tintColor={colors.ink2}
            fallback={<Text style={styles.toolbarIconFallback}>♪</Text>}
          />
        </Pressable>

        {isMedia ? (
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

        {/* AI illustration toggle */}
        {!isMedia && (
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
        )}
      </View>

      {/* ── Voice modal ── */}
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
    </SafeAreaView>
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
  typePill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 11,
  },
  typePillText: {
    fontFamily: fonts.sansBold,
    fontSize: 12,
  },
  body: {
    flex: 1,
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
  datePillWrap: {
    marginTop: 14,
    marginBottom: 4,
  },
  textarea: {
    flex: 1,
    fontFamily: fonts.display,
    fontSize: 24,
    lineHeight: 24 * 1.35,
    color: colors.ink,
    backgroundColor: 'transparent',
    textAlignVertical: 'top',
  },
  textareaCaption: {
    flex: 0,
    flexGrow: 0,
    minHeight: 96,
    maxHeight: 200,
  },
  mediaWrap: {
    flex: 1,
    minHeight: 160,
    marginBottom: spacing.md,
    overflow: 'hidden',
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
  wordCount: {
    fontFamily: 'SpaceMono',
    fontSize: 11,
    color: colors.ink3,
    textAlign: 'right',
    marginBottom: spacing.md,
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 13,
    paddingBottom: 28,
    borderTopWidth: 1,
    borderTopColor: colors.border,
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
  toolbarIconBtnPressed: {
    opacity: 0.7,
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
