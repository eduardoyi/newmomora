import { StyleSheet, View } from 'react-native';

import { colors } from '@/constants/theme';

interface PlusGlyphProps {
  size?: number;
  thickness?: number;
  color?: string;
}

// Drawn with two bars rather than a "+" text glyph: font padding/metrics
// (notably on Android) push a text plus off-center inside small circles.
export function PlusGlyph({ size = 12, thickness = 2, color = colors.primary }: PlusGlyphProps) {
  return (
    <View style={{ height: size, width: size }}>
      <View
        style={[
          styles.bar,
          { backgroundColor: color, height: thickness, top: (size - thickness) / 2, width: size },
        ]}
      />
      <View
        style={[
          styles.bar,
          { backgroundColor: color, height: size, left: (size - thickness) / 2, width: thickness },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    borderRadius: 1,
    position: 'absolute',
  },
});
