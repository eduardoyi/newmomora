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
   * The surface color directly behind the tear -- the punched notches are
   * solid circles painted in this color to read as holes through to it.
   * Pass the card's own background (white for the timeline card).
   */
  cardColor?: string;
  testID?: string;
}

const NOTCH_SIZE = 12;

export function StubTear({ cardColor = colors.white, testID }: StubTearProps) {
  return (
    <View style={styles.container} testID={testID}>
      <View style={styles.perforation} />
      <View style={[styles.notch, styles.notchLeft, { backgroundColor: cardColor }]} />
      <View style={[styles.notch, styles.notchRight, { backgroundColor: cardColor }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 1,
    position: 'relative',
  },
  perforation: {
    borderColor: colors.borderStrong,
    borderStyle: 'dashed',
    borderTopWidth: 1,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  notch: {
    borderRadius: NOTCH_SIZE / 2,
    height: NOTCH_SIZE,
    position: 'absolute',
    top: -(NOTCH_SIZE / 2) + 0.5,
    width: NOTCH_SIZE,
  },
  notchLeft: {
    left: -(NOTCH_SIZE / 2),
  },
  notchRight: {
    right: -(NOTCH_SIZE / 2),
  },
});
