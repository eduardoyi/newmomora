// Book-cover visual surface for the Memory Books shelf redesign
// (owner-approved picker-redesign brief, 2026-09-17). Renders the square,
// asymmetric-corner "physical book" tile in its three states (ready /
// generating / failed) plus the thin page-edge strips that make it read as
// a book rather than a plain photo card. Reused by both the shelf grid
// (`app/(app)/family/[id]/memory-books.tsx`) and the empty state's
// personalized example cover -- the example cover is just a `ready` tile
// whose photo/name/scope-line happen not to correspond to a real
// `memory_books` row.
//
// This component owns only the square visual -- the below-tile label/range
// line, the surrounding Pressable, and the `memory-book-tile-${scopeKey}`
// testID all live in the caller (a real DB row is needed to know the scope
// key and the tap target, neither of which this component has).
//
// Structure note (device-testing fix, 2026-09-17): the rounded/clipped
// "cover" layer and the page-edge strips are SIBLINGS inside a plain,
// non-clipping outer box -- never strips-as-children-of-the-clipped-cover.
// The cover is inset a few px from the outer box's right edge, and the
// strips live in that reserved gap. On Android, a `View` with
// `overflow:'hidden'` + an asymmetric `borderRadius` clips its children via
// a rounded clip path; a child (the old page-edge strips) positioned to
// straddle or sit just past that same view's own right edge produced a
// square-cornered notch artifact at the top-right/bottom-right corners --
// the clip mask and the child's square bounds didn't reconcile cleanly
// there (iOS's CALayer-based clipping handled the identical layout fine,
// which is why this only showed up on a real Android device). Keeping the
// strips spatially outside the cover's own clipped rect removes the
// rounded-corner/child-bounds interaction entirely, on both platforms.
import { useEffect } from 'react';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { SymbolView } from 'expo-symbols';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

import { coverWashForId } from '@/components/memory-books/cover-washes';
import { colors, fonts, radius } from '@/constants/theme';
import { useMediaUrl } from '@/hooks/useMediaUrls';
import { mediaImageSource } from '@/utils/media-image-source';

export type BookCoverTileStatus = 'ready' | 'generating' | 'failed';

export interface BookCoverTileProps {
  status: BookCoverTileStatus;
  /** Stable identity used only for the deterministic wash-fallback hash --
   * a real book's id, or a synthetic key for the empty-state example cover.
   * Never persisted, never required to be a real DB id. */
  washId: string;
  /** R2 object key for the cover photo. Null (or an unresolved signed URL)
   * renders the wash fallback instead. Ready state only. */
  coverAssetKey?: string | null;
  /** Cache-busting version for `useMediaUrl` -- pass the book's `updated_at`. */
  cacheVersion?: string | null;
  childFirstName: string;
  scopeLabel: string;
  /** "2022 – 2023" / "2023" -- omitted (no " · " separator) when null (the
   * `everything` scope, or unknown). Rendered in the ready/failed states. */
  yearRangeLabel?: string | null;
  testID?: string;
}

/** The two page-edge strips, positioned in the gap reserved to the right of
 * the `cover` layer (see the file header comment) -- never children of a
 * clipped view, so there is nothing for a rounded-corner clip mask to
 * fight with. */
function PageEdges() {
  return (
    <>
      <LinearGradient
        colors={['#F4F3F8', '#E6E1F0']}
        end={{ x: 1, y: 0 }}
        pointerEvents="none"
        start={{ x: 0, y: 0 }}
        style={[styles.pageEdge, styles.pageEdgeBack]}
      />
      <LinearGradient
        colors={['#FFFFFF', '#F2EFF8']}
        end={{ x: 1, y: 0 }}
        pointerEvents="none"
        start={{ x: 0, y: 0 }}
        style={[styles.pageEdge, styles.pageEdgeFront]}
      />
    </>
  );
}

function PulseBar({ style }: { style: object }) {
  const opacity = useSharedValue(0.4);
  useEffect(() => {
    opacity.value = withRepeat(withTiming(0.85, { duration: 800 }), -1, true);
  }, [opacity]);
  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={[styles.skeletonBar, style, animatedStyle]} />;
}

