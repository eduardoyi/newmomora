// Year Film edit sheet (docs/plans/year-film-p2.md Step 11, feature doc
// docs/features/year-film.md "Edit sheet"). Owner/manager only. A keyboard-free
// bottom sheet opened from the player's completion overlay: hide moments,
// pick the line of the year, pick the music (with 5 s previews), Save.
// House Modal + pan-to-dismiss pattern (family-activity-sheet.tsx,
// create-book-sheet.tsx). The Save footer sits outside the scroll area and
// above the bottom safe-area inset, so it stays reachable however long the
// moments grid is.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EditMomentsGrid } from '@/components/year-films/edit/edit-moments-grid';
import { EditMusicList } from '@/components/year-films/edit/edit-music-list';
import { EditQuoteList, isSameQuote, type SelectedQuote } from '@/components/year-films/edit/edit-quote-list';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useBedPreview } from '@/hooks/useBedPreview';
import { useYearFilmEditFrames } from '@/hooks/useYearFilmEditFrames';
import { useSaveYearFilmEdits, useYearFilmEditOptions } from '@/hooks/useYearFilms';
import { trackEvent } from '@/services/analytics';
import type {
  SaveYearFilmEditsFailure,
  YearFilmEdits,
  YearFilmEditOptions,
  YearFilmNotEditableReason,
} from '@/services/year-films';
import { getBottomSheetBottomPadding, shouldDismissBottomSheet } from '@/utils/bottom-sheet-dismiss';
import { bedsForFilmKind } from '@/utils/year-film-beds';

/** The host (the player) shows this after a successful save. */
export const FILM_EDIT_SAVED_MESSAGE = 'Remaking your film… this takes a few minutes';
export const FILM_EDIT_REMOVAL_NOTE = 'Removing moments takes this film down until the new version is ready.';

const SAVE_FAILURE_MESSAGES: Record<SaveYearFilmEditsFailure, string> = {
  rate_limited: "You've remade this film a lot today. Try again tomorrow.",
  film_not_editable: "This film can't be edited right now.",
  subscription_required: 'Editing films needs an active subscription.',
  unauthorized: "This film can't be edited right now.",
  invalid_edits: "Those changes couldn't be saved. Close this and try again.",
};
const SAVE_ERROR_MESSAGE = "Couldn't save your changes. Check your connection and try again.";

const NOT_EDITABLE_MESSAGES: Record<YearFilmNotEditableReason, string> = {
  not_ready: 'This film is being remade. You can edit it again once the new version is ready.',
  blocked: "This film can't be edited right now.",
  subscription_required: 'Editing films needs an active subscription.',
};

export interface FilmEditSheetProps {
  visible: boolean;
  filmId: string;
  /** The FILM's family (a push can open a film of a non-active family). */
  familyId: string | null;
  onClose: () => void;
  /** The edits were saved and the film is being remade. The host closes the
   * sheet, shows FILM_EDIT_SAVED_MESSAGE and leaves the player. */
  onSaved: () => void;
}

type EditableOptions = Extract<YearFilmEditOptions, { editable: true }>;

function initialQuote(options: EditableOptions): SelectedQuote | null {
  if (options.chosenQuote) return options.chosenQuote;
  const current = options.quoteCandidates.find((candidate) => candidate.isCurrent);
  return current ? { memoryId: current.memoryId, textHash: current.textHash } : null;
}

interface FilmEditFormProps {
  filmId: string;
  familyId: string | null;
  options: EditableOptions;
  onSaved: () => void;
  onSavingChange: (isSaving: boolean) => void;
}

