import { Image } from 'expo-image';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { useMemo, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ListRenderItemInfo,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { DatePickerField } from '@/components/date-picker-field';
import {
  FullScreenMediaViewer,
  type FullScreenMediaItem,
} from '@/components/full-screen-media-viewer';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useMediaUrls } from '@/hooks/useMediaUrls';
import type { FamilyMember } from '@/services/family-members';
import { getLocalTodayIso } from '@/utils/portrait-versions';

export type PortraitDateSource = 'exif' | 'manual' | 'default_today' | 'legacy_unknown';
export type PortraitTimelineStatus = 'pending' | 'generating' | 'ready' | 'failed';

export interface PortraitTimelineVersion {
  id: string;
  referenceDate: string | null;
  dateSource: PortraitDateSource;
  status: PortraitTimelineStatus;
  sourcePhotoKey: string;
  portraitKey: string | null;
  createdAt: string;
  updatedAt: string;
  isGenerating?: boolean;
  isDeleting?: boolean;
  deletionInterrupted?: boolean;
}

export interface PortraitTimelinePhotoDraft {
  uri: string;
  contentType: string;
  referenceDate: string;
  dateSource: Exclude<PortraitDateSource, 'legacy_unknown'>;
}

interface PortraitTimelineProps {
  member: FamilyMember;
  versions: PortraitTimelineVersion[];
  currentVersionId: string | null;
  canEdit: boolean;
  isLoading?: boolean;
  isRefreshing?: boolean;
  isCreating?: boolean;
  errorMessage?: string | null;
  recoveredPhotoDraft?: PortraitTimelinePhotoDraft | null;
  onBack: () => void;
  onRefresh?: () => void;
  onPickPhoto: (source: 'camera' | 'library') => Promise<PortraitTimelinePhotoDraft | null>;
  onCreate: (draft: PortraitTimelinePhotoDraft) => Promise<void>;
  onEditDate: (versionId: string, referenceDate: string) => Promise<void>;
  onRetry: (versionId: string) => Promise<void>;
  onRegenerate: (versionId: string) => Promise<void>;
  onDelete: (versionId: string) => Promise<void>;
}

type SheetName = 'add' | 'date' | 'actions' | null;

const DATE_SOURCE_COPY: Record<PortraitDateSource, { label: string; symbol: SymbolViewProps['name'] }> = {
  exif: { label: 'From photo', symbol: { ios: 'camera', android: 'photo_camera' } },
  manual: { label: 'Set manually', symbol: { ios: 'pencil', android: 'edit' } },
  default_today: { label: 'Added today', symbol: { ios: 'clock', android: 'schedule' } },
  legacy_unknown: { label: 'Date unknown', symbol: { ios: 'clock', android: 'schedule' } },
};

function parseCivilDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatLongDate(value: string | null): string {
  if (!value) return 'Date unknown';
  const date = parseCivilDate(value);
  if (!date) return 'Date unknown';
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

export function formatPortraitAge(dateOfBirth: string | null, referenceDate: string | null): string | null {
  if (!dateOfBirth || !referenceDate) return null;
  const birth = parseCivilDate(dateOfBirth);
  const at = parseCivilDate(referenceDate);
  if (!birth || !at || at < birth) return null;

  let years = at.getFullYear() - birth.getFullYear();
  let months = at.getMonth() - birth.getMonth();
  if (at.getDate() < birth.getDate()) months -= 1;
  if (months < 0) {
    years -= 1;
    months += 12;
  }

  const yearCopy = `${years} ${years === 1 ? 'year' : 'years'}`;
  const monthCopy = `${months} ${months === 1 ? 'month' : 'months'}`;
  if (years === 0) return monthCopy;
  if (months === 0) return yearCopy;
  return `${yearCopy}, ${monthCopy}`;
}

function SourceChip({ source }: { source: PortraitDateSource }) {
  const copy = DATE_SOURCE_COPY[source];
  return (
    <View style={styles.sourceChip} testID={`portrait-source-${source}`}>
      <SymbolView
        fallback={<Text style={styles.sourceChipFallback}>•</Text>}
        name={copy.symbol}
        size={12}
        tintColor={colors.ink3}
      />
      <Text style={styles.sourceChipText}>{copy.label}</Text>
    </View>
  );
}

function PortraitPlaceholder({ version }: { version: PortraitTimelineVersion }) {
  const isWorking = version.status === 'pending' || version.status === 'generating';
  if (isWorking) {
    return (
      <View style={[styles.visual, styles.generatingVisual]} testID={`portrait-version-${version.id}-generating`}>
        <ActivityIndicator color={colors.primary} size="small" />
        <Text style={styles.generatingText}>
          {version.status === 'pending' ? 'Waiting…' : 'Generating…'}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.visual, styles.failedVisual]} testID={`portrait-version-${version.id}-failed`}>
      <SymbolView
        fallback={<Text style={styles.failedFallback}>!</Text>}
        name={{ ios: 'exclamationmark.triangle', android: 'warning' }}
        size={25}
        tintColor={colors.error}
      />
      <Text style={styles.failedText}>Couldn’t generate</Text>
    </View>
  );
}

