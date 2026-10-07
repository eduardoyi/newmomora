import { fireEvent, render } from '@testing-library/react-native';

import { NeedsYouBanner } from '@/components/keepsakes/needs-you-banner';

jest.mock('expo-symbols', () => ({ SymbolView: () => null }));

describe('NeedsYouBanner', () => {
  it('renders one ellipsized line and reports taps', () => {
    const onPress = jest.fn();
    const { getByTestId, getByText } = render(
      <NeedsYouBanner label="Your holiday card is ready to order" onPress={onPress} />,
    );
    const label = getByText('Your holiday card is ready to order');
    expect(label.props.numberOfLines).toBe(1);
    expect(label.props.ellipsizeMode).toBe('tail');
    fireEvent.press(getByTestId('keepsakes-needs-you'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
