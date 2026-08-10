import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { SettingsBlock, SettingsRow } from '@/components/settings-row';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import { getGalleryCaptionLocaleOptions, searchGalleryCaptionLocales } from '@/constants/gallery-caption-locales';
import { useGalleryCaptionSettings, useGalleryImport } from '@/hooks/useGalleryImport';
import { isGalleryImportFeatureEnabled } from '@/utils/gallery-import-flags';
import { isOwnerRole, isViewerRole } from '@/utils/roles';
import { useFamily } from '@/hooks/use-family';

const SAVE_DELAY_MS = 500;

export function GalleryImportSettingsBlock() {
  const { role } = useFamily();
  const { run } = useGalleryImport();
  const isViewer = isViewerRole(role);
  const isOwner = isOwnerRole(role);
  const captionSettings = useGalleryCaptionSettings();
  const saveCaptionSettings = captionSettings.save;
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [language, setLanguage] = useState('en-GB');
  const [instructions, setInstructions] = useState('');
  const [search, setSearch] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'pending' | 'saved' | 'error'>('idle');
  const [isDirty, setIsDirty] = useState(false);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!captionSettings.settings || initializedRef.current) return;
    initializedRef.current = true;
    setLanguage(captionSettings.settings.language);
    setInstructions(captionSettings.settings.instructions);
  }, [captionSettings.settings]);

  useEffect(() => {
    if (!isEditorOpen || !initializedRef.current || !isOwner || !isDirty) return;
    setSaveState('pending');
    const timer = setTimeout(() => {
      void saveCaptionSettings({ language, instructions })
        .then(() => { setSaveState('saved'); setIsDirty(false); })
        .catch(() => setSaveState('error'));
    }, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [instructions, isDirty, isEditorOpen, isOwner, language, saveCaptionSettings]);

  const options = useMemo(() => searchGalleryCaptionLocales(search), [search]);

  if (!isGalleryImportFeatureEnabled) return null;
  const rowCaption = isViewer
    ? 'Only the family owner can choose how photo captions are written.'
    : run
      ? run.status === 'reviewing' ? 'Suggestions are ready to review.' : 'An import is in progress on the device that started it.'
      : 'Look through your camera roll for moments worth keeping.';
  const languageLabel = getGalleryCaptionLocaleOptions().find((option) => option.tag === language)?.englishLabel ?? language;
  return <SettingsBlock title="Your journal">
    <SettingsRow chevron={!isViewer} label="Find memories in your photos" caption={rowCaption} onPress={isViewer ? undefined : () => router.push('/(app)/gallery-import' as never)} testID="settings-gallery-import" />
    {isViewer ? <SettingsRow label="Photo caption language" caption="Only the family owner can change this setting." testID="settings-gallery-caption-viewer" /> : <SettingsRow chevron={isOwner} label="Photo caption language" caption={isOwner ? languageLabel : 'Only the family owner can change this setting.'} onPress={isOwner ? () => setIsEditorOpen((open) => !open) : undefined} testID="settings-gallery-caption" />}
    {isEditorOpen && isOwner ? <View style={styles.editor} testID="gallery-caption-settings-editor"><Text style={styles.label}>Caption language</Text><TextInput accessibilityLabel="Search caption languages" onChangeText={setSearch} placeholder="Search languages" placeholderTextColor={colors.ink3} style={styles.search} testID="gallery-caption-language-search" value={search} /><ScrollView accessibilityLabel="Caption language options" keyboardShouldPersistTaps="handled" nestedScrollEnabled style={styles.options}>{options.map((option) => <Pressable accessibilityRole="radio" accessibilityState={{ checked: option.tag === language }} key={option.tag} onPress={() => { setLanguage(option.tag); setIsDirty(true); }} style={[styles.option, option.tag === language && styles.optionSelected]} testID={`gallery-caption-language-${option.tag}`}><Text style={styles.optionLabel}>{option.englishLabel}</Text><Text style={styles.optionTag}>{option.tag}</Text></Pressable>)}</ScrollView><Text style={styles.label}>How should captions sound?</Text><TextInput multiline onChangeText={(value) => { setInstructions(value); setIsDirty(true); }} placeholder="Optional guidance for Momora" placeholderTextColor={colors.ink3} style={styles.instructions} testID="gallery-caption-instructions" value={instructions} /><View style={styles.saveRow}>{saveState === 'pending' ? <ActivityIndicator color={colors.sea} size="small" /> : null}<Text style={[styles.saveText, saveState === 'error' && styles.saveError]}>{saveState === 'pending' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Could not save — edit and try again.' : ''}</Text></View></View> : null}
  </SettingsBlock>;
}

const styles = StyleSheet.create({
  editor: { borderTopColor: colors.border, borderTopWidth: 1, gap: 8, padding: spacing.md },
  label: { color: colors.ink2, fontFamily: fonts.sansBold, fontSize: 12, marginTop: 4 },
  search: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: radius.sm, borderWidth: 1, color: colors.ink, fontFamily: fonts.sans, minHeight: 42, paddingHorizontal: 10 },
  options: { borderColor: colors.border, borderRadius: radius.sm, borderWidth: 1, maxHeight: 248, overflow: 'hidden' },
  option: { alignItems: 'center', borderTopColor: colors.border, borderTopWidth: 1, flexDirection: 'row', gap: 8, paddingHorizontal: 10, paddingVertical: 9 },
  optionSelected: { backgroundColor: colors.primaryTint },
  optionLabel: { color: colors.ink, flex: 1, fontFamily: fonts.sans, fontSize: 13 },
  optionTag: { color: colors.ink3, fontFamily: fonts.sansBold, fontSize: 11 },
  instructions: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: radius.sm, borderWidth: 1, color: colors.ink, fontFamily: fonts.sans, minHeight: 84, padding: 10, textAlignVertical: 'top' },
  saveRow: { alignItems: 'center', flexDirection: 'row', gap: 6, minHeight: 18 },
  saveText: { color: colors.seaInk, fontFamily: fonts.sans, fontSize: 11.5 },
  saveError: { color: colors.error },
});
