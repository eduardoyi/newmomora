import { fireEvent, render } from '@testing-library/react-native';

import { ClipChip } from './clip-chip';
import { hasFloorTrace, SILENT_WAVEFORM } from './trace-test-utils';

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
  it('draws the real waveform when supplied and the seeded trace otherwise', () => {
    const chip = (waveform?: number[] | null) => (
      <ClipChip
        durationSeconds={10}
        emotion={null}
        onToggle={jest.fn()}
        playing={false}
        progress={0}
        seed={7}
        waveform={waveform}
      />
    );
    expect(hasFloorTrace(render(chip(null)).toJSON())).toBe(false);
    expect(hasFloorTrace(render(chip(SILENT_WAVEFORM)).toJSON())).toBe(true);
  });

  describe('trim control', () => {
    const base = {
      durationSeconds: 10,
      emotion: null,
      onToggle: jest.fn(),
      playing: false,
      progress: 0,
      seed: 7,
      testID: 'clip-chip',
    };

    it('is hidden unless onTrim is provided', () => {
      const { queryByTestId } = render(<ClipChip {...base} onRemove={jest.fn()} />);
      expect(queryByTestId('clip-chip-trim')).toBeNull();
    });

    it('calls onTrim when pressed, alongside the remove control', () => {
      const onTrim = jest.fn();
      const { getByTestId, getByLabelText } = render(<ClipChip {...base} onRemove={jest.fn()} onTrim={onTrim} />);
      expect(getByLabelText('Trim this sound')).toBeTruthy();
      fireEvent.press(getByTestId('clip-chip-trim'));
      expect(onTrim).toHaveBeenCalledTimes(1);
      expect(getByTestId('clip-chip-remove')).toBeTruthy();
    });

    it('keeps the trim button on a busy (playback-loading) seal', () => {
      const { getByTestId, queryByTestId } = render(
        <ClipChip {...base} busy onRemove={jest.fn()} onTrim={jest.fn()} />,
      );
      expect(getByTestId('clip-chip-seal-busy')).toBeTruthy();
      expect(getByTestId('clip-chip-trim')).toBeTruthy();
      expect(queryByTestId('clip-chip-trim-busy')).toBeNull();
      expect(getByTestId('clip-chip-remove').props.accessibilityState?.disabled).toBeFalsy();
    });

    it('swaps the trim button for a spinner and disables remove while processing', () => {
      const onRemove = jest.fn();
      const { getByTestId, queryByTestId } = render(
        <ClipChip {...base} onRemove={onRemove} onTrim={jest.fn()} processing />,
      );
      expect(queryByTestId('clip-chip-trim')).toBeNull();
      expect(getByTestId('clip-chip-trim-busy')).toBeTruthy();
      expect(queryByTestId('clip-chip-seal-busy')).toBeNull();
      fireEvent.press(getByTestId('clip-chip-remove'));
      expect(onRemove).not.toHaveBeenCalled();
    });
  });
});
