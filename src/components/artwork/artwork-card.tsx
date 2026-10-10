import { memo, useCallback, useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { ArtworkFrame } from '@/components/artwork-frame';
import { ArtworkDeck } from '@/components/artwork/artwork-deck';
import {
  artworkContentWidth,
  deckLayout,
  singleArtWidth,
} from '@/components/artwork/artwork-layout';
import { ArtworkPieceImage, useArtworkPieceUrls } from '@/components/artwork/artwork-piece-image';
import {
  artworkLabelContent,
  artworkPieces,
  type ArtworkLabelContent,
  type ArtworkPiece,
} from '@/components/artwork/artwork-pieces';
import {
  ArtworkRevealDriver,
  revealPivot,
  useShouldRevealArtwork,
  type ArtworkRevealStyles,
} from '@/components/artwork/artwork-reveal';
import { CardFooter } from '@/components/memory-card-footer';
import { MemoryEngagementBar } from '@/components/memory-engagement-bar';
import { colors, fonts } from '@/constants/theme';
import type { MemoryWithTags } from '@/services/memories';

// The Timeline card for an artwork memory (docs/plans/artwork-scanning-v2.md
// decisions 3 and 4, canvas Timeline.dc.html): no white card. A single piece
// hangs on the Timeline background in its frame; a batch is a swipeable deck.
// Below: a handwritten title, "Artist, age", the engagement row and the date
// footer with the medium chip.
//
// MemoryCard is memoized inside a virtualized list, so this stays pure: the
// width is `useWindowDimensions` minus the list padding (deterministic row
// heights), geometry is memoized, and nothing here updates on scroll.

interface ArtworkCardProps {
  memory: MemoryWithTags;
  /** `mediaIndex` is the asset the tapped piece is, so the detail screen opens
   * on it. The label / footer have no piece context and omit it. */
  onPress: (memoryId: string, mediaIndex?: number) => void;
  onOpenComments: (memoryId: string) => void;
}

function ArtworkLabel({
  content,
  memoryId,
  onPress,
  revealStyle,
  isBatch,
}: {
  content: ArtworkLabelContent;
  memoryId: string;
  onPress: () => void;
  revealStyle: ArtworkRevealStyles['label'] | null;
  isBatch: boolean;
}) {
  if (!content.title && !content.artist) return null;
  const body = (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.label,
        isBatch ? styles.labelBatch : styles.labelSingle,
        pressed && styles.pressed,
      ]}
      testID={`memory-card-content-${memoryId}`}
    >
      {content.title ? (
        <Text numberOfLines={2} style={styles.title} testID={`memory-card-${memoryId}-artwork-title`}>
          {content.title}
        </Text>
      ) : null}
      {content.artist ? (
        <Text numberOfLines={1} style={styles.artist} testID={`memory-card-${memoryId}-artwork-artist`}>
          {content.artist}
        </Text>
      ) : null}
    </Pressable>
  );
  return revealStyle ? <Animated.View style={revealStyle}>{body}</Animated.View> : body;
}

function SinglePiece({
  memoryId,
  piece,
  artWidth,
  url,
  onUrlError,
  onPress,
  revealStyle,
  accessibilityLabel,
}: {
  memoryId: string;
  accessibilityLabel: string;
  piece: ArtworkPiece;
  artWidth: number;
  url: string | undefined;
  onUrlError: () => void;
  onPress: () => void;
  revealStyle: ArtworkRevealStyles['frame'] | null;
}) {
  const frame = (
    <ArtworkFrame
      artWidth={artWidth}
      aspectRatio={piece.ratio}
      color={piece.color}
      kind={piece.kind}
      testID={`memory-card-${memoryId}-artwork-frame`}
      tilt={piece.tilt}
    >
      <ArtworkPieceImage
        objectKey={piece.displayKey}
        onError={onUrlError}
        testID={`memory-card-${memoryId}-artwork-image-0`}
        url={piece.displayKey ? url : undefined}
      />
    </ArtworkFrame>
  );
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      onPress={onPress}
      style={styles.singlePress}
      testID={`memory-card-${memoryId}-artwork`}
    >
      {revealStyle ? (
        <Animated.View style={[revealPivot, revealStyle]}>{frame}</Animated.View>
      ) : (
        frame
      )}
    </Pressable>
  );
}

