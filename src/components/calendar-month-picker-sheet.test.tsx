import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { CalendarMonthPickerSheet } from './calendar-month-picker-sheet';
import type { CalendarMonthOption } from '@/utils/calendar';

function option(
  year: number,
  month: number,
  label: string,
  isCurrent = false,
): CalendarMonthOption {
  return {
    year,
    month,
    label,
    iso: `${year}-${String(month + 1).padStart(2, '0')}-01`,
    isCurrent,
  };
}

function renderSheet(props: Partial<React.ComponentProps<typeof CalendarMonthPickerSheet>> = {}) {
  const defaultOptions: CalendarMonthOption[] = [
    option(2026, 5, 'June', true),
    option(2026, 4, 'May'),
    option(2026, 3, 'April'),
    option(2025, 11, 'December'),
  ];

  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <CalendarMonthPickerSheet
        onClose={jest.fn()}
        onSelect={jest.fn()}
        options={defaultOptions}
        visible
        {...props}
      />
    </SafeAreaProvider>,
  );
}

describe('CalendarMonthPickerSheet', () => {
  it('groups months by year and renders every option', () => {
    const { getByText, getByTestId } = renderSheet();

    expect(getByText('2026')).toBeTruthy();
    expect(getByText('2025')).toBeTruthy();
    expect(getByTestId('month-picker-option-2026-06-01')).toBeTruthy();
    expect(getByTestId('month-picker-option-2026-05-01')).toBeTruthy();
    expect(getByTestId('month-picker-option-2026-04-01')).toBeTruthy();
    expect(getByTestId('month-picker-option-2025-12-01')).toBeTruthy();
  });

  it('calls onSelect with the tapped option', () => {
    const onSelect = jest.fn();
    const { getByTestId } = renderSheet({ onSelect });

    fireEvent.press(getByTestId('month-picker-option-2026-04-01'));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ year: 2026, month: 3, label: 'April' }),
    );
  });

  it('calls onClose from the backdrop and the Cancel row', () => {
    const onClose = jest.fn();
    const { getByLabelText, getByTestId } = renderSheet({ onClose });

    fireEvent.press(getByTestId('month-picker-cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.press(getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('renders nothing when not visible', () => {
    const { queryByTestId } = renderSheet({ visible: false });

    expect(queryByTestId('month-picker-sheet')).toBeNull();
  });

  it('renders a single-month sheet without a year grouping issue', () => {
    const { getByText, queryByTestId } = renderSheet({
      options: [option(2026, 5, 'June', true)],
    });

    expect(getByText('June')).toBeTruthy();
    expect(queryByTestId('month-picker-option-2026-05-01')).toBeNull();
  });
});
