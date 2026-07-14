import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GeneratingVisualOverlay } from '@/components/generating-visual-overlay';
import { FamilyMemberAvatar } from '@/components/family-member-avatar';
import { FullScreenMediaViewer, type FullScreenMediaItem } from '@/components/full-screen-media-viewer';
import { MemoryCommentsDrawer } from '@/components/memory-comments-drawer';
import { MemoryContentText } from '@/components/memory-content-text';
import { MemoryEngagementBar } from '@/components/memory-engagement-bar';
import { MemoryMediaCarousel } from '@/components/memory-media-carousel';
import { colors, fonts, getEmotionColors, getEmotionGradient, radius, spacing } from '@/constants/theme';
import type { FamilyMember } from '@/services/family-members';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMemberProfiles, resolveAttributionName } from '@/hooks/useFamilyMemberProfiles';
import { useMemory, useMemoryMutations } from '@/hooks/useMemories';
import { useMediaUrl } from '@/hooks/useMediaUrls';
import { navigateBack } from '@/lib/navigation';
import { editMemoryRoute } from '@/lib/routes';
import { aspectRatioFromDimensions, clampMediaAspectRatio } from '@/utils/media-aspect';
import { canEditFamilyContent } from '@/utils/roles';
import { formatTaggedMemberAge } from '@/utils/family-members';
import { toLinkPreviewMap } from '@/utils/links';
import {
  formatDisplayDate,
  getIllustrationStatusLabel,
  isIllustrationGenerationStale,
  isIllustrationInProgress,
  needsIllustrationRecovery,
  type IllustrationStatus,
} from '@/utils/memories';

// ── Shared header chrome ──────────────────────────────────────────────────────
function DetailChrome({
  onBack,
  onRegenerateIllustration,
  onEdit,
  onDelete,
  isDeleting = false,
  isRegeneratingIllustration = false,
  regenerateIllustrationDisabled = false,
}: {
  onBack: () => void;
  onRegenerateIllustration?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  isDeleting?: boolean;
  isRegeneratingIllustration?: boolean;
  regenerateIllustrationDisabled?: boolean;
}) {
  const chromeActionDisabled = isDeleting || isRegeneratingIllustration;
  return (
    <View style={styles.chrome}>
      <Pressable onPress={onBack} style={styles.chromeBtn} testID="memory-detail-back">
        <SymbolView
          name={{ ios: 'chevron.left', android: 'chevron_left' }}
          size={17}
          tintColor="rgba(44,36,24,0.75)"
          fallback={<Text style={styles.chromeBtnIcon}>‹</Text>}
        />
      </Pressable>
      <View style={styles.chromeRight}>
        {onRegenerateIllustration && (
          <Pressable
            disabled={chromeActionDisabled || regenerateIllustrationDisabled}
            onPress={onRegenerateIllustration}
            style={[
              styles.chromeBtn,
              (chromeActionDisabled || regenerateIllustrationDisabled) && styles.chromeBtnDisabled,
            ]}
            testID="memory-detail-regenerate-illustration"
          >
            {isRegeneratingIllustration ? (
              <ActivityIndicator color={colors.primary} size="small" />
            ) : (
              <SymbolView
                name={{ ios: 'arrow.clockwise', android: 'refresh' }}
                size={16}
                tintColor="rgba(44,36,24,0.75)"
                fallback={<Text style={styles.chromeBtnText}>↻</Text>}
              />
            )}
          </Pressable>
        )}
        {onEdit && (
          <Pressable
            disabled={chromeActionDisabled}
            onPress={onEdit}
            style={[styles.chromeBtn, chromeActionDisabled && styles.chromeBtnDisabled]}
            testID="memory-detail-edit"
          >
            <SymbolView
              name={{ ios: 'pencil', android: 'edit' }}
              size={16}
              tintColor="rgba(44,36,24,0.75)"
              fallback={<Text style={styles.chromeBtnText}>✎</Text>}
            />
          </Pressable>
        )}
        {onDelete && (
          <Pressable
            disabled={chromeActionDisabled}
            onPress={onDelete}
            style={[styles.chromeBtn, chromeActionDisabled && styles.chromeBtnDisabled]}
            testID="memory-detail-delete"
          >
            <SymbolView
              name={{ ios: 'trash', android: 'delete' }}
              size={16}
              tintColor={colors.error}
              fallback={<Text style={styles.chromeDeleteIcon}>🗑</Text>}
            />
          </Pressable>
        )}
      </View>
    </View>
  );
}

