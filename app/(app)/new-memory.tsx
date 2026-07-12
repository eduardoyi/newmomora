import { navigateBack } from '@/lib/navigation';
import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useRef, useState } from 'react';
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

import {
  MemoryMediaPicker,
  type MediaAttachment,
} from '@/components/memory-media-picker';
import { MemoryMediaPreview } from '@/components/memory-media-preview';
import { MemoryTagPicker } from '@/components/memory-tag-picker';
import { VoiceSpeakItModal } from '@/components/voice-speak-it-modal';
import { DatePickerField } from '@/components/date-picker-field';
import { colors, fonts, spacing } from '@/constants/theme';
import { useAutoMemoryTags } from '@/hooks/useAutoMemoryTags';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useMemories } from '@/hooks/useMemories';
import { usePendingMemoryUploads } from '@/hooks/use-pending-memory-uploads';
import { useUserProfile } from '@/hooks/useUserProfile';
import { canEditFamilyContent } from '@/utils/roles';
import { todayIsoDate } from '@/utils/dates';
import {
  deriveMemoryType,
  validateMemoryContent,
  validateMemoryDate,
} from '@/utils/memories';

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

const TYPE_CONFIGS = {
  text_illustration: { label: 'Illustrated', color: colors.primary, bg: colors.primaryTint, border: colors.primarySoft },
  text_only:         { label: 'Text only',   color: colors.ink2,    bg: colors.surface,     border: colors.border },
  media_photo:       { label: 'Photo',        color: colors.ink2,    bg: colors.surface,     border: colors.border },
  media_video:       { label: 'Video',        color: colors.ink2,    bg: colors.surface,     border: colors.border },
  media_mixed:       { label: 'Media',        color: colors.ink2,    bg: colors.surface,     border: colors.border },
} as const;

