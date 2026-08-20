import { render } from '@testing-library/react-native';

import { SoundMark, SoundTile } from './sound-tile';

describe('SoundTile', () => {
  it('renders the duration label by default', () => {
    const { getByText } = render(<SoundTile durationSeconds={65} emotion={null} seed={7} />);
    expect(getByText('1:05')).toBeTruthy();
  });

  it('hides the duration label when showDuration is false', () => {
    const { queryByText } = render(
      <SoundTile durationSeconds={65} emotion={null} seed={7} showDuration={false} />,
    );
    expect(queryByText('1:05')).toBeNull();
  });

  it('renders for both neutral and analyzed emotion without crashing', () => {
    const { getByTestId: getNeutral } = render(
      <SoundTile durationSeconds={10} emotion={null} seed={7} testID="tile-neutral" />,
    );
    const { getByTestId: getJoy } = render(
      <SoundTile durationSeconds={10} emotion="joy" seed={7} testID="tile-joy" />,
    );
    expect(getNeutral('tile-neutral')).toBeTruthy();
    expect(getJoy('tile-joy')).toBeTruthy();
  });
});

describe('SoundMark', () => {
  it('renders without crashing for neutral and analyzed emotion', () => {
    const { getByTestId: getNeutral } = render(<SoundMark emotion={null} seed={7} testID="mark-neutral" />);
    const { getByTestId: getJoy } = render(<SoundMark emotion="joy" seed={7} testID="mark-joy" />);
    expect(getNeutral('mark-neutral')).toBeTruthy();
    expect(getJoy('mark-joy')).toBeTruthy();
  });
});