// ── Member tag pill ───────────────────────────────────────────────────────────
function MemberPill({ member }: { member: FamilyMember }) {
  const age = member.date_of_birth ? formatTaggedMemberAge(member.date_of_birth) : null;

  return (
    <View style={styles.memberPill}>
      <FamilyMemberAvatar member={member} size={22} />
      <Text style={styles.memberName}>{member.name}{age ? `, ${age}` : ''}</Text>
    </View>
  );
}

// ── Shared low-priority metadata footer ──────────────────────────────────────
function MemoryMetaFooter({
  date,
  attributionName,
  emotion,
}: {
  date: string;
  attributionName: string;
  emotion?: string | null;
}) {
  const emo = getEmotionColors(emotion);
  return (
    <View style={styles.metaFooter} testID="memory-detail-section-metadata">
      <View style={styles.metaFooterTop}>
        <Text style={styles.detailDate}>{formatDisplayDate(date)}</Text>
        {emo && emotion ? (
          <View style={[styles.emotionChip, { backgroundColor: emo.soft }]}>
            <View style={[styles.emotionDot, { backgroundColor: emo.c }]} />
            <Text style={[styles.emotionLabel, { color: emo.ink }]}>{emotion}</Text>
          </View>
        ) : null}
      </View>
      <Text style={styles.attributionText} testID="memory-detail-attribution">
        Added by {attributionName}
      </Text>
    </View>
  );
}