function ScopeLine({ scopeLabel, yearRangeLabel, style }: { scopeLabel: string; yearRangeLabel?: string | null; style: object }) {
  const text = yearRangeLabel ? `${scopeLabel} · ${yearRangeLabel}` : scopeLabel;
  return <Text style={style}>{text.toUpperCase()}</Text>;
}

export function BookCoverTile({
  status,
  washId,
  coverAssetKey,
  cacheVersion,
  childFirstName,
  scopeLabel,
  yearRangeLabel,
  testID,
}: BookCoverTileProps) {
  const { url: coverUrl } = useMediaUrl(status === 'ready' ? coverAssetKey : null, cacheVersion);
  const wash = coverWashForId(washId);

  if (status === 'generating') {
    return (
      <View style={styles.tileOuter} testID={testID}>
        <PageEdges />
        <View style={[styles.cover, styles.generatingTile]}>
          <View style={styles.generatingText}>
            <Text style={styles.generatingTitle}>We’re making it</Text>
            <Text style={styles.generatingSubtitle}>Ready in about 3 minutes</Text>
          </View>
          <View style={styles.skeletonBars}>
            <PulseBar style={styles.skeletonBarWide} />
            <PulseBar style={styles.skeletonBarNarrow} />
          </View>
        </View>
      </View>
    );
  }

  if (status === 'failed') {
    return (
      <View style={styles.tileOuter} testID={testID}>
        <PageEdges />
        <View style={[styles.cover, styles.failedTile]}>
          <View style={styles.failedBadge}>
            <SymbolView
              fallback={<Text style={styles.failedBadgeGlyph}>!</Text>}
              name={{ ios: 'exclamationmark.triangle', android: 'warning' }}
              size={11}
              tintColor={colors.sunInk}
            />
            <Text style={styles.failedBadgeText}>Didn’t finish</Text>
          </View>
          <View style={styles.tileTextBlock}>
            <Text numberOfLines={1} style={styles.failedName}>{childFirstName}</Text>
            <ScopeLine scopeLabel={scopeLabel} style={styles.failedScopeLine} yearRangeLabel={yearRangeLabel} />
          </View>
        </View>
      </View>
    );
  }

  // ready
  if (coverUrl && coverAssetKey) {
    return (
      <View style={styles.tileOuter} testID={testID}>
        <PageEdges />
        <View style={styles.cover}>
          <Image
            cachePolicy="disk"
            contentFit="cover"
            source={mediaImageSource(coverUrl, coverAssetKey)}
            style={StyleSheet.absoluteFill}
          />
          <LinearGradient
            colors={['rgba(20,14,8,0.3)', 'rgba(20,14,8,0)']}
            end={{ x: 0, y: 0.32 }}
            pointerEvents="none"
            start={{ x: 0, y: 0 }}
            style={StyleSheet.absoluteFill}
          />
          <LinearGradient
            colors={['rgba(20,14,8,0)', 'rgba(20,14,8,0.62)']}
            end={{ x: 0, y: 1 }}
            pointerEvents="none"
            start={{ x: 0, y: 0.45 }}
            style={StyleSheet.absoluteFill}
          />
          <LinearGradient
            colors={['rgba(20,14,8,0.35)', 'rgba(20,14,8,0)']}
            end={{ x: 1, y: 0 }}
            pointerEvents="none"
            start={{ x: 0, y: 0 }}
            style={styles.spineShade}
          />
          <View style={styles.tileTextBlock}>
            <Text numberOfLines={1} style={styles.readyName}>{childFirstName}</Text>
            <ScopeLine scopeLabel={scopeLabel} style={styles.readyScopeLine} yearRangeLabel={yearRangeLabel} />
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.tileOuter} testID={testID}>
      <PageEdges />
      <View style={styles.cover}>
        <LinearGradient
          colors={wash.colors}
          end={{ x: 0.5, y: 1 }}
          pointerEvents="none"
          start={{ x: 0.5, y: 0 }}
          style={StyleSheet.absoluteFill}
        />
        <LinearGradient
          colors={['rgba(20,14,8,0)', 'rgba(20,14,8,0.5)']}
          end={{ x: 0, y: 1 }}
          pointerEvents="none"
          start={{ x: 0, y: 0.5 }}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.tileTextBlock}>
          <Text numberOfLines={1} style={styles.readyName}>{childFirstName}</Text>
          <ScopeLine scopeLabel={scopeLabel} style={styles.readyScopeLine} yearRangeLabel={yearRangeLabel} />
        </View>
      </View>
    </View>
  );
}

