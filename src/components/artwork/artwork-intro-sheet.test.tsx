import { fireEvent, render } from '@testing-library/react-native';
import { Modal, Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ArtworkIntroSheet, type ArtworkIntroSheetProps } from './artwork-intro-sheet';

const safeAreaMetrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function renderSheet(props: Partial<ArtworkIntroSheetProps> = {}) {
  const merged: ArtworkIntroSheetProps = {
    visible: true,
    onStart: jest.fn(),
    onClose: jest.fn(),
    ...props,
  };
  const screen = render(
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <ArtworkIntroSheet {...merged} />
    </SafeAreaProvider>,
  );
  const rerender = (next: Partial<ArtworkIntroSheetProps>) =>
    screen.rerender(
      <SafeAreaProvider initialMetrics={safeAreaMetrics}>
        <ArtworkIntroSheet {...merged} {...next} />
      </SafeAreaProvider>,
    );
  return { ...screen, props: merged, rerender };
}

describe('ArtworkIntroSheet', () => {
  const originalPlatform = Platform.OS;

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
  });

  it('renders the eyebrow, title, body, both tips and the primary action with the approved copy', () => {
    const screen = renderSheet();

    expect(screen.getByText('NEW · ARTWORK')).toBeTruthy();
    expect(screen.getByText('Let’s hang it on the wall')).toBeTruthy();
    expect(screen.getByText('Scan your kid’s drawings and they’ll show up framed on your Timeline.')).toBeTruthy();
    expect(screen.getByText('Lay it flat')).toBeTruthy();
    expect(screen.getByText('Smooth out folds so the edges come out straight.')).toBeTruthy();
    expect(screen.getByText('Use a darker surface')).toBeTruthy();
    expect(screen.getByText('A wooden table or the floor helps the scanner find the paper.')).toBeTruthy();
    expect(screen.getByText('Start scanning')).toBeTruthy();
  });

  it('shows the framed doodle on the plaster panel', () => {
    const screen = renderSheet();

    expect(screen.getByTestId('artwork-intro-sheet-illustration')).toBeTruthy();
    expect(screen.getByTestId('artwork-intro-sheet-frame')).toBeTruthy();
  });

  it('renders nothing while not visible', () => {
    const screen = renderSheet({ visible: false });

    expect(screen.queryByText('Let’s hang it on the wall')).toBeNull();
  });

  it('Start scanning calls onStart only', () => {
    const screen = renderSheet();

    fireEvent.press(screen.getByTestId('artwork-intro-sheet-start'));

    expect(screen.props.onStart).toHaveBeenCalledTimes(1);
    expect(screen.props.onClose).not.toHaveBeenCalled();
  });

  it('the backdrop calls onClose, not onStart', () => {
    const screen = renderSheet();

    fireEvent.press(screen.getByTestId('artwork-intro-sheet-backdrop', { includeHiddenElements: true }));

    expect(screen.props.onClose).toHaveBeenCalledTimes(1);
    expect(screen.props.onStart).not.toHaveBeenCalled();
  });

  it('on Android, reports the dismissal right after visible turns false', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    const onDismissed = jest.fn();
    const screen = renderSheet({ onDismissed });

    expect(onDismissed).not.toHaveBeenCalled();
    screen.rerender({ visible: false });

    expect(onDismissed).toHaveBeenCalledTimes(1);
  });

  it('on iOS, reports the dismissal from the Modal onDismiss, not from visible', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    const onDismissed = jest.fn();
    const screen = renderSheet({ onDismissed });

    screen.rerender({ visible: false });
    expect(onDismissed).not.toHaveBeenCalled();

    screen.UNSAFE_getByType(Modal).props.onDismiss();
    expect(onDismissed).toHaveBeenCalledTimes(1);
  });
});
