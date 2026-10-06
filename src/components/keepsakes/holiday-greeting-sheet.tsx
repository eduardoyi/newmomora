// "Pick your greeting" bottom sheet for the Keepsakes holiday-card tile
// (docs/plans/holiday-cards-p2.md Step 6). Choices only -- no text input, so
// no keyboard handling. The greeting is baked into the card's film, so it is
// fixed once the card is created. Confirm -> create -> open the shop editor
// (or, when the device timezone is outside US/Canada, first show an inline
// "Cards ship to the US and Canada" note with Continue). Errors stay inline.
import { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import type { CreateHolidayCardOutcome } from '@/hooks/useHolidayCard';
import {
  HOLIDAY_CARD_GREETINGS,
  HOLIDAY_CARD_GREETING_TEXT,
  type CreateHolidayCardErrorCode,
  type HolidayCardGreeting,
  type HolidayCardLanguage,
} from '@/services/holiday-cards';
import { getBottomSheetBottomPadding } from '@/utils/bottom-sheet-dismiss';

export const HOLIDAY_GREETING_NOTE = 'The greeting is printed on your card and in your film, so it can’t be changed later.';
export const HOLIDAY_REGION_NOTE = 'Cards ship to the US and Canada';
export const HOLIDAY_EXISTING_NOTE = 'You already have this year’s card — opening it';

export const HOLIDAY_CREATE_ERROR_MESSAGES: Record<CreateHolidayCardErrorCode, string> = {
  disabled: "Holiday cards aren't available yet",
  slot_used: "You've already made this year's card",
  subscription_required: 'Making a holiday card needs an active subscription.',
  forbidden: 'Only the family owner or a manager can make the holiday card.',
  network: 'We couldn’t reach Momora. Check your connection and try again.',
  unknown: 'Something went wrong. Please try again.',
};

/** Errors where pressing Confirm again could succeed. */
const RETRYABLE: ReadonlySet<CreateHolidayCardErrorCode> = new Set(['network', 'unknown', 'subscription_required']);

export interface HolidayGreetingSheetProps {
  visible: boolean;
  /** The card's language: the greetings are shown (and printed) in it. */
  language: HolidayCardLanguage;
  /** Creates the card (the hook's `create`). Never rejects. */
  onCreate: (greeting: HolidayCardGreeting) => Promise<CreateHolidayCardOutcome>;
  /** Opens the shop editor for the new card (the caller uses `openShopUrl`). */
  onOpenCard: (cardId: string) => void;
  onClose: () => void;
}

export function HolidayGreetingSheet({ visible, language, onCreate, onOpenCard, onClose }: HolidayGreetingSheetProps) {
  const insets = useSafeAreaInsets();
  const [selected, setSelected] = useState<HolidayCardGreeting | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [errorCode, setErrorCode] = useState<CreateHolidayCardErrorCode | null>(null);
  // A notice shown before the shop opens: an existing card (its greeting may
  // differ from the pick) and/or the US/Canada region warning.
  const [notice, setNotice] = useState<{ cardId: string; existing: boolean; region: boolean } | null>(null);
  // A ref as well as state: two taps in one frame must not create twice.
  const inFlight = useRef(false);
  const visibleRef = useRef(visible);
  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  // Start each opening fresh. Adjusting state while rendering (instead of in
  // an effect) avoids a stale first frame; closing keeps the old content so
  // the slide-out doesn't flash.
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible) {
      setSelected(null);
      setIsCreating(false);
      setErrorCode(null);
      setNotice(null);
    }
  }

  const handleConfirm = async () => {
    if (!selected || inFlight.current) return;
    inFlight.current = true;
    setIsCreating(true);
    setErrorCode(null);
    try {
      const outcome = await onCreate(selected);
      if (!outcome.ok) {
        setErrorCode(outcome.error.code);
        return;
      }
      if (!visibleRef.current) return; // dismissed before the create resolved: don't pop the browser
      const { cardId, created, regionWarning } = outcome.result;
      if (!created || regionWarning) {
        setNotice({ cardId, existing: !created, region: regionWarning });
        return;
      }
      onOpenCard(cardId);
      onClose();
    } finally {
      inFlight.current = false;
      setIsCreating(false);
    }
  };

  const handleContinue = () => {
    if (!notice) return;
    onOpenCard(notice.cardId);
    onClose();
  };

  // Dismissal is blocked while the card is being created (backdrop, Android back).
  const requestClose = () => {
    if (!isCreating) onClose();
  };

  const isRetryable = errorCode === null || RETRYABLE.has(errorCode);
  const greetings = HOLIDAY_CARD_GREETING_TEXT[language];

  return (
    <Modal animationType="slide" onRequestClose={requestClose} presentationStyle="overFullScreen" transparent visible={visible}>
      <View style={styles.root}>
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          onPress={requestClose}
          style={styles.backdrop}
          testID="holiday-greeting-backdrop"
        />
        <View
          accessibilityViewIsModal
          style={[styles.sheet, { paddingBottom: getBottomSheetBottomPadding(insets.bottom, false) + spacing.sm }]}
          testID="holiday-greeting-sheet"
        >
          <View style={styles.handle} />

          {notice ? (
            <View
              style={styles.regionBlock}
              testID={notice.existing ? 'holiday-greeting-existing' : 'holiday-greeting-region'}
            >
              <Text style={styles.title}>{notice.existing ? HOLIDAY_EXISTING_NOTE : HOLIDAY_REGION_NOTE}</Text>
              {notice.existing ? (
                <Text style={styles.body}>
                  Its greeting may be different from the one you just picked.
                  {notice.region ? ` ${HOLIDAY_REGION_NOTE}.` : ''}
                </Text>
              ) : (
                <Text style={styles.body}>
                  Your card is being made. You can still continue and choose a US or Canadian address when you order.
                </Text>
              )}
              <Pressable
                accessibilityRole="button"
                onPress={handleContinue}
                style={({ pressed }) => [styles.confirmButton, pressed && styles.pressed]}
                testID="holiday-greeting-continue"
              >
                <Text style={styles.confirmText}>Continue</Text>
              </Pressable>
            </View>
          ) : (
            <>
              <Text style={styles.title}>Pick your greeting</Text>
              <Text style={styles.body} testID="holiday-greeting-note">
                {HOLIDAY_GREETING_NOTE}
              </Text>

              <View accessibilityRole="radiogroup" style={styles.list}>
                {HOLIDAY_CARD_GREETINGS.map((key) => {
                  const isSelected = selected === key;
                  return (
                    <Pressable
                      accessibilityLabel={greetings[key]}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: isSelected, disabled: isCreating }}
                      disabled={isCreating}
                      key={key}
                      onPress={() => {
                        setSelected(key);
                        setErrorCode(null);
                      }}
                      style={({ pressed }) => [styles.row, isSelected && styles.rowSelected, pressed && styles.pressed]}
                      testID={`holiday-greeting-${key}`}
                    >
                      <Text style={styles.rowText}>{greetings[key]}</Text>
                      <View style={[styles.radio, isSelected && styles.radioSelected]}>
                        {isSelected ? <View style={styles.radioDot} /> : null}
                      </View>
                    </Pressable>
                  );
                })}
              </View>

              {errorCode ? (
                <Text accessibilityRole="alert" style={styles.error} testID="holiday-greeting-error">
                  {HOLIDAY_CREATE_ERROR_MESSAGES[errorCode]}
                </Text>
              ) : null}

              {isRetryable ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !selected || isCreating }}
                  disabled={!selected || isCreating}
                  onPress={() => void handleConfirm()}
                  style={({ pressed }) => [
                    styles.confirmButton,
                    (!selected || isCreating) && styles.confirmDisabled,
                    pressed && styles.pressed,
                  ]}
                  testID="holiday-greeting-confirm"
                >
                  <Text style={styles.confirmText}>
                    {isCreating ? 'Making your card…' : errorCode === 'network' ? 'Try again' : 'Make my card'}
                  </Text>
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                disabled={isCreating}
                onPress={onClose}
                style={styles.cancel}
                testID="holiday-greeting-cancel"
              >
                <Text style={styles.cancelText}>{isRetryable ? 'Not now' : 'Close'}</Text>
              </Pressable>
            </>
          )}
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
  title: { color: colors.ink, fontFamily: fonts.display, fontSize: 21, marginBottom: 6 },
  body: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 13, lineHeight: 19, marginBottom: spacing.md },
  list: { gap: 10 },
  row: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: 'transparent',
    borderRadius: radius.lg,
    borderWidth: 1.5,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: 16,
  },
  rowSelected: { backgroundColor: colors.primaryTint, borderColor: colors.primary },
  rowText: { color: colors.ink, fontFamily: fonts.displayMedium, fontSize: 18 },
  radio: {
    alignItems: 'center',
    borderColor: colors.borderStrong,
    borderRadius: 10,
    borderWidth: 1.5,
    height: 20,
    justifyContent: 'center',
    width: 20,
  },
  radioSelected: { borderColor: colors.primary },
  radioDot: { backgroundColor: colors.primary, borderRadius: 5, height: 10, width: 10 },
  error: { color: colors.error, fontFamily: fonts.sansMedium, fontSize: 13, lineHeight: 18, marginTop: spacing.md },
  regionBlock: { paddingBottom: spacing.sm },
  confirmButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    justifyContent: 'center',
    marginTop: spacing.md,
    minHeight: 50,
  },
  confirmDisabled: { opacity: 0.45 },
  confirmText: { color: colors.white, fontFamily: fonts.sansBold, fontSize: 15 },
  pressed: { opacity: 0.85 },
  cancel: { alignItems: 'center', justifyContent: 'center', minHeight: 44, marginTop: 4 },
  cancelText: { color: colors.ink3, fontFamily: fonts.sansBold, fontSize: 14 },
});
