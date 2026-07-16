import { navigateBack } from '@/lib/navigation';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { pickJournalingPrompt } from '@/constants/journaling-prompts';
import { useAutoMemoryTags } from '@/hooks/useAutoMemoryTags';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useMemoryMutations } from '@/hooks/useMemories';
import { usePendingMemoryUploads } from '@/hooks/use-pending-memory-uploads';
import { useIncomingMemoryShare } from '@/hooks/use-incoming-memory-share';
import { useSuggestedMemoryDate } from '@/hooks/use-suggested-memory-date';
import { useUserProfile } from '@/hooks/useUserProfile';
import { canEditFamilyContent } from '@/utils/roles';
import {
  clearNewMemoryDraft,
  isEmptyDraft,
  loadNewMemoryDraft,
  saveNewMemoryDraft,
} from '@/utils/new-memory-draft';
import {
  deriveMemoryType,
  MAX_ILLUSTRATION_MEMBERS,
  validateMemoryContent,
  validateMemoryDate,
} from '@/utils/memories';

// Debounced draft-autosave write delay -- long enough to coalesce
// keystrokes, short enough that an interruption rarely loses more than
// half a second of typing.
const DRAFT_SAVE_DEBOUNCE_MS = 500;

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
  const { user } = useAuth();
  const { role, familyId } = useFamily();
  const { members } = useFamilyMembers();
  const { createMemory, isCreating } = useMemoryMutations();
  const { enqueue: enqueuePendingMemoryUpload } = usePendingMemoryUploads();
  const { updateProfile } = useUserProfile();
  const [placeholderPrompt] = useState(() => pickJournalingPrompt());

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
  const { memoryDate, setMemoryDate, dateSource } = useSuggestedMemoryDate({
    attachments: attachedMedia,
  });
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [illustrationEnabled, setIllustrationEnabled] = useState(true);
  const [showVoiceModal, setShowVoiceModal] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  // Enqueueing a media post returns instantly, so React Query's isPending
  // can't guard the Save button like it did for the old inline mutation. The
  // ref blocks synchronous double-taps that land before the state re-render.
  const [isPostingMedia, setIsPostingMedia] = useState(false);
  const hasEnqueuedMediaRef = useRef(false);
  const handleIncomingSharePrepared = useCallback((attachments: MediaAttachment[], message: string | null) => {
    setAttachedMedia(attachments);
    setErrorMessage(message ?? '');
  }, []);
  const isPreparingIncomingShare = useIncomingMemoryShare({
    onPrepared: handleIncomingSharePrepared,
  });

  const tagMembers = useMemo(
    () => members.map((m) => ({ id: m.id, name: m.name, nicknames: m.nicknames })),
    [members],
  );

  const handleSelectedMemberIdsChange = useCallback((memberIds: string[]) => {
    if (memberIds.length > MAX_ILLUSTRATION_MEMBERS) {
      setIllustrationEnabled(false);
    }
  }, []);

  const { selectedMemberIds, applyForContent, toggleMember, applyVoiceResult, initializeTags } = useAutoMemoryTags({
    members: tagMembers,
    enabled: true,
    onSelectedMemberIdsChange: handleSelectedMemberIdsChange,
  });

  // ── Draft autosave (docs/features/memories.md "Draft autosave") ──
  // Refs mirror the latest values of fields the restore effect checks, so
  // that effect (which only runs once) never needs them in its dependency
  // array or reads a stale closure. Synced in an effect (not during render)
  // to avoid mutating a ref as a render side effect.
  const contentRef = useRef(content);
  const selectedMemberIdsRef = useRef(selectedMemberIds);
  const attachedMediaRef = useRef(attachedMedia);
  useEffect(() => {
    contentRef.current = content;
    selectedMemberIdsRef.current = selectedMemberIds;
    attachedMediaRef.current = attachedMedia;
  });

  const hasAttemptedDraftRestoreRef = useRef(false);
  const [isDraftRestoreReady, setIsDraftRestoreReady] = useState(false);

  // Restore a saved draft once per mount. Deferred while an incoming share
  // is still being prepared (`isPreparingIncomingShare`) so a share/voice
  // prefill always wins -- a stored draft is only ever applied to an
  // otherwise-empty form. Media is never restored (see new-memory-draft.ts).
  useEffect(() => {
    if (hasAttemptedDraftRestoreRef.current || isPreparingIncomingShare) {
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
          attachedMediaRef.current.length === 0;
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
  }, [isPreparingIncomingShare, user?.id, familyId, initializeTags, setMemoryDate]);

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
      if (isEmptyDraft(draft)) {
        void clearNewMemoryDraft(userId, familyId);
      } else {
        void saveNewMemoryDraft(userId, familyId, draft);
      }
    }, DRAFT_SAVE_DEBOUNCE_MS);

    return () => clearTimeout(timeoutId);
  }, [isDraftRestoreReady, user?.id, familyId, content, selectedMemberIds, memoryDate, illustrationEnabled]);

  const isIllustrationOverLimit = selectedMemberIds.length > MAX_ILLUSTRATION_MEMBERS;
  const isIllustrationEnabled = illustrationEnabled && !isIllustrationOverLimit;

  const memoryType = deriveMemoryType({
    hasAttachedMedia: attachedMedia.length > 0,
    illustrationEnabled: isIllustrationEnabled,
  });

  const typeKey =
    attachedMedia.length > 1 ? 'media_mixed' :
    attachedMedia[0]?.contentType?.startsWith('video/') ? 'media_video' :
    attachedMedia.length > 0 ? 'media_photo' :
    memoryType === 'text_illustration' ? 'text_illustration' : 'text_only';
  const typeCfg = TYPE_CONFIGS[typeKey];

  const wordCount = content.trim().split(/\s+/).filter(Boolean).length;
  const isSaving = isCreating || isPostingMedia;
  const canSave = memoryType === 'media' ? attachedMedia.length > 0 : content.trim().length > 0;

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
            aspectRatio: attachment.aspectRatio,
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
            accessibilityHint={dateSource === 'media' ? 'Suggested from photo date' : undefined}
            onChange={setMemoryDate}
            placeholder="Today"
            testID="new-memory-date"
            value={memoryDate}
          />
          {dateSource === 'media' ? (
            // The accessibility announcement lives on the DatePickerField's
            // accessibilityHint above; this visible label is hidden from the
            // accessibility tree so screen readers don't announce it twice.
            <Text
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={styles.dateSourceHint}
              testID="new-memory-date-source"
            >
              From media
            </Text>
          ) : null}
        </View>

        {/* Text area — grows to fill space when no media attached */}
        <TextInput
          multiline
          value={content}
          onChangeText={handleContentChange}
          placeholder={placeholderPrompt}
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
        {isPreparingIncomingShare ? (
          <View style={styles.sharedMediaLoading} testID="new-memory-shared-media-loading">
            <ActivityIndicator color={colors.primary} size="small" />
            <Text style={styles.sharedMediaLoadingText}>Preparing shared media…</Text>
          </View>
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
          includeCaptureDate
          onError={setErrorMessage}
          onSelect={appendMedia}
          remainingSlots={10 - attachedMedia.length}
        />

        {/* AI illustration toggle */}
        {attachedMedia.length === 0 && (
          <View style={styles.toggleRow}>
            <View style={styles.toggleCopy}>
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: 14,
    marginBottom: 4,
  },
  dateSourceHint: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.ink3,
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
  errorText: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.error,
  },
});