interface VersionCardProps {
  member: FamilyMember;
  version: PortraitTimelineVersion;
  isCurrent: boolean;
  canEdit: boolean;
  onActions: () => void;
  onOpen: (initialIndex: number) => void;
  onRetry: () => void;
}

function VersionCard({
  member,
  version,
  isCurrent,
  canEdit,
  onActions,
  onOpen,
  onRetry,
}: VersionCardProps) {
  const keys = [version.sourcePhotoKey, version.portraitKey].filter((key): key is string => Boolean(key));
  const { data: urls = {} } = useMediaUrls(keys, version.updatedAt);
  const sourceUri = urls[version.sourcePhotoKey];
  const portraitUri = version.portraitKey ? urls[version.portraitKey] : undefined;
  const age = formatPortraitAge(member.date_of_birth, version.referenceDate);
  const hasPortraitKey = Boolean(version.portraitKey);
  const hasUsablePortrait = Boolean(hasPortraitKey && portraitUri);
  const isBusy = Boolean(version.isGenerating || version.isDeleting || version.status === 'generating');

  return (
    <View style={styles.card} testID={`portrait-version-${version.id}`}>
      <View style={styles.pair}>
        <Pressable
          accessibilityLabel={`Open source photo from ${formatLongDate(version.referenceDate)}`}
          accessibilityRole="button"
          disabled={!sourceUri}
          onPress={() => onOpen(0)}
          style={styles.visualSlot}
          testID={`portrait-version-${version.id}-source`}
        >
          {sourceUri ? (
            <Image contentFit="cover" source={{ uri: sourceUri }} style={styles.visual} />
          ) : (
            <View style={[styles.visual, styles.photoFallback]}>
              <ActivityIndicator color={colors.ink3} size="small" />
            </View>
          )}
          <View style={styles.pairTag}><Text style={styles.pairTagText}>Photo</Text></View>
        </Pressable>

        <Pressable
          accessibilityLabel={`Open illustrated portrait from ${formatLongDate(version.referenceDate)}`}
          accessibilityRole="button"
          disabled={!hasUsablePortrait}
          onPress={() => onOpen(1)}
          style={styles.visualSlot}
          testID={`portrait-version-${version.id}-portrait`}
        >
          {hasPortraitKey ? (
            <>
              {portraitUri ? (
                <Image contentFit="cover" source={{ uri: portraitUri }} style={styles.visual} />
              ) : (
                <View style={[styles.visual, styles.photoFallback]}>
                  <ActivityIndicator color={colors.ink3} size="small" />
                </View>
              )}
              <View style={[styles.pairTag, styles.pairTagRight]}>
                <Text style={styles.pairTagText}>Portrait</Text>
              </View>
              {isCurrent ? (
                <View style={styles.currentBadge} testID={`portrait-version-${version.id}-current`}>
                  <View style={styles.currentDot} />
                  <Text style={styles.currentBadgeText}>Current</Text>
                </View>
              ) : null}
              {version.isGenerating ? (
                <View style={styles.updatingBadge}>
                  <ActivityIndicator color={colors.white} size={10} />
                  <Text style={styles.updatingText}>Updating</Text>
                </View>
              ) : null}
            </>
          ) : (
            <PortraitPlaceholder version={version} />
          )}
        </Pressable>
      </View>

      <View style={styles.infoRow}>
        <View style={styles.infoCopy}>
          <Text style={styles.dateTitle}>{formatLongDate(version.referenceDate)}</Text>
          <View style={styles.metaRow}>
            {age ? <Text style={styles.ageText}>{age} old</Text> : null}
            <SourceChip source={version.dateSource} />
          </View>
        </View>
        {version.isDeleting ? (
          <View style={styles.workingLabel}>
            <ActivityIndicator color={colors.ink3} size="small" />
            <Text style={styles.workingText}>Removing</Text>
          </View>
        ) : isBusy ? (
          <View style={styles.workingLabel}>
            <View style={styles.workingDot} />
            <Text style={styles.workingText}>Working</Text>
          </View>
        ) : canEdit ? (
          <Pressable
            accessibilityLabel="Portrait options"
            accessibilityRole="button"
            onPress={onActions}
            style={({ pressed }) => [styles.smallIconButton, pressed && styles.pressed]}
            testID={`portrait-version-${version.id}-actions`}
          >
            <SymbolView
              fallback={<Text style={styles.moreFallback}>•••</Text>}
              name={{ ios: 'ellipsis', android: 'more_horiz' }}
              size={18}
              tintColor={colors.ink2}
            />
          </Pressable>
        ) : null}
      </View>

      {version.deletionInterrupted ? (
        <View style={styles.inlineNotice}>
          <Text style={styles.inlineNoticeText}>Deletion was interrupted. Open options to try again.</Text>
        </View>
      ) : null}

      {version.status === 'failed' && canEdit ? (
        <View style={styles.retryWrap}>
          <Pressable
            accessibilityRole="button"
            onPress={onRetry}
            style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}
            testID={`portrait-version-${version.id}-retry`}
          >
            <SymbolView
              fallback={<Text style={styles.retryText}>↻</Text>}
              name={{ ios: 'arrow.clockwise', android: 'refresh' }}
              size={15}
              tintColor={colors.primary}
            />
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

interface BottomSheetProps {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
  testID: string;
}

function BottomSheet({ visible, onClose, children, testID }: BottomSheetProps) {
  const insets = useSafeAreaInsets();
  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={visible}>
      <View style={styles.sheetRoot}>
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.sheetBackdrop}
        />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]} testID={testID}>
          <View style={styles.grabber} />
          {children}
        </View>
      </View>
    </Modal>
  );
}

