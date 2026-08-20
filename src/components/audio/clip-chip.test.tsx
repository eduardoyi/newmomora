import { fireEvent, render } from '@testing-library/react-native';

import { ClipChip } from './clip-chip';

describe('ClipChip', () => {
  it('shows only the total duration when idle', () => {
    const { getByText, queryByText } = render(
      <ClipChip
        durationSeconds={42}
        emotion={null}
        onToggle={jest.fn()}
        playing={false}
        progress={0}
        seed={7}
      />,
    );

    expect(getByText('0:42')).toBeTruthy();
    expect(queryByText('/')).toBeNull();
  });

  it('shows elapsed / total while playing', () => {
    const { getByText } = render(
      <ClipChip
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

  it('calls onToggle when the seal is pressed', () => {
    const onToggle = jest.fn();
    const { getByTestId } = render(
      <ClipChip
        durationSeconds={10}
        emotion={null}
        onToggle={onToggle}
        playing={false}
        progress={0}
        seed={7}
        testID="clip-chip"
      />,
    );

    fireEvent.press(getByTestId('clip-chip-seal'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('shows a remove control by default when onRemove is provided, and calls it', () => {
    const onRemove = jest.fn();
    const { getByTestId } = render(
      <ClipChip
        durationSeconds={10}
        emotion={null}
        onRemove={onRemove}
        onToggle={jest.fn()}
        playing={false}
        progress={0}
        seed={7}
        testID="clip-chip"
      />,
    );

    const removeButton = getByTestId('clip-chip-remove');
    fireEvent.press(removeButton);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('never shows the remove control in the recessed variant, even if onRemove is provided', () => {
    const { queryByTestId } = render(
      <ClipChip
        durationSeconds={10}
        emotion={null}
        onRemove={jest.fn()}
        onToggle={jest.fn()}
        playing={false}
        progress={0}
        recessed
        seed={7}
        testID="clip-chip"
      />,
    );

    expect(queryByTestId('clip-chip-remove')).toBeNull();
  });

  it('omits the remove control when no onRemove is given', () => {
    const { queryByTestId } = render(
      <ClipChip
        durationSeconds={10}
        emotion={null}
        onToggle={jest.fn()}
        playing={false}
        progress={0}
        seed={7}
        testID="clip-chip"
      />,
    );

    expect(queryByTestId('clip-chip-remove')).toBeNull();
  });

  it('renders the slim variant without crashing', () => {
    const { getByTestId } = render(
      <ClipChip
        durationSeconds={10}
        emotion={null}
        onToggle={jest.fn()}
        playing={false}
        progress={0}
        seed={7}
        slim
        testID="clip-chip"
      />,
    );

    expect(getByTestId('clip-chip')).toBeTruthy();
  });

  it('shows a busy state on the seal while transcoding/uploading', () => {
    const { getByTestId } = render(
      <ClipChip
        busy
        durationSeconds={10}
        emotion={null}
        onToggle={jest.fn()}
        playing={false}
        progress={0}
        seed={7}
        testID="clip-chip"
      />,
    );

    expect(getByTestId('clip-chip-seal-busy')).toBeTruthy();
  });
});
