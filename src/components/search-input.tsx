import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, spacing } from '@/constants/theme';

interface SearchInputProps {
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
}

export function SearchInput({
  value,
  onChangeText,
  placeholder = 'Search memories',
}: SearchInputProps) {
  return (
    <View style={styles.container}>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        style={styles.input}
        testID="memory-search-input"
        value={value}
      />
      {value.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => onChangeText('')}
          style={styles.clearButton}
          testID="memory-search-clear"
        >
          <Text style={styles.clearText}>Clear</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  input: {
    color: colors.text,
    flex: 1,
    fontSize: 16,
    paddingVertical: spacing.sm,
  },
  clearButton: {
    paddingVertical: spacing.sm,
  },
  clearText: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: '600',
  },
});