function ArtworkCardBase({ memory, onPress, onOpenComments }: ArtworkCardProps) {
  const { width: windowWidth } = useWindowDimensions();
  const contentWidth = artworkContentWidth(windowWidth);
  const pieces = useMemo(
    () => artworkPieces(memory.id, memory.mediaAssets, memory.media_key),
    [memory.id, memory.mediaAssets, memory.media_key],
  );
  const labelContent = useMemo(() => artworkLabelContent(memory), [memory]);
  const isBatch = pieces.length > 1;
  const [frontIndex, setFrontIndex] = useState(0);
  const { urls, refetch } = useArtworkPieceUrls(pieces, memory.updated_at);
  const handleUrlError = useCallback(() => void refetch(), [refetch]);
  const shouldReveal = useShouldRevealArtwork(memory.id);

  const single = useMemo(() => {
    if (isBatch) return null;
    const piece = pieces[0];
    return { piece, artWidth: singleArtWidth(contentWidth, piece.ratio) };
  }, [contentWidth, isBatch, pieces]);
  const deck = useMemo(
    () => (isBatch ? deckLayout(contentWidth, pieces.map((piece) => piece.ratio)) : null),
    [contentWidth, isBatch, pieces],
  );

  const memoryId = memory.id;
  const handleOpenFront = useCallback(
    (assetIndex: number) => onPress(memoryId, assetIndex),
    [memoryId, onPress],
  );
  const handleOpenSingle = useCallback(() => onPress(memoryId, 0), [memoryId, onPress]);
  const handleOpenPlain = useCallback(() => onPress(memoryId), [memoryId, onPress]);
  const handleOpenComments = useCallback(() => onOpenComments(memoryId), [memoryId, onOpenComments]);

  const activeAssetId = memory.mediaAssets[frontIndex]?.id ?? memory.mediaAssets[0]?.id ?? null;

  const renderBody = (reveal: ArtworkRevealStyles | null): ReactNode => (
    <View
      style={[styles.root, isBatch ? styles.rootBatch : styles.rootSingle]}
      testID={`memory-card-${memoryId}`}
    >
      {deck ? (
        <ArtworkDeck
          layout={deck}
          memoryId={memoryId}
          onFrontChange={setFrontIndex}
          onOpen={handleOpenFront}
          onUrlError={handleUrlError}
          pieces={pieces}
          reveal={reveal}
          urls={urls}
        />
      ) : single ? (
        <SinglePiece
          accessibilityLabel={labelContent.title ? `Artwork, ${labelContent.title}` : 'Artwork'}
          artWidth={single.artWidth}
          memoryId={memoryId}
          onPress={handleOpenSingle}
          onUrlError={handleUrlError}
          piece={single.piece}
          revealStyle={reveal ? reveal.frame : null}
          url={single.piece.displayKey ? urls[single.piece.displayKey] : undefined}
        />
      ) : null}
      <ArtworkLabel
        content={labelContent}
        isBatch={isBatch}
        memoryId={memoryId}
        onPress={handleOpenPlain}
        revealStyle={reveal ? reveal.label : null}
      />
      <View style={styles.engagement}>
        <MemoryEngagementBar
          currentMediaAssetId={activeAssetId}
          enableShare
          iconSize={23}
          isCurrentPageVideo={false}
          memory={memory}
          onOpenComments={handleOpenComments}
        />
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={handleOpenPlain}
        style={({ pressed }) => pressed && styles.pressed}
        testID={`memory-card-footer-${memoryId}`}
      >
        <CardFooter memory={memory} style={styles.footer} />
      </Pressable>
    </View>
  );

  if (shouldReveal) {
    return (
      <ArtworkRevealDriver tilt={pieces[0]?.tilt ?? 0}>{renderBody}</ArtworkRevealDriver>
    );
  }
  return <>{renderBody(null)}</>;
}

export const ArtworkCard = memo(ArtworkCardBase);

const styles = StyleSheet.create({
  root: {
    alignItems: 'stretch',
  },
  // Canvas padding above the first frame (the nail-less frame hangs from the
  // top, so this is the gap under the previous card).
  rootSingle: {
    paddingTop: 18,
  },
  rootBatch: {
    paddingTop: 14,
  },
  singlePress: {
    alignSelf: 'center',
  },
  label: {
    alignItems: 'center',
  },
  labelSingle: {
    marginTop: 26,
  },
  labelBatch: {
    marginTop: 22,
  },
  title: {
    color: colors.ink,
    fontFamily: fonts.script,
    fontSize: 30,
    lineHeight: 34,
    textAlign: 'center',
  },
  artist: {
    color: colors.ink2,
    fontFamily: fonts.sans,
    fontSize: 13,
    marginTop: 6,
    textAlign: 'center',
  },
  engagement: {
    paddingBottom: 4,
    paddingHorizontal: 2,
    paddingTop: 16,
  },
  footer: {
    paddingBottom: 0,
    paddingHorizontal: 2,
    paddingTop: 10,
  },
  pressed: {
    opacity: 0.94,
  },
});
