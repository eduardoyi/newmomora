import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from '@/constants/theme';

interface MemoryFabProps {
  onPress: () => void;
}

export function MemoryFab({ onPress }: MemoryFabProps) {
  const insets = useSafeAreaInsets();
  // Tab bar sits at max(28, insets.bottom+8) from screen bottom and is ~50px tall.
  // FAB bottom edge = tab bar top + 10px gap.
  const tabBarBottom = Platform.OS === 'android' ? Math.max(28, insets.bottom + 8) : 28;
  const bottom = tabBarBottom + 60;

  return (
    <View style={[styles.wrapper, { bottom }]} pointerEvents="box-none">
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
        testID="new-memory-fab"
      >
        <Text style={styles.fabText}>+</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    right: 26,
    bottom: 100,
  },
  fab: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: 30,
    height: 60,
    justifyContent: 'center',
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.36,
    shadowRadius: 28,
    elevation: 8,
    width: 60,
  },
  fabPressed: {
    backgroundColor: colors.primaryDark,
    transform: [{ scale: 0.96 }],
  },
  fabText: {
    color: colors.white,
    fontSize: 30,
    fontWeight: '300',
    lineHeight: 34,
    marginTop: -2,
  },
});