function FilmEditForm({ filmId, familyId, options, onSaved, onSavingChange }: FilmEditFormProps) {
  const save = useSaveYearFilmEdits();
  const preview = useBedPreview();

  const initialRemoved = useMemo(() => new Set(options.removedMemoryIds), [options.removedMemoryIds]);
  const initialQuoteChoice = useMemo(() => initialQuote(options), [options]);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(initialRemoved);
  const [quote, setQuote] = useState<SelectedQuote | null>(initialQuoteChoice);
  const [bedId, setBedId] = useState<string | null>(options.musicBedId);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const beds = useMemo(() => bedsForFilmKind(options.kind, options.musicBedId), [options.kind, options.musicBedId]);
  const frameIds = useMemo(() => options.frames.map((frame) => frame.memoryId), [options.frames]);
  const thumbnails = useYearFilmEditFrames(familyId, frameIds);

  const newRemovals = useMemo(() => [...removed].filter((id) => !initialRemoved.has(id)), [initialRemoved, removed]);
  const isRemovedChanged = removed.size !== initialRemoved.size || newRemovals.length > 0;
  const isQuoteChanged = !isSameQuote(quote, initialQuoteChoice);
  const isMusicChanged = bedId !== options.musicBedId;
  const hasChanges = isRemovedChanged || isQuoteChanged || isMusicChanged;
  const isSaving = save.isPending;

  useEffect(() => {
    onSavingChange(isSaving);
  }, [isSaving, onSavingChange]);

  const toggleMoment = useCallback((memoryId: string) => {
    setErrorMessage(null);
    setRemoved((current) => {
      const next = new Set(current);
      if (next.has(memoryId)) next.delete(memoryId);
      else next.add(memoryId);
      return next;
    });
  }, []);

  const handleSave = async () => {
    if (!hasChanges || isSaving) return;
    preview.stop();
    setErrorMessage(null);

    const edits: YearFilmEdits = { removedMemoryIds: [...removed] };
    if (isQuoteChanged && quote) edits.quote = quote;
    if (isMusicChanged && bedId) edits.musicBedId = bedId;

    try {
      const result = await save.mutateAsync({ filmId, edits });
      if (!result.ok) {
        setErrorMessage(SAVE_FAILURE_MESSAGES[result.reason]);
        return;
      }
      trackEvent('year_film_edit_saved', {
        kind: options.kind,
        removed_count: removed.size,
        quote_changed: isQuoteChanged,
        music_changed: isMusicChanged,
      });
      onSaved();
    } catch {
      setErrorMessage(SAVE_ERROR_MESSAGE);
    }
  };

  return (
    <>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        style={styles.scroll}
        testID="film-edit-scroll"
      >
        <Text accessibilityRole="header" style={styles.title}>
          Edit this film
        </Text>
        <Text style={styles.subtitle}>Hide moments, pick the line and choose the music. We remake the film for you.</Text>

        <View style={styles.sectionHeader}>
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            Moments
          </Text>
          {removed.size > 0 ? (
            <Text accessibilityLiveRegion="polite" style={styles.hiddenCount} testID="film-edit-hidden-count">
              {`${removed.size} hidden`}
            </Text>
          ) : null}
        </View>
        <EditMomentsGrid
          frames={options.frames}
          hiddenIds={removed}
          onToggle={toggleMoment}
          resolveThumbnail={thumbnails.resolve}
        />

        {options.quoteCandidates.length > 0 ? (
          <>
            <View style={styles.sectionHeader}>
              <Text accessibilityRole="header" style={styles.sectionTitle}>
                Line of the year
              </Text>
            </View>
            <EditQuoteList
              candidates={options.quoteCandidates}
              onSelect={(next) => {
                setErrorMessage(null);
                setQuote(next);
              }}
              selected={quote}
            />
          </>
        ) : null}

        <View style={styles.sectionHeader}>
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            Music
          </Text>
        </View>
        <EditMusicList
          beds={beds}
          onSelect={(next) => {
            setErrorMessage(null);
            setBedId(next);
          }}
          onTogglePreview={(bed) => void preview.toggle(bed)}
          playingBedId={preview.playingBedId}
          selectedBedId={bedId}
        />
      </ScrollView>

      <View style={styles.footer}>
        {newRemovals.length > 0 ? (
          <Text style={styles.note} testID="film-edit-removal-note">
            {FILM_EDIT_REMOVAL_NOTE}
          </Text>
        ) : null}
        {errorMessage ? (
          <Text accessibilityLiveRegion="polite" style={styles.error} testID="film-edit-error">
            {errorMessage}
          </Text>
        ) : null}
        <Pressable
          accessibilityLabel="Save changes"
          accessibilityRole="button"
          accessibilityState={{ disabled: !hasChanges || isSaving, busy: isSaving }}
          disabled={!hasChanges || isSaving}
          onPress={() => void handleSave()}
          style={({ pressed }) => [
            styles.saveButton,
            (!hasChanges || isSaving) && styles.saveButtonDisabled,
            pressed && styles.pressed,
          ]}
          testID="film-edit-save"
        >
          {isSaving ? <ActivityIndicator color={colors.white} /> : <Text style={styles.saveText}>Save</Text>}
        </Pressable>
      </View>
    </>
  );
}

interface FilmEditBodyProps {
  filmId: string;
  familyId: string | null;
  onSaved: () => void;
  onSavingChange: (isSaving: boolean) => void;
}

