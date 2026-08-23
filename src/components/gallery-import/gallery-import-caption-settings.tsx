// Gallery-import caption settings -- a pushed screen (not an in-place
// accordion; see docs/design/gallery-import/README.md and
// docs/plans/gallery-import.md), reachable only by the family owner from the
// "Photo caption language" row in app/(app)/(tabs)/settings.tsx via
// gallery-import-settings.tsx. Translates the design handoff's
// GICaptionSettings/GILocalePicker (gi-settings.jsx) into Momora's RN
// primitives and live theme/safe-area/keyboard machinery.
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type KeyboardEvent,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { KeyboardStickyShell } from '@/components/keyboard-sticky-shell';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import {
  formatGalleryCaptionLocaleLabel,
  getCuratedGalleryCaptionLocaleOptions,
  getGalleryCaptionLocaleOptions,
  GALLERY_CAPTION_INSTRUCTIONS_MAX_LENGTH,
  type GalleryCaptionLocaleOption,
} from '@/constants/gallery-caption-locales';
import { useGalleryCaptionSettings } from '@/hooks/useGalleryImport';
import { useFamily } from '@/hooks/use-family';
import {
  getRecentGalleryCaptionLocales,
  recordGalleryCaptionLocaleRecent,
} from '@/utils/gallery-caption-locale-recents';
import { isOwnerRole } from '@/utils/roles';

const SAVE_DELAY_MS = 500;
const MAX_INSTRUCTIONS = GALLERY_CAPTION_INSTRUCTIONS_MAX_LENGTH;
const COUNTER_WARN_THRESHOLD = MAX_INSTRUCTIONS - 50;

const EXAMPLE_PILLS = [
  'Keep it to one short sentence.',
  'We call the baby Bear.',
  'No exclamation marks.',
  'Use British spelling.',
];

function Header() {
  return (
    <View style={styles.header}>
      <Pressable
        accessibilityLabel="Back to Settings"
        accessibilityRole="button"
        hitSlop={12}
        onPress={() => router.back()}
        testID="gallery-caption-settings-back"
      >
        <Text style={styles.back}>‹ Settings</Text>
      </Pressable>
    </View>
  );
}

function SectionRule({ children }: { children: string }) {
  return (
    <View style={styles.ruleRow}>
      <Text style={styles.ruleLabel}>{children}</Text>
      <View style={styles.ruleLine} />
    </View>
  );
}

function LockedCaptionSettingsScreen() {
  return (
    <SafeAreaView style={styles.screen} testID="gallery-caption-settings-locked">
      <Header />
      <View style={styles.lockedBody}>
        <Text style={styles.eyebrow}>Family owner only</Text>
        <Text style={styles.display}>{'How captions\nare written.'}</Text>
        <Text style={styles.body}>
          Only the family owner can change how Momora writes captions from your photos.
        </Text>
      </View>
    </SafeAreaView>
  );
}

