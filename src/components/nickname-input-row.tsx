import { useRef } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useFormScrollContext } from '@/components/keyboard-aware-form-screen';
import { colors, fonts, radius, spacing } from '@/constants/theme';

interface NicknameInputRowProps {
  value: string;
  onChangeText: (text: string) => void;
  onSubmitEditing: () => void;
  onAdd: () => void;
  addTestID?: string;
  inputTestID?: string;
}

export function NicknameInputRow({
  value,
  onChangeText,
  onSubmitEditing,
  onAdd,
  addTestID,
  inputTestID,
}: NicknameInputRowProps) {
  const formScroll = useFormScrollContext();
  const wrapperRef = useRef<View>(null);

  return (
    <View ref={wrapperRef} collapsable={false} style={styles.row}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onFocus={() => formScroll?.scrollInputIntoView(wrapperRef)}
        onSubmitEditing={onSubmitEditing}
        placeholder="Add a nickname…"
        placeholderTextColor={colors.ink3}
        returnKeyType="done"
        style={styles.input}
        testID={inputTestID}
      />
      {value.trim().length > 0 && (
        <Pressable onPress={onAdd} style={styles.addBtn} testID={addTestID}>
          <Text style={styles.addBtnText}>Add</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  input: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 15,
    color: colors.ink,
    paddingVertical: 6,
  },
  addBtn: {
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
  },
  addBtnText: {
    fontFamily: fonts.sansBold,
    fontSize: 12,
    color: colors.white,
  },
});