// ── Detail A — Framed print (illustrated + media) ─────────────────────────────
function MemoryDetailFramed({
  memory,
  illustrationUrl,
  attributionName,
  canEdit,
  onBack,
  onRegenerateIllustration,
  onEdit,
  onDelete,
  isDeleting,
  isRegeneratingIllustration,
  regenerateIllustrationDisabled,
  isRetrying,
  onRetry,
  onOpenComments,
}: {
  memory: NonNullable<ReturnType<typeof useMemory>['data']>;
  illustrationUrl: string | null | undefined;
  attributionName: string;
  canEdit: boolean;
  onBack: () => void;
  onRegenerateIllustration?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  isDeleting: boolean;
  isRegeneratingIllustration: boolean;
  regenerateIllustrationDisabled: boolean;
  isRetrying: boolean;
  onRetry: () => void;
  onOpenComments: () => void;
}) {
  const isMedia = memory.memory_type === 'media';
  const showIllustrationGenerating = isIllustrationInProgress(memory.illustration_status);
  // Illustrations are generated square (1024×1024); measure on load so any
  // legacy or future sizes still render uncropped.
  const [illustrationRatio, setIllustrationRatio] = useState(1);
  const [fullScreenIndex, setFullScreenIndex] = useState<number | null>(null);
  const fullScreenItems: FullScreenMediaItem[] = isMedia
    ? memory.mediaAssets.map((asset) => ({
        id: asset.id,
        contentType: asset.content_type,
        objectKey: asset.object_key,
      }))
    : illustrationUrl
      ? [{ id: memory.id, contentType: 'image/webp', uri: illustrationUrl }]
      : [];

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <LinearGradient
        colors={getEmotionGradient(memory.emotion)}
        locations={[0, 0.45, 1]}
        style={styles.emotionGradient}
        pointerEvents="none"
      />
      <SafeAreaView edges={['top']}>
        <DetailChrome
          isDeleting={isDeleting}
          isRegeneratingIllustration={isRegeneratingIllustration}
          regenerateIllustrationDisabled={regenerateIllustrationDisabled}
          onBack={onBack}
          onRegenerateIllustration={onRegenerateIllustration}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      </SafeAreaView>
      <ScrollView contentContainerStyle={styles.detailScrollContent}>
        <View style={styles.framedCard}>
          {/* Media / illustration */}
          <View style={styles.framedMediaWrap}>
            {isMedia ? (
              memory.mediaAssets.length > 0 ? (
                <MemoryMediaCarousel
                  assets={memory.mediaAssets}
                  cacheVersion={memory.updated_at}
                  isActive={fullScreenIndex === null}
                  mutedVideos={false}
                  onPress={setFullScreenIndex}
                  style={styles.framedMedia}
                />
              ) : (
                <View style={[styles.framedImage, styles.placeholderFrame]}>
                  <Text style={styles.placeholderText}>Loading…</Text>
                </View>
              )
            ) : showIllustrationGenerating || !illustrationUrl ? (
              <View style={[styles.framedImage, styles.placeholderFrame, { aspectRatio: 1 }]}>
                <GeneratingVisualOverlay
                  label={
                    getIllustrationStatusLabel(memory.illustration_status as IllustrationStatus) ??
                    'Illustrated memory'
                  }
                  sparkleSize={32}
                  variant="inline"
                />
              </View>
            ) : (
              <Pressable
                accessibilityLabel="View illustration full screen"
                accessibilityRole="button"
                onPress={() => setFullScreenIndex(0)}
                style={({ pressed }) => pressed && styles.mediaPressed}
                testID="memory-detail-illustration"
              >
                <Image
                  contentFit="cover"
                  onLoad={(event) => {
                    const ratio = aspectRatioFromDimensions(event.source.width, event.source.height);
                    if (ratio) {
                      setIllustrationRatio(clampMediaAspectRatio(ratio));
                    }
                  }}
                  source={{ uri: illustrationUrl }}
                  style={[styles.framedImage, { aspectRatio: illustrationRatio }]}
                />
              </Pressable>
            )}
          </View>

          {/* Content inside card */}
          <View style={styles.framedCardBody}>
            <View testID="memory-detail-section-engagement">
              <MemoryEngagementBar
                memory={memory}
                onOpenComments={onOpenComments}
                iconSize={24}
              />
            </View>
            {memory.content ? (
              <MemoryContentText
                content={memory.content}
                linkPreviews={toLinkPreviewMap(memory.link_previews)}
                style={styles.detailText}
                testID="memory-detail-section-content"
              />
            ) : null}
            {memory.taggedMembers.length > 0 && (
              <View style={styles.memberRow} testID="memory-detail-section-members">
                {memory.taggedMembers.map((m) => (
                  <MemberPill key={m.id} member={m} />
                ))}
              </View>
            )}
            {canEdit &&
              memory.memory_type === 'text_illustration' &&
              (memory.illustration_status === 'failed' || needsIllustrationRecovery(memory)) && (
              <Pressable
                onPress={onRetry}
                disabled={isRetrying}
                style={styles.retryBtn}
                testID="memory-detail-retry-illustration"
              >
                <Text style={styles.retryBtnText}>{isRetrying ? 'Retrying…' : 'Retry illustration'}</Text>
              </Pressable>
            )}
            <MemoryMetaFooter
              date={memory.memory_date}
              attributionName={attributionName}
              emotion={memory.emotion}
            />
          </View>
        </View>
      </ScrollView>
      {fullScreenIndex !== null && fullScreenItems.length > 0 ? (
        <FullScreenMediaViewer
          accessibilityLabel={isMedia ? 'Full-screen memory media' : 'Full-screen memory illustration'}
          cacheVersion={memory.updated_at}
          initialIndex={fullScreenIndex}
          items={fullScreenItems}
          onClose={() => setFullScreenIndex(null)}
        />
      ) : null}
    </View>
  );
}