export function GalleryImportCaptionSettingsScreen() {
  const { role } = useFamily();
  const isOwner = isOwnerRole(role);
  const captionSettings = useGalleryCaptionSettings();
  const saveCaptionSettings = captionSettings.save;

  const [language, setLanguage] = useState('en-GB');
  const [instructions, setInstructions] = useState('');
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [recents, setRecents] = useState<string[]>([]);
  const [saveState, setSaveState] = useState<'idle' | 'pending' | 'saved' | 'error'>('idle');
  const [isDirty, setIsDirty] = useState(false);
  const initializedRef = useRef(false);

  useEffect(() => {
    void getRecentGalleryCaptionLocales().then(setRecents);
  }, []);

  useEffect(() => {
    if (!captionSettings.settings || initializedRef.current) return;
    initializedRef.current = true;
    setLanguage(captionSettings.settings.language);
    setInstructions(captionSettings.settings.instructions);
  }, [captionSettings.settings]);

  useEffect(() => {
    if (!initializedRef.current || !isOwner || !isDirty) return;
    setSaveState('pending');
    const timer = setTimeout(() => {
      void saveCaptionSettings({ language, instructions })
        .then(() => { setSaveState('saved'); setIsDirty(false); })
        .catch(() => setSaveState('error'));
    }, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [instructions, isDirty, isOwner, language, saveCaptionSettings]);

  // `fullOptions` (all 241 registry tags) resolves the CURRENT selection and
  // "recently used" list -- a family's saved language can fall outside the
  // curated picker list below (a setting from before the 2026-08-10 curation,
  // or any future non-picker path), and it must still render its real
  // human-readable name rather than falling back to some other language.
  // `curatedOptions` (~40-60 tags) is what the picker itself browses/searches.
  const fullOptions = useMemo(() => getGalleryCaptionLocaleOptions(), []);
  const curatedOptions = useMemo(() => getCuratedGalleryCaptionLocaleOptions(), []);
  const selectedOption = useMemo(
    () => fullOptions.find((option) => option.tag === language) ?? curatedOptions[0],
    [fullOptions, curatedOptions, language],
  );
  const recentOptions = useMemo(
    () => recents
      .map((tag) => fullOptions.find((option) => option.tag === tag))
      .filter((option): option is GalleryCaptionLocaleOption => Boolean(option)),
    [fullOptions, recents],
  );
  const selectedLabel = formatGalleryCaptionLocaleLabel(selectedOption);

  const handlePick = useCallback((tag: string) => {
    setIsPickerOpen(false);
    if (tag === language) return;
    void recordGalleryCaptionLocaleRecent(language, tag).then(setRecents);
    setLanguage(tag);
    setIsDirty(true);
  }, [language]);

  const handleInstructionsChange = useCallback((value: string) => {
    setInstructions(value.slice(0, MAX_INSTRUCTIONS));
    setIsDirty(true);
  }, []);

  const insertExample = useCallback((example: string) => {
    setInstructions((current) => (current ? `${current} ${example}` : example).slice(0, MAX_INSTRUCTIONS));
    setIsDirty(true);
  }, []);

  if (!isOwner) return <LockedCaptionSettingsScreen />;

  return (
    <>
      <KeyboardStickyShell
        safeAreaStyle={styles.screen}
        contentContainerStyle={styles.content}
        scrollTestID="gallery-caption-settings-scroll"
        testID="gallery-caption-settings-screen"
      >
        <Header />
        <Text style={styles.eyebrow}>Family owner only</Text>
        <Text style={styles.display}>{'How captions\nare written.'}</Text>
        <Text style={styles.body}>
          This is for the drafts Momora writes from your photos. It applies to everyone in the
          family, so the journal reads in one voice.
        </Text>

        <SectionRule>Language</SectionRule>
        <Pressable
          accessibilityLabel={`Caption language: ${selectedLabel}`}
          accessibilityRole="button"
          onPress={() => setIsPickerOpen(true)}
          style={styles.languageRow}
          testID="gallery-caption-language-row"
        >
          <View style={styles.languageRowText}>
            <Text style={styles.languageLabel}>{selectedLabel}</Text>
            <Text style={styles.languageTag}>{selectedOption.tag}</Text>
          </View>
          <Text style={styles.chevronDown}>⌄</Text>
        </Pressable>
        <Text style={styles.hint}>
          Regional variants matter: “colour” or “color”, “nappy” or “diaper”.
        </Text>

        <SectionRule>Your own instructions</SectionRule>
        <View style={styles.instructionsCard}>
          <TextInput
            accessibilityLabel="Your own caption instructions"
            maxLength={MAX_INSTRUCTIONS}
            multiline
            onChangeText={handleInstructionsChange}
            placeholder="For example: keep captions to one short sentence, and call the little one Bear."
            placeholderTextColor={colors.ink3}
            style={styles.instructionsInput}
            testID="gallery-caption-instructions"
            value={instructions}
          />
          <View style={styles.instructionsFooter}>
            <Text style={styles.instructionsHint}>
              Nicknames, tone, how formal: the wording is yours.
            </Text>
            <Text
              style={[styles.counter, instructions.length > COUNTER_WARN_THRESHOLD && styles.counterWarn]}
              testID="gallery-caption-instructions-counter"
            >
              {instructions.length}/{MAX_INSTRUCTIONS}
            </Text>
          </View>
        </View>

        <View style={styles.pillRow}>
          {EXAMPLE_PILLS.map((example) => (
            <Pressable
              key={example}
              accessibilityLabel={`Add example instruction: ${example}`}
              accessibilityRole="button"
              onPress={() => insertExample(example)}
              style={styles.pill}
              testID={`gallery-caption-example-${example}`}
            >
              <Text style={styles.pillText}>+ {example}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.hintLine} testID="gallery-caption-settings-hint">
          Momora won’t invent names or change which photos were chosen.
        </Text>
        <Text style={styles.footnote}>
          Changes apply to new drafts. Captions you have already edited stay as you wrote them.
        </Text>

        <View style={styles.saveRow}>
          {saveState === 'pending' ? <ActivityIndicator color={colors.sea} size="small" /> : null}
          <Text style={[styles.saveText, saveState === 'error' && styles.saveError]}>
            {saveState === 'pending'
              ? 'Saving…'
              : saveState === 'saved'
                ? 'Saved'
                : saveState === 'error'
                  ? 'Could not save. Edit and try again.'
                  : ''}
          </Text>
        </View>
      </KeyboardStickyShell>

      {isPickerOpen ? (
        <GalleryCaptionLocalePicker
          current={language}
          currentOption={selectedOption}
          onClose={() => setIsPickerOpen(false)}
          onPick={handlePick}
          options={curatedOptions}
          recentOptions={recentOptions}
        />
      ) : null}
    </>
  );
}

interface LocaleRow extends GalleryCaptionLocaleOption {
  rowKey: string;
}

function toRow(option: GalleryCaptionLocaleOption, sectionKey: string): LocaleRow {
  return { ...option, rowKey: `${sectionKey}:${option.tag}` };
}

interface LocaleSection {
  title: string;
  data: LocaleRow[];
}

interface GalleryCaptionLocalePickerProps {
  /** Tag of the active selection -- used only to mark the matching row selected. */
  current: string;
  /**
   * Fully resolved option for `current`, from the FULL registry (not the
   * curated `options` list below) -- a saved language can fall outside the
   * curated list, and the "Current" section must still show its real name.
   */
  currentOption: GalleryCaptionLocaleOption;
  /** Resolved from the full registry for the same reason as `currentOption`. */
  recentOptions: GalleryCaptionLocaleOption[];
  /** The curated, browsable/searchable list (2026-08-10 product decision). */
  options: GalleryCaptionLocaleOption[];
  onPick: (tag: string) => void;
  onClose: () => void;
}

// Same shape as family-roster-sheet.tsx's `getRosterKeyboardAvoidingBehavior`
// -- the established pattern in this codebase for a Modal-based bottom sheet
// that holds a search TextInput: `KeyboardAvoidingView` inside the Modal
// (Modal renders in its own native root, but keyboard events still reach it)
// with `'padding'` on iOS and `'height'` on Android, but only once the
// keyboard has actually opened on Android -- an unconditional `'height'`
// there fights the OS's own resize before any keyboard event has fired.
export function getGalleryCaptionLocalePickerKeyboardAvoidingBehavior(
  platform: string,
  isKeyboardVisible: boolean,
) {
  if (platform === 'ios') return 'padding' as const;
  if (platform === 'android' && isKeyboardVisible) return 'height' as const;
  return undefined;
}

// The sheet's "no keyboard" size: 88% cap, 68% comfortable minimum -- the
// values this component shipped with before the keyboard-metrics fix, kept
// as the baseline so closed-keyboard sizing is unchanged.
const PICKER_NORMAL_MAX_HEIGHT_RATIO = 0.88;
const PICKER_DESIRED_MIN_HEIGHT_RATIO = 0.68;
// How much of the screen stays visible as dimmed backdrop above the sheet,
// keyboard open or not -- the fix for round 2 of the keyboard bug: the sheet
// must never grow to fill the space the keyboard frees up.
const PICKER_TOP_MARGIN_RATIO = 0.16;

export interface GalleryCaptionLocalePickerSheetMetrics {
  minHeight: number;
  maxHeight: number;
}

/**
 * Pure height computation for the locale picker sheet -- deliberately kept
 * free of any RN/keyboard globals so it's testable without a real keyboard
 * (round 2 of the keyboard bug: round 1's `KeyboardAvoidingView`-only fix
 * kept the sheet visible above the keyboard, but let it stretch to fill
 * essentially the whole screen once the keyboard was open, because the
 * sheet's own `minHeight`/`maxHeight` were screen-relative percentages that
 * didn't account for the keyboard eating into the available space).
 *
 * `maxHeight` is capped at the smaller of the sheet's normal (no-keyboard)
 * height and the actual space above the keyboard, minus a reserved top
 * margin so a band of dimmed backdrop always stays visible -- the sheet
 * never reaches the status bar. `minHeight` is the sheet's normal
 * comfortable height, but never more than `maxHeight` -- this is round 1's
 * fix (a short/empty result list must not shrink the sheet down behind the
 * keyboard), now bounded so it can't overshoot in the other direction either.
 */
export function computeGalleryCaptionLocalePickerSheetMetrics(
  windowHeight: number,
  keyboardHeight: number,
  topInset: number,
): GalleryCaptionLocalePickerSheetMetrics {
  const safeWindowHeight = Math.max(0, windowHeight);
  const safeKeyboardHeight = Math.max(0, keyboardHeight);
  const normalMaxHeight = safeWindowHeight * PICKER_NORMAL_MAX_HEIGHT_RATIO;
  const desiredMinHeight = safeWindowHeight * PICKER_DESIRED_MIN_HEIGHT_RATIO;
  const topMargin = Math.max(safeWindowHeight * PICKER_TOP_MARGIN_RATIO, Math.max(0, topInset));
  const maxHeight = safeKeyboardHeight > 0
    ? Math.min(normalMaxHeight, Math.max(0, safeWindowHeight - safeKeyboardHeight - topMargin))
    : normalMaxHeight;
  const minHeight = Math.min(desiredMinHeight, maxHeight);
  return { minHeight, maxHeight };
}

function GalleryCaptionLocalePicker({
  current,
  currentOption,
  recentOptions,
  options,
  onPick,
  onClose,
}: GalleryCaptionLocalePickerProps) {
  const [query, setQuery] = useState('');
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const isKeyboardVisible = keyboardHeight > 0;
  const sheetMetrics = useMemo(
    () => computeGalleryCaptionLocalePickerSheetMetrics(windowHeight, keyboardHeight, insets.top),
    [windowHeight, keyboardHeight, insets.top],
  );
  const searching = query.trim().length > 0;

  useEffect(() => {
    // This component only exists while the sheet is open (mounted/unmounted
    // by the parent's `isPickerOpen` conditional), so there is no separate
    // `visible` prop to gate this on -- mount and unmount are the open/close
    // boundary.
    const showSubscription = Keyboard.addListener('keyboardDidShow', (event: KeyboardEvent) => {
      setKeyboardHeight(event.endCoordinates?.height ?? 0);
    });
    const hideSubscription = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0));
    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);
  // Filter the already-computed `options` (see the screen's `useMemo` above)
  // rather than re-deriving the whole locale registry per keystroke --
  // getGalleryCaptionLocaleOptions() runs Intl.DisplayNames for every one of
  // ~250 tags, which is too costly to repeat on every character typed.
  const results = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return options;
    return options.filter((option) => option.searchText.includes(normalizedQuery));
  }, [options, query]);

  const alphabeticalSections = useMemo<LocaleSection[]>(() => {
    const sorted = [...options].sort((a, b) => a.englishLabel.localeCompare(b.englishLabel));
    const sections: LocaleSection[] = [];
    sorted.forEach((option) => {
      const letter = option.englishLabel.charAt(0).toUpperCase() || '#';
      const last = sections[sections.length - 1];
      const row = toRow(option, 'all');
      if (last?.title === letter) {
        last.data.push(row);
      } else {
        sections.push({ title: letter, data: [row] });
      }
    });
    return sections;
  }, [options]);

  const sections = useMemo<LocaleSection[]>(() => {
    if (searching) {
      return [{ title: '', data: results.map((option) => toRow(option, 'search')) }];
    }
    const leading: LocaleSection[] = [
      { title: 'Current', data: currentOption ? [toRow(currentOption, 'current')] : [] },
    ];
    if (recentOptions.length > 0) {
      leading.push({ title: 'Recently used', data: recentOptions.map((option) => toRow(option, 'recent')) });
    }
    leading.push({ title: 'All languages', data: [] });
    return [...leading, ...alphabeticalSections];
  }, [alphabeticalSections, currentOption, recentOptions, results, searching]);

  const renderRow = useCallback(({ item }: { item: LocaleRow }) => {
    const isSelected = item.tag === current;
    return (
      <Pressable
        accessibilityRole="radio"
        accessibilityState={{ selected: isSelected }}
        onPress={() => onPick(item.tag)}
        style={[styles.optionRow, isSelected && styles.optionRowSelected]}
        testID={`gallery-caption-language-${item.tag}`}
      >
        <View style={styles.optionText}>
          <Text style={[styles.optionNative, isSelected && styles.optionNativeSelected]}>
            {item.nativeLabel}
          </Text>
          <Text style={styles.optionEnglish}>{item.englishLabel} · {item.tag}</Text>
        </View>
        {isSelected ? <Text style={styles.optionCheck}>✓</Text> : null}
      </Pressable>
    );
  }, [current, onPick]);

  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="overFullScreen" transparent visible>
      <KeyboardAvoidingView
        behavior={getGalleryCaptionLocalePickerKeyboardAvoidingBehavior(Platform.OS, isKeyboardVisible)}
        keyboardVerticalOffset={0}
        style={styles.modalRoot}
        testID="gallery-caption-language-picker-keyboard-avoiding-view"
      >
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.backdrop}
          testID="gallery-caption-language-picker-backdrop"
        />
        <View
          style={[
            styles.sheet,
            {
              // Explicit pixel min/max (not the screen-relative percentage
              // strings this sheet used before) -- percentages resolve
              // against the JS-visible parent height, not the space actually
              // left above the keyboard, which is what let the sheet
              // overexpand once `KeyboardAvoidingView` shrank/padded that
              // parent. `sheetMetrics` is the single source of truth for
              // both the "don't collapse" (round 1) and "don't overexpand"
              // (round 2) requirements.
              minHeight: sheetMetrics.minHeight,
              maxHeight: sheetMetrics.maxHeight,
              paddingBottom: isKeyboardVisible ? spacing.md : insets.bottom + spacing.md,
            },
          ]}
          testID="gallery-caption-language-picker"
        >
          <View style={styles.grabber} />
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Caption language</Text>
            <Pressable
              accessibilityRole="button"
              onPress={onClose}
              testID="gallery-caption-language-picker-cancel"
            >
              <Text style={styles.sheetCancel}>Cancel</Text>
            </Pressable>
          </View>

          <View style={styles.searchRow}>
            <TextInput
              accessibilityLabel="Search languages"
              autoFocus
              onChangeText={setQuery}
              placeholder="Language, country, or code: try “pt” or “Brasil”"
              placeholderTextColor={colors.ink3}
              style={styles.searchInput}
              testID="gallery-caption-language-search"
              value={query}
            />
            {query ? (
              <Pressable accessibilityLabel="Clear search" accessibilityRole="button" onPress={() => setQuery('')}>
                <Text style={styles.searchClear}>✕</Text>
              </Pressable>
            ) : null}
          </View>
          <Text style={styles.resultCount}>
            {searching
              ? `${results.length} match${results.length === 1 ? '' : 'es'}`
              : `${options.length} languages and regional variants`}
          </Text>

          {/* Fixed-height results area (flex: 1 of the sheet's stable
              min-height, set below) so a short result list -- or none at all
              -- never shrinks the sheet down into/behind the keyboard. The
              empty state renders inside this same area, centered, instead of
              collapsing it. */}
          <View style={styles.resultsArea}>
            {searching && results.length === 0 ? (
              <View style={styles.emptyResults}>
                <Text style={styles.emptyResultsTitle}>No language matches “{query}”.</Text>
                <Text style={styles.emptyResultsBody}>
                  Try the country instead, or a code like es-MX.
                </Text>
              </View>
            ) : (
              <SectionList
                accessibilityLabel="Caption language options"
                contentContainerStyle={styles.optionsContent}
                keyExtractor={(item) => item.rowKey}
                keyboardShouldPersistTaps="handled"
                renderItem={renderRow}
                renderSectionHeader={({ section }) => (
                  section.title ? <Text style={styles.groupHead}>{section.title}</Text> : null
                )}
                sections={sections}
                style={styles.optionsList}
                stickySectionHeadersEnabled={!searching}
                testID="gallery-caption-language-options"
              />
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.bg, flex: 1 },
  content: { gap: 4, paddingBottom: spacing.xxl, paddingHorizontal: spacing.lg },
  header: { minHeight: 44, paddingVertical: spacing.sm },
  back: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 15.5 },
  lockedBody: { flex: 1, gap: spacing.sm, justifyContent: 'center', paddingHorizontal: spacing.lg },
  eyebrow: { color: colors.ink3, fontFamily: fonts.sansBold, fontSize: 10, letterSpacing: 1.4, textTransform: 'uppercase' },
  display: { color: colors.ink, fontFamily: fonts.display, fontSize: 32, lineHeight: 36, marginTop: 10 },
  body: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 14, lineHeight: 21, marginTop: 12 },
  ruleRow: { alignItems: 'center', flexDirection: 'row', gap: 12, marginTop: spacing.xl },
  ruleLabel: { color: colors.ink3, fontFamily: fonts.sansBold, fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase' },
  ruleLine: { backgroundColor: colors.border, flex: 1, height: 1 },
  languageRow: {
    alignItems: 'center',
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
  },
  languageRowText: { flex: 1 },
  languageLabel: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 15 },
  languageTag: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 12, marginTop: 3 },
  chevronDown: { color: colors.ink3, fontSize: 18 },
  hint: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 12, lineHeight: 17, marginTop: 9 },
  instructionsCard: {
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    marginTop: spacing.sm,
    padding: 14,
  },
  instructionsInput: { color: colors.ink, fontFamily: fonts.sans, fontSize: 14.5, lineHeight: 21, minHeight: 92, textAlignVertical: 'top' },
  instructionsFooter: {
    alignItems: 'center',
    borderTopColor: colors.border,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
    paddingTop: 10,
  },
  instructionsHint: { color: colors.ink3, flex: 1, fontFamily: fonts.sans, fontSize: 11.5 },
  counter: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 11.5 },
  counterWarn: { color: colors.primary },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  pill: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  pillText: { color: colors.ink2, fontFamily: fonts.sansBold, fontSize: 12 },
  hintLine: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 12, lineHeight: 17, marginTop: spacing.lg },
  footnote: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 11.5, lineHeight: 17, marginTop: 6 },
  saveRow: { alignItems: 'center', flexDirection: 'row', gap: 6, marginTop: spacing.lg, minHeight: 18 },
  saveText: { color: colors.seaInk, fontFamily: fonts.sans, fontSize: 11.5 },
  saveError: { color: colors.error },

  // Locale picker
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(44, 36, 24, 0.35)' },
  // `minHeight`/`maxHeight` are set inline per-render from
  // `computeGalleryCaptionLocalePickerSheetMetrics` (real pixels, keyboard-
  // aware) -- see that function's doc comment for why screen-relative
  // percentage strings don't work here.
  sheet: { backgroundColor: colors.white, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, flexShrink: 0 },
  grabber: { alignSelf: 'center', backgroundColor: colors.border, borderRadius: 999, height: 5, marginTop: 10, width: 38 },
  sheetHeader: { alignItems: 'flex-end', flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingTop: 6 },
  sheetTitle: { color: colors.ink, fontFamily: fonts.display, fontSize: 22 },
  sheetCancel: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 14.5 },
  searchRow: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    marginHorizontal: spacing.lg,
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  searchInput: { color: colors.ink, flex: 1, fontFamily: fonts.sans, fontSize: 15 },
  searchClear: { color: colors.ink3, fontSize: 13 },
  resultCount: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 11.5, paddingHorizontal: spacing.lg, paddingTop: 8 },
  // `flex: 1` + `minHeight: 0` is the other half of the collapsing-sheet fix:
  // this area always fills the sheet's stable `minHeight` above, whether it
  // renders the SectionList or the empty state, so neither one lets the
  // sheet (and its content) shrink down to nothing.
  resultsArea: { flex: 1, minHeight: 0 },
  emptyResults: { alignItems: 'center', flex: 1, justifyContent: 'center', paddingHorizontal: spacing.lg },
  emptyResultsTitle: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 14, textAlign: 'center' },
  emptyResultsBody: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 12.5, marginTop: 6, textAlign: 'center' },
  optionsList: { flex: 1 },
  optionsContent: { paddingBottom: 24 },
  groupHead: {
    backgroundColor: colors.white,
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1.2,
    paddingHorizontal: spacing.lg,
    paddingTop: 14,
    paddingBottom: 6,
    textTransform: 'uppercase',
  },
  optionRow: { alignItems: 'center', flexDirection: 'row', gap: 12, paddingHorizontal: spacing.lg, paddingVertical: 11 },
  optionRowSelected: { backgroundColor: colors.primaryTint },
  optionText: { flex: 1 },
  optionNative: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 15 },
  optionNativeSelected: { color: colors.primary },
  optionEnglish: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 12.5, marginTop: 2 },
  optionCheck: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 16 },
});