interface SheetRowProps {
  title: string;
  subtitle?: string;
  symbol: SymbolViewProps['name'];
  onPress?: () => void;
  danger?: boolean;
  disabled?: boolean;
  testID: string;
}

function SheetRow({ title, subtitle, symbol, onPress, danger, disabled, testID }: SheetRowProps) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.sheetRow,
        disabled && styles.sheetRowDisabled,
        pressed && !disabled && styles.pressed,
      ]}
      testID={testID}
    >
      <View style={[styles.sheetRowIcon, danger && styles.sheetRowIconDanger]}>
        <SymbolView
          fallback={<Text style={{ color: danger ? colors.error : colors.ink2 }}>•</Text>}
          name={symbol}
          size={20}
          tintColor={danger ? colors.error : colors.ink2}
        />
      </View>
      <View style={styles.sheetRowCopy}>
        <Text style={[styles.sheetRowTitle, danger && styles.sheetRowTitleDanger]}>{title}</Text>
        {subtitle ? <Text style={styles.sheetRowSubtitle}>{subtitle}</Text> : null}
      </View>
    </Pressable>
  );
}

function OnePortraitCallout({ name }: { name: string }) {
  return (
    <View style={styles.callout} testID="portrait-timeline-first-callout">
      <View style={styles.calloutIcon}>
        <SymbolView
          fallback={<Text style={styles.calloutFallback}>↻</Text>}
          name={{ ios: 'clock.arrow.circlepath', android: 'history' }}
          size={20}
          tintColor={colors.primary}
        />
      </View>
      <Text style={styles.calloutTitle}>One portrait so far</Text>
      <Text style={styles.calloutText}>
        The first of many. Add a new photo whenever {name} changes, and watch the years gather here.
      </Text>
    </View>
  );
}

