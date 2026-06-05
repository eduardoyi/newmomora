import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import {
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';

import type { MediaAttachment } from '@/components/memory-media-picker';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useVideoThumbnail } from '@/hooks/useVideoThumbnail';
import { formatVideoDurationLabel } from '@/utils/memories';
import { isVideoContentType } from '@/utils/media-validation';

const GRID_COLUMNS = 3;
const GRID_GAP = spacing.sm;
const DEFAULT_TILE_SIZE = 96;
const MAX_GRID_HEIGHT = 336;

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

function getTargetIndex(
  index: number,
  dx: number,
  dy: number,
  tileSize: number,
  length: number,
): number {
  const step = tileSize + GRID_GAP;
  const columnOffset = Math.round(dx / step);
  const rowOffset = Math.round(dy / step);

  return clampIndex(index + rowOffset * GRID_COLUMNS + columnOffset, length);
}

interface MemoryMediaTileProps {
  attachment: MediaAttachment;
  attachmentsLength: number;
  index: number;
  isSelected: boolean;
  onMove: (fromIndex: number, toIndex: number) => void;
  onRemove: (attachmentId: string) => void;
  onSelect: (attachmentId: string | null) => void;
  tileSize: number;
}

function MemoryMediaTile({
  attachment,
  attachmentsLength,
  index,
  isSelected,
  onMove,
  onRemove,
  onSelect,
  tileSize,
}: MemoryMediaTileProps) {
  const isVideo = isVideoContentType(attachment.contentType);
  const thumbnailUri = useVideoThumbnail(isVideo ? attachment.uri : null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  const panResponder = useMemo(
    () => PanResponder.create({
      onStartShouldSetPanResponder: () => isSelected,
      onMoveShouldSetPanResponder: (_event, gestureState) =>
        isSelected && Math.max(Math.abs(gestureState.dx), Math.abs(gestureState.dy)) > 8,
      onPanResponderGrant: () => {
        setDragOffset({ x: 0, y: 0 });
      },
      onPanResponderMove: (_event, gestureState) => {
        setDragOffset({ x: gestureState.dx, y: gestureState.dy });
      },
      onPanResponderRelease: (_event, gestureState) => {
        setDragOffset({ x: 0, y: 0 });

        const targetIndex = getTargetIndex(
          index,
          gestureState.dx,
          gestureState.dy,
          tileSize,
          attachmentsLength,
        );

        if (targetIndex !== index) {
          onMove(index, targetIndex);
          onSelect(null);
        }
      },
      onPanResponderTerminate: () => {
        setDragOffset({ x: 0, y: 0 });
      },
    }),
    [attachmentsLength, index, isSelected, onMove, onSelect, tileSize],
  );

  return (
    <Pressable
      accessibilityHint="Long press, then drag to reorder"
      accessibilityRole="button"
      accessibilityLabel="Attached media"
      onLongPress={() => onSelect(isSelected ? null : attachment.id)}
      onPress={() => {
        if (isSelected) {
          onSelect(null);
        }
      }}
      style={[
        styles.tile,
        { height: tileSize, width: tileSize },
        isSelected && styles.tileSelected,
        isSelected && styles.tileRaised,
        isSelected && {
          transform: [
            { translateX: dragOffset.x },
            { translateY: dragOffset.y },
          ],
        },
      ]}
      testID={`memory-media-tile-${index}`}
      {...panResponder.panHandlers}
    >
      {isVideo ? (
        <View style={styles.videoWrap}>
          {thumbnailUri ? (
            <Image contentFit="cover" source={{ uri: thumbnailUri }} style={styles.image} />
          ) : (
            <View style={styles.videoPlaceholder}>
              <SymbolView
                name={{ ios: 'video', android: 'videocam' }}
                size={26}
                tintColor={colors.white}
                fallback={<Text style={styles.videoIcon}>▻</Text>}
              />
            </View>
          )}
          <View style={styles.playBadge}>
            <SymbolView
              name={{ ios: 'play.fill', android: 'play_arrow' }}
              size={20}
              tintColor={colors.ink}
              fallback={<Text style={styles.playIcon}>▶</Text>}
            />
          </View>
          {attachment.durationMs != null ? (
            <View style={styles.durationBadge}>
              <SymbolView
                name={{ ios: 'play.fill', android: 'play_arrow' }}
                size={8}
                tintColor={colors.white}
                fallback={<Text style={styles.durationIcon}>▶</Text>}
              />
              <Text style={styles.durationLabel}>
                {formatVideoDurationLabel(attachment.durationMs)}
              </Text>
            </View>
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
  const [gridWidth, setGridWidth] = useState(0);
  const tileSize = gridWidth > 0
    ? Math.floor((gridWidth - GRID_GAP * (GRID_COLUMNS - 1)) / GRID_COLUMNS)
    : DEFAULT_TILE_SIZE;

  return (
    <View style={styles.container} testID="new-memory-media-preview">
      <View style={styles.header}>
        <Text style={styles.headerLabel}>Photos & videos</Text>
        <Text style={styles.headerCount}>{attachments.length}/10</Text>
      </View>
      <View
        onLayout={(event: LayoutChangeEvent) => {
          const width = event.nativeEvent.layout.width;
          if (width > 0) {
            setGridWidth(width);
          }
        }}
        style={styles.gridMeasure}
      >
        <ScrollView
          contentContainerStyle={styles.tileGrid}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
          showsVerticalScrollIndicator={false}
          style={styles.tileScroll}
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
                tileSize={tileSize}
              />
            );
          })}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.sm,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  headerLabel: {
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1.8,
    textTransform: 'uppercase',
  },
  headerCount: {
    color: colors.ink2,
    fontFamily: fonts.sansBold,
    fontSize: 14,
  },
  gridMeasure: {
    width: '100%',
  },
  tileScroll: {
    maxHeight: MAX_GRID_HEIGHT,
  },
  tileGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GRID_GAP,
  },
  tile: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    overflow: 'hidden',
    position: 'relative',
  },
  tileSelected: {
    borderColor: colors.primary,
    borderWidth: 2,
  },
  tileRaised: {
    opacity: 0.94,
    zIndex: 2,
  },
  image: {
    height: '100%',
    width: '100%',
  },
  videoWrap: {
    height: '100%',
    width: '100%',
  },
  videoPlaceholder: {
    alignItems: 'center',
    backgroundColor: colors.ink3,
    height: '100%',
    justifyContent: 'center',
    width: '100%',
  },
  videoIcon: {
    color: colors.white,
    fontSize: 22,
    fontWeight: '700',
  },
  playBadge: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.9)',
    borderRadius: 26,
    height: 52,
    justifyContent: 'center',
    left: '50%',
    marginLeft: -26,
    marginTop: -26,
    position: 'absolute',
    top: '50%',
    width: 52,
  },
  playIcon: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '700',
  },
  durationBadge: {
    alignItems: 'center',
    backgroundColor: 'rgba(44,36,24,0.62)',
    borderRadius: 10,
    bottom: 7,
    flexDirection: 'row',
    gap: 3,
    left: 7,
    paddingHorizontal: 6,
    paddingVertical: 3,
    position: 'absolute',
  },
  durationIcon: {
    color: colors.white,
    fontSize: 8,
  },
  durationLabel: {
    color: colors.white,
    fontFamily: fonts.sansBold,
    fontSize: 11,
  },
  positionBadge: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 9,
    bottom: 7,
    height: 18,
    justifyContent: 'center',
    position: 'absolute',
    right: 7,
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
});
