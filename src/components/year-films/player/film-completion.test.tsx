import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { FilmCompletion } from '@/components/year-films/player/film-completion';

jest.mock('lucide-react-native', () => ({ RotateCcw: () => null, Share2: () => null }));

const safeAreaMetrics = {
  frame: { height: 844, width: 390, x: 0, y: 0 },
  insets: { bottom: 34, left: 0, right: 0, top: 47 },
};

function renderCompletion(props: Partial<React.ComponentProps<typeof FilmCompletion>> = {}) {
  return render(
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <FilmCompletion
        onReplay={jest.fn()}
        share={{ status: 'idle', progress: 0, onShare: jest.fn(), onCancel: jest.fn() }}
        title="September recap"
        {...props}
      />
    </SafeAreaProvider>,
  );
}

describe('FilmCompletion', () => {
  it('hides the rate link when no onRate is given', () => {
    expect(renderCompletion().queryByTestId('year-film-rate')).toBeNull();
  });

  it('renders the rate link and calls onRate when pressed', () => {
    const onRate = jest.fn();
    const screen = renderCompletion({ onRate });

    expect(screen.getByText('Rate Momora')).toBeTruthy();
    fireEvent.press(screen.getByTestId('year-film-rate'));

    expect(onRate).toHaveBeenCalledTimes(1);
  });

  it('hides the rate link while a share is in progress', () => {
    const screen = renderCompletion({
      onRate: jest.fn(),
      share: { status: 'downloading', progress: 0.4, onShare: jest.fn(), onCancel: jest.fn() },
    });

    expect(screen.queryByTestId('year-film-rate')).toBeNull();
  });
});
