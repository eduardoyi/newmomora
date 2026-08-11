// The memory composer's form body -- extracted from app/(app)/new-memory.tsx
// and app/(app)/memory/[id]/edit.tsx so gallery-import's "keep" step can
// render the exact same form instead of a lookalike fork (see
// docs/features/gallery-import.md). Owns header/date/content/media-grid/
// tags/toolbar layout and styling; screen-level concerns (navigation,
// share-intake, draft persistence, the posting pipeline, voice-result
// business logic) stay in each screen.
//
// Every prop that only one caller needs is optional and defaults to the
// new-memory/edit-memory behavior (off) -- new-memory and edit-memory pass
// nothing for gallery-import-only props, so this is a pure extraction for
// them; zero visual/behavior change.
import { SymbolView } from 'expo-symbols';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { DatePickerField } from '@/components/date-picker-field';
import type { MediaAttachment } from '@/components/memory-media-picker';
import { MemoryMediaPreview } from '@/components/memory-media-preview';
import { MemoryTagPicker } from '@/components/memory-tag-picker';
import { colors, fonts, spacing } from '@/constants/theme';
import type { FamilyMember } from '@/services/family-members';

export interface MemoryComposerTypeBadge {
  label: string;
  color: string;
  bg: string;
  border: string;
}

export interface MemoryComposerFormProps {
  // ── Header: Cancel · type badge · Save ──────────────────────────────
  cancelTestID: string;
  onCancel: () => void;
  typeBadge: MemoryComposerTypeBadge;
  saveTestID: string;
  onSave: () => void;
  isSaving: boolean;
  canSave: boolean;
  /** Defaults to 'Save'; gallery-import overrides with 'Retry saving' /
   * 'Continue saving' / 'Saving…'. */
  saveLabel?: string;

  // ── Date row ─────────────────────────────────────────────────────────
  dateValue: string;
  onDateChange: (isoDate: string) => void;
  dateTestID: string;
  dateAccessibilityHint?: string;
  datePlaceholder?: string;
  /** Rendered inline after the date field (new-memory: "From media" hint;
   * gallery-import: "From the photos" pill). Undefined for edit-memory. */
  dateAccessorySlot?: ReactNode;
  /** Wraps the date field so it can't be opened (gallery-import: while an
   * approval upload is in flight). Unused elsewhere. */
  dateLocked?: boolean;

  // ── Content ──────────────────────────────────────────────────────────
  contentValue: string;
  onContentChange: (text: string) => void;
  contentPlaceholder: string;
  contentTestID: string;
  /** Whether a media/illustration region is present -- toggles the same
   * caption-sized (vs. full-height) textarea style new-memory/edit already
   * use, and hides the word count the same way they do. */
  hasMediaRegion: boolean;
  contentEditable?: boolean;
  /** gallery-import only -- new-memory/edit-memory leave content unbounded. */
  contentMaxLength?: number;
  /** Rendered directly under the content field, replacing the word count
   * (gallery-import: the AI-draft hint / "Restore Momora's draft"). Only
   * one of the word count or this slot is ever shown, matching how
   * new-memory/edit already only show the word count without media. */
  contentBelowSlot?: ReactNode;

  // ── Notices (gallery-import only) ───────────────────────────────────
  /** Rendered between the content field and the media grid. Undefined for
   * new-memory/edit-memory. */
  noticeSlot?: ReactNode;

  // ── Media / illustration region ─────────────────────────────────────
  /** Edit-memory's read-only illustration display (image or "generating"
   * placeholder), mutually exclusive with the media grid in practice.
   * Undefined for new-memory and gallery-import. */
  illustrationSlot?: ReactNode;
  attachments: MediaAttachment[];
  onMoveMedia: (fromIndex: number, toIndex: number) => void;
  onRemoveMedia: (attachmentId: string) => void;
  selectedMediaId: string | null;
  onSelectMedia: (attachmentId: string | null) => void;
  /** gallery-import only -- see MemoryMediaPreview's own prop docs. */
  mediaUnavailableIds?: string[];
  mediaDisabled?: boolean;
  onAddMediaPress?: () => void;
  onMediaImageError?: (attachmentId: string) => void;

  // ── Tags ─────────────────────────────────────────────────────────────
  members: FamilyMember[];
  selectedMemberIds: string[];
  onToggleMember: (memberId: string) => void;
  maxSelectedMembers?: number;
  tagsLocked?: boolean;

  // ── Error / trailing body content ───────────────────────────────────
  errorMessage?: string;
  /** gallery-import only -- new-memory/edit-memory's error text has never
   * carried a testID. */
  errorTestID?: string;
  /** Rendered after the error text (new-memory: the "preparing shared
   * media" loader). Undefined elsewhere. */
  belowErrorSlot?: ReactNode;

  // ── Toolbar ──────────────────────────────────────────────────────────
  voiceTestID: string;
  onVoicePress: () => void;
  voiceDisabled?: boolean;
  /** The toolbar's second button -- a `<MemoryMediaPicker compact .../>`
   * instance (new-memory, edit-memory's media case, and gallery-import,
   * which wires the identical component to its own onAddPhotos seam via
   * MemoryMediaPicker's `onPress` override) or edit-memory's disabled
   * placeholder for a non-media memory. Built by the caller so this stays a
   * pure extraction -- the form never constructs it itself. */
  toolbarMediaButton?: ReactNode;
  /** The toolbar's trailing area (new-memory/edit-memory: the AI
   * illustration toggle; gallery-import: the "Saves on {date}..." footer
   * line). Undefined renders nothing extra. */
  toolbarTrailingSlot?: ReactNode;

  /** Rendered last, inside the form's SafeAreaView (a Modal, so its exact
   * tree position doesn't affect layout) -- each screen's own
   * `<VoiceSpeakItModal .../>` instance, unchanged. */
  voiceModalSlot?: ReactNode;
}