// ── Detail B — Editorial text (text_only) ─────────────────────────────────────
function MemoryDetailEditorial({
  memory,
  attributionName,
  onBack,
  onEdit,
  onDelete,
  isDeleting,
  onOpenComments,
}: {
  memory: NonNullable<ReturnType<typeof useMemory>['data']>;
  attributionName: string;
  onBack: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  isDeleting: boolean;
  onOpenComments: () => void;
}) {
  const emo = getEmotionColors(memory.emotion);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <LinearGradient
        colors={getEmotionGradient(memory.emotion)}
        locations={[0, 0.45, 1]}
        style={styles.emotionGradient}
        pointerEvents="none"
      />
      <SafeAreaView edges={['top']}>
        <DetailChrome isDeleting={isDeleting} onBack={onBack} onEdit={onEdit} onDelete={onDelete} />
      </SafeAreaView>
      <ScrollView contentContainerStyle={styles.detailScrollContent}>
        <View style={styles.editorialCard}>
          <Text style={[styles.editorialQuote, { color: emo ? emo.ink : colors.ink3 }]}>“</Text>
          <MemoryContentText
            content={memory.content}
            linkPreviews={toLinkPreviewMap(memory.link_previews)}
            style={styles.editorialText}
            testID="memory-detail-section-content"
          />
          {memory.taggedMembers.length > 0 && (
            <View style={styles.memberRow} testID="memory-detail-section-members">
              {memory.taggedMembers.map((m) => (
                <MemberPill key={m.id} member={m} />
              ))}
            </View>
          )}
          <View style={styles.detailUtilities} testID="memory-detail-section-engagement">
            <MemoryEngagementBar
              memory={memory}
              onOpenComments={onOpenComments}
              iconSize={24}
            />
          </View>
          <MemoryMetaFooter
            date={memory.memory_date}
            attributionName={attributionName}
            emotion={memory.emotion}
          />
        </View>
      </ScrollView>
    </View>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────
export default function MemoryDetailScreen() {
  const { id, comments } = useLocalSearchParams<{ id: string; comments?: string }>();
  const { data: memory, isLoading, isError } = useMemory(id);
  const [commentsOpen, setCommentsOpen] = useState(comments === '1');
  const { familyId, role } = useFamily();
  const canEdit = canEditFamilyContent(role);
  const { profiles: memberProfiles } = useFamilyMemberProfiles(familyId);
  const attributionName = resolveAttributionName(memberProfiles, memory?.user_id);
  const {
    deleteMemory,
    retryIllustration,
    regenerateIllustration,
    isDeleting,
    isRetrying,
    isRegenerating,
  } = useMemoryMutations();
  const isLeavingRef = useRef(false);
  const { url: illustrationUrl } = useMediaUrl(
    memory?.illustration_key,
    memory?.updated_at,
  );

  const leaveMemoryDetail = () => {
    if (isLeavingRef.current) {
      return;
    }

    isLeavingRef.current = true;
    navigateBack();
  };

  const confirmDelete = async () => {
    if (!memory || isDeleting || isLeavingRef.current) {
      return;
    }

    try {
      await deleteMemory(memory.id);
      leaveMemoryDetail();
    } catch {
      Alert.alert('Could not delete memory', 'Please try again.');
    }
  };

  const handleDelete = () => {
    if (!memory || isDeleting || isLeavingRef.current) {
      return;
    }

    Alert.alert(
      'Delete memory',
      'This memory will be permanently deleted.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => void confirmDelete() },
      ],
    );
  };

  const handleRetry = async () => {
    if (!memory) return;
    await retryIllustration(memory.id);
  };

  const handleRegenerateIllustration = () => {
    if (!memory || isRegenerating || isDeleting) {
      return;
    }

    Alert.alert(
      'Regenerate illustration',
      'This will create a new AI illustration for this memory. The current image will be replaced.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Regenerate',
          onPress: () => {
            void regenerateIllustration(memory.id).catch((error: unknown) => {
              const message =
                error &&
                typeof error === 'object' &&
                'message' in error &&
                typeof error.message === 'string'
                  ? error.message
                  : 'Please try again in a moment.';
              Alert.alert('Could not regenerate illustration', message);
            });
          },
        },
      ],
    );
  };

  const regenerateIllustrationDisabled =
    memory?.memory_type === 'text_illustration' &&
    memory.illustration_status === 'generating' &&
    !isIllustrationGenerationStale(memory);

  if (isLoading) {
    return (
      <View style={styles.centeredFull}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (isError || !memory) {
    return (
      <View style={styles.centeredFull}>
        <Text style={styles.errorText}>Memory not found</Text>
      </View>
    );
  }

  if (memory.memory_type === 'text_only') {
    return (
      <>
        <MemoryDetailEditorial
          memory={memory}
          attributionName={attributionName}
          isDeleting={isDeleting}
          onBack={leaveMemoryDetail}
          onEdit={canEdit ? () => router.push(editMemoryRoute(id)) : undefined}
          onDelete={canEdit ? handleDelete : undefined}
          onOpenComments={() => setCommentsOpen(true)}
        />
        <MemoryCommentsDrawer
          memory={memory}
          onClose={() => setCommentsOpen(false)}
          visible={commentsOpen}
        />
      </>
    );
  }

  return (
    <>
      <MemoryDetailFramed
        memory={memory}
        illustrationUrl={illustrationUrl}
        attributionName={attributionName}
        canEdit={canEdit}
        onBack={leaveMemoryDetail}
        onRegenerateIllustration={
          canEdit && memory.memory_type === 'text_illustration' ? handleRegenerateIllustration : undefined
        }
        onEdit={canEdit ? () => router.push(editMemoryRoute(id)) : undefined}
        onDelete={canEdit ? handleDelete : undefined}
        isDeleting={isDeleting}
        isRegeneratingIllustration={isRegenerating}
        regenerateIllustrationDisabled={regenerateIllustrationDisabled}
        isRetrying={isRetrying}
        onRetry={handleRetry}
        onOpenComments={() => setCommentsOpen(true)}
      />
      <MemoryCommentsDrawer
        memory={memory}
        onClose={() => setCommentsOpen(false)}
        visible={commentsOpen}
      />
    </>
  );
}

const styles = StyleSheet.create({
  centeredFull: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  errorText: {
    fontFamily: fonts.sans,
    color: colors.error,
    fontSize: 16,
  },

  // ── Chrome ──
  chrome: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  chromeRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  chromeBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chromeBtnDisabled: {
    opacity: 0.45,
  },
  chromeBtnIcon: {
    fontSize: 22,
    color: colors.ink,
    fontWeight: '300',
    marginTop: -1,
  },
  chromeBtnText: {
    fontSize: 16,
    color: colors.ink2,
  },
  chromeDeleteIcon: {
    fontSize: 15,
    color: colors.error,
  },
  emotionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 3,
    paddingLeft: 7,
    paddingRight: 9,
    borderRadius: radius.pill,
  },
  emotionDot: {
    width: 5,
    height: 5,
    borderRadius: radius.pill,
  },
  emotionLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 10.5,
    letterSpacing: 0.02 * 10.5,
  },

  emotionGradient: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '60%',
  },

  // ── Shared low-priority footer ──
  metaFooter: {
    gap: spacing.xs,
  },
  metaFooterTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  detailUtilities: {
    borderTopColor: colors.border,
    borderTopWidth: 1,
    marginTop: 2,
    paddingTop: 10,
  },

  // ── Shared scroll content ──
  detailScrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingVertical: 24,
  },

  // ── Framed detail ──
  framedCard: {
    marginHorizontal: 20,
    marginTop: 12,
    backgroundColor: colors.white,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#281E14',
    shadowOffset: { width: 0, height: 24 },
    shadowOpacity: 0.08,
    shadowRadius: 48,
    elevation: 6,
  },
  framedMediaWrap: {
    padding: 10,
  },
  framedCardBody: {
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 20,
    gap: 14,
  },
  framedImage: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  framedMedia: {
    width: '100%',
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  mediaPressed: {
    opacity: 0.92,
  },
  placeholderFrame: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  placeholderIcon: {
    fontSize: 32,
    color: colors.primary,
  },
  placeholderText: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.ink3,
    textAlign: 'center',
  },
  detailDate: {
    fontFamily: fonts.sansBold,
    fontSize: 10,
    letterSpacing: 0.14 * 10,
    textTransform: 'uppercase',
    color: colors.ink3,
  },
  attributionText: {
    fontFamily: fonts.sans,
    fontSize: 10.5,
    color: colors.ink3,
  },
  detailText: {
    fontFamily: fonts.sans,
    fontSize: 16,
    lineHeight: 26,
    color: colors.ink,
  },
  memberRow: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  memberPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingRight: 10,
    paddingLeft: 4,
    paddingVertical: 4,
  },
  memberName: {
    fontFamily: fonts.sansBold,
    fontSize: 12,
    color: colors.ink,
  },
  retryBtn: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  retryBtnText: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    color: colors.primary,
  },

  // ── Editorial detail ──
  editorialCard: {
    marginHorizontal: 20,
    backgroundColor: colors.white,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 24,
    shadowColor: '#281E14',
    shadowOffset: { width: 0, height: 24 },
    shadowOpacity: 0.08,
    shadowRadius: 48,
    elevation: 4,
    gap: 14,
  },
  editorialQuote: {
    fontFamily: fonts.display,
    fontSize: 56,
    lineHeight: 56,
    height: 34,
    opacity: 0.18,
    marginBottom: -6,
  },
  editorialText: {
    fontFamily: fonts.display,
    fontSize: 22,
    lineHeight: 22 * 1.55,
    color: colors.ink,
  },
});
