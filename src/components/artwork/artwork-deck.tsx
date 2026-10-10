import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { ArtworkFrame } from '@/components/artwork-frame';
import {
  deckCounterLabel,
  deckReducer,
  deckSwipeCommit,
  initialDeckOrder,
  reconcileDeckOrder,
  visibleDeckIndices,
} from '@/components/artwork/artwork-deck-order';
import {
  DECK_SIDE_BLEED,
  deckSlotPose,
  type DeckLayout,
} from '@/components/artwork/artwork-layout';
import { ArtworkPieceImage } from '@/components/artwork/artwork-piece-image';
import type { ArtworkPiece } from '@/components/artwork/artwork-pieces';
import { revealPivot, type ArtworkRevealStyles } from '@/components/artwork/artwork-reveal';
import { colors, fonts } from '@/constants/theme';
import { useReduceMotion } from '@/hooks/use-reduce-motion';

// The Timeline batch deck (docs/plans/artwork-scanning-v2.md decision 4, canvas
// ClusterDeck.dc.html): up to 3 frames stacked at different angles, a paper tag
// "n of N", and a horizontal swipe that flings the front piece off so it tucks
// in at the back of the pile like a pack of cards.
//
// Animation model (everything per-frame stays on the UI thread; React state
// only changes when a swipe commits):
//   * `order` (React, reducer) -- asset indices, front first.
//   * each card has a `slot` shared value that eases to its depth (0 front,
//     1 back-right, 2 back-left) and renders the matching pose.
//   * `dx` is the front card's drag / exit offset. When the exit finishes, ONE
//     UI-thread step hands the offset to the tuck (`tuckIndex` / `tuck`),
//     moves `frontIndex` on, resets `dx`, and asks React to cycle `order`.
//     The leaving card is therefore never visible at the front slot between
//     the exit ending and React committing the new order.

const EXIT_MS = 260;
const RETURN_MS = 200;
const TUCK_MS = 320;
const SLOT_MS = 320;
const EXIT_DISTANCE_FACTOR = 1.2;
const EXIT_TILT_DEG = 16;

export interface ArtworkDeckProps {
  memoryId: string;
  pieces: readonly ArtworkPiece[];
  layout: DeckLayout;
  urls: Record<string, string>;
  onUrlError: () => void;
  /** Tap: open the detail screen on this asset index (the front piece). */
  onOpen: (assetIndex: number) => void;
  /** The front piece changed (initial value included). */
  onFrontChange?: (assetIndex: number) => void;
  /** Set only for a card that is playing the reveal. */
  reveal?: ArtworkRevealStyles | null;
}

interface DeckSharedValues {
  dx: SharedValue<number>;
  tuck: SharedValue<number>;
  tuckIndex: SharedValue<number>;
  frontIndex: SharedValue<number>;
}

interface DeckCardProps {
  index: number;
  depth: number;
  piece: ArtworkPiece;
  pieceWidth: number;
  pieceHeight: number;
  artWidth: number;
  centerX: number;
  centerY: number;
  scale: number;
  maxShiftX: number;
  exitDistance: number;
  zIndex: number;
  memoryId: string;
  url: string | undefined;
  onUrlError: () => void;
  reduceMotion: boolean;
  shared: DeckSharedValues;
  revealStyle: ArtworkRevealStyles['frame'] | ArtworkRevealStyles['fade'] | null;
  isRevealFront: boolean;
}

