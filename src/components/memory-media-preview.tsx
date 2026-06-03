import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { useMemo } from 'react';
import { PanResponder, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import type { MediaAttachment } from '@/components/memory-media-picker';
import { formatVideoDurationLabel } from '@/utils/memories';
import { isVideoContentType } from '@/utils/media-validation';

interface MemoryMediaPreviewProps {
  attachments: MediaAttachment[];
  onMove: (fromIndex: number, toIndex: number) => void;
  onRemove: (attachmentId: string) => void;
  selectedId: string | null;
  onSelect: (attachmentId: string | null) => void;
}

function clampIndex(index: number, length: number): number {
  return Math.min(Math.max(index, 0), length - 1);
}

interface MemoryMediaTileProps {
  attachment: MediaAttachment;
  attachmentsLength: number;
  index: number;
  isSelected: boolean;
  onMove: (fromIndex: number, toIndex: number) => void;
  onRemove: (attachmentId: string) => void;
  onSelect: (attachmentId: string | null) => void;
}

function MemoryMediaTile({
  attachment,
  attachmentsLength,
  index,
  isSelected,
  onMove,
  onRemove,
  onSelect,
}: MemoryMediaTileProps) {
  const isVideo = isVideoContentType(attachment.contentType);
  const panResponder = useMemo(
    () => PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gestureState) =>
        isSelected && Math.abs(gestureState.dx) > 12 && Math.abs(gestureState.dx) > Math.abs(gestureState.dy),
      onPanResponderRelease: (_event, gestureState) => {
        const tileStep = 92;
        const offset = Math.round(gestureState.dx / tileStep);
        if (offset === 0) {
          return;
        }

        onMove(index, clampIndex(index + offset, attachmentsLength));
      },
    }),
    [attachmentsLength, index, isSelected, onMove],
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Attached media"
      key={attachment.id}
      onLongPress={() => onSelect(isSelected ? null : attachment.id)}
      onPress={() => {
        if (isSelected) {
          onSelect(null);
        }
      }}
      style={[
        styles.tile,
        isSelected && styles.tileSelected,
      ]}
      testID={`memory-media-tile-${index}`}
      {...panResponder.panHandlers}
    >
      {isVideo ? (
        <View style={styles.videoPlaceholder}>
          <SymbolView
            name={{ ios: 'play.fill', android: 'play_arrow' }}
            size={22}
            tintColor={colors.primary}
            fallback={<Text style={styles.videoIcon}>▶</Text>}
          />
          {attachment.durationMs != null ? (
            <Text style={styles.durationLabel}>
              {formatVideoDurationLabel(attachment.durationMs)}
            </Text>
          ) : null}
        </View>
      ) : (
        <Image contentFit="cover" source={{ uri: attachment.uri }} style={styles.image} />
      )}

      <View style={styles.positionBadge}>
        <Text style={styles.positionText}>{index + 1}</Text>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Remove attached media"
        onPress={() => onRemove(attachment.id)}
        style={styles.removeButton}
        testID={`memory-media-remove-${index}`}
      >
        <Text style={styles.removeButtonText}>×</Text>
      </Pressable>

      {isSelected ? (
        <View style={styles.reorderControls}>
          <Pressable
            accessibilityRole="button"
            disabled={index === 0}
            onPress={() => onMove(index, clampIndex(index - 1, attachmentsLength))}
            style={[styles.reorderButton, index === 0 && styles.reorderButtonDisabled]}
            testID={`memory-media-move-left-${index}`}
          >
            <SymbolView
              name={{ ios: 'chevron.left', android: 'chevron_left' }}
              size={16}
              tintColor={colors.white}
              fallback={<Text style={styles.reorderText}>‹</Text>}
            />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={index === attachmentsLength - 1}
            onPress={() => onMove(index, clampIndex(index + 1, attachmentsLength))}
            style={[
              styles.reorderButton,
              index === attachmentsLength - 1 && styles.reorderButtonDisabled,
            ]}
            testID={`memory-media-move-right-${index}`}
          >
            <SymbolView
              name={{ ios: 'chevron.right', android: 'chevron_right' }}
              size={16}
              tintColor={colors.white}
              fallback={<Text style={styles.reorderText}>›</Text>}
            />
          </Pressable>
        </View>
      ) : null}
    </Pressable>
  );
}

export function MemoryMediaPreview({
  attachments,
  onMove,
  onRemove,
  selectedId,
  onSelect,
}: MemoryMediaPreviewProps) {
  return (
    <View style={styles.container} testID="new-memory-media-preview">
      <ScrollView
        contentContainerStyle={styles.tileRow}
        horizontal
        keyboardShouldPersistTaps="handled"
        showsHorizontalScrollIndicator={false}
      >
        {attachments.map((attachment, index) => {
          const isSelected = selectedId === attachment.id;

          return (
            <MemoryMediaTile
              attachment={attachment}
              attachmentsLength={attachments.length}
              index={index}
              isSelected={isSelected}
              key={attachment.id}
              onMove={onMove}
              onRemove={onRemove}
              onSelect={onSelect}
            />
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.xs,
  },
  tileRow: {
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  tile: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    height: 104,
    overflow: 'hidden',
    position: 'relative',
    width: 84,
  },
  tileSelected: {
    borderColor: colors.primary,
    borderWidth: 2,
  },
  image: {
    height: '100%',
    width: '100%',
  },
  videoPlaceholder: {
    alignItems: 'center',
    height: '100%',
    justifyContent: 'center',
    width: '100%',
  },
  videoIcon: {
    color: colors.primary,
    fontSize: 22,
    fontWeight: '700',
  },
  durationLabel: {
    color: colors.textMuted,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    marginTop: 5,
  },
  positionBadge: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 9,
    height: 18,
    justifyContent: 'center',
    left: 6,
    position: 'absolute',
    top: 6,
    width: 18,
  },
  positionText: {
    color: colors.white,
    fontFamily: fonts.sansBold,
    fontSize: 10,
  },
  removeButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.65)',
    borderRadius: 12,
    height: 24,
    justifyContent: 'center',
    position: 'absolute',
    right: 6,
    top: 6,
    width: 24,
  },
  removeButtonText: {
    color: colors.white,
    fontSize: 17,
    fontWeight: '700',
    lineHeight: 18,
  },
  reorderControls: {
    alignItems: 'center',
    bottom: 7,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
  },
  reorderButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: 14,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  reorderButtonDisabled: {
    opacity: 0.35,
  },
  reorderText: {
    color: colors.white,
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 18,
  },
});
