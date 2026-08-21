import { Bell } from 'lucide-react-native';
import { Pressable, StyleSheet, View } from 'react-native';

import { colors } from '@/constants/theme';

interface TimelineActivityBellProps {
  unread: boolean;
  onPress: () => void;
}

// Its own component (not inlined in timeline.tsx) so the later
// gallery-import merge -- which adds a TimelineImportGlyph in the same
// header row -- is a one-line conflict (plan §11).
export function TimelineActivityBell({ unread, onPress }: TimelineActivityBellProps) {
  return (
    <Pressable
      accessibilityLabel={unread ? 'Family activity, new' : 'Family activity'}
      accessibilityRole="button"
      hitSlop={12}
      onPress={onPress}
      style={styles.button}
      testID="timeline-activity-bell"
    >
      <Bell color={colors.ink2} size={22} strokeWidth={1.8} />
      {unread ? <View style={styles.dot} testID="timeline-activity-bell-dot" /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  dot: {
    backgroundColor: colors.primary,
    borderColor: colors.bg,
    borderRadius: 5,
    borderWidth: 1.5,
    height: 8,
    position: 'absolute',
    right: 2,
    top: 2,
    width: 8,
  },
});
