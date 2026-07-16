import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, fonts, getEmotionColors, radius, spacing } from '@/constants/theme';
import { CastCard } from '@/components/cast-card';
import { ContentActionSheet } from '@/components/content-action-sheet';
import { ContentHiddenNotice } from '@/components/content-hidden-notice';
import { FullScreenMediaViewer } from '@/components/full-screen-media-viewer';
import { ReportSheet } from '@/components/report-sheet';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useContentSafety } from '@/hooks/useContentSafety';
import { useMemberMemories } from '@/hooks/useMemories';
import { useMediaUrl } from '@/hooks/useMediaUrls';
import { usePortraitVersions } from '@/hooks/usePortraitVersions';
import { useVideoThumbnail } from '@/hooks/useVideoThumbnail';
import { editFamilyMemberRoute, memoryDetailRoute, portraitTimelineRoute } from '@/lib/routes';
import type { MemoryWithTags } from '@/services/memories';
import type { ReportTargetType } from '@/services/content-safety';
import { substituteLinkLabels, toLinkPreviewMap } from '@/utils/links';
import { resolvePreferredCoverKey, resolveVideoPosterKey } from '@/utils/media-preview';
import { canEditFamilyContent } from '@/utils/roles';
import { formatDisplayDate } from '@/utils/memories';

