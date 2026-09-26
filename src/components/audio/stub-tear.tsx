// The ticket-stub perforation line between the tinted stub band and the
// card's shipped chrome below it -- ported from the design prototype's
// `StubTear` (audio-kit.jsx): a dashed line with two punched notches (small
// circles matching the surface behind the tear) at both ends, like a torn
// ticket stub. NEW kit file (P3.1, docs/plans/audio-memories-v1.md) --
// StubBand/StubTear didn't exist in the ported kit yet.
import { StyleSheet, View } from 'react-native';

import { colors } from '@/constants/theme';

export interface StubTearProps {
  /**
   * The surface BEHIND the card (the screen background), not the card
   * itself: the notches are painted in this color so they read as holes
   * punched through the card's edge. Defaults to the app background the
   * timeline sits on. (It used to be passed the card's own white, which
   * made the notches invisible.)
   */
  backgroundColor?: string;
  testID?: string;
}

const NOTCH_SIZE = 18;
// Gap between each notch and the start/end of the dashed line.
const PERFORATION_INSET = NOTCH_SIZE / 2 + 6;

/**
 * Must sit directly inside a card with `overflow: 'hidden'`: the card clips
 * the outer half of each notch, leaving a semicircular bite (with the card's
 * border color as its rim) on both edges, like a torn ticket stub.
 */
export function StubTear({ backgroundColor = colors.bg, testID }: StubTearProps) {
  return (
    <View style={styles.container} testID={testID}>
      <View style={styles.perforation} />
      <View style={[styles.notch, styles.notchLeft, { backgroundColor }]} testID={testID ? `${testID}-notch-left` : undefined} />
      <View style={[styles.notch, styles.notchRight, { backgroundColor }]} testID={testID ? `${testID}-notch-right` : undefined} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 1,
    position: 'relative',
    zIndex: 1,
  },
  perforation: {
    borderColor: colors.borderStrong,
    borderStyle: 'dashed',
    borderTopWidth: 1,
    left: PERFORATION_INSET,
    position: 'absolute',
    right: PERFORATION_INSET,
    top: 0,
  },
  notch: {
    borderColor: colors.border,
    borderRadius: NOTCH_SIZE / 2,
    borderWidth: 1,
    height: NOTCH_SIZE,
    position: 'absolute',
    top: -(NOTCH_SIZE / 2) + 0.5,
    width: NOTCH_SIZE,
  },
  notchLeft: {
    // One card-border width further out so the rim lines up with the
    // card's own 1px border.
    left: -(NOTCH_SIZE / 2) - 1,
  },
  notchRight: {
    right: -(NOTCH_SIZE / 2) - 1,
  },
});
