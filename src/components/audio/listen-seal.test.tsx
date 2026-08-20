import { fireEvent, render } from '@testing-library/react-native';

import { ListenSeal } from './listen-seal';

describe('ListenSeal', () => {
  it('shows the play glyph when idle and the two-bar glyph while playing', () => {
    const idle = render(<ListenSeal emotion={null} onPress={jest.fn()} playing={false} testID="seal" />);
    expect(idle.getByTestId('seal-play-glyph')).toBeTruthy();
    expect(idle.queryByTestId('seal-bars')).toBeNull();

    const playing = render(<ListenSeal emotion={null} onPress={jest.fn()} playing testID="seal" />);
    expect(playing.getByTestId('seal-bars')).toBeTruthy();
    expect(playing.queryByTestId('seal-play-glyph')).toBeNull();
  });

  it('shows a busy spinner instead of a play/pause glyph when busy', () => {
    const { getByTestId, queryByTestId } = render(
      <ListenSeal busy emotion={null} onPress={jest.fn()} playing={false} testID="seal" />,
    );
    expect(getByTestId('seal-busy')).toBeTruthy();
    expect(queryByTestId('seal-play-glyph')).toBeNull();
  });

  it('only shows the breathing halo while playing', () => {
    const idle = render(<ListenSeal emotion={null} onPress={jest.fn()} playing={false} testID="seal" />);
    expect(idle.queryByTestId('seal-halo')).toBeNull();

    const playing = render(<ListenSeal emotion={null} onPress={jest.fn()} playing testID="seal" />);
    expect(playing.getByTestId('seal-halo')).toBeTruthy();
  });

  it('calls onPress when tapped, and never when disabled', () => {
    const onPress = jest.fn();
    const { getByTestId, rerender } = render(
      <ListenSeal emotion={null} onPress={onPress} playing={false} testID="seal" />,
    );
    fireEvent.press(getByTestId('seal'));
    expect(onPress).toHaveBeenCalledTimes(1);

    rerender(<ListenSeal disabled emotion={null} onPress={onPress} playing={false} testID="seal" />);
    fireEvent.press(getByTestId('seal'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('uses a distinct accessibility label for play vs pause', () => {
    const idle = render(<ListenSeal emotion={null} onPress={jest.fn()} playing={false} testID="seal" />);
    expect(idle.getByTestId('seal').props.accessibilityLabel).toBe('Listen');

    const playing = render(<ListenSeal emotion={null} onPress={jest.fn()} playing testID="seal" />);
    expect(playing.getByTestId('seal').props.accessibilityLabel).toBe('Pause');
  });
});