const DeckCard = memo(function DeckCard({
  index,
  depth,
  piece,
  pieceWidth,
  pieceHeight,
  artWidth,
  centerX,
  centerY,
  scale,
  maxShiftX,
  exitDistance,
  zIndex,
  memoryId,
  url,
  onUrlError,
  reduceMotion,
  shared,
  revealStyle,
  isRevealFront,
}: DeckCardProps) {
  const { dx, tuck, tuckIndex, frontIndex } = shared;
  const tilt = piece.tilt;
  const slot = useSharedValue(depth);
  const previousDepthRef = useRef(depth);

  useEffect(() => {
    const previousDepth = previousDepthRef.current;
    previousDepthRef.current = depth;
    if (previousDepth === depth) return;
    // The card that just left the front is off-screen and is already sliding
    // in via `tuck`: put it straight on its back slot instead of animating
    // the slot too (that would loop it through the upper-right slot).
    if (reduceMotion || previousDepth === 0) {
      slot.set(depth);
      return;
    }
    slot.set(withTiming(depth, { duration: SLOT_MS, easing: Easing.out(Easing.cubic) }));
  }, [depth, reduceMotion, slot]);

  const animatedStyle = useAnimatedStyle(() => {
    const pose = deckSlotPose(slot.get(), tilt, scale);
    let offset = 0;
    if (index === frontIndex.get()) {
      offset = dx.get();
    } else if (index === tuckIndex.get()) {
      offset = tuck.get();
    }
    const progress = Math.min(1, Math.abs(offset) / exitDistance);
    const exitTilt = offset < 0 ? -EXIT_TILT_DEG : EXIT_TILT_DEG;
    const rotate = pose.rotate + (exitTilt - pose.rotate) * progress;
    // Keep a wide piece's slot on screen (it may poke into the list padding).
    const x = Math.min(maxShiftX, Math.max(-maxShiftX, pose.x));
    return {
      transform: [{ translateX: x + offset }, { translateY: pose.y }, { rotate: `${rotate}deg` }],
    };
  });

  const frame = (
    <ArtworkFrame
      artWidth={artWidth}
      aspectRatio={piece.ratio}
      color={piece.color}
      kind={piece.kind}
      testID={depth === 0 ? `memory-card-${memoryId}-artwork-frame` : undefined}
    >
      <ArtworkPieceImage
        objectKey={piece.displayKey}
        onError={onUrlError}
        testID={`memory-card-${memoryId}-artwork-image-${index}`}
        url={piece.displayKey ? url : undefined}
      />
    </ArtworkFrame>
  );

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.card,
        {
          height: pieceHeight,
          left: centerX - pieceWidth / 2,
          top: centerY - pieceHeight / 2,
          width: pieceWidth,
          zIndex,
        },
        animatedStyle,
      ]}
      testID={`memory-card-${memoryId}-artwork-deck-card-${index}`}
    >
      {revealStyle ? (
        <Animated.View
          style={[isRevealFront ? revealPivot : null, { height: pieceHeight, width: pieceWidth }, revealStyle]}
        >
          {frame}
        </Animated.View>
      ) : (
        frame
      )}
    </Animated.View>
  );
});