/** Everything data-dependent lives here so it only mounts while the sheet is open. */
function FilmEditBody({ filmId, familyId, onSaved, onSavingChange }: FilmEditBodyProps) {
  const { options, isLoading, isError, refetch } = useYearFilmEditOptions(filmId);

  const openedTrackedRef = useRef(false);
  const editableKind = options?.editable ? options.kind : null;
  useEffect(() => {
    if (!editableKind || openedTrackedRef.current) return;
    openedTrackedRef.current = true;
    trackEvent('year_film_edit_opened', { kind: editableKind });
  }, [editableKind]);

  if (isLoading) {
    return (
      <View style={styles.centered} testID="film-edit-loading">
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (isError || !options) {
    return (
      <View style={styles.centered} testID="film-edit-error-state">
        <Text style={styles.message}>Could not load the edit options.</Text>
        <Pressable accessibilityRole="button" onPress={() => void refetch()} style={styles.retry} testID="film-edit-retry">
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  if (!options.editable) {
    return (
      <View style={styles.centered} testID="film-edit-not-editable">
        <Text style={styles.message}>{NOT_EDITABLE_MESSAGES[options.reason]}</Text>
      </View>
    );
  }

  return (
    <FilmEditForm
      familyId={familyId}
      filmId={filmId}
      onSaved={onSaved}
      onSavingChange={onSavingChange}
      options={options}
    />
  );
}

export function FilmEditSheet({ visible, filmId, familyId, onClose, onSaved }: FilmEditSheetProps) {
  const insets = useSafeAreaInsets();
  const drawerTranslateY = useSharedValue(0);
  // A save in flight cannot be dismissed away from (the result decides what
  // happens next).
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (visible) drawerTranslateY.set(0);
  }, [drawerTranslateY, visible]);

  const handleClose = useCallback(() => {
    if (isSaving) return;
    onClose();
  }, [isSaving, onClose]);

  const drawerDrag = Gesture.Pan()
    .withTestId('film-edit-sheet-dismiss-pan')
    .activeOffsetY(8)
    .failOffsetX([-30, 30])
    .failOffsetY([-4, Number.MAX_SAFE_INTEGER])
    .maxPointers(1)
    .onUpdate((event) => {
      drawerTranslateY.set(Math.max(0, event.translationY));
    })
    .onEnd((event) => {
      if (shouldDismissBottomSheet(event.translationY, event.velocityY)) {
        runOnJS(handleClose)();
        return;
      }
      drawerTranslateY.set(withSpring(0));
    })
    .onFinalize((_event, success) => {
      if (!success) {
        drawerTranslateY.set(withSpring(0));
      }
    });

  const animatedSheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: drawerTranslateY.get() }],
  }));

  return (
    <Modal
      animationType="slide"
      onRequestClose={handleClose}
      presentationStyle="overFullScreen"
      transparent
      visible={visible}
    >
      {/* A Modal is its own Android window: it needs its own gesture root.
          It renders null while `visible` is false, so the body (and its
          queries and the preview player) only exist while the sheet is open. */}
      <GestureHandlerRootView style={styles.root}>
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          onPress={handleClose}
          style={styles.backdrop}
          testID="film-edit-sheet-backdrop"
        />
        <Animated.View
          accessibilityViewIsModal
          style={[styles.sheet, animatedSheetStyle, { paddingBottom: getBottomSheetBottomPadding(insets.bottom, false) }]}
          testID="film-edit-sheet"
        >
          <GestureDetector gesture={drawerDrag}>
            <View collapsable={false} style={styles.dragRegion}>
              <View style={styles.handle} />
            </View>
          </GestureDetector>

          <FilmEditBody familyId={familyId} filmId={filmId} onSaved={onSaved} onSavingChange={setIsSaving} />
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(44,36,24,0.5)' },
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    maxHeight: '90%',
    overflow: 'hidden',
  },
  handle: {
    alignSelf: 'center',
    backgroundColor: colors.borderStrong,
    borderRadius: radius.pill,
    height: 5,
    marginBottom: 6,
    marginTop: 10,
    width: 40,
  },
  dragRegion: { minHeight: 24 },
  scroll: { flexShrink: 1 },
  scrollContent: { paddingBottom: 16, paddingHorizontal: spacing.lg },
  title: { color: colors.ink, fontFamily: fonts.display, fontSize: 21, marginBottom: 6 },
  subtitle: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 18 },
  sectionHeader: {
    alignItems: 'baseline',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
    marginTop: 22,
  },
  sectionTitle: {
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    fontSize: 12,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  hiddenCount: { color: colors.primaryDark, fontFamily: fonts.sansBold, fontSize: 12.5 },
  footer: {
    backgroundColor: colors.white,
    borderTopColor: colors.border,
    borderTopWidth: 1,
    gap: 8,
    paddingHorizontal: spacing.lg,
    paddingTop: 12,
  },
  note: { color: colors.sunInk, fontFamily: fonts.sansMedium, fontSize: 12.5, lineHeight: 18 },
  error: { color: colors.error, fontFamily: fonts.sansMedium, fontSize: 12.5, lineHeight: 18 },
  saveButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    justifyContent: 'center',
    minHeight: 50,
  },
  saveButtonDisabled: { opacity: 0.4 },
  pressed: { opacity: 0.85 },
  saveText: { color: colors.white, fontFamily: fonts.sansBold, fontSize: 15 },
  centered: { alignItems: 'center', gap: 12, justifyContent: 'center', minHeight: 180, paddingHorizontal: spacing.lg, paddingVertical: 24 },
  message: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  retry: { alignItems: 'center', justifyContent: 'center', minHeight: 44, paddingHorizontal: 18 },
  retryText: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 14 },
});
