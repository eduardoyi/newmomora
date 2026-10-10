import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors } from '@/constants/theme';

// A gallery frame drawn entirely in Views (no bitmap): a walnut band with a
// lit top/left edge, a 1px beveled lip, a cream mat, and a hairline shade at
// the mat opening so the artwork reads as sitting slightly behind the mat.
// Layers, outside in:
//   shadow carrier -> wood band -> bevel lip -> mat -> mat opening -> children
// The frame adds only fixed padding (band + mat), never a measured one, so the
// child keeps its own aspect-ratio layout and list heights stay deterministic.

export type ArtworkFrameSize = 'card' | 'detail';

interface ArtworkFrameProps {
  children: React.ReactNode;
  /** `card` for Timeline rows, `detail` for the memory detail hero. */
  size?: ArtworkFrameSize;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

// Total chrome per side = band + 1 (outer edge) + 1 (lip) + mat + 1 (opening).
const FRAME_METRICS = {
  card: { band: 8, mat: 14, radius: 2, shadowRadius: 10, shadowOffset: 5, shadowOpacity: 0.2, elevation: 5 },
  detail: { band: 12, mat: 22, radius: 3, shadowRadius: 18, shadowOffset: 10, shadowOpacity: 0.24, elevation: 8 },
} as const;

export function ArtworkFrame({ children, size = 'card', style, testID }: ArtworkFrameProps) {
  const metrics = FRAME_METRICS[size];

  return (
    <View
      style={[
        styles.shadowCarrier,
        {
          borderRadius: metrics.radius,
          shadowOffset: { width: 0, height: metrics.shadowOffset },
          shadowOpacity: metrics.shadowOpacity,
          shadowRadius: metrics.shadowRadius,
          elevation: metrics.elevation,
        },
        style,
      ]}
      testID={testID}
    >
      <View
        style={[styles.band, { borderRadius: metrics.radius, padding: metrics.band }]}
        testID={testID ? `${testID}-band` : undefined}
      >
        <View style={styles.lip} testID={testID ? `${testID}-lip` : undefined}>
          <View style={[styles.mat, { padding: metrics.mat }]} testID={testID ? `${testID}-mat` : undefined}>
            <View style={styles.opening} testID={testID ? `${testID}-opening` : undefined}>
              {children}
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Carries the soft outer shadow; needs a solid background for Android's
  // elevation shadow to render.
  shadowCarrier: {
    backgroundColor: colors.frameWood,
    shadowColor: colors.frameShadow,
  },
  // The wood itself. Light catches the top/left edge, the bottom/right falls
  // into shade.
  band: {
    backgroundColor: colors.frameWood,
    borderBottomColor: colors.frameWoodDark,
    borderLeftColor: colors.frameWoodLight,
    borderRightColor: colors.frameWoodDark,
    borderTopColor: colors.frameWoodLight,
    borderWidth: 1,
  },
  // 1px lip where the band steps down toward the mat: inverse of the outer
  // edge (shaded top/left, lit bottom/right) so it reads as a beveled rebate.
  lip: {
    borderBottomColor: colors.frameWoodLight,
    borderLeftColor: colors.frameWoodDark,
    borderRightColor: colors.frameWoodLight,
    borderTopColor: colors.frameWoodDark,
    borderWidth: 1,
  },
  mat: {
    backgroundColor: colors.frameMat,
  },
  // Hairline inner shadow at the mat opening: shade along the top/left (the
  // mat overhangs the artwork), a faint highlight along the bottom/right.
  opening: {
    backgroundColor: colors.surface,
    borderBottomColor: colors.frameMatLight,
    borderLeftColor: colors.frameMatShade,
    borderRightColor: colors.frameMatLight,
    borderTopColor: colors.frameMatShade,
    borderWidth: 1,
    overflow: 'hidden',
  },
});
