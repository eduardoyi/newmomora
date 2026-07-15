import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';

import {
  PortraitTimeline,
  type PortraitTimelinePhotoDraft,
  type PortraitTimelineVersion,
} from '@/components/portrait-timeline';
import { colors, fonts } from '@/constants/theme';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { usePortraitVersions } from '@/hooks/usePortraitVersions';
import {
  type FamilyProfilePhotoPickResult,
  parsePendingPickerResult,
  pickPortraitVersionPhoto,
} from '@/utils/family-profile-photo-picker';
import {
  getLocalTodayIso,
  resolvePortraitVersion,
} from '@/utils/portrait-versions';
import { canEditFamilyContent } from '@/utils/roles';

function pickResultToDraft(
  result: FamilyProfilePhotoPickResult,
): PortraitTimelinePhotoDraft | null {
  if (result.error) throw new Error(result.error);
  if (!result.selection) return null;

  const selection = result.selection;
  return {
    uri: selection.uri,
    contentType: selection.contentType,
    referenceDate: selection.referenceDate,
    dateSource: selection.dateSource,
  };
}

export default function PortraitTimelineScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { role } = useFamily();
  const { members, isLoading: isLoadingMembers } = useFamilyMembers();
  const portraitVersions = usePortraitVersions(id);
  const member = members.find((candidate) => candidate.id === id);
  const canEdit = canEditFamilyContent(role);
  const [recoveredPhotoDraft, setRecoveredPhotoDraft] = useState<PortraitTimelinePhotoDraft | null>(null);
  const [recoveryError, setRecoveryError] = useState('');

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    let isMounted = true;
    void ImagePicker.getPendingResultAsync()
      .then((result) => {
        if (!isMounted || !result) return;
        const draft = pickResultToDraft(parsePendingPickerResult(result));
        if (draft) setRecoveredPhotoDraft(draft);
      })
      .catch((error: unknown) => {
        if (isMounted) {
          setRecoveryError(error instanceof Error
            ? error.message
            : 'Could not recover the selected profile photo.');
        }
      });
    return () => { isMounted = false; };
  }, []);

  if (isLoadingMembers || portraitVersions.isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (!member) {
    return (
      <View style={styles.centered}>
        <Text style={styles.notFound}>Person not found</Text>
      </View>
    );
  }

  const current = resolvePortraitVersion(portraitVersions.versions, getLocalTodayIso());
  const versions: PortraitTimelineVersion[] = portraitVersions.versions.map((version) => ({
    id: version.id,
    referenceDate: version.reference_date,
    dateSource: version.date_source,
    status: version.illustrated_profile_status,
    sourcePhotoKey: version.profile_picture_key,
    portraitKey: version.illustrated_profile_key,
    createdAt: version.created_at,
    updatedAt: version.updated_at,
    isGenerating: Boolean(version.generation_token) || portraitVersions.retryingVersionId === version.id || portraitVersions.regeneratingVersionId === version.id,
    isDeleting: Boolean(version.deletion_token) || portraitVersions.deletingVersionId === version.id,
  }));

  return (
    <PortraitTimeline
      key={recoveredPhotoDraft?.uri ?? 'portrait-timeline'}
      canEdit={canEdit}
      currentVersionId={current?.id ?? null}
      errorMessage={recoveryError || (portraitVersions.isError
        ? portraitVersions.error instanceof Error
          ? portraitVersions.error.message
          : 'Could not load portrait timeline'
        : null)}
      isCreating={portraitVersions.isCreating}
      isRefreshing={portraitVersions.isRefetching}
      member={member}
      onBack={() => router.back()}
      onCreate={(draft) => portraitVersions.createVersion({
        photoUri: draft.uri,
        photoContentType: draft.contentType,
        referenceDate: draft.referenceDate,
        dateSource: draft.dateSource,
        dateOfBirth: member.date_of_birth,
      }).then(() => undefined)}
      onDelete={(versionId) => portraitVersions.deleteVersion(versionId).then(() => undefined)}
      onEditDate={(versionId, referenceDate) => portraitVersions.editVersionDate({
        portraitVersionId: versionId,
        referenceDate,
        dateOfBirth: member.date_of_birth,
      }).then(() => undefined)}
      onPickPhoto={async (source) => pickResultToDraft(await pickPortraitVersionPhoto(source))}
      onRefresh={() => { void portraitVersions.refetch(); }}
      onRegenerate={(versionId) => portraitVersions.regenerateVersion(versionId)}
      onRetry={(versionId) => portraitVersions.retryVersion(versionId)}
      recoveredPhotoDraft={recoveredPhotoDraft}
      versions={versions}
    />
  );
}

const styles = StyleSheet.create({
  centered: {
    alignItems: 'center',
    backgroundColor: colors.bg,
    flex: 1,
    justifyContent: 'center',
  },
  notFound: {
    color: colors.ink3,
    fontFamily: fonts.sans,
    fontSize: 16,
  },
});
