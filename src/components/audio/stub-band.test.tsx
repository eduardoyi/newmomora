import { fireEvent, render } from '@testing-library/react-native';

import { StubBand } from './stub-band';

describe('StubBand', () => {
  it('shows only the total duration when idle', () => {
    const { getByText, queryByText } = render(
      <StubBand
        durationSeconds={42}
        emotion={null}
        onToggle={jest.fn()}
        playing={false}
        positionSeconds={0}
        progress={0}
        seed={7}
      />,
    );

    expect(getByText('0:42')).toBeTruthy();
    expect(queryByText('/')).toBeNull();
  });

  it('shows elapsed / total while playing', () => {
    const { getByText } = render(
      <StubBand
        durationSeconds={42}
        emotion="joy"
        onToggle={jest.fn()}
        playing
        positionSeconds={17}
        progress={17 / 42}
        seed={7}
      />,
    );

    expect(getByText('0:17')).toBeTruthy();
    expect(getByText('/')).toBeTruthy();
    expect(getByText('0:42')).toBeTruthy();
  });

  it('calls onToggle when the seal is pressed, without navigating', () => {
    const onToggle = jest.fn();
    const onPress = jest.fn();
    const { getByTestId } = render(
      <StubBand
        durationSeconds={10}
        emotion={null}
        onPress={onPress}
        onToggle={onToggle}
        playing={false}
        positionSeconds={0}
        progress={0}
        seed={7}
        testID="stub-band"
      />,
    );

    fireEvent.press(getByTestId('stub-band-seal'));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('opens the memory on tapping the band outside the seal/trace', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <StubBand
        durationSeconds={10}
        emotion={null}
        onPress={onPress}
        onToggle={jest.fn()}
        playing={false}
        positionSeconds={0}
        progress={0}
        seed={7}
        testID="stub-band"
      />,
    );

    fireEvent.press(getByTestId('stub-band'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('seeks to the tapped fraction when the trace is pressed and onSeek is provided', () => {
    const onSeek = jest.fn();
    const { getByTestId } = render(
      <StubBand
        durationSeconds={10}
        emotion={null}
        onSeek={onSeek}
        onToggle={jest.fn()}
        playing={false}
        positionSeconds={0}
        progress={0}
        seed={7}
        testID="stub-band"
      />,
    );

    const trace = getByTestId('stub-band-trace');
    fireEvent(trace, 'layout', { nativeEvent: { layout: { width: 200 } } });
    fireEvent.press(trace, { nativeEvent: { locationX: 50 } });

    expect(onSeek).toHaveBeenCalledWith(0.25);
  });

  it('does not intercept taps on the trace when onSeek is omitted', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <StubBand
        durationSeconds={10}
        emotion={null}
        onPress={onPress}
        onToggle={jest.fn()}
        playing={false}
        positionSeconds={0}
        progress={0}
        seed={7}
        testID="stub-band"
      />,
    );

    fireEvent.press(getByTestId('stub-band-trace'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('tapping the band does nothing when onPress is omitted -- the seal still plays', () => {
    const onToggle = jest.fn();
    const { getByTestId } = render(
      <StubBand
        durationSeconds={10}
        emotion={null}
        onToggle={onToggle}
        playing={false}
        positionSeconds={0}
        progress={0}
        seed={7}
        testID="stub-band"
      />,
    );

    fireEvent.press(getByTestId('stub-band'));
    fireEvent.press(getByTestId('stub-band-seal'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
