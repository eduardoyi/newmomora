import { useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, spacing } from '@/constants/theme';

export interface SelectOption {
  value: string;
  label: string;
}

function optionTestIdSuffix(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

interface SelectFieldProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  testID?: string;
}

export function SelectField({
  value,
  onChange,
  options,
  placeholder = 'Select an option',
  testID,
}: SelectFieldProps) {
  const [isOpen, setIsOpen] = useState(false);
  const insets = useSafeAreaInsets();

  const displayValue = useMemo(() => {
    const trimmed = value.trim();

    if (!trimmed) {
      return null;
    }

    return options.find((option) => option.value === trimmed)?.label ?? trimmed;
  }, [options, value]);

  const openPicker = () => {
    setIsOpen(true);
  };

  const closePicker = () => {
    setIsOpen(false);
  };

  const selectOption = (nextValue: string) => {
    onChange(nextValue);
    closePicker();
  };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={displayValue ?? placeholder}
        onPress={openPicker}
        style={({ pressed }) => [styles.field, pressed && styles.fieldPressed]}
        testID={testID}
      >
        <Text style={[styles.fieldText, !displayValue && styles.placeholderText]}>
          {displayValue ?? placeholder}
        </Text>
      </Pressable>

      <Modal
        animationType="slide"
        onRequestClose={closePicker}
        presentationStyle="overFullScreen"
        transparent
        visible={isOpen}
      >
        <View style={styles.modalRoot}>
          <Pressable accessibilityRole="button" onPress={closePicker} style={styles.backdrop} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.lg }]}>
            <View style={styles.toolbar}>
              <Text style={styles.toolbarTitle}>Select an option</Text>
              <Pressable accessibilityRole="button" onPress={closePicker} testID={`${testID}-cancel`}>
                <Text style={styles.toolbarAction}>Cancel</Text>
              </Pressable>
            </View>
            <ScrollView>
              {options.map((option) => {
                const isSelected = option.value === value;

                return (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                    key={option.value}
                    onPress={() => selectOption(option.value)}
                    style={({ pressed }) => [
                      styles.option,
                      isSelected && styles.optionSelected,
                      pressed && styles.optionPressed,
                    ]}
                    testID={`${testID}-option-${optionTestIdSuffix(option.value)}`}
                  >
                    <Text style={[styles.optionText, isSelected && styles.optionTextSelected]}>
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  field: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
  },
  fieldPressed: {
    opacity: 0.9,
  },
  fieldText: {
    color: colors.text,
    fontSize: 16,
  },
  placeholderText: {
    color: colors.textMuted,
  },
  modalRoot: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(44, 36, 24, 0.35)',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '60%',
  },
  toolbar: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  toolbarTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  toolbarAction: {
    color: colors.primary,
    fontSize: 16,
    fontWeight: '600',
  },
  option: {
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  optionSelected: {
    backgroundColor: colors.background,
  },
  optionPressed: {
    opacity: 0.9,
  },
  optionText: {
    color: colors.text,
    fontSize: 16,
  },
  optionTextSelected: {
    color: colors.primary,
    fontWeight: '700',
  },
});