export function MemoryComposerForm({
  cancelTestID,
  onCancel,
  typeBadge,
  saveTestID,
  onSave,
  isSaving,
  canSave,
  saveLabel = 'Save',
  dateValue,
  onDateChange,
  dateTestID,
  dateAccessibilityHint,
  datePlaceholder = 'Select a date',
  dateAccessorySlot,
  dateLocked = false,
  contentValue,
  onContentChange,
  contentPlaceholder,
  contentTestID,
  hasMediaRegion,
  contentEditable = true,
  contentMaxLength,
  contentBelowSlot,
  noticeSlot,
  illustrationSlot,
  attachments,
  onMoveMedia,
  onRemoveMedia,
  selectedMediaId,
  onSelectMedia,
  mediaUnavailableIds,
  mediaDisabled = false,
  onAddMediaPress,
  onMediaImageError,
  members,
  selectedMemberIds,
  onToggleMember,
  maxSelectedMembers,
  tagsLocked = false,
  errorMessage,
  errorTestID,
  belowErrorSlot,
  voiceTestID,
  onVoicePress,
  voiceDisabled = false,
  toolbarMediaButton,
  toolbarTrailingSlot,
  voiceModalSlot,
}: MemoryComposerFormProps) {
  const wordCount = contentValue.trim().split(/\s+/).filter(Boolean).length;
  const showMediaGrid = attachments.length > 0 || Boolean(onAddMediaPress);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      {/* ── Header ── */}
      <View style={styles.header}>
        <Pressable onPress={onCancel} style={styles.headerTextBtn} testID={cancelTestID}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>

        <View style={[styles.typePill, { backgroundColor: typeBadge.bg, borderColor: typeBadge.border }]}>
          <Text style={[styles.typePillText, { color: typeBadge.color }]}>· {typeBadge.label}</Text>
        </View>

        <Pressable
          onPress={onSave}
          disabled={isSaving || !canSave}
          style={styles.headerTextBtn}
          testID={saveTestID}
        >
          {isSaving ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Text style={[styles.saveText, !canSave && styles.saveTextDisabled]}>{saveLabel}</Text>
          )}
        </Pressable>
      </View>

      {/* ── Body: flex layout so textarea grows and tags sit at the bottom ── */}
      <KeyboardAvoidingView behavior="padding" style={styles.body}>
        {/* Date pill */}
        <View style={styles.datePillWrap}>
          <View pointerEvents={dateLocked ? 'none' : 'auto'} style={dateLocked ? styles.locked : undefined}>
            <DatePickerField
              accessibilityHint={dateAccessibilityHint}
              onChange={onDateChange}
              placeholder={datePlaceholder}
              testID={dateTestID}
              value={dateValue}
            />
          </View>
          {dateAccessorySlot}
        </View>

        {/* Text area -- grows to fill space when no media/illustration present */}
        <TextInput
          editable={contentEditable}
          maxLength={contentMaxLength}
          multiline
          value={contentValue}
          onChangeText={onContentChange}
          placeholder={contentPlaceholder}
          placeholderTextColor={colors.ink3}
          style={[styles.textarea, hasMediaRegion ? styles.textareaCaption : null]}
          testID={contentTestID}
        />
        {contentBelowSlot ?? (!hasMediaRegion && (
          <Text style={styles.wordCount}>{wordCount} {wordCount === 1 ? 'word' : 'words'}</Text>
        ))}

        {noticeSlot}

        {/* Illustration (read-only, edit-memory only) */}
        {illustrationSlot ? <View style={styles.mediaWrap}>{illustrationSlot}</View> : null}

        {/* Media grid -- fills remaining space when present */}
        {showMediaGrid ? (
          <View style={styles.mediaWrap}>
            <MemoryMediaPreview
              attachments={attachments}
              disabled={mediaDisabled}
              onAddPress={onAddMediaPress}
              onImageError={onMediaImageError}
              onMove={onMoveMedia}
              onRemove={onRemoveMedia}
              onSelect={onSelectMedia}
              selectedId={selectedMediaId}
              unavailableIds={mediaUnavailableIds}
            />
          </View>
        ) : null}

        {/* Tag picker -- anchored at bottom */}
        <View pointerEvents={tagsLocked ? 'none' : 'auto'} style={tagsLocked ? styles.locked : undefined}>
          <MemoryTagPicker
            members={members}
            maxSelected={maxSelectedMembers}
            onToggleMember={onToggleMember}
            selectedMemberIds={selectedMemberIds}
          />
        </View>

        {errorMessage ? (
          <Text style={styles.errorText} testID={errorTestID}>{errorMessage}</Text>
        ) : null}
        {belowErrorSlot}
      </KeyboardAvoidingView>

      {/* ── Bottom toolbar ── */}
      <View style={styles.toolbar}>
        {/* Mic -- opens the full-screen Speak It modal */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Record voice memory"
          disabled={voiceDisabled}
          onPress={onVoicePress}
          style={({ pressed }) => [
            styles.toolbarIconBtn,
            voiceDisabled && styles.toolbarIconBtnDisabled,
            pressed && !voiceDisabled && styles.toolbarIconBtnPressed,
          ]}
          testID={voiceTestID}
        >
          <SymbolView
            name={{ ios: 'mic', android: 'mic' }}
            size={20}
            tintColor={colors.ink2}
            fallback={<Text style={styles.toolbarIconFallback}>♪</Text>}
          />
        </Pressable>

        {toolbarMediaButton}
        {toolbarTrailingSlot}
      </View>

      {voiceModalSlot}
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
  locked: {
    opacity: 0.5,
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
  errorText: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.error,
  },
});
