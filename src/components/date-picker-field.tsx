import DateTimePicker, {
  DateTimePickerAndroid,
  type DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import { useMemo, useState, type ReactNode } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, spacing } from '@/constants/theme';
import { formatIsoDateForDisplay, parseIsoDate, toIsoDate } from '@/utils/dates';

const IOS_PICKER_HEIGHT = 216;

interface DatePickerFieldProps {
  value: string;
  onChange: (isoDate: string) => void;
  placeholder?: string;
  testID?: string;
  minimumDate?: Date;
  maximumDate?: Date;
  defaultPickerDate?: Date;
  /** Announced by screen readers alongside the field's accessibility label
   * (e.g. to note that the current value is a suggestion). */
  accessibilityHint?: string;
  renderTrigger?: (options: {
    displayValue: string | null;
    openPicker: () => void;
    placeholder: string;
  }) => ReactNode;
}

function resolvePickerDate(
  value: string,
  defaultPickerDate: Date | undefined,
  maximumDate: Date | undefined,
): Date {
  const parsedValue = parseIsoDate(value);
  if (parsedValue) {
    return parsedValue;
  }

  if (defaultPickerDate) {
    return defaultPickerDate;
  }

  if (maximumDate) {
    return maximumDate;
  }

  return new Date();
}

export function DatePickerField({
  value,
  onChange,
  placeholder = 'Select a date',
  testID,
  minimumDate,
  maximumDate,
  defaultPickerDate,
  accessibilityHint,
  renderTrigger,
}: DatePickerFieldProps) {
  const insets = useSafeAreaInsets();
  const [showIosPicker, setShowIosPicker] = useState(false);
  const [draftDate, setDraftDate] = useState(() =>
    resolvePickerDate(value, defaultPickerDate, maximumDate),
  );

  const displayValue = useMemo(() => {
    if (!value.trim()) {
      return null;
    }

    return formatIsoDateForDisplay(value);
  }, [value]);

  const openPicker = () => {
    const nextDraftDate = resolvePickerDate(value, defaultPickerDate, maximumDate);
    setDraftDate(nextDraftDate);

    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: nextDraftDate,
        mode: 'date',
        display: 'default',
        minimumDate,
        maximumDate,
        onChange: (event: DateTimePickerEvent, selectedDate?: Date) => {
          if (event.type === 'set' && selectedDate) {
            onChange(toIsoDate(selectedDate));
          }
        },
      });
      return;
    }

    setShowIosPicker(true);
  };

  const closeIosPicker = () => {
    setShowIosPicker(false);
  };

  const confirmIosPicker = () => {
    onChange(toIsoDate(draftDate));
    closeIosPicker();
  };

  return (
    <>
      {renderTrigger ? renderTrigger({ displayValue, openPicker, placeholder }) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={displayValue ?? placeholder}
          accessibilityHint={accessibilityHint}
          onPress={openPicker}
          style={({ pressed }) => [styles.field, pressed && styles.fieldPressed]}
          testID={testID}
        >
          <Text style={[styles.fieldText, !displayValue && styles.placeholderText]}>
            {displayValue ?? placeholder}
          </Text>
        </Pressable>
      )}

      {Platform.OS === 'ios' ? (
        <Modal
          animationType="slide"
          onRequestClose={closeIosPicker}
          presentationStyle="overFullScreen"
          transparent
          visible={showIosPicker}
        >
          <View style={styles.modalRoot}>
            <Pressable accessibilityRole="button" onPress={closeIosPicker} style={styles.backdrop} />
            <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
              <View style={styles.pickerContainer}>
                <DateTimePicker
                  display="spinner"
                  maximumDate={maximumDate}
                  minimumDate={minimumDate}
                  mode="date"
                  onChange={(_event, selectedDate) => {
                    if (selectedDate) {
                      setDraftDate(selectedDate);
                    }
                  }}
                  style={styles.picker}
                  testID={`${testID}-picker`}
                  textColor={colors.text}
                  themeVariant="light"
                  value={draftDate}
                />
              </View>
              <View style={styles.toolbar}>
                <Pressable accessibilityRole="button" onPress={closeIosPicker} testID={`${testID}-cancel`}>
                  <Text style={styles.toolbarAction}>Cancel</Text>
                </Pressable>
                <Pressable accessibilityRole="button" onPress={confirmIosPicker} testID={`${testID}-done`}>
                  <Text style={[styles.toolbarAction, styles.toolbarActionPrimary]}>Done</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      ) : null}
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
    overflow: 'hidden',
  },
  pickerContainer: {
    height: IOS_PICKER_HEIGHT,
    width: '100%',
  },
  picker: {
    height: IOS_PICKER_HEIGHT,
    width: '100%',
  },
  toolbar: {
    alignItems: 'center',
    borderTopColor: colors.border,
    borderTopWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  toolbarAction: {
    color: colors.textMuted,
    fontSize: 16,
    fontWeight: '600',
  },
  toolbarActionPrimary: {
    color: colors.primary,
  },
});
