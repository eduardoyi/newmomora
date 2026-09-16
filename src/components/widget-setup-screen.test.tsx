import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { WidgetSetupScreen } from './widget-setup-screen';

const mockSyncNow = jest.fn(async () => ({ published: true, cleared: false }));
let mockSupported = true;
let mockLoading = false;

jest.mock('expo-router', () => ({ router: { back: jest.fn() } }));
jest.mock('@/hooks/useMemoryWidgetSync', () => ({
  useMemoryWidgetSync: () => ({
    isSupported: mockSupported,
    isLoading: mockLoading,
    syncNow: mockSyncNow,
  }),
}));

beforeEach(() => {
  mockSupported = true;
  mockLoading = false;
  jest.clearAllMocks();
});

it('shows the settings-style instructions without an opt-in or privacy reminder', () => {
  const screen = render(<WidgetSetupScreen />);

  expect(screen.getByText('Home-screen widget')).toBeTruthy();
  expect(screen.getByText('Enjoy photos and illustrations from your family on your Home Screen.')).toBeTruthy();
  expect(screen.getByText('Add it on iPhone')).toBeTruthy();
  expect(screen.queryByTestId('widget-enable-toggle')).toBeNull();
  expect(screen.queryByTestId('widget-settings-done')).toBeNull();
  expect(screen.queryByText(/Anyone who can see your Home Screen/)).toBeNull();
});

it('keeps Show another memory full-width below the instructions', async () => {
  const screen = render(<WidgetSetupScreen />);
  const button = screen.getByTestId('widget-refresh-button');
  const style = StyleSheet.flatten(button.props.style);

  expect(style.width).toBe('100%');
  expect(screen.getByText('Show another memory')).toBeTruthy();
  fireEvent.press(button);
  await waitFor(() => expect(mockSyncNow).toHaveBeenCalledWith({ showAnother: true }));
});

it('explains unsupported builds and disables the refresh action', () => {
  mockSupported = false;
  const screen = render(<WidgetSetupScreen />);

  expect(screen.getByTestId('widget-unsupported-message')).toBeTruthy();
  expect(StyleSheet.flatten(screen.getByTestId('widget-refresh-button').props.style).opacity).toBe(0.55);
});

it('waits for the automatic sync lifecycle before enabling refresh', () => {
  mockLoading = true;
  const screen = render(<WidgetSetupScreen />);

  expect(StyleSheet.flatten(screen.getByTestId('widget-refresh-button').props.style).opacity).toBe(0.55);
});
