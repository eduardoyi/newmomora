import { fireEvent, render } from '@testing-library/react-native';

import { TimelineActivityBell } from './timeline-activity-bell';

describe('TimelineActivityBell', () => {
  it('shows no dot and the plain a11y label when there is nothing new', () => {
    const { queryByTestId, getByTestId } = render(
      <TimelineActivityBell onPress={jest.fn()} unread={false} />,
    );

    expect(queryByTestId('timeline-activity-bell-dot')).toBeNull();
    expect(getByTestId('timeline-activity-bell').props.accessibilityLabel).toBe('Family activity');
  });

  it('shows the dot and the "new" a11y label when unread', () => {
    const { getByTestId } = render(<TimelineActivityBell onPress={jest.fn()} unread />);

    expect(getByTestId('timeline-activity-bell-dot')).toBeTruthy();
    expect(getByTestId('timeline-activity-bell').props.accessibilityLabel).toBe('Family activity, new');
  });

  it('calls onPress when tapped', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(<TimelineActivityBell onPress={onPress} unread={false} />);

    fireEvent.press(getByTestId('timeline-activity-bell'));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('exposes the button accessibility role', () => {
    const { getByTestId } = render(<TimelineActivityBell onPress={jest.fn()} unread={false} />);

    expect(getByTestId('timeline-activity-bell').props.accessibilityRole).toBe('button');
  });
});