// ── Thumbnail for the memories list ──────────────────────────────────────────
function MemoryThumb({
  memory,
  isIllustrationHidden = false,
  onShowIllustration,
}: {
  memory: MemoryWithTags;
  isIllustrationHidden?: boolean;
  onShowIllustration?: () => void;
}) {
  const isMedia = memory.memory_type === 'media';
  const coverAsset = memory.mediaAssets[0];
  const isVideo = coverAsset ? coverAsset.content_type.startsWith('video/') : isMedia && memory.media_content_type?.startsWith('video/');

  // Prefers the derived preview key (Workstream C6) for the photo case.
  const photoMediaKey = isMedia ? resolvePreferredCoverKey(coverAsset, memory.media_key) : null;
  const posterKey = isVideo ? resolveVideoPosterKey(coverAsset) : null;
  // Only fetch the actual video file when there's no stored poster -- avoids
  // a full ranged fetch + native decode purely to render a paused thumbnail.
  const videoMediaKey =
    isMedia && isVideo && !posterKey ? (coverAsset?.object_key ?? memory.media_key ?? null) : null;
  const illustrationKey =
    memory.memory_type === 'text_illustration' ? (memory.illustration_key ?? null) : null;

  const { url: illustrationUrl } = useMediaUrl(
    isIllustrationHidden ? null : illustrationKey,
    memory.updated_at,
  );
  const { url: mediaUrl } = useMediaUrl(isMedia && !isVideo ? photoMediaKey : null, memory.updated_at);
  const { url: posterUrl } = useMediaUrl(posterKey, memory.updated_at);
  const { url: videoUrl } = useMediaUrl(videoMediaKey, memory.updated_at);
  const runtimeVideoThumbnail = useVideoThumbnail(videoUrl);
  const videoThumbnail = posterUrl ?? runtimeVideoThumbnail;

  const emo = getEmotionColors(memory.emotion);

  if (memory.memory_type === 'text_illustration' && isIllustrationHidden && onShowIllustration) {
    return (
      <Pressable
        accessibilityLabel="Show reported AI illustration"
        accessibilityRole="button"
        onPress={(event) => {
          event.stopPropagation();
          onShowIllustration();
        }}
        style={[styles.thumb, styles.hiddenThumb]}
        testID={`member-memory-${memory.id}-illustration-show`}
      >
        <Text style={styles.hiddenThumbText}>Show</Text>
      </Pressable>
    );
  }

  if (memory.memory_type === 'text_illustration' && illustrationUrl) {
    return (
      <Image
        source={{ uri: illustrationUrl }}
        style={styles.thumb}
        contentFit="cover"
      />
    );
  }

  if (memory.memory_type === 'text_only') {
    return (
      <View style={[styles.thumb, { backgroundColor: emo?.soft ?? colors.surface, alignItems: 'center', justifyContent: 'center' }]}>
        <Text style={[styles.thumbQuote, { color: emo?.ink ?? colors.ink3 }]}>“</Text>
      </View>
    );
  }

  const displayUri = isVideo ? videoThumbnail : mediaUrl;
  if (isMedia && displayUri) {
    return (
      <View style={styles.thumb}>
        <Image source={{ uri: displayUri }} style={styles.thumb} contentFit="cover" />
        {isVideo && (
          <View style={styles.playOverlay}>
            <SymbolView
              name={{ ios: 'play.fill', android: 'play_arrow' }}
              size={14}
              tintColor={colors.white}
              fallback={<Text style={{ fontSize: 12, color: colors.white }}>▶</Text>}
            />
          </View>
        )}
        {memory.mediaAssets.length > 1 && (
          <View style={styles.thumbCountBadge}>
            <Text style={styles.thumbCountText}>{memory.mediaAssets.length}</Text>
          </View>
        )}
      </View>
    );
  }

  return (
    <View style={[styles.thumb, { backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' }]}>
      <SymbolView
        name={{ ios: isVideo ? 'video' : 'camera', android: isVideo ? 'videocam' : 'photo_camera' }}
        size={20}
        tintColor={colors.ink3}
        fallback={<Text style={{ fontSize: 16, color: colors.ink3 }}>📷</Text>}
      />
    </View>
  );
}

// Module-level so FlatList sees a stable component type -- an inline arrow
// would remount every separator on each screen re-render.
function MemoryRowSeparator() {
  return <View style={styles.memoryRowSeparator} />;
}

export default function ViewFamilyMemberScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { role } = useFamily();
  const canEdit = canEditFamilyContent(role);
  const contentSafety = useContentSafety();
  const { members, isLoading, deleteMember, isDeleting } = useFamilyMembers();
  const { versions: portraitVersions } = usePortraitVersions(id);
  // Server-filtered to this member (Workstream A6) instead of paging in and
  // client-filtering the whole timeline.
  const { memories: memberMemories, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useMemberMemories(id);
  const [deleteError, setDeleteError] = useState('');
  const [isPortraitFullScreen, setIsPortraitFullScreen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [reportTarget, setReportTarget] = useState<{
    type: ReportTargetType;
    id: string;
  } | null>(null);

  const member = members.find((m) => m.id === id);
  const portraitKey = member?.resolvedPortraitVersion?.illustrated_profile_key ?? null;
  const portraitCacheVersion = member?.avatarUpdatedAt ?? member?.updated_at;
  const currentPortraitId = member?.resolvedPortraitVersion?.id ?? null;
  const shouldLoadPortrait = Boolean(
    member &&
    !contentSafety.isLoading &&
    !contentSafety.isError &&
    !contentSafety.isTargetReported('family_member_profile', member.id) &&
    !contentSafety.isTargetReported('family_member_portrait', currentPortraitId),
  );
  const { url: portraitUrl } = useMediaUrl(
    shouldLoadPortrait ? portraitKey : null,
    portraitCacheVersion,
  );
  const portraitCount = portraitVersions.filter((version) => !version.deletion_token).length;

  const handleDelete = () => {
    if (!member) return;
    Alert.alert(
      'Remove from family',
      `Remove ${member.name} from your family? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            setDeleteError('');
            try {
              await deleteMember(member.id);
              router.back();
            } catch (error) {
              setDeleteError(error instanceof Error ? error.message : 'Could not remove member');
            }
          },
        },
      ],
    );
  };

  if (isLoading || contentSafety.isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (!member) {
    return (
      <View style={styles.centered}>
        <Text style={styles.notFoundText}>Person not found</Text>
      </View>
    );
  }

  if (contentSafety.isError) {
    return (
      <View style={styles.centered}>
        <Text style={styles.notFoundText}>Couldn’t load this profile</Text>
        <Pressable onPress={() => void contentSafety.refetch()}>
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  const isProfileHidden = contentSafety.isTargetReported('family_member_profile', member.id);
  const isPortraitHidden = contentSafety.isTargetReported('family_member_portrait', currentPortraitId);
  const visibleMemberMemories = memberMemories.filter((memory) => !contentSafety.isUserBlocked(memory.user_id));
  const canReportProfile = !contentSafety.hasActiveReport('family_member_profile', member.id);
  const canReportPortrait = Boolean(
    currentPortraitId && member.resolvedPortraitVersion?.illustrated_profile_status === 'ready' &&
    member.resolvedPortraitVersion.illustrated_profile_key &&
    !contentSafety.hasActiveReport('family_member_portrait', currentPortraitId),
  );

  const listHeader = (
    <>
      {/* ── Header ── */}
      <SafeAreaView edges={['top']}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.iconBtn} testID="view-member-back">
            <SymbolView
              name={{ ios: 'chevron.left', android: 'chevron_left' }}
              size={17}
              tintColor={colors.ink2}
              fallback={<Text style={styles.iconBtnText}>‹</Text>}
            />
          </Pressable>
          <View style={styles.headerRight}>
            {canReportProfile || canReportPortrait ? <Pressable
              accessibilityLabel="Profile actions"
              accessibilityRole="button"
              onPress={() => setActionsOpen(true)}
              style={styles.iconBtn}
              testID="view-member-more"
            >
              <SymbolView
                name={{ ios: 'ellipsis', android: 'more_horiz' }}
                size={17}
                tintColor={colors.ink2}
                fallback={<Text style={styles.iconBtnText}>•••</Text>}
              />
            </Pressable> : null}
            {canEdit ? (
              <>
              <Pressable
                onPress={() => router.push(editFamilyMemberRoute(member.id))}
                style={styles.iconBtn}
                testID="view-member-edit"
              >
                <SymbolView
                  name={{ ios: 'pencil', android: 'edit' }}
                  size={16}
                  tintColor={colors.ink2}
                  fallback={<Text style={styles.iconBtnText}>✎</Text>}
                />
              </Pressable>
              <Pressable
                onPress={handleDelete}
                disabled={isDeleting}
                style={styles.iconBtn}
                testID="view-member-delete"
              >
                {isDeleting ? (
                  <ActivityIndicator size="small" color={colors.error} />
                ) : (
                  <SymbolView
                    name={{ ios: 'trash', android: 'delete' }}
                    size={16}
                    tintColor={colors.error}
                    fallback={<Text style={{ fontSize: 15, color: colors.error }}>🗑</Text>}
                  />
                )}
              </Pressable>
              </>
            ) : null}
          </View>
        </View>
      </SafeAreaView>

      <View style={styles.content}>
        {isProfileHidden ? (
          <ContentHiddenNotice
            label="Reported family profile hidden"
            onShow={() => {
              contentSafety.revealTarget('family_member_profile', member.id);
            }}
            testID="family-profile-hidden"
          />
        ) : (
          <CastCard
            isPortraitHidden={isPortraitHidden}
            member={member}
            onPortraitPress={portraitUrl && !isPortraitHidden ? () => setIsPortraitFullScreen(true) : undefined}
            onPortraitTimelinePress={() => router.push(portraitTimelineRoute(member.id))}
            onShowPortrait={currentPortraitId
              ? () => contentSafety.revealTarget('family_member_portrait', currentPortraitId)
              : undefined}
            portraitCount={portraitCount}
          />
        )}

        {deleteError ? <Text style={styles.deleteErrorText}>{deleteError}</Text> : null}

        {/* ── Memories with this person ── */}
        {visibleMemberMemories.length > 0 ? (
          <Text style={styles.memoriesEyebrow}>Memories with {isProfileHidden ? 'this person' : member.name}</Text>
        ) : null}
      </View>
    </>
  );

  return (
    <View style={styles.container}>
      <FlatList
        contentContainerStyle={styles.scrollContent}
        data={visibleMemberMemories}
        keyExtractor={(m) => m.id}
        ListHeaderComponent={listHeader}
        initialNumToRender={10}
        ItemSeparatorComponent={MemoryRowSeparator}
        onEndReached={() => {
          if (hasNextPage && !isFetchingNextPage) {
            void fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.5}
        ListFooterComponent={
          isFetchingNextPage ? (
            <ActivityIndicator style={styles.footerSpinner} color={colors.primary} />
          ) : null
        }
        renderItem={({ item: m }) => {
          const isMemoryReported = contentSafety.isTargetReported('memory', m.id);
          const isIllustrationReported = contentSafety.isTargetReported(
            'memory_illustration',
            m.id,
            m.illustration_generation_id,
          );
          if (isMemoryReported) {
            return (
              <View style={styles.memoryRowWrap}>
                <ContentHiddenNotice
                  label="Reported memory hidden"
                  onShow={() => contentSafety.revealTarget('memory', m.id)}
                  testID={`member-memory-${m.id}-hidden`}
                />
              </View>
            );
          }
          return <View style={styles.memoryRowWrap}>
            <Pressable
              onPress={() => router.push(memoryDetailRoute(m.id))}
              style={({ pressed }) => [styles.memoryRow, pressed && styles.memoryRowPressed]}
              testID={`member-memory-${m.id}`}
            >
              <MemoryThumb
                isIllustrationHidden={isIllustrationReported}
                memory={m}
                onShowIllustration={() => contentSafety.revealTarget(
                  'memory_illustration',
                  m.id,
                  m.illustration_generation_id,
                )}
              />
              <View style={styles.memoryRowContent}>
                <Text style={styles.memoryDate}>{formatDisplayDate(m.memory_date)}</Text>
                {m.content ? (
                  <Text style={styles.memoryText} numberOfLines={2}>
                    {substituteLinkLabels(m.content, toLinkPreviewMap(m.link_previews))}
                  </Text>
                ) : (
                  <Text style={styles.memoryNoCaption}>
                    {m.memory_type === 'media' && m.mediaAssets.length > 1
                      ? 'Media'
                      : m.memory_type === 'media' && m.media_content_type?.startsWith('video/')
                        ? 'Video'
                        : 'Photo'}
                  </Text>
                )}
                {(() => {
                  const emo = getEmotionColors(m.emotion);
                  return emo && m.emotion ? (
                    <View style={[styles.emotionChip, { backgroundColor: emo.soft }]}>
                      <View style={[styles.emotionDot, { backgroundColor: emo.c }]} />
                      <Text style={[styles.emotionLabel, { color: emo.ink }]}>{m.emotion}</Text>
                    </View>
                  ) : null;
                })()}
              </View>
              <SymbolView
                name={{ ios: 'chevron.right', android: 'chevron_right' }}
                size={14}
                tintColor={colors.ink3}
                fallback={<Text style={styles.chevronText}>›</Text>}
              />
            </Pressable>
          </View>;
        }}
      />
      <ContentActionSheet
        actions={[
          ...(canReportProfile ? [{
            danger: true,
            label: 'Report family profile',
            onPress: () => setReportTarget({
              type: 'family_member_profile' as const,
              id: member.id,
            }),
            testID: 'family-profile-action-report',
          }] : []),
          ...(canReportPortrait ? [{
              danger: true,
              label: 'Report current AI portrait',
              onPress: () => setReportTarget({
                type: 'family_member_portrait' as const,
                id: currentPortraitId!,
              }),
              testID: 'family-profile-action-report-portrait',
            }] : []),
        ]}
        onClose={() => setActionsOpen(false)}
        testID="family-profile-actions-sheet"
        visible={actionsOpen}
      />
      {reportTarget ? (
        <ReportSheet
          isSubmitting={contentSafety.isReporting}
          onClose={() => setReportTarget(null)}
          onSubmit={(reason, note) => contentSafety.report({
            targetType: reportTarget.type,
            targetId: reportTarget.id,
            reason,
            note,
          }).then(() => undefined)}
          targetLabel={reportTarget.type === 'family_member_portrait' ? 'AI portrait' : 'family profile'}
          targetType={reportTarget.type}
          visible
        />
      ) : null}
      {isPortraitFullScreen && portraitUrl && !isPortraitHidden ? (
        <FullScreenMediaViewer
          accessibilityLabel={`Full-screen portrait of ${member.name}`}
          cacheVersion={portraitCacheVersion}
          items={[{
            id: member.id,
            contentType: 'image/webp',
            uri: portraitUrl,
          }]}
          onClose={() => setIsPortraitFullScreen(false)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  notFoundText: {
    fontFamily: fonts.sans,
    fontSize: 16,
    color: colors.ink3,
  },
  retryText: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 14, marginTop: spacing.sm },
  hiddenThumb: { alignItems: 'center', backgroundColor: colors.surface, justifyContent: 'center' },
  hiddenThumbText: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 11 },
  scrollContent: {
    paddingBottom: 60,
  },
  footerSpinner: {
    paddingVertical: spacing.lg,
  },

  // Header
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnText: {
    fontSize: 22,
    color: colors.ink2,
    fontWeight: '300',
    marginTop: -2,
  },

  // Content
  content: {
    paddingHorizontal: spacing.md,
    gap: 16,
  },

  deleteErrorText: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.error,
    paddingHorizontal: spacing.sm,
  },

  // Memories section
  memoriesEyebrow: {
    fontFamily: fonts.sansBold,
    fontSize: 10,
    letterSpacing: 0.14 * 10,
    textTransform: 'uppercase',
    color: colors.ink3,
    marginBottom: 12,
  },
  memoryRowWrap: {
    paddingHorizontal: spacing.md,
  },
  memoryRowSeparator: {
    height: 10,
  },
  memoryRow: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    gap: 12,
  },
  memoryRowPressed: {
    opacity: 0.85,
  },
  thumb: {
    width: 54,
    height: 54,
    borderRadius: 12,
    flexShrink: 0,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  thumbQuote: {
    fontFamily: fonts.display,
    fontSize: 32,
    lineHeight: 32,
    opacity: 0.45,
    marginTop: -4,
  },
  playOverlay: {
    position: 'absolute',
    inset: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.30)',
    borderRadius: 12,
  },
  thumbCountBadge: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 9,
    height: 18,
    justifyContent: 'center',
    minWidth: 18,
    position: 'absolute',
    right: 4,
    top: 4,
  },
  thumbCountText: {
    color: colors.white,
    fontFamily: fonts.sansBold,
    fontSize: 10,
    paddingHorizontal: 5,
  },
  memoryRowContent: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  memoryDate: {
    fontFamily: fonts.sansBold,
    fontSize: 10,
    letterSpacing: 0.14 * 10,
    textTransform: 'uppercase',
    color: colors.ink3,
  },
  memoryText: {
    fontFamily: fonts.display,
    fontSize: 14,
    lineHeight: 14 * 1.4,
    color: colors.ink,
  },
  memoryNoCaption: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.ink3,
    fontStyle: 'italic',
  },
  chevronText: {
    fontSize: 20,
    color: colors.ink3,
    lineHeight: 22,
  },
  emotionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    paddingVertical: 2,
    paddingLeft: 6,
    paddingRight: 8,
    borderRadius: 999,
  },
  emotionDot: {
    width: 5,
    height: 5,
    borderRadius: 999,
  },
  emotionLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 10.5,
  },
});
