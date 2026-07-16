import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fonts, radius, spacing } from '@/constants/theme';

export interface ContentAction {
  label: string;
  onPress: () => void;
  danger?: boolean;
  testID: string;
}

export function ContentActionSheet({
  visible,
  title,
  actions,
  onClose,
  testID = 'content-action-sheet',
}: {
  visible: boolean;
  title?: string;
  actions: ContentAction[];
  onClose: () => void;
  testID?: string;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <Pressable
        accessibilityLabel="Close actions"
        accessibilityRole="button"
        onPress={onClose}
        style={styles.backdrop}
      />
      <View pointerEvents="box-none" style={[styles.wrap, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
        <View accessibilityViewIsModal style={styles.card} testID={testID}>
          {title ? <Text style={styles.title}>{title}</Text> : null}
          {actions.map((action, index) => (
            <View key={action.testID}>
              {(index > 0 || title) ? <View style={styles.divider} /> : null}
              <Pressable
                accessibilityLabel={action.label}
                accessibilityRole="button"
                onPress={() => {
                  onClose();
                  action.onPress();
                }}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                testID={action.testID}
              >
                <Text style={[styles.rowText, action.danger && styles.danger]}>{action.label}</Text>
              </Pressable>
            </View>
          ))}
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={onClose}
          style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}
          testID={`${testID}-cancel`}
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(44,36,24,0.4)' },
  wrap: { flex: 1, justifyContent: 'flex-end', paddingHorizontal: spacing.md },
  card: { backgroundColor: colors.white, borderRadius: radius.lg, overflow: 'hidden' },
  title: { color: colors.ink3, fontFamily: fonts.sansMedium, fontSize: 13, padding: spacing.md, textAlign: 'center' },
  divider: { backgroundColor: colors.border, height: 1 },
  row: { alignItems: 'center', paddingVertical: 15 },
  rowText: { color: colors.primary, fontFamily: fonts.sansMedium, fontSize: 16 },
  danger: { color: colors.error },
  pressed: { backgroundColor: colors.surface },
  cancel: { alignItems: 'center', backgroundColor: colors.white, borderRadius: radius.lg, marginTop: spacing.sm, paddingVertical: 15 },
  cancelText: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 16 },
});
