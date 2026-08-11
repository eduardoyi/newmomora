// The Timeline entry point for gallery import (design: gi-entry.jsx
// GIImportGlyph/GIImportButton, ~L130-169). A small stroke tray-with-
// down-arrow icon inside the existing 38px white circle, with a status dot
// that reflects the six-state entry status derived by
// useGalleryImportEntryStatus (see src/utils/gallery-import-entry-state.ts).
import { useEffect } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

import { colors } from '@/constants/theme';
import type { GalleryImportEntryState } from '@/utils/gallery-import-entry-state';

const GLYPH_SIZE = 38;
const ICON_SIZE = 19;
// design: gi-entry.jsx GIImportButton's dot -- a 10px colored circle behind a
// 2px white ring, sized with CSS `content-box` (border ADDS to the 10px).
// React Native draws borders inset instead (width/height already includes
// them), so the RN box has to be specified at the design's rendered total
// (10 + 2*2 = 14) to land on the same 14px footprint with a 10px colored
// center peeking through the 2px ring.
const DOT_RING_WIDTH = 2;
const DOT_TOTAL_SIZE = 10 + DOT_RING_WIDTH * 2;
const BREATHE_DURATION_MS = 900;
const BREATHE_MIN_OPACITY = 0.55;
const BREATHE_MAX_OPACITY = 0.92;

// design: gi-entry.jsx GIImportButton's `dot` map.
const DOT_COLOR_BY_STATE: Partial<Record<GalleryImportEntryState, string>> = {
  processing: colors.sea,
  ready: colors.primary,
  resume: colors.primary,
  attention: colors.sun,
  expiring: colors.sun,
};

// Copied verbatim from the design handoff's `label` map (gi-entry.jsx
// GIImportButton) so the accessible name matches the approved copy exactly.
// No "import/upload/scan/library" wording per docs/design/gallery-import/README.md.
function accessibilityLabelForState(state: GalleryImportEntryState, readyCount: number | null): string {
  switch (state) {
    case 'processing':
      return 'Photo suggestions, still working';
    case 'ready':
      return readyCount ? `Photo suggestions ready, ${readyCount} waiting` : 'Photo suggestions ready';
    case 'resume':
      return 'Photo suggestions, pick up where you left off';
    case 'attention':
      return 'Photo suggestions need your attention';
    case 'expiring':
      return 'Photo suggestions ending soon';
    case 'none':
    default:
      return 'Find memories in your photos';
  }
}

function ImportGlyphIcon() {
  return (
    <Svg
      fill="none"
      height={ICON_SIZE}
      stroke={colors.ink2}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.85}
      viewBox="0 0 24 24"
      width={ICON_SIZE}
    >
      <Path d="M12 3v9" />
      <Path d="M8.5 8.5L12 12l3.5-3.5" />
      <Path d="M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3" />
    </Svg>
  );
}

function ImportGlyphDot({ state }: { state: GalleryImportEntryState }) {
  const isBreathing = state === 'processing';
  // design: gi-shared.jsx giBreathe keyframes (opacity .5 -> .9 -> .5,
  // ~1600ms). withRepeat's own reverse flag reproduces the ease-in/ease-out
  // back-and-forth without needing `withSequence`/`Easing` (both unavailable
  // in this repo's reanimated Jest mock -- see jest.setup.ts).
  const opacity = useSharedValue(BREATHE_MAX_OPACITY);

  useEffect(() => {
    if (!isBreathing) {
      opacity.value = BREATHE_MAX_OPACITY;
      return;
    }
    opacity.value = withRepeat(withTiming(BREATHE_MIN_OPACITY, { duration: BREATHE_DURATION_MS }), -1, true);
  }, [isBreathing, opacity]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  const color = DOT_COLOR_BY_STATE[state];
  if (!color) return null;

  return (
    <Animated.View
      style={[styles.dot, { backgroundColor: color }, animatedStyle]}
      testID="import-glyph-dot"
    />
  );
}

export interface ImportGlyphProps {
  state: GalleryImportEntryState;
  /** Only used for the `ready` state's accessible label -- see design copy above. */
  readyCount?: number | null;
  onPress: () => void;
  testID?: string;
}

export function ImportGlyph({ state, readyCount = null, onPress, testID }: ImportGlyphProps) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabelForState(state, readyCount)}
      accessibilityRole="button"
      onPress={onPress}
      style={styles.button}
      testID={testID ?? 'timeline-gallery-import-glyph'}
    >
      <ImportGlyphIcon />
      <ImportGlyphDot state={state} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: GLYPH_SIZE / 2,
    borderWidth: 1,
    height: GLYPH_SIZE,
    justifyContent: 'center',
    marginTop: 8,
    width: GLYPH_SIZE,
  },
  dot: {
    borderColor: colors.white,
    borderRadius: DOT_TOTAL_SIZE / 2,
    borderWidth: DOT_RING_WIDTH,
    height: DOT_TOTAL_SIZE,
    position: 'absolute',
    right: 1,
    top: 1,
    width: DOT_TOTAL_SIZE,
  },
});
