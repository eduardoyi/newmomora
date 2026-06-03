import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
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

import { colors, fonts, getEmotionColors, radius, spacing } from '@/constants/theme';
import { CastCard } from '@/components/cast-card';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useMemories } from '@/hooks/useMemories';
import { useMediaUrl } from '@/hooks/useMediaUrls';
import { useVideoThumbnail } from '@/hooks/useVideoThumbnail';
import { editFamilyMemberRoute, memoryDetailRoute } from '@/lib/routes';
import type { MemoryWithTags } from '@/services/memories';
import { formatDisplayDate } from '@/utils/memories';

// ── Thumbnail for the memories list ──────────────────────────────────────────
function MemoryThumb({ memory }: { memory: MemoryWithTags }) {
  const isMedia = memory.memory_type === 'media';
  const coverAsset = memory.mediaAssets[0];
  const isVideo = coverAsset ? coverAsset.content_type.startsWith('video/') : isMedia && memory.media_content_type?.startsWith('video/');

  const mediaKey = isMedia ? (coverAsset?.object_key ?? memory.media_key ?? null) : null;
  const illustrationKey =
    memory.memory_type === 'text_illustration' ? (memory.illustration_key ?? null) : null;

  const { url: illustrationUrl } = useMediaUrl(illustrationKey, memory.updated_at);
  const { url: mediaUrl } = useMediaUrl(isMedia && !isVideo ? mediaKey : null, memory.updated_at);
  const { url: videoUrl } = useMediaUrl(isVideo ? mediaKey : null, memory.updated_at);
  const videoThumbnail = useVideoThumbnail(videoUrl);

  const emo = getEmotionColors(memory.emotion);

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
        <Text style={[styles.thumbQuote, { color: emo?.ink ?? colors.ink3 }]}>"</Text>
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

export default function ViewFamilyMemberScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { members, isLoading, deleteMember, isDeleting } = useFamilyMembers();
  const { memories } = useMemories();
  const [deleteError, setDeleteError] = useState('');

  const member = members.find((m) => m.id === id);

  const memberMemories = memories.filter((m) =>
    m.taggedMembers.some((tm) => tm.id === id),
  );

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

  if (isLoading) {
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

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
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
            </View>
          </View>
        </SafeAreaView>

        <View style={styles.content}>
          <CastCard member={member} />

          {deleteError ? <Text style={styles.deleteErrorText}>{deleteError}</Text> : null}

          {/* ── Memories with this person ── */}
          {memberMemories.length > 0 && (
            <View style={styles.memoriesSection}>
              <Text style={styles.memoriesEyebrow}>Memories with {member.name}</Text>
              <View style={styles.memoriesList}>
                {memberMemories.map((m) => (
                  <Pressable
                    key={m.id}
                    onPress={() => router.push(memoryDetailRoute(m.id))}
                    style={({ pressed }) => [styles.memoryRow, pressed && styles.memoryRowPressed]}
                    testID={`member-memory-${m.id}`}
                  >
                    <MemoryThumb memory={m} />
                    <View style={styles.memoryRowContent}>
                      <Text style={styles.memoryDate}>{formatDisplayDate(m.memory_date)}</Text>
                      {m.content ? (
                        <Text style={styles.memoryText} numberOfLines={2}>{m.content}</Text>
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
                ))}
              </View>
            </View>
          )}
        </View>
      </ScrollView>
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
  scrollContent: {
    paddingBottom: 60,
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
  memoriesSection: {
    gap: 12,
  },
  memoriesEyebrow: {
    fontFamily: fonts.sansBold,
    fontSize: 10,
    letterSpacing: 0.14 * 10,
    textTransform: 'uppercase',
    color: colors.ink3,
  },
  memoriesList: {
    gap: 10,
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
