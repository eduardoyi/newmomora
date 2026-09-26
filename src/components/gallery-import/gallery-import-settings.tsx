import { router } from 'expo-router';

import { SettingsRow } from '@/components/settings-row';
import { formatGalleryCaptionLocaleLabel, getGalleryCaptionLocaleOptions } from '@/constants/gallery-caption-locales';
import { useFamily } from '@/hooks/use-family';
import { useGalleryCaptionSettings, useGalleryImportEntryStatus } from '@/hooks/useGalleryImport';
import { galleryCaptionSettingsRoute } from '@/lib/routes';
import type { GalleryImportEntryStatus } from '@/utils/gallery-import-entry-state';
import type { GalleryImportComingIndicator } from '@/utils/gallery-import-deck';
import type { GalleryImportDriverPhase, GalleryImportDriverState } from '@/services/gallery-import-driver';
import type { GalleryImportCheckpoint } from '@/utils/gallery-import-checkpoint';
import { isGalleryImportFeatureEnabled } from '@/utils/gallery-import-flags';
import { isOwnerRole, isViewerRole } from '@/utils/roles';

const SWEEP_ACTIVE_PHASES = new Set<GalleryImportDriverPhase>(['scanning', 'sending', 'dispatching']);

function pluralizeDays(count: number): string {
  return count === 1 ? '1 day' : `${count} days`;
}

interface FindMemoriesRowStatus {
  checkpoint: GalleryImportCheckpoint | null;
  state: GalleryImportEntryStatus['state'];
  attentionReason: GalleryImportEntryStatus['attentionReason'];
  reviewDaysLeft: number | null;
  readyCount: number;
  driverState: GalleryImportDriverState;
  comingIndicator: GalleryImportComingIndicator;
}

export interface GalleryImportSettingsRowRoute {
  caption: string;
  pathname: '/(app)/gallery-import' | '/(app)/gallery-import/review' | '/(app)/gallery-import/progress';
}

/**
 * The "Find memories in your photos" row is a status hub, not a static CTA
 * (docs/plans/gallery-import-continuous.md I4a step 4) -- its caption and
 * destination read the SAME device-bound status the activity bell/sheet use
 * (`useGalleryImportEntryStatus`), so this row never goes stale the way the
 * old `useGalleryImport()`-driven caption did (that hook's `run` is only
 * ever populated by a `createRun` mutation still sitting in this session's
 * query cache -- see useGalleryImport.ts -- so a fresh Settings mount always
 * read it as null, showing "Look through your camera roll..." regardless of
 * any real in-progress or ready-to-review state; that was the "viewer
 * caption bug" this rewrite fixes). Order matters: each condition below is
 * checked only once every earlier one has failed to match.
 */
export function deriveGalleryImportSettingsRow(status: FindMemoriesRowStatus): GalleryImportSettingsRowRoute {
  // No device-bound checkpoint: nothing is in flight on this phone, whatever
  // the derived indicators say -- offer a fresh look.
  if (!status.checkpoint) return { caption: 'Look through your photos', pathname: '/(app)/gallery-import' };
  if (status.readyCount > 0) {
    const noun = status.readyCount === 1 ? 'suggestion' : 'suggestions';
    // Expiry must win over the plain ready count: the warning matters exactly
    // when there is still something to review (device-observed 2026-08-23:
    // the ready branch swallowed it).
    if (status.state === 'expiring' && status.reviewDaysLeft !== null) {
      return { caption: `${status.readyCount} ${noun} ready · clear in ${pluralizeDays(status.reviewDaysLeft)}`, pathname: '/(app)/gallery-import/review' };
    }
    return { caption: `${status.readyCount} ${noun} ready to review`, pathname: '/(app)/gallery-import/review' };
  }
  if (status.attentionReason === 'waiting_for_wifi' || status.driverState.phase === 'waiting_wifi') {
    return { caption: 'Needs Wi-Fi to keep going', pathname: '/(app)/gallery-import/progress' };
  }
  if (status.driverState.phase === 'paused_fair_use') {
    return { caption: 'Momora will keep looking tomorrow', pathname: '/(app)/gallery-import/progress' };
  }
  if (status.attentionReason === 'run_failed' || status.driverState.phase === 'error') {
    return { caption: 'Something needs a second look', pathname: '/(app)/gallery-import/progress' };
  }
  const sweepActive = status.comingIndicator.kind !== 'none' || SWEEP_ACTIVE_PHASES.has(status.driverState.phase);
  if (sweepActive) {
    return { caption: `Looking through your photos · ${status.readyCount} ready`, pathname: '/(app)/gallery-import/progress' };
  }
  if (status.state === 'expiring' && status.reviewDaysLeft !== null) {
    return { caption: `Suggestions clear in ${pluralizeDays(status.reviewDaysLeft)}`, pathname: '/(app)/gallery-import/review' };
  }
  return { caption: 'Look through your photos', pathname: '/(app)/gallery-import' };
}

/**
 * "Find memories in your photos" -- rendered inside Settings' "Your journal"
 * block. Viewers never start or resume an import, so they get no row at all
 * (the trimmed viewer Settings screen) and never reach the device-bound
 * `useGalleryImportEntryStatus` (enabled: false below).
 */
export function GalleryImportSettingsRow({ first }: { first?: boolean }) {
  const { role } = useFamily();
  const isViewer = isViewerRole(role);
  const entryStatus = useGalleryImportEntryStatus({ enabled: !isViewer });

  if (!isGalleryImportFeatureEnabled || isViewer) return null;

  const findMemoriesRow = deriveGalleryImportSettingsRow(entryStatus);

  const handleFindMemoriesPress = () => {
    const runId = entryStatus.checkpoint?.runId;
    router.push(runId && findMemoriesRow.pathname !== '/(app)/gallery-import'
      ? { pathname: findMemoriesRow.pathname as never, params: { runId } }
      : (findMemoriesRow.pathname as never));
  };

  return <SettingsRow chevron first={first} label="Find memories in your photos" caption={findMemoriesRow.caption} onPress={handleFindMemoriesPress} testID="settings-gallery-import" />;
}

/**
 * "Photo caption language" -- a family-level setting, so it lives on the
 * Family settings screen (app/(app)/family-settings.tsx, owner/manager only),
 * not in Settings' personal "Your journal" block. It pushes the dedicated,
 * family-owner-only caption settings screen
 * (src/components/gallery-import/gallery-import-caption-settings.tsx); a
 * non-owner manager sees only the explanatory disabled row with no `onPress`.
 */
export function GalleryCaptionLanguageRow({ first }: { first?: boolean }) {
  const { role } = useFamily();
  const isOwner = isOwnerRole(role);
  const captionSettings = useGalleryCaptionSettings();

  if (!isGalleryImportFeatureEnabled) return null;

  const captionLanguage = captionSettings.settings?.language;
  const selectedOption = captionLanguage
    ? getGalleryCaptionLocaleOptions().find((option) => option.tag === captionLanguage)
    : undefined;
  const languageLabel = selectedOption ? formatGalleryCaptionLocaleLabel(selectedOption) : undefined;

  return <SettingsRow
    chevron={isOwner}
    first={first}
    label="Photo caption language"
    caption={isOwner ? (languageLabel ?? 'How Momora writes photo captions for your family.') : 'Only the family owner can change this setting.'}
    onPress={isOwner ? () => router.push(galleryCaptionSettingsRoute) : undefined}
    testID="settings-gallery-caption"
  />;
}