export function ArtworkDeck({
  memoryId,
  pieces,
  layout,
  urls,
  onUrlError,
  onOpen,
  onFrontChange,
  reveal = null,
}: ArtworkDeckProps) {
  const count = pieces.length;
  const reduceMotion = useReduceMotion();
  const [state, dispatch] = useReducer(deckReducer, count, (n) => ({ order: initialDeckOrder(n) }));
  const order = useMemo(() => reconcileDeckOrder(state.order, count), [state.order, count]);
  const front = order[0] ?? 0;
  const nextFront = order.length > 1 ? order[1] : front;
  const visible = visibleDeckIndices(order);
  // Only the piece that is in front when this deck mounts takes the reveal's
  // swing; the pieces behind it fade in with it.
  const [revealFrontIndex] = useState(front);

  const dx = useSharedValue(0);
  const tuck = useSharedValue(0);
  const tuckIndex = useSharedValue(-1);
  const frontIndex = useSharedValue(front);
  const busy = useSharedValue(0);
  const shared = useMemo<DeckSharedValues>(
    () => ({ dx, tuck, tuckIndex, frontIndex }),
    [dx, tuck, tuckIndex, frontIndex],
  );

  const advance = useCallback(() => dispatch({ type: 'advance', count }), [count]);

  // Mirrors the order into the UI-thread front index (the gesture already set
  // it for a swipe; this covers the accessibility action) and tells the card.
  useEffect(() => {
    frontIndex.set(front);
    onFrontChange?.(front);
  }, [front, frontIndex, onFrontChange]);

  const width = layout.width;
  const exitDistance = width * EXIT_DISTANCE_FACTOR;
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .withTestId('artwork-deck-pan')
        .enabled(count > 1)
        .maxPointers(1)
        // Horizontal intent wins over a tap; vertical intent hands the touch
        // to the Timeline list so scrolling is never fought.
        .activeOffsetX([-12, 12])
        .failOffsetY([-10, 10])
        .onUpdate((event) => {
          if (busy.get() === 1 || reduceMotion) return;
          dx.set(event.translationX);
        })
        .onEnd((event) => {
          if (busy.get() === 1) return;
          const direction = deckSwipeCommit(event.translationX, event.velocityX, width);
          if (direction === null) {
            dx.set(withTiming(0, { duration: RETURN_MS }));
            return;
          }
          busy.set(1);
          if (reduceMotion) {
            dx.set(0);
            frontIndex.set(nextFront);
            busy.set(0);
            runOnJS(advance)();
            return;
          }
          dx.set(
            withTiming(
              direction * exitDistance,
              { duration: EXIT_MS, easing: Easing.out(Easing.cubic) },
              (finished) => {
                if (!finished) {
                  busy.set(0);
                  return;
                }
                tuckIndex.set(front);
                tuck.set(dx.get());
                frontIndex.set(nextFront);
                dx.set(0);
                tuck.set(withTiming(0, { duration: TUCK_MS, easing: Easing.out(Easing.cubic) }));
                busy.set(0);
                runOnJS(advance)();
              },
            ),
          );
        }),
    [advance, busy, count, dx, exitDistance, front, frontIndex, nextFront, reduceMotion, tuck, tuckIndex, width],
  );

  const handlePress = useCallback(() => onOpen(front), [front, onOpen]);
  const handleAccessibilityAction = useCallback(
    (event: { nativeEvent: { actionName: string } }) => {
      if (event.nativeEvent.actionName === 'increment') advance();
    },
    [advance],
  );

  const counterLabel = deckCounterLabel(order);
  const containerStyle = useMemo(
    () => ({ alignSelf: 'center' as const, height: layout.height, width }),
    [layout.height, width],
  );
  const tagStyle = useMemo(
    () => ({ left: layout.tagLeft, top: layout.tagTop }),
    [layout.tagLeft, layout.tagTop],
  );

  return (
    <GestureDetector gesture={pan}>
      <View collapsable={false} style={containerStyle}>
        <Pressable
          accessibilityActions={count > 1 ? [{ name: 'increment', label: 'Next piece' }] : undefined}
          accessibilityHint={
            count > 1 ? 'Double tap to open. Swipe sideways to see the next piece.' : undefined
          }
          accessibilityLabel={`Artwork, piece ${front + 1} of ${count}`}
          accessibilityRole="button"
          onAccessibilityAction={handleAccessibilityAction}
          onPress={handlePress}
          style={styles.stage}
          testID={`memory-card-${memoryId}-artwork-deck`}
        >
          {visible.map((assetIndex, depth) => {
            const piece = pieces[assetIndex];
            const pieceLayout = layout.pieces[assetIndex];
            if (!piece || !pieceLayout) return null;
            const isRevealFront = assetIndex === revealFrontIndex;
            return (
              <DeckCard
                artWidth={pieceLayout.artWidth}
                centerX={layout.centerX}
                centerY={layout.centerY}
                depth={depth}
                exitDistance={exitDistance}
                index={assetIndex}
                isRevealFront={isRevealFront}
                key={assetIndex}
                maxShiftX={Math.max(0, width / 2 + DECK_SIDE_BLEED - pieceLayout.width / 2)}
                memoryId={memoryId}
                onUrlError={onUrlError}
                piece={piece}
                pieceHeight={pieceLayout.height}
                pieceWidth={pieceLayout.width}
                reduceMotion={reduceMotion}
                revealStyle={reveal ? (isRevealFront ? reveal.frame : reveal.fade) : null}
                scale={layout.scale}
                shared={shared}
                url={piece.displayKey ? urls[piece.displayKey] : undefined}
                zIndex={visible.length - depth}
              />
            );
          })}
          <View
            pointerEvents="none"
            style={[styles.tag, tagStyle]}
            testID={`memory-card-${memoryId}-artwork-deck-tag`}
          >
            <Text style={styles.tagText}>{counterLabel}</Text>
          </View>
        </Pressable>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  stage: {
    flex: 1,
  },
  card: {
    position: 'absolute',
  },
  tag: {
    backgroundColor: colors.white,
    borderRadius: 6,
    elevation: 4,
    paddingBottom: 6,
    paddingHorizontal: 12,
    paddingTop: 4,
    position: 'absolute',
    shadowColor: '#462D14',
    shadowOffset: { height: 4, width: 2 },
    shadowOpacity: 0.22,
    shadowRadius: 4,
    transform: [{ rotate: '5deg' }],
    zIndex: 20,
  },
  tagText: {
    color: colors.ink,
    fontFamily: fonts.script,
    fontSize: 22,
    lineHeight: 26,
  },
});
