import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fonts, radius, spacing } from '@/constants/theme';

export interface ChildPickerSheetProps {
  visible: boolean;
  options: { id: string; name: string }[];
  onSelect: (memberId: string) => void;
  onClose: () => void;
}

/**
 * "Whose book?" -- Keepsakes' one family-level "Create a book" CTA asks this
 * first when the family has more than one shelf
 * (docs/plans/timeline-calendar-keepsakes.md C4). Same Modal + backdrop
 * shape as the other memory-book sheets.
 */
export function ChildPickerSheet({ visible, options, onSelect, onClose }: ChildPickerSheetProps) {
  const insets = useSafeAreaInsets();

  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="overFullScreen" transparent visible={visible}>
      <View style={styles.root}>
        <Pressable accessibilityLabel="Close" accessibilityRole="button" onPress={onClose} style={styles.backdrop} />
        <View
          accessibilityViewIsModal
          style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}
          testID="child-picker-sheet"
        >
          <View style={styles.handle} />
          <Text style={styles.title}>Whose book?</Text>
          <View style={styles.list}>
            {options.map((child) => (
              <Pressable
                accessibilityRole="button"
                key={child.id}
                onPress={() => onSelect(child.id)}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                testID={`child-picker-${child.id}`}
              >
                <Text style={styles.rowText}>{child.name}</Text>
              </Pressable>
            ))}
          </View>
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.cancel} testID="child-picker-cancel">
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(44,36,24,0.34)' },
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  handle: {
    alignSelf: 'center',
    backgroundColor: colors.borderStrong,
    borderRadius: 2,
    height: 4,
    marginBottom: spacing.md,
    width: 36,
  },
  title: { color: colors.ink, fontFamily: fonts.display, fontSize: 21, marginBottom: spacing.md },
  list: { gap: 10 },
  row: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: 16,
  },
  rowPressed: { opacity: 0.85 },
  rowText: { color: colors.ink, fontFamily: fonts.displayMedium, fontSize: 17 },
  cancel: { alignItems: 'center', marginTop: spacing.md, paddingVertical: 12 },
  cancelText: { color: colors.ink2, fontFamily: fonts.sansBold, fontSize: 15 },
});