// Room reserved on the outer box's right edge for the two page-edge strips
// to live in, entirely outside the `cover` layer's own (clipped) bounds.
const COVER_RIGHT_INSET = 7;

const styles = StyleSheet.create({
  tileOuter: {
    aspectRatio: 1,
    width: '100%',
    // Deliberately NOT clipped and NOT rounded -- this is a plain layout
    // box. All rounding/clipping happens on `cover` below so the page-edge
    // strips (its siblings, not its children) are never subject to its
    // clip mask. See the file header comment.
  },
  cover: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    right: COVER_RIGHT_INSET,
    borderBottomLeftRadius: 2,
    borderBottomRightRadius: 6,
    borderTopLeftRadius: 2,
    borderTopRightRadius: 6,
    overflow: 'hidden',
  },
  pageEdge: {
    borderColor: colors.border,
    borderRadius: 2,
    borderWidth: StyleSheet.hairlineWidth,
    position: 'absolute',
    width: 5,
  },
  // Vertically inset well clear of the cover's own corner radius, and
  // horizontally confined to the reserved gap (never overlapping the
  // cover's rounded corners) -- back sits flush with the outer edge, front
  // sits a couple px further left so its inner edge tucks a couple px
  // behind the cover's flat (non-curved) right edge, reading as "peeking
  // out from behind the cover" without ever touching the curved corners.
  pageEdgeBack: { bottom: 12, right: 0, top: 12 },
  pageEdgeFront: { bottom: 9, right: 2, top: 9 },
  spineShade: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    top: 0,
    width: 10,
  },
  tileTextBlock: {
    bottom: 12,
    gap: 2,
    left: 12,
    position: 'absolute',
    right: 12,
  },
  readyName: {
    color: colors.white,
    fontFamily: fonts.display,
    fontSize: 31,
    lineHeight: 33,
  },
  readyScopeLine: {
    color: 'rgba(255,255,255,0.84)',
    fontFamily: fonts.sansBold,
    fontSize: 8.5,
    letterSpacing: 0.8,
  },
  generatingTile: { backgroundColor: colors.surface2 },
  generatingText: {
    gap: 2,
    left: 14,
    position: 'absolute',
    right: 14,
    top: 14,
  },
  generatingTitle: {
    color: colors.ink,
    fontFamily: fonts.display,
    fontSize: 16,
  },
  generatingSubtitle: {
    color: colors.ink2,
    fontFamily: fonts.sans,
    fontSize: 10.5,
  },
  skeletonBars: {
    bottom: 14,
    gap: 8,
    left: 14,
    position: 'absolute',
    right: 14,
  },
  skeletonBar: {
    backgroundColor: colors.white,
    borderRadius: radius.sm,
    height: 8,
  },
  skeletonBarWide: { width: '78%' },
  skeletonBarNarrow: { width: '46%' },
  failedTile: { backgroundColor: colors.surface },
  failedBadge: {
    alignItems: 'center',
    backgroundColor: colors.sunSoft,
    borderRadius: radius.pill,
    flexDirection: 'row',
    gap: 4,
    left: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
    position: 'absolute',
    top: 10,
  },
  failedBadgeGlyph: { color: colors.sunInk, fontSize: 10, fontWeight: '700' },
  failedBadgeText: {
    color: colors.sunInk,
    fontFamily: fonts.sansBold,
    fontSize: 9.5,
  },
  failedName: {
    color: '#CFC8E0',
    fontFamily: fonts.display,
    fontSize: 31,
    lineHeight: 33,
  },
  failedScopeLine: {
    color: '#B9AE9E',
    fontFamily: fonts.sansBold,
    fontSize: 8.5,
    letterSpacing: 0.8,
  },
});
