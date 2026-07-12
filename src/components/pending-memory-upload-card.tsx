import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import type { PendingMemoryUpload } from '@/hooks/use-pending-memory-uploads';
import { isVideoContentType } from '@/utils/media-validation';

interface PendingMemoryUploadCardProps {
  upload: PendingMemoryUpload;
  onRetry: () => void;
  onDiscard: () => void;
}

function statusLine(upload: PendingMemoryUpload): string {
  if (upload.status === 'failed') {
    return upload.errorMessage ?? 'Could not save memory';
  }
  if (upload.uploadedAssets >= upload.totalAssets) {
    return 'Finishing up…';
  }
  return `Uploading ${Math.min(upload.uploadedAssets + 1, upload.totalAssets)} of ${upload.totalAssets}`;
}

export function PendingMemoryUploadCard({ upload, onRetry, onDiscard }: PendingMemoryUploadCardProps) {
  const isFailed = upload.status === 'failed';
  const isVideoPreview = isVideoContentType(upload.previewContentType ?? '');
  // Never let the bar sit at 0 -- a sliver of progress reads as "working".
  const progress = Math.max(
    0.06,
    upload.totalAssets > 0 ? upload.uploadedAssets / upload.totalAssets : 0,
  );

  return (
    <View style={styles.card} testID={`pending-memory-card-${upload.memoryId}`}>
      <View style={styles.thumbWrap}>
        {upload.previewUri && !isVideoPreview ? (
          <Image contentFit="cover" source={{ uri: upload.previewUri }} style={styles.thumb} />
        ) : (
          <View style={[styles.thumb, styles.thumbPlaceholder]}>
            <SymbolView
              name={{ ios: isVideoPreview ? 'play.fill' : 'photo', android: isVideoPreview ? 'play_arrow' : 'image' }}
              size={18}
              tintColor={colors.ink3}
              fallback={<Text style={styles.thumbFallback}>{isVideoPreview ? '▶' : '🖼'}</Text>}
            />
          </View>
        )}
      </View>

      <View style={styles.body}>
        <Text style={[styles.title, isFailed && styles.titleFailed]}>
          {isFailed ? "Couldn't post memory" : 'Posting memory…'}
        </Text>
        <Text numberOfLines={1} style={styles.subtitle}>{statusLine(upload)}</Text>
        {isFailed ? (
          <View style={styles.actions}>
            <Pressable
              onPress={onRetry}
              style={styles.actionBtn}
              testID={`pending-memory-retry-${upload.memoryId}`}
            >
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
            <Pressable
              onPress={onDiscard}
              style={styles.actionBtn}
              testID={`pending-memory-discard-${upload.memoryId}`}
            >
              <Text style={styles.discardText}>Discard</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.min(progress, 1) * 100}%` }]} />
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.sm,
  },
  thumbWrap: {
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  thumb: {
    width: 52,
    height: 52,
    backgroundColor: colors.surface,
  },
  thumbPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbFallback: {
    fontSize: 16,
    color: colors.ink3,
  },
  body: {
    flex: 1,
    gap: 4,
  },
  title: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    color: colors.ink,
  },
  titleFailed: {
    color: colors.error,
  },
  subtitle: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.ink3,
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.surface,
    overflow: 'hidden',
    marginTop: 2,
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
    backgroundColor: colors.primary,
  },
  actions: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 2,
  },
  actionBtn: {
    paddingVertical: 2,
  },
  retryText: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    color: colors.primary,
  },
  discardText: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    color: colors.ink3,
  },
});
