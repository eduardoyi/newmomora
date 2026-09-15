// One row in the Memory Book scope picker (docs/plans/memory-book.md
// §"5a.5"). Shows a scope option ("Year One · Oct 2022 – Oct 2023") and,
// per the locked design, doubles as the status surface: an existing
// memory_books row for this exact scope takes over the row instead of
// offering generation again.
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import type { MemoryBookScopeRow as MemoryBookScopeRowData } from '@/hooks/useMemoryBooks';

interface MemoryBookScopeRowProps {
  row: MemoryBookScopeRowData;
  /** Owner/manager only (RLS would reject anyone else's insert anyway --
   * this hides the affordance rather than relying on that error). */
  canGenerate: boolean;
  onGenerate: () => void;
  onRetryDispatch: () => void;
  onView: () => void;
  testID: string;
}

export function MemoryBookScopeRow({
  row,
  canGenerate,
  onGenerate,
  onRetryDispatch,
  onView,
  testID,
}: MemoryBookScopeRowProps) {
  return (
    <View style={styles.row} testID={testID}>
      <View style={styles.labelBlock}>
        <Text style={styles.label}>{row.option.label}</Text>
        {row.option.eraLine ? <Text style={styles.eraLine}>{row.option.eraLine}</Text> : null}
      </View>

      {row.status === 'ready' ? (
        <Pressable
          accessibilityLabel={`View your ${row.option.label} book`}
          accessibilityRole="button"
          onPress={onView}
          style={({ pressed }) => [styles.primaryButton, pressed && styles.buttonPressed]}
          testID={`${testID}-view`}
        >
          <Text style={styles.primaryButtonText}>View your book</Text>
        </Pressable>
      ) : null}

      {row.status === 'in_progress' ? (
        <View style={styles.progressBlock} testID={`${testID}-progress`}>
          <ActivityIndicator color={colors.primary} size="small" />
          <Text style={styles.progressText}>Working on it — ready in about 3 minutes</Text>
          {row.dispatchError ? (
            <View style={styles.errorBlock}>
              <Text style={styles.errorText}>{row.dispatchError}</Text>
              <Pressable
                accessibilityLabel={`Try starting ${row.option.label} again`}
                accessibilityRole="button"
                disabled={row.isPending}
                onPress={onRetryDispatch}
                style={({ pressed }) => [styles.retryButton, pressed && styles.buttonPressed]}
                testID={`${testID}-retry-dispatch`}
              >
                <Text style={styles.retryButtonText}>Try again</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      ) : null}

      {row.status === 'failed' ? (
        <View style={styles.errorBlock} testID={`${testID}-failed`}>
          <Text style={styles.errorText}>
            {row.book?.failure_reason ?? 'Something went wrong making this book.'}
          </Text>
          {canGenerate ? (
            <Pressable
              accessibilityLabel={`Retry making the ${row.option.label} book`}
              accessibilityRole="button"
              disabled={row.isPending}
              onPress={onGenerate}
              style={({ pressed }) => [styles.retryButton, pressed && styles.buttonPressed]}
              testID={`${testID}-retry`}
            >
              <Text style={styles.retryButtonText}>Retry</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {row.status === 'thin' ? (
        <Text style={styles.thinReason} testID={`${testID}-thin`}>{row.disabledReason}</Text>
      ) : null}

      {row.status === 'available' && canGenerate ? (
        <Pressable
          accessibilityLabel={`Create the ${row.option.label} book`}
          accessibilityRole="button"
          disabled={row.isPending}
          onPress={onGenerate}
          style={({ pressed }) => [styles.primaryButton, pressed && styles.buttonPressed, row.isPending && styles.buttonPending]}
          testID={`${testID}-generate`}
        >
          {row.isPending ? (
            <ActivityIndicator color={colors.white} size="small" />
          ) : (
            <Text style={styles.primaryButtonText}>Create book</Text>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: 10,
  },
  labelBlock: { gap: 2 },
  label: {
    fontFamily: fonts.displayMedium,
    fontSize: 17,
    color: colors.ink,
  },
  eraLine: {
    fontFamily: fonts.sans,
    fontSize: 12.5,
    color: colors.ink3,
  },
  primaryButton: {
    alignSelf: 'flex-start',
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingHorizontal: 16,
    paddingVertical: 10,
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonPending: { opacity: 0.75 },
  buttonPressed: { opacity: 0.85 },
  primaryButtonText: {
    color: colors.white,
    fontFamily: fonts.sansBold,
    fontSize: 13.5,
  },
  progressBlock: { gap: 8, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  progressText: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.ink2,
  },
  errorBlock: { gap: 8, width: '100%' },
  errorText: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.error,
  },
  retryButton: {
    alignSelf: 'flex-start',
    backgroundColor: colors.errorSoft,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 8,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryButtonText: {
    color: colors.error,
    fontFamily: fonts.sansBold,
    fontSize: 13,
  },
  thinReason: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.ink3,
    fontStyle: 'italic',
  },
});