export default function NewMemoryScreen() {
  const { role } = useFamily();
  const { members } = useFamilyMembers();
  const { createMemory, isCreating } = useMemories();
  const { enqueue: enqueuePendingMemoryUpload } = usePendingMemoryUploads();
  const { updateProfile } = useUserProfile();

  // Guard on mount: viewers reaching this route directly (FAB is hidden for
  // them) get bounced back rather than seeing a form whose save would be
  // RLS-rejected.
  useEffect(() => {
    if (!canEditFamilyContent(role)) {
      navigateBack();
    }
  }, [role]);
  const [content, setContent] = useState('');
  const [memoryDate, setMemoryDate] = useState(todayIsoDate());
  const [attachedMedia, setAttachedMedia] = useState<MediaAttachment[]>([]);
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [illustrationEnabled, setIllustrationEnabled] = useState(true);
  const [showVoiceModal, setShowVoiceModal] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  // Enqueueing a media post returns instantly, so React Query's isPending
  // can't guard the Save button like it did for the old inline mutation. The
  // ref blocks synchronous double-taps that land before the state re-render.
  const [isPostingMedia, setIsPostingMedia] = useState(false);
  const hasEnqueuedMediaRef = useRef(false);

  const memoryType = deriveMemoryType({ hasAttachedMedia: attachedMedia.length > 0, illustrationEnabled });

  const typeKey =
    attachedMedia.length > 1 ? 'media_mixed' :
    attachedMedia[0]?.contentType?.startsWith('video/') ? 'media_video' :
    attachedMedia.length > 0 ? 'media_photo' :
    memoryType === 'text_illustration' ? 'text_illustration' : 'text_only';
  const typeCfg = TYPE_CONFIGS[typeKey];

  const wordCount = content.trim().split(/\s+/).filter(Boolean).length;
  const isSaving = isCreating || isPostingMedia;
  const canSave = memoryType === 'media' ? attachedMedia.length > 0 : content.trim().length > 0;

  const tagMembers = useMemo(
    () => members.map((m) => ({ id: m.id, name: m.name, nicknames: m.nicknames })),
    [members],
  );

  const { selectedMemberIds, applyForContent, toggleMember, applyVoiceResult } = useAutoMemoryTags({
    members: tagMembers,
    enabled: true,
  });

  const voiceMembers = useMemo(
    () => members.map((m) => ({ id: m.id, name: m.name, nicknames: m.nicknames ?? [], is_user_profile: m.is_user_profile })),
    [members],
  );

  const handleContentChange = (text: string) => {
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
    setAttachedMedia((current) => current.filter((attachment) => attachment.id !== attachmentId));
    setSelectedMediaId((current) => (current === attachmentId ? null : current));
  };

  const finishSave = () => {
    void updateProfile({ hasCompletedOnboarding: true });
    navigateBack();
  };

  const handleSave = async () => {
    setErrorMessage('');
    const contentError = validateMemoryContent(content, memoryType);
    if (contentError) { setErrorMessage(contentError); return; }
    const dateError = validateMemoryDate(memoryDate);
    if (dateError) { setErrorMessage(dateError); return; }

    try {
      if (memoryType === 'media') {
        if (attachedMedia.length === 0) { setErrorMessage('Attach a photo or video before saving.'); return; }
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
          })),
          content: content.trim() || undefined,
          memoryDate: memoryDate.trim(),
          taggedMemberIds: selectedMemberIds,
        });
      } else {
        await createMemory({
          content: content.trim(),
          memoryDate: memoryDate.trim(),
          taggedMemberIds: selectedMemberIds,
          memoryType,
        });
      }
      finishSave();
    } catch (error) {
      hasEnqueuedMediaRef.current = false;
      setIsPostingMedia(false);
      setErrorMessage(
        error instanceof Error ? error.message : 'Could not save memory',
      );
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      {/* ── Header ── */}
      <View style={styles.header}>
        <Pressable onPress={() => navigateBack()} style={styles.headerTextBtn} testID="new-memory-cancel">
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>

        <View style={[styles.typePill, { backgroundColor: typeCfg.bg, borderColor: typeCfg.border }]}>
          <Text style={[styles.typePillText, { color: typeCfg.color }]}>· {typeCfg.label}</Text>
        </View>

        <Pressable
          onPress={handleSave}
          disabled={isSaving || !canSave}
          style={styles.headerTextBtn}
          testID="new-memory-save"
        >
          {isSaving ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Text style={[styles.saveText, (!canSave) && styles.saveTextDisabled]}>Save</Text>
          )}
        </Pressable>
      </View>

      {/* ── Body: flex layout so textarea grows and tags sit at the bottom ── */}
      <KeyboardAvoidingView behavior="padding" style={styles.body}>
        {/* Date pill */}
        <View style={styles.datePillWrap}>
          <DatePickerField
            onChange={setMemoryDate}
            placeholder="Today"
            testID="new-memory-date"
            value={memoryDate}
          />
        </View>

        {/* Text area — grows to fill space when no media attached */}
        <TextInput
          multiline
          value={content}
          onChangeText={handleContentChange}
          placeholder="What happened on this day?"
          placeholderTextColor={colors.ink3}
          style={[styles.textarea, attachedMedia.length > 0 ? styles.textareaCaption : null]}
          testID="new-memory-content"
        />
        {attachedMedia.length === 0 && (
          <Text style={styles.wordCount}>{wordCount} {wordCount === 1 ? 'word' : 'words'}</Text>
        )}

        {/* Media preview — fills remaining space when attached */}
        {attachedMedia.length > 0 ? (
          <View style={styles.mediaWrap}>
            <MemoryMediaPreview
              attachments={attachedMedia}
              onMove={moveMedia}
              onRemove={removeMedia}
              onSelect={setSelectedMediaId}
              selectedId={selectedMediaId}
            />
          </View>
        ) : null}

        {/* Tag picker — anchored at bottom */}
        <MemoryTagPicker
          members={members}
          onToggleMember={toggleMember}
          selectedMemberIds={selectedMemberIds}
        />

        {errorMessage ? (
          <Text style={styles.errorText}>{errorMessage}</Text>
        ) : null}
      </KeyboardAvoidingView>

      {/* ── Bottom toolbar ── */}
      <View style={styles.toolbar}>
        {/* Mic — opens the full-screen Speak It modal */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Record voice memory"
          disabled={isSaving}
          onPress={() => setShowVoiceModal(true)}
          style={({ pressed }) => [
            styles.toolbarIconBtn,
            isSaving && styles.toolbarIconBtnDisabled,
            pressed && !isSaving && styles.toolbarIconBtnPressed,
          ]}
          testID="new-memory-voice-trigger"
        >
          <SymbolView
            name={{ ios: 'mic', android: 'mic' }}
            size={20}
            tintColor={colors.ink2}
            fallback={<Text style={styles.toolbarIconFallback}>♪</Text>}
          />
        </Pressable>

        {/* Attach */}
        <MemoryMediaPicker
          compact
          disabled={isSaving || attachedMedia.length >= 10}
          onError={setErrorMessage}
          onSelect={appendMedia}
          remainingSlots={10 - attachedMedia.length}
        />

        {/* AI illustration toggle */}
        {attachedMedia.length === 0 && (
          <View style={styles.toggleRow}>
            <View style={styles.toggleCopy}>
              <Text style={[styles.toggleLabel, !illustrationEnabled && styles.toggleLabelOff]}>
                AI illustration
              </Text>
              <Text style={styles.toggleHint}>
                {illustrationEnabled ? 'On — runs after save' : 'Off — text only'}
              </Text>
            </View>
            <Switch
              accessibilityLabel="Generate AI illustration"
              onValueChange={setIllustrationEnabled}
              value={illustrationEnabled}
              trackColor={{ false: colors.border, true: colors.primary }}
              testID="new-memory-ai-toggle"
            />
          </View>
        )}
      </View>

      {/* ── Voice "Speak It" modal ── */}
      <VoiceSpeakItModal
        familyMembers={voiceMembers}
        onDismiss={() => setShowVoiceModal(false)}
        onResult={(result) => {
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
