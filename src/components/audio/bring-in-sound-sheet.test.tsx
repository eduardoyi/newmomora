import { fireEvent, render } from '@testing-library/react-native';
import { Modal, Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { BringInSoundSheet, type BringInSoundSheetProps } from './bring-in-sound-sheet';

const safeAreaMetrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function renderSheet(props: Partial<BringInSoundSheetProps> = {}) {
  const merged: BringInSoundSheetProps = {
    visible: true,
    onChooseFile: jest.fn(),
    onClose: jest.fn(),
    ...props,
  };
  const screen = render(
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <BringInSoundSheet {...merged} />
    </SafeAreaProvider>,
  );
  const rerender = (next: Partial<BringInSoundSheetProps>) => screen.rerender(
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <BringInSoundSheet {...merged} {...next} />
    </SafeAreaProvider>,
  );
  return { ...screen, props: merged, rerender };
}

describe('BringInSoundSheet', () => {
  const originalPlatform = Platform.OS;

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
  });

  it('renders the title, primary action and both guides', () => {
    const screen = renderSheet();

    expect(screen.getByText('Bring in a sound')).toBeTruthy();
    expect(screen.getByText('Choose from Files')).toBeTruthy();
    expect(screen.getByText('From WhatsApp')).toBeTruthy();
    expect(screen.getByText(
      'Press and hold the voice note → Forward → tap the share button (bottom right) → Momora',
    )).toBeTruthy();
    expect(screen.getByText('From Voice Memos')).toBeTruthy();
    expect(screen.getByText('Tap ⋯ on the recording → Share → Momora')).toBeTruthy();
  });

  it('renders nothing while not visible', () => {
    const screen = renderSheet({ visible: false });

    expect(screen.queryByText('Bring in a sound')).toBeNull();
  });

  it('calls onChooseFile from the primary button', () => {
    const screen = renderSheet();

    fireEvent.press(screen.getByTestId('bring-in-sound-sheet-choose'));

    expect(screen.props.onChooseFile).toHaveBeenCalledTimes(1);
    expect(screen.props.onClose).not.toHaveBeenCalled();
  });

  it('uses a custom testID prefix', () => {
    const screen = renderSheet({ testID: 'composer-sound' });

    expect(screen.getByTestId('composer-sound-choose')).toBeTruthy();
  });

  it('calls onClose from the close button and the backdrop', () => {
    const screen = renderSheet();

    fireEvent.press(screen.getByTestId('bring-in-sound-sheet-close'));
    fireEvent.press(screen.getByTestId('bring-in-sound-sheet-backdrop', { includeHiddenElements: true }));

    expect(screen.props.onClose).toHaveBeenCalledTimes(2);
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

    const modal = screen.UNSAFE_getByType(Modal);
    modal.props.onDismiss();
    expect(onDismissed).toHaveBeenCalledTimes(1);
  });
});
