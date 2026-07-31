// Reusable "Momora." wordmark (Claude Design handoff, src/screens/auth.jsx
// `Wordmark` -- soft-editorial login restyle). Newsreader medium, tight
// letter-spacing, with the trailing period picked out in the primary color.
// A colored nested <Text> is the RN-idiomatic way to recreate the mockup's
// `<span>` -- RN text runs don't support margin, so the mockup's extra
// `marginLeft` on the dot is folded into the shared negative letter-spacing
// instead of reproduced literally.
import { StyleSheet, Text } from 'react-native';

import { colors, fonts } from '@/constants/theme';

interface WordmarkProps {
  /** @default 28 */
  size?: number;
  /** @default colors.ink */
  color?: string;
  testID?: string;
}

export function Wordmark({ size = 28, color = colors.ink, testID }: WordmarkProps) {
  return (
    <Text
      style={[
        styles.base,
        { color, fontSize: size, letterSpacing: size * -0.025, lineHeight: size },
      ]}
      testID={testID}
    >
      Momora
      <Text style={styles.dot}>.</Text>
    </Text>
  );
}

const styles = StyleSheet.create({
  base: {
    fontFamily: fonts.displayMedium,
  },
  dot: {
    color: colors.primary,
  },
});