export function PortraitTimeline({
  member,
  versions,
  currentVersionId,
  canEdit,
  isLoading = false,
  isRefreshing = false,
  isCreating = false,
  errorMessage,
  recoveredPhotoDraft,
  onBack,
  onRefresh,
  onPickPhoto,
  onCreate,
  onEditDate,
  onRetry,
  onRegenerate,
  onDelete,
}: PortraitTimelineProps) {
  const [sheet, setSheet] = useState<SheetName>(recoveredPhotoDraft ? 'date' : null);
  const [focusedVersion, setFocusedVersion] = useState<PortraitTimelineVersion | null>(null);
  const [photoDraft, setPhotoDraft] = useState<PortraitTimelinePhotoDraft | null>(recoveredPhotoDraft ?? null);
  const [draftDate, setDraftDate] = useState(recoveredPhotoDraft?.referenceDate ?? '');
  const [isPicking, setIsPicking] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [localError, setLocalError] = useState('');
  const [viewer, setViewer] = useState<{ version: PortraitTimelineVersion; index: number } | null>(null);

  const timelineCount = versions.filter((version) => !version.isDeleting).length;
  const usablePortraitCount = versions.filter((version) => (
    !version.isDeleting && version.status === 'ready' && Boolean(version.portraitKey)
  )).length;
  const hasSingleReadyPortrait = timelineCount === 1 && versions.some((version) => (
    !version.isDeleting && version.status === 'ready' && Boolean(version.portraitKey)
  ));
  const today = useMemo(() => new Date(), []);
  const minimumDate = useMemo(
    () => member.date_of_birth ? parseCivilDate(member.date_of_birth) ?? undefined : undefined,
    [member.date_of_birth],
  );

  const closeSheet = () => {
    if (isMutating || isPicking) return;
    setSheet(null);
    setPhotoDraft(null);
    setLocalError('');
  };

  const pickPhoto = async (source: 'camera' | 'library') => {
    setIsPicking(true);
    setLocalError('');
    try {
      const draft = await onPickPhoto(source);
      if (!draft) return;
      setPhotoDraft(draft);
      setDraftDate(draft.referenceDate);
      setSheet('date');
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Could not select the photo');
    } finally {
      setIsPicking(false);
    }
  };

  const saveDate = async () => {
    setLocalError('');
    setIsMutating(true);
    try {
      if (photoDraft) {
        await onCreate({
          ...photoDraft,
          referenceDate: draftDate,
          dateSource: draftDate === photoDraft.referenceDate ? photoDraft.dateSource : 'manual',
        });
      } else if (focusedVersion) {
        await onEditDate(focusedVersion.id, draftDate);
      }
      setSheet(null);
      setPhotoDraft(null);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Could not save the portrait date');
    } finally {
      setIsMutating(false);
    }
  };

  const runMutation = async (action: () => Promise<void>) => {
    setLocalError('');
    setIsMutating(true);
    try {
      await action();
      setSheet(null);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Could not update this portrait');
    } finally {
      setIsMutating(false);
    }
  };

  const requestDelete = (version: PortraitTimelineVersion) => {
    setSheet(null);
    Alert.alert(
      'Delete portrait',
      `Delete the photo and portrait from ${formatLongDate(version.referenceDate)}? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => void runMutation(() => onDelete(version.id)) },
      ],
    );
  };

  const viewerItems: FullScreenMediaItem[] = viewer ? [
    {
      id: `${viewer.version.id}-source`,
      contentType: 'image/jpeg',
      objectKey: viewer.version.sourcePhotoKey,
    },
    ...(viewer.version.portraitKey ? [{
      id: `${viewer.version.id}-portrait`,
      contentType: 'image/webp',
      objectKey: viewer.version.portraitKey,
    }] : []),
  ] : [];
  const focusedIsLastUsablePortrait = Boolean(
    focusedVersion?.status === 'ready' &&
      focusedVersion.portraitKey &&
      usablePortraitCount <= 1,
  );
  const cannotDeleteFocusedVersion = timelineCount <= 1 || focusedIsLastUsablePortrait;

  const renderVersion = ({ item }: ListRenderItemInfo<PortraitTimelineVersion>) => (
    <VersionCard
      canEdit={canEdit}
      isCurrent={item.id === currentVersionId}
      member={member}
      onActions={() => {
        setFocusedVersion(item);
        setLocalError('');
        setSheet('actions');
      }}
      onOpen={(index) => setViewer({ version: item, index })}
      onRetry={() => void runMutation(() => onRetry(item.id))}
      version={item}
    />
  );

  if (isLoading) {
    return (
      <SafeAreaView style={styles.centered}>
        <ActivityIndicator color={colors.primary} size="large" />
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.container} testID="portrait-timeline-screen">
      <SafeAreaView edges={['top']} style={styles.safeHeader}>
        <View style={styles.header}>
          <Pressable
            accessibilityLabel="Back"
            accessibilityRole="button"
            onPress={onBack}
            style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
            testID="portrait-timeline-back"
          >
            <SymbolView
              fallback={<Text style={styles.backFallback}>‹</Text>}
              name={{ ios: 'chevron.left', android: 'chevron_left' }}
              size={18}
              tintColor={colors.ink2}
            />
          </Pressable>
          <Text style={styles.headerTitle}>Then &amp; now</Text>
          {canEdit ? (
            <Pressable
              accessibilityLabel="Add a portrait"
              accessibilityRole="button"
              onPress={() => {
                setLocalError('');
                setSheet('add');
              }}
              style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
              testID="portrait-timeline-add"
            >
              <SymbolView
                fallback={<Text style={styles.plusFallback}>+</Text>}
                name={{ ios: 'plus', android: 'add' }}
                size={19}
                tintColor={colors.primary}
              />
            </Pressable>
          ) : <View style={styles.iconButtonSpacer} />}
        </View>
      </SafeAreaView>

      <FlatList
        contentContainerStyle={styles.listContent}
        data={versions}
        keyExtractor={(item) => item.id}
        ListEmptyComponent={(
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>No portraits yet</Text>
            <Text style={styles.emptyText}>The first photo will begin {member.name}’s portrait timeline.</Text>
          </View>
        )}
        ListFooterComponent={hasSingleReadyPortrait ? <OnePortraitCallout name={member.name} /> : null}
        ListHeaderComponent={(
          <View style={styles.intro}>
            <Text style={styles.eyebrow}>Through the years</Text>
            <Text style={styles.memberName}>{member.name}</Text>
            <Text style={styles.introCopy}>
              {timelineCount} {timelineCount === 1 ? 'portrait' : 'portraits'} · how {member.name} has looked over time
            </Text>
            {!canEdit ? <Text style={styles.viewerCopy}>Family managers can add and update portraits.</Text> : null}
            {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
            {localError && sheet === null ? <Text style={styles.errorText}>{localError}</Text> : null}
          </View>
        )}
        onRefresh={onRefresh}
        refreshing={isRefreshing}
        renderItem={renderVersion}
        ItemSeparatorComponent={() => <View style={styles.cardGap} />}
        testID="portrait-timeline-list"
      />

      <BottomSheet onClose={closeSheet} testID="portrait-add-sheet" visible={sheet === 'add'}>
        <Text style={styles.sheetTitle}>Add a portrait</Text>
        <Text style={styles.sheetSubtitle}>
          Add a current or older photo to capture how {member.name} looked at that time.
        </Text>
        <SheetRow
          disabled={isPicking}
          onPress={() => void pickPhoto('camera')}
          subtitle={`Dated today, ${formatLongDate(getLocalTodayIso())}`}
          symbol={{ ios: 'camera', android: 'photo_camera' }}
          testID="portrait-add-camera"
          title="Take photo"
        />
        <View style={styles.divider} />
        <SheetRow
          disabled={isPicking}
          onPress={() => void pickPhoto('library')}
          subtitle="Uses the photo’s own date when available"
          symbol={{ ios: 'photo', android: 'photo_library' }}
          testID="portrait-add-library"
          title="Choose from library"
        />
        {isPicking ? <ActivityIndicator color={colors.primary} style={styles.sheetSpinner} /> : null}
        {localError ? <Text style={styles.errorText}>{localError}</Text> : null}
        <View style={styles.helperBox}>
          <SymbolView
            fallback={<Text style={styles.sparkleFallback}>✦</Text>}
            name={{ ios: 'sparkles', android: 'auto_awesome' }}
            size={15}
            tintColor={colors.primary}
          />
          <Text style={styles.helperText}>
            The portrait generates after the photo is saved. The current one stays until the new one is ready.
          </Text>
        </View>
      </BottomSheet>

      <BottomSheet onClose={closeSheet} testID="portrait-date-sheet" visible={sheet === 'date'}>
        <Text style={styles.sheetTitle}>Portrait date</Text>
        <Text style={styles.sheetSubtitle}>This sets {member.name}’s age in the illustration.</Text>
        <View style={styles.dateCard}>
          <View style={styles.dateCardCopy}>
            <Text style={styles.dateCardTitle}>{formatLongDate(draftDate)}</Text>
            {formatPortraitAge(member.date_of_birth, draftDate) ? (
              <Text style={styles.dateCardAge}>{formatPortraitAge(member.date_of_birth, draftDate)} old</Text>
            ) : null}
          </View>
          {photoDraft ? (
            <SourceChip source={draftDate === photoDraft.referenceDate ? photoDraft.dateSource : 'manual'} />
          ) : null}
        </View>
        <Text style={styles.dateLabel}>Set the date</Text>
        <DatePickerField
          accessibilityHint="Cannot be after today or before this person’s birthday"
          defaultPickerDate={today}
          maximumDate={today}
          minimumDate={minimumDate}
          onChange={setDraftDate}
          testID="portrait-date-picker"
          value={draftDate}
        />
        <Text style={styles.dateHint}>Can’t be after today{member.date_of_birth ? ` or before ${member.name}’s birthday` : ''}.</Text>
        {localError ? <Text style={styles.errorText}>{localError}</Text> : null}
        <Pressable
          accessibilityRole="button"
          disabled={!draftDate || isMutating || isCreating}
          onPress={() => void saveDate()}
          style={({ pressed }) => [
            styles.primaryButton,
            (!draftDate || isMutating || isCreating) && styles.primaryButtonDisabled,
            pressed && styles.primaryButtonPressed,
          ]}
          testID="portrait-date-save"
        >
          {isMutating || isCreating ? <ActivityIndicator color={colors.white} /> : <Text style={styles.primaryButtonText}>Save portrait</Text>}
        </Pressable>
      </BottomSheet>

      <BottomSheet onClose={closeSheet} testID="portrait-actions-sheet" visible={sheet === 'actions'}>
        {focusedVersion ? (
          <>
            <View style={styles.actionHeader}>
              <View style={styles.actionHeaderCopy}>
                <Text style={styles.actionHeaderTitle}>{formatLongDate(focusedVersion.referenceDate)}</Text>
                <Text style={styles.actionHeaderSubtitle}>
                  {formatPortraitAge(member.date_of_birth, focusedVersion.referenceDate)
                    ? `${formatPortraitAge(member.date_of_birth, focusedVersion.referenceDate)} old`
                    : 'Legacy portrait'}
                </Text>
              </View>
              {focusedVersion.id === currentVersionId ? <Text style={styles.currentPill}>Current</Text> : null}
            </View>
            <View style={styles.divider} />
            <SheetRow
              disabled={isMutating || focusedVersion.isGenerating || focusedVersion.isDeleting}
              onPress={() => {
                setPhotoDraft(null);
                setDraftDate(focusedVersion.referenceDate ?? getLocalTodayIso());
                setSheet('date');
              }}
              subtitle={focusedVersion.dateSource === 'legacy_unknown' ? 'Add a date to place this portrait' : undefined}
              symbol={{ ios: 'calendar', android: 'calendar_month' }}
              testID="portrait-action-edit-date"
              title="Edit date"
            />
            <SheetRow
              disabled={isMutating || !focusedVersion.referenceDate || focusedVersion.isGenerating || focusedVersion.isDeleting}
              onPress={() => void runMutation(() => onRegenerate(focusedVersion.id))}
              subtitle={focusedVersion.referenceDate
                ? 'Make a new illustration from the same photo'
                : 'Add a date before regenerating this portrait'}
              symbol={{ ios: 'arrow.clockwise', android: 'refresh' }}
              testID="portrait-action-regenerate"
              title="Regenerate portrait"
            />
            <View style={styles.divider} />
            <SheetRow
              danger={!cannotDeleteFocusedVersion}
              disabled={isMutating || focusedVersion.isGenerating || focusedVersion.isDeleting || cannotDeleteFocusedVersion}
              onPress={() => requestDelete(focusedVersion)}
              subtitle={timelineCount <= 1
                ? `${member.name}’s only timeline record — can’t be removed`
                : focusedIsLastUsablePortrait
                  ? 'Keep at least one finished portrait before removing this one'
                : undefined}
              symbol={{ ios: 'trash', android: 'delete' }}
              testID="portrait-action-delete"
              title={cannotDeleteFocusedVersion ? 'Delete' : 'Delete portrait'}
            />
            {localError ? <Text style={styles.errorText}>{localError}</Text> : null}
          </>
        ) : null}
      </BottomSheet>

      {viewer ? (
        <FullScreenMediaViewer
          accessibilityLabel={`${member.name} portrait pair from ${formatLongDate(viewer.version.referenceDate)}`}
          cacheVersion={viewer.version.updatedAt}
          initialIndex={Math.min(viewer.index, Math.max(viewerItems.length - 1, 0))}
          items={viewerItems}
          onClose={() => setViewer(null)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: colors.bg, flex: 1 },
  centered: { alignItems: 'center', backgroundColor: colors.bg, flex: 1, justifyContent: 'center' },
  safeHeader: { backgroundColor: colors.bg },
  header: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 20, paddingBottom: 4 },
  iconButton: { alignItems: 'center', backgroundColor: colors.white, borderColor: colors.border, borderRadius: 19, borderWidth: 1, height: 38, justifyContent: 'center', width: 38 },
  iconButtonSpacer: { height: 38, width: 38 },
  headerTitle: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 15 },
  pressed: { opacity: 0.72 },
  backFallback: { color: colors.ink2, fontSize: 24, lineHeight: 24 },
  plusFallback: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 21 },
  listContent: { paddingBottom: spacing.xxl },
  intro: { paddingBottom: 18, paddingHorizontal: spacing.lg, paddingTop: 18 },
  eyebrow: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 11, letterSpacing: 1.5, textTransform: 'uppercase' },
  memberName: { color: colors.ink, fontFamily: fonts.displayMedium, fontSize: 27, lineHeight: 31, marginTop: 7 },
  introCopy: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 13, lineHeight: 19, marginTop: 5 },
  viewerCopy: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 12, marginTop: 6 },
  card: { backgroundColor: colors.white, borderColor: colors.border, borderRadius: radius.lg, borderWidth: 1, marginHorizontal: spacing.lg, overflow: 'hidden' },
  cardGap: { height: spacing.md },
  pair: { backgroundColor: colors.border, flexDirection: 'row', gap: 2 },
  visualSlot: { aspectRatio: 1, flex: 1, minWidth: 0, position: 'relative' },
  visual: { height: '100%', width: '100%' },
  photoFallback: { alignItems: 'center', backgroundColor: colors.surface, justifyContent: 'center' },
  generatingVisual: { alignItems: 'center', backgroundColor: colors.primaryTint, gap: 9, justifyContent: 'center' },
  generatingText: { color: colors.ink2, fontFamily: fonts.sansBold, fontSize: 12 },
  failedVisual: { alignItems: 'center', backgroundColor: colors.surface, gap: 7, justifyContent: 'center' },
  failedText: { color: colors.ink2, fontFamily: fonts.sansBold, fontSize: 12 },
  failedFallback: { color: colors.error, fontFamily: fonts.sansBold, fontSize: 20 },
  pairTag: { backgroundColor: 'rgba(28,20,10,0.5)', borderRadius: radius.pill, bottom: 8, left: 8, paddingHorizontal: 7, paddingVertical: 2, position: 'absolute' },
  pairTagRight: { left: undefined, right: 8 },
  pairTagText: { color: colors.white, fontFamily: fonts.sansBold, fontSize: 9, letterSpacing: 1, textTransform: 'uppercase' },
  currentBadge: { alignItems: 'center', backgroundColor: colors.primary, borderRadius: radius.pill, flexDirection: 'row', gap: 5, paddingHorizontal: 9, paddingVertical: 4, position: 'absolute', right: 8, top: 8 },
  currentDot: { backgroundColor: colors.white, borderRadius: 3, height: 5, width: 5 },
  currentBadgeText: { color: colors.white, fontFamily: fonts.sansBold, fontSize: 10.5 },
  updatingBadge: { alignItems: 'center', backgroundColor: 'rgba(44,36,24,0.6)', borderRadius: radius.pill, flexDirection: 'row', gap: 5, left: 8, paddingHorizontal: 8, paddingVertical: 4, position: 'absolute', top: 8 },
  updatingText: { color: colors.white, fontFamily: fonts.sansBold, fontSize: 10 },
  infoRow: { alignItems: 'flex-start', flexDirection: 'row', gap: 10, padding: 14 },
  infoCopy: { flex: 1, minWidth: 0 },
  dateTitle: { color: colors.ink, fontFamily: fonts.displayMedium, fontSize: 17, lineHeight: 20 },
  metaRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 7 },
  ageText: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 13 },
  sourceChip: { alignItems: 'center', alignSelf: 'flex-start', backgroundColor: colors.surface, borderColor: colors.border, borderRadius: radius.pill, borderWidth: 1, flexDirection: 'row', gap: 5, paddingHorizontal: 8, paddingVertical: 4 },
  sourceChipText: { color: colors.ink2, fontFamily: fonts.sansBold, fontSize: 11.5 },
  sourceChipFallback: { color: colors.ink3, fontSize: 10 },
  smallIconButton: { alignItems: 'center', backgroundColor: colors.white, borderColor: colors.border, borderRadius: 17, borderWidth: 1, height: 34, justifyContent: 'center', width: 34 },
  moreFallback: { color: colors.ink2, fontFamily: fonts.sansBold, fontSize: 11 },
  workingLabel: { alignItems: 'center', flexDirection: 'row', gap: 6, paddingTop: 9 },
  workingDot: { backgroundColor: '#F2B441', borderRadius: 3, height: 6, width: 6 },
  workingText: { color: colors.ink3, fontFamily: fonts.sansBold, fontSize: 11.5 },
  retryWrap: { paddingBottom: 14, paddingHorizontal: 14 },
  retryButton: { alignItems: 'center', backgroundColor: colors.primaryTint, borderColor: '#D63E7844', borderRadius: radius.md, borderWidth: 1, flexDirection: 'row', gap: 8, justifyContent: 'center', paddingVertical: 11 },
  retryText: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 14 },
  inlineNotice: { backgroundColor: colors.errorSoft, marginBottom: 12, marginHorizontal: 14, padding: 10, borderRadius: radius.md },
  inlineNoticeText: { color: colors.error, fontFamily: fonts.sans, fontSize: 12, lineHeight: 17 },
  callout: { alignItems: 'center', backgroundColor: colors.surface, borderColor: colors.border, borderRadius: radius.lg, borderWidth: 1, gap: 8, marginHorizontal: spacing.lg, marginTop: 20, paddingHorizontal: 18, paddingVertical: 20 },
  calloutIcon: { alignItems: 'center', backgroundColor: colors.primaryTint, borderRadius: 20, height: 40, justifyContent: 'center', width: 40 },
  calloutFallback: { color: colors.primary, fontSize: 18 },
  calloutTitle: { color: colors.ink, fontFamily: fonts.displayMedium, fontSize: 17 },
  calloutText: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 13.5, lineHeight: 20, maxWidth: 270, textAlign: 'center' },
  emptyState: { alignItems: 'center', marginHorizontal: spacing.lg, paddingVertical: spacing.xxl },
  emptyTitle: { color: colors.ink, fontFamily: fonts.displayMedium, fontSize: 20 },
  emptyText: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20, marginTop: spacing.sm, textAlign: 'center' },
  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  sheetBackdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(28,20,10,0.34)' },
  sheet: { backgroundColor: colors.white, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, paddingHorizontal: 20, paddingTop: 10 },
  grabber: { alignSelf: 'center', backgroundColor: colors.border, borderRadius: radius.pill, height: 4, marginBottom: 16, width: 38 },
  sheetTitle: { color: colors.ink, fontFamily: fonts.displayMedium, fontSize: 22, lineHeight: 26 },
  sheetSubtitle: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20, marginBottom: 12, marginTop: 4 },
  sheetRow: { alignItems: 'center', flexDirection: 'row', gap: 14, minHeight: 68, paddingHorizontal: 6, paddingVertical: 9 },
  sheetRowDisabled: { opacity: 0.42 },
  sheetRowIcon: { alignItems: 'center', backgroundColor: colors.surface, borderRadius: 12, height: 42, justifyContent: 'center', width: 42 },
  sheetRowIconDanger: { backgroundColor: colors.errorSoft },
  sheetRowCopy: { flex: 1, minWidth: 0 },
  sheetRowTitle: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 15.5 },
  sheetRowTitleDanger: { color: colors.error },
  sheetRowSubtitle: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 17, marginTop: 2 },
  divider: { backgroundColor: colors.border, height: 1 },
  sheetSpinner: { marginVertical: 4 },
  helperBox: { alignItems: 'flex-start', backgroundColor: colors.surface, borderColor: colors.border, borderRadius: radius.md, borderWidth: 1, flexDirection: 'row', gap: 9, marginTop: 12, padding: 11 },
  sparkleFallback: { color: colors.primary, fontSize: 16 },
  helperText: { color: colors.ink2, flex: 1, fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 18 },
  dateCard: { alignItems: 'center', backgroundColor: colors.surface, borderColor: colors.border, borderRadius: radius.lg, borderWidth: 1, flexDirection: 'row', gap: 10, justifyContent: 'space-between', padding: spacing.md },
  dateCardCopy: { flex: 1, minWidth: 0 },
  dateCardTitle: { color: colors.ink, fontFamily: fonts.displayMedium, fontSize: 20 },
  dateCardAge: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 12.5, marginTop: 4 },
  dateLabel: { color: colors.ink2, fontFamily: fonts.sansBold, fontSize: 13, marginBottom: 6, marginTop: 14 },
  dateHint: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 12, marginTop: 8, textAlign: 'center' },
  errorText: { color: colors.error, fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 18, marginTop: 10 },
  primaryButton: { alignItems: 'center', backgroundColor: colors.primary, borderRadius: radius.pill, justifyContent: 'center', marginTop: 16, minHeight: 50, paddingHorizontal: 20 },
  primaryButtonDisabled: { opacity: 0.45 },
  primaryButtonPressed: { backgroundColor: colors.primaryDark },
  primaryButtonText: { color: colors.white, fontFamily: fonts.sansBold, fontSize: 16 },
  actionHeader: { alignItems: 'center', flexDirection: 'row', gap: 12, paddingBottom: 12, paddingHorizontal: 2 },
  actionHeaderCopy: { flex: 1, minWidth: 0 },
  actionHeaderTitle: { color: colors.ink, fontFamily: fonts.displayMedium, fontSize: 16 },
  actionHeaderSubtitle: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 12.5, marginTop: 2 },
  currentPill: { backgroundColor: colors.primaryTint, borderRadius: radius.pill, color: colors.primary, fontFamily: fonts.sansBold, fontSize: 10.5, overflow: 'hidden', paddingHorizontal: 9, paddingVertical: 4 },
});
