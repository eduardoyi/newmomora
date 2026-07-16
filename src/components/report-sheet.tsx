import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import type { ReportReason, ReportTargetType } from '@/services/content-safety';

const REASONS: { value: ReportReason; label: string }[] = [
  { value: 'unsafe_or_sexual', label: 'Unsafe or sexual content' },
  { value: 'harassment_or_abuse', label: 'Harassment or abuse' },
  { value: 'privacy', label: 'Privacy concern' },
  { value: 'misleading_ai_depiction', label: 'Incorrect AI depiction' },
  { value: 'other', label: 'Something else' },
];

export function getReportKeyboardAvoidingBehavior(platform: string) {
  return platform === 'ios' ? 'padding' as const : platform === 'android' ? 'height' as const : undefined;
}

export function ReportSheet({
  visible,
  targetLabel,
  targetType,
  isSubmitting,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  targetLabel: string;
  targetType: ReportTargetType;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: (reason: ReportReason, note?: string) => Promise<void>;
}) {
  const insets = useSafeAreaInsets();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const reasons = targetType === 'memory_illustration' || targetType === 'family_member_portrait'
    ? REASONS
    : REASONS.filter((item) => item.value !== 'misleading_ai_depiction');

  const close = () => {
    if (isSubmitting) return;
    setReason(null);
    setNote('');
    setError('');
    onClose();
  };

  const submit = async () => {
    if (!reason || note.length > 500 || isSubmitting) return;
    setError('');
    try {
      await onSubmit(reason, note.trim() || undefined);
      close();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not send report');
    }
  };

  return (
    <Modal animationType="fade" onRequestClose={close} transparent visible={visible}>
      <KeyboardAvoidingView behavior={getReportKeyboardAvoidingBehavior(Platform.OS)} style={styles.root}>
        <Pressable
          accessibilityLabel="Close report"
          accessibilityRole="button"
          onPress={close}
          style={styles.backdrop}
        />
        <View
          accessibilityViewIsModal
          style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}
          testID="report-sheet"
        >
          <View style={styles.handle} />
          <Text style={styles.title}>Report {targetLabel}</Text>
          <Text style={styles.subtitle}>Your report is private and goes to Momora.</Text>
          <ScrollView keyboardShouldPersistTaps="handled" style={styles.scroll}>
            {reasons.map((item) => (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ checked: reason === item.value }}
                key={item.value}
                onPress={() => setReason(item.value)}
                style={styles.reasonRow}
                testID={`report-reason-${item.value}`}
              >
                <View style={[styles.radio, reason === item.value && styles.radioSelected]} />
                <Text style={styles.reasonText}>{item.label}</Text>
              </Pressable>
            ))}
            <TextInput
              maxLength={500}
              multiline
              onChangeText={setNote}
              placeholder="Add details (optional)"
              placeholderTextColor={colors.ink3}
              style={styles.note}
              testID="report-note"
              value={note}
            />
            <Text style={styles.noteHint}>Don’t include journal text, child names, or photos.</Text>
            {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          </ScrollView>
          <Pressable
            accessibilityRole="button"
            disabled={!reason || isSubmitting}
            onPress={() => void submit()}
            style={[styles.submit, (!reason || isSubmitting) && styles.submitDisabled]}
            testID="report-submit"
          >
            {isSubmitting ? <ActivityIndicator color={colors.white} /> : <Text style={styles.submitText}>Send report</Text>}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(44,36,24,0.4)' },
  sheet: { backgroundColor: colors.white, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, maxHeight: '88%', paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  handle: { alignSelf: 'center', backgroundColor: colors.border, borderRadius: 2, height: 4, marginBottom: spacing.md, width: 38 },
  title: { color: colors.ink, fontFamily: fonts.display, fontSize: 24 },
  subtitle: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 13, marginBottom: spacing.md, marginTop: spacing.xs },
  scroll: { flexGrow: 0 },
  reasonRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.md, minHeight: 44 },
  radio: { borderColor: colors.border, borderRadius: 8, borderWidth: 2, height: 16, width: 16 },
  radioSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  reasonText: { color: colors.ink, fontFamily: fonts.sansMedium, fontSize: 15 },
  note: { borderColor: colors.border, borderRadius: radius.md, borderWidth: 1, color: colors.ink, fontFamily: fonts.sans, fontSize: 14, marginTop: spacing.md, minHeight: 76, padding: spacing.md, textAlignVertical: 'top' },
  noteHint: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 11.5, lineHeight: 16, marginTop: spacing.xs },
  error: { color: colors.error, fontFamily: fonts.sans, fontSize: 13, marginTop: spacing.sm },
  submit: { alignItems: 'center', backgroundColor: colors.primary, borderRadius: radius.pill, marginTop: spacing.md, minHeight: 48, justifyContent: 'center' },
  submitDisabled: { opacity: 0.45 },
  submitText: { color: colors.white, fontFamily: fonts.sansBold, fontSize: 15 },
});
