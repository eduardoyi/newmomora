import { router } from 'expo-router';
import { Search } from 'lucide-react-native';
import { Pressable, StyleSheet } from 'react-native';

import { colors } from '@/constants/theme';
import { memorySearchRoute } from '@/lib/routes';

// Sits beside TimelineActivityBell in the timeline header and opens the
// search screen (docs/features/memory-search.md).
export function TimelineSearchButton() {
  return (
    <Pressable
      accessibilityLabel="Search memories"
      accessibilityRole="button"
      hitSlop={12}
      onPress={() => router.push(memorySearchRoute)}
      style={styles.button}
      testID="timeline-search-button"
    >
      <Search color={colors.ink2} size={21} strokeWidth={1.8} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { alignItems: 'center', height: 32, justifyContent: 'center', width: 32 },
});
