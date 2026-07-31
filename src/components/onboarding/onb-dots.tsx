// Story-beat progress dots (docs/plans/onboarding-implementation.md WP0
// §0.1), matching the handoff's `OnbDots`
// (src/screens/onboarding-story.jsx): active dot 16x5 in `colors.primary`,
// rest 5x5 in `colors.border`.
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radius } from '@/constants/theme';

interface OnbDotsProps {
  /** Total number of beats. */
  n: number;
  /** Index (0-based) of the active beat. */
  at: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function OnbDots({ n, at, style, testID }: OnbDotsProps) {
  return (
    <View style={[styles.row, style]} testID={testID}>
      {Array.from({ length: n }).map((_, index) => (
        <View
          key={index}
          style={[styles.dot, index === at ? styles.dotActive : styles.dotInactive]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    paddingTop: 14,
  },
  dot: {
    height: 5,
    borderRadius: radius.pill,
  },
  dotActive: {
    width: 16,
    backgroundColor: colors.primary,
  },
  dotInactive: {
    width: 5,
    backgroundColor: colors.border,
  },
});
