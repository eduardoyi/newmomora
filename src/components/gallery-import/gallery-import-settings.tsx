import { router } from 'expo-router';

import { SettingsBlock, SettingsRow } from '@/components/settings-row';
import { formatGalleryCaptionLocaleLabel, getGalleryCaptionLocaleOptions } from '@/constants/gallery-caption-locales';
import { useGalleryCaptionSettings, useGalleryImport } from '@/hooks/useGalleryImport';
import { isGalleryImportFeatureEnabled } from '@/utils/gallery-import-flags';
import { isOwnerRole, isViewerRole } from '@/utils/roles';
import { useFamily } from '@/hooks/use-family';
import { galleryCaptionSettingsRoute } from '@/lib/routes';

/**
 * The "Photo caption language" row now pushes the dedicated, family-owner-only
 * caption settings screen (src/components/gallery-import/gallery-import-caption-settings.tsx)
 * instead of expanding an in-place editor -- see
 * docs/design/gallery-import/README.md. Viewers (and non-owner managers) see
 * only the explanatory disabled row below and have no way to open or edit the
 * screen: no `onPress` is wired for them, so there is nothing to navigate.
 */
export function GalleryImportSettingsBlock() {
  const { role } = useFamily();
  const { run } = useGalleryImport();
  const isViewer = isViewerRole(role);
  const isOwner = isOwnerRole(role);
  const captionSettings = useGalleryCaptionSettings();

  if (!isGalleryImportFeatureEnabled) return null;
  const rowCaption = isViewer
    ? 'Only the family owner can choose how photo captions are written.'
    : run
      ? run.status === 'reviewing' ? 'Suggestions are ready to review.' : 'An import is in progress on the device that started it.'
      : 'Look through your camera roll for moments worth keeping.';
  const captionLanguage = captionSettings.settings?.language;
  const selectedOption = captionLanguage
    ? getGalleryCaptionLocaleOptions().find((option) => option.tag === captionLanguage)
    : undefined;
  const languageLabel = selectedOption ? formatGalleryCaptionLocaleLabel(selectedOption) : undefined;
  return <SettingsBlock title="Your journal">
    <SettingsRow chevron={!isViewer} label="Find memories in your photos" caption={rowCaption} onPress={isViewer ? undefined : () => router.push('/(app)/gallery-import' as never)} testID="settings-gallery-import" />
    {isViewer
      ? <SettingsRow label="Photo caption language" caption="Only the family owner can change this setting." testID="settings-gallery-caption-viewer" />
      : <SettingsRow
          chevron={isOwner}
          label="Photo caption language"
          caption={isOwner ? (languageLabel ?? 'How Momora writes photo captions for your family.') : 'Only the family owner can change this setting.'}
          onPress={isOwner ? () => router.push(galleryCaptionSettingsRoute) : undefined}
          testID="settings-gallery-caption"
        />}
  </SettingsBlock>;
}
