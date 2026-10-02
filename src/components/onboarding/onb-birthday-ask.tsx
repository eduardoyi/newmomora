// "When's {name}'s birthday?" -- the optional date-of-birth ask for an
// onboarded kid (created name-only, spec decision 8). Birthday films,
// age-aware captions and milestone age bands all need it. Shown first on
// S16's painting state (the parent is waiting anyway) and again on S17's
// reveal only if it's still missing. Saves the moment a date is picked.
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { DatePickerField } from '@/components/date-picker-field';
import { OnbBody } from '@/components/onboarding/onb-typography';
import { colors, fonts, radius } from '@/constants/theme';
import type { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { possessive } from '@/utils/onboarding-copy';

const BIRTHDAY_SAVE_ERROR = "Couldn't save that. Try again?";

function defaultBirthdayPickerDate(): Date {
  // Same starting point as the Add person form's date of birth field.
  const date = new Date();
  date.setFullYear(date.getFullYear() - 3);
  return date;
}

export interface OnbBirthdayAskProps {
  memberId: string;
  name: string;
  updateMember: ReturnType<typeof useFamilyMembers>['updateMember'];
  /** e.g. "onb-reveal-birthday" -> "onb-reveal-birthday-button", "-saved", ... */
  testIDPrefix: string;
  /** Lets a screen that navigates on its own (S16's ready hand-off) wait while the picker is open. */
  onPickerOpenChange?: (isOpen: boolean) => void;
}

export function OnbBirthdayAsk({ memberId, name, updateMember, testIDPrefix, onPickerOpenChange }: OnbBirthdayAskProps) {
  const [birthday, setBirthday] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [today] = useState(() => new Date());
  const [defaultPickerDate] = useState(defaultBirthdayPickerDate);

  const save = async (isoDate: string) => {
    setBirthday(isoDate);
    setStatus('saving');
    try {
      await updateMember({ memberId, dateOfBirth: isoDate });
      setStatus('saved');
    } catch {
      setStatus('error');
    }
  };

  return (
    <View style={styles.card} testID={testIDPrefix}>
      <Text style={styles.title}>{`When's ${possessive(name)} birthday?`}</Text>
      <OnbBody muted size={13}>{`${name} gets a little film every birthday.`}</OnbBody>
      <DatePickerField
        defaultPickerDate={defaultPickerDate}
        maximumDate={today}
        onChange={(isoDate) => void save(isoDate)}
        onPickerOpenChange={onPickerOpenChange}
        renderTrigger={({ displayValue, openPicker }) => (
          <Pressable
            accessibilityLabel={displayValue ? `Birthday, ${displayValue}. Change it` : 'Add birthday'}
            accessibilityRole="button"
            disabled={status === 'saving'}
            onPress={openPicker}
            style={styles.button}
            testID={`${testIDPrefix}-button`}
          >
            <Text style={styles.buttonText}>{displayValue ?? 'Add birthday'}</Text>
          </Pressable>
        )}
        testID={`${testIDPrefix}-picker`}
        value={birthday}
      />
      {status === 'saving' ? (
        <ActivityIndicator color={colors.ink3} size="small" style={styles.status} testID={`${testIDPrefix}-saving`} />
      ) : null}
      {status === 'saved' ? (
        <Text style={styles.statusText} testID={`${testIDPrefix}-saved`}>Saved</Text>
      ) : null}
      {status === 'error' ? (
        <Text style={[styles.statusText, styles.errorText]} testID={`${testIDPrefix}-error`}>
          {BIRTHDAY_SAVE_ERROR}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    alignSelf: 'stretch',
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: 4,
    marginTop: 18,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  title: {
    color: colors.ink,
    fontFamily: fonts.sansBold,
    fontSize: 15,
  },
  button: {
    alignSelf: 'flex-start',
    backgroundColor: colors.primaryTint,
    borderRadius: radius.pill,
    marginTop: 8,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  buttonText: {
    color: colors.primary,
    fontFamily: fonts.sansBold,
    fontSize: 14,
  },
  status: {
    alignSelf: 'flex-start',
    marginTop: 6,
  },
  statusText: {
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    fontSize: 12.5,
    marginTop: 6,
  },
  errorText: {
    color: colors.error,
  },
});
