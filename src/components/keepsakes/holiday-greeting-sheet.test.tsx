import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import {
  HOLIDAY_CREATE_ERROR_MESSAGES,
  HOLIDAY_EXISTING_NOTE,
  HOLIDAY_GREETING_NOTE,
  HOLIDAY_PREPARING_NOTE,
  HOLIDAY_PREPARING_TITLE,
  HolidayGreetingSheet,
} from '@/components/keepsakes/holiday-greeting-sheet';
import type { CreateHolidayCardOutcome } from '@/hooks/useHolidayCard';
import type { CreateHolidayCardErrorCode } from '@/services/holiday-cards';

jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context');
  return { ...actual, useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) };
});

const onCreate = jest.fn<Promise<CreateHolidayCardOutcome>, [string]>();
const onOpenCard = jest.fn();
const onClose = jest.fn();

function renderSheet(language: 'es' | 'en' = 'en') {
  return render(
    <HolidayGreetingSheet
      language={language}
      onClose={onClose}
      onCreate={onCreate as never}
      onOpenCard={onOpenCard}
      visible
    />,
  );
}

const success = (regionWarning = false, created = true): CreateHolidayCardOutcome => ({
  ok: true,
  result: { cardId: 'card-1', created, regionWarning },
});
const failure = (code: CreateHolidayCardErrorCode): CreateHolidayCardOutcome => ({
  ok: false,
  error: { code, message: 'server text' },
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('HolidayGreetingSheet', () => {
  it('shows the English greetings and the cannot-change note, with Confirm disabled until a choice', () => {
    const { getByText, getByTestId } = renderSheet('en');
    expect(getByText('Merry Christmas')).toBeTruthy();
    expect(getByText('Happy Holidays')).toBeTruthy();
    expect(getByText('Happy New Year')).toBeTruthy();
    expect(getByText(HOLIDAY_GREETING_NOTE)).toBeTruthy();
    expect(getByTestId('holiday-greeting-confirm').props.accessibilityState).toMatchObject({ disabled: true });

    fireEvent.press(getByTestId('holiday-greeting-confirm'));
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('shows the Spanish greetings for a Spanish card', () => {
    const { getByText } = renderSheet('es');
    expect(getByText('Feliz Navidad')).toBeTruthy();
    expect(getByText('Felices fiestas')).toBeTruthy();
    expect(getByText('Feliz Año Nuevo')).toBeTruthy();
  });

  it('has no text input', () => {
    const { UNSAFE_queryAllByType } = renderSheet();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { TextInput } = require('react-native');
    expect(UNSAFE_queryAllByType(TextInput)).toHaveLength(0);
  });

  it('creates with the chosen greeting, says it takes ~20 minutes, and stays in the app on OK', async () => {
    onCreate.mockResolvedValue(success());
    const { getByTestId, getByText } = renderSheet();
    fireEvent.press(getByTestId('holiday-greeting-new-year'));
    fireEvent.press(getByTestId('holiday-greeting-confirm'));

    await waitFor(() => expect(getByTestId('holiday-greeting-preparing')).toBeTruthy());
    expect(onCreate).toHaveBeenCalledWith('new-year');
    expect(getByText(HOLIDAY_PREPARING_TITLE)).toBeTruthy();
    expect(getByText('This takes about 20 minutes. We’ll send you a notification when it’s ready.')).toBeTruthy();
    expect(onOpenCard).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    expect(getByText('OK')).toBeTruthy();
    fireEvent.press(getByTestId('holiday-greeting-continue'));
    expect(onOpenCard).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('guards a double tap and disables Confirm while creating', async () => {
    let resolve!: (value: CreateHolidayCardOutcome) => void;
    onCreate.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { getByTestId, getByText } = renderSheet();
    fireEvent.press(getByTestId('holiday-greeting-holidays'));
    fireEvent.press(getByTestId('holiday-greeting-confirm'));
    fireEvent.press(getByTestId('holiday-greeting-confirm'));

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(getByText('Making your card…')).toBeTruthy();
    expect(getByTestId('holiday-greeting-confirm').props.accessibilityState).toMatchObject({ disabled: true });

    await act(async () => resolve(success()));
    await waitFor(() => expect(getByTestId('holiday-greeting-preparing')).toBeTruthy());
    fireEvent.press(getByTestId('holiday-greeting-continue'));
    expect(onOpenCard).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('on regionWarning shows the US/Canada note and stays in the app on OK', async () => {
    onCreate.mockResolvedValue(success(true));
    const { getByTestId, getByText } = renderSheet();
    fireEvent.press(getByTestId('holiday-greeting-christmas'));
    fireEvent.press(getByTestId('holiday-greeting-confirm'));

    await waitFor(() => expect(getByTestId('holiday-greeting-region')).toBeTruthy());
    expect(getByText('Cards ship to the US and Canada')).toBeTruthy();
    expect(getByText(new RegExp(HOLIDAY_PREPARING_NOTE))).toBeTruthy();
    expect(onOpenCard).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.press(getByTestId('holiday-greeting-continue'));
    expect(onOpenCard).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says so before opening when the card already existed (created:false)', async () => {
    onCreate.mockResolvedValue(success(false, false));
    const { getByTestId, getByText } = renderSheet();
    fireEvent.press(getByTestId('holiday-greeting-christmas'));
    fireEvent.press(getByTestId('holiday-greeting-confirm'));

    await waitFor(() => expect(getByTestId('holiday-greeting-existing')).toBeTruthy());
    expect(getByText(HOLIDAY_EXISTING_NOTE)).toBeTruthy();
    expect(onOpenCard).not.toHaveBeenCalled();

    fireEvent.press(getByTestId('holiday-greeting-continue'));
    expect(onOpenCard).toHaveBeenCalledWith('card-1');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cannot be dismissed (backdrop, Android back) while creating', async () => {
    let resolve!: (value: CreateHolidayCardOutcome) => void;
    onCreate.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { getByTestId, UNSAFE_getByType } = renderSheet();
    fireEvent.press(getByTestId('holiday-greeting-christmas'));
    fireEvent.press(getByTestId('holiday-greeting-confirm'));

    fireEvent.press(getByTestId('holiday-greeting-backdrop', { includeHiddenElements: true }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    UNSAFE_getByType(require('react-native').Modal).props.onRequestClose();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => resolve(success()));
    await waitFor(() => expect(getByTestId('holiday-greeting-preparing')).toBeTruthy());
    fireEvent.press(getByTestId('holiday-greeting-continue'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not open the browser when the sheet was closed before the create resolved', async () => {
    let resolve!: (value: CreateHolidayCardOutcome) => void;
    onCreate.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { getByTestId, rerender } = renderSheet();
    fireEvent.press(getByTestId('holiday-greeting-christmas'));
    fireEvent.press(getByTestId('holiday-greeting-confirm'));

    rerender(
      <HolidayGreetingSheet language="en" onClose={onClose} onCreate={onCreate as never} onOpenCard={onOpenCard} visible={false} />,
    );
    await act(async () => resolve(success()));
    expect(onOpenCard).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each<[CreateHolidayCardErrorCode, string]>([
    ['disabled', "Holiday cards aren't available yet"],
    ['slot_used', "You've already made this year's card"],
    ['subscription_required', HOLIDAY_CREATE_ERROR_MESSAGES.subscription_required],
    ['forbidden', HOLIDAY_CREATE_ERROR_MESSAGES.forbidden],
    ['unknown', HOLIDAY_CREATE_ERROR_MESSAGES.unknown],
  ])('shows the %s error inline and does not open the shop', async (code, message) => {
    onCreate.mockResolvedValue(failure(code));
    const { getByTestId, getByText } = renderSheet();
    fireEvent.press(getByTestId('holiday-greeting-christmas'));
    fireEvent.press(getByTestId('holiday-greeting-confirm'));

    await waitFor(() => expect(getByTestId('holiday-greeting-error')).toBeTruthy());
    expect(getByText(message)).toBeTruthy();
    expect(onOpenCard).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('drops Confirm for errors that cannot be retried (disabled, slot used)', async () => {
    onCreate.mockResolvedValue(failure('slot_used'));
    const { getByTestId, queryByTestId, getByText } = renderSheet();
    fireEvent.press(getByTestId('holiday-greeting-christmas'));
    fireEvent.press(getByTestId('holiday-greeting-confirm'));

    await waitFor(() => expect(getByTestId('holiday-greeting-error')).toBeTruthy());
    expect(queryByTestId('holiday-greeting-confirm')).toBeNull();
    expect(getByText('Close')).toBeTruthy();
  });

  it('offers "Try again" after a network error and succeeds on retry', async () => {
    onCreate.mockResolvedValueOnce(failure('network')).mockResolvedValueOnce(success());
    const { getByTestId, getByText } = renderSheet();
    fireEvent.press(getByTestId('holiday-greeting-holidays'));
    fireEvent.press(getByTestId('holiday-greeting-confirm'));

    await waitFor(() => expect(getByText(HOLIDAY_CREATE_ERROR_MESSAGES.network)).toBeTruthy());
    expect(getByText('Try again')).toBeTruthy();

    fireEvent.press(getByTestId('holiday-greeting-confirm'));
    await waitFor(() => expect(getByTestId('holiday-greeting-preparing')).toBeTruthy());
    fireEvent.press(getByTestId('holiday-greeting-continue'));
    expect(onOpenCard).not.toHaveBeenCalled();
    expect(onCreate).toHaveBeenCalledTimes(2);
    expect(onCreate).toHaveBeenLastCalledWith('holidays');
  });

  it('Not now closes without creating', () => {
    const { getByTestId } = renderSheet();
    fireEvent.press(getByTestId('holiday-greeting-cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCreate).not.toHaveBeenCalled();
  });
});
