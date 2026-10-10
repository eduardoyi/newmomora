import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import { act, fireEvent, render } from '@testing-library/react-native';
import { AppState, Modal, Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { trackEvent } from '@/services/analytics';
import { isArtworkScannerAvailable, scanArtwork } from '@/services/artwork-scanner';
import { deleteArtworkScanFile } from '@/utils/artwork-scan-custody';

import {
  ARTWORK_INTRO_DISMISS_TIMEOUT_MS,
  ARTWORK_INTRO_SEEN_STORAGE_KEY,
  ARTWORK_SCAN_RESULT_GRACE_MS,
  ArtworkScanButton,
  ArtworkScanNotice,
} from './artwork-scan-button';

jest.mock('expo-image-picker', () => ({
  getCameraPermissionsAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
}));

jest.mock('@/services/analytics', () => ({
  trackEvent: jest.fn(),
}));

jest.mock('@/services/artwork-scanner', () => ({
  isArtworkScannerAvailable: jest.fn(),
  scanArtwork: jest.fn(),
}));

jest.mock('@/utils/artwork-scan-custody', () => ({
  deleteArtworkScanFile: jest.fn().mockResolvedValue(undefined),
}));

const mockedImagePicker = ImagePicker as jest.Mocked<typeof ImagePicker>;
const mockedIsAvailable = isArtworkScannerAvailable as jest.Mock;
const mockedScan = scanArtwork as jest.Mock;
const mockedDeleteFile = deleteArtworkScanFile as jest.Mock;
const mockedTrackEvent = trackEvent as jest.Mock;

const originalPlatform = Platform.OS;

function setPlatform(os: 'ios' | 'android') {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: os });
}

function page(id: string) {
  return {
    id,
    uri: `file:///documents/artwork-scans/${id}.jpg`,
    contentType: 'image/jpeg',
    sizeBytes: 1024,
    aspectRatio: 1.3,
    source: 'scan' as const,
  };
}

function success(ids: string[], overrides: Record<string, unknown> = {}) {
  return {
    status: 'success' as const,
    attachments: ids.map(page),
    droppedCount: 0,
    rejectedCount: 0,
    validationError: null,
    ...overrides,
  };
}

function scanError(code: string) {
  return Object.assign(new Error(code), { code });
}

function renderButton(props: Partial<React.ComponentProps<typeof ArtworkScanButton>> = {}) {
  const handlers = {
    onScanned: jest.fn(),
    onError: jest.fn(),
    onNotice: jest.fn(),
  };
  const screen = render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      <ArtworkScanButton {...handlers} {...props} />
    </SafeAreaProvider>,
  );
  return { screen, ...handlers };
}

async function press(screen: ReturnType<typeof render>) {
  await act(async () => {
    fireEvent.press(screen.getByTestId('new-memory-scan-artwork'));
  });
}

// Every suite below except "first-time intro" runs as a returning user: the
// intro has already been seen on this device.
async function seedIntroSeen() {
  await AsyncStorage.clear();
  await AsyncStorage.setItem(ARTWORK_INTRO_SEEN_STORAGE_KEY, '1');
}

describe('ArtworkScanButton', () => {
  beforeEach(async () => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    jest.useFakeTimers();
    setPlatform('android');
    mockedIsAvailable.mockReturnValue(true);
    mockedScan.mockReset();
    await seedIntroSeen();
  });

  afterEach(() => {
    jest.useRealTimers();
    setPlatform(originalPlatform as 'ios' | 'android');
  });

  it('renders nothing when the native scanner is unavailable', () => {
    mockedIsAvailable.mockReturnValue(false);
    const { screen } = renderButton();

    expect(screen.queryByTestId('new-memory-scan-artwork')).toBeNull();
  });

  it('is a labelled 46pt toolbar button with the page cap as its hint', () => {
    const { screen } = renderButton({ remainingSlots: 7, testID: 'edit-memory-scan-artwork' });

    const button = screen.getByTestId('edit-memory-scan-artwork');
    expect(button.props.accessibilityLabel).toBe('Scan artwork');
    expect(button.props.accessibilityRole).toBe('button');
    expect(button.props.accessibilityHint).toBe('Scans up to 7 pieces of artwork');
  });

  it('does nothing while disabled', () => {
    const { screen } = renderButton({ disabled: true });

    fireEvent.press(screen.getByTestId('new-memory-scan-artwork'));

    expect(mockedScan).not.toHaveBeenCalled();
    expect(screen.getByTestId('new-memory-scan-artwork').props.accessibilityState).toEqual({ disabled: true });
  });

  it('android: scans without a permission check and hands the pages to onScanned', async () => {
    mockedScan.mockResolvedValueOnce(success(['a', 'b']));
    const { screen, onScanned, onNotice, onError } = renderButton({ remainingSlots: 8 });

    await press(screen);

    expect(mockedImagePicker.getCameraPermissionsAsync).not.toHaveBeenCalled();
    expect(mockedScan).toHaveBeenCalledWith({ remainingSlots: 8 });
    expect(onScanned).toHaveBeenCalledWith([page('a'), page('b')]);
    expect(onNotice).toHaveBeenLastCalledWith('');
    expect(onError).toHaveBeenLastCalledWith('');
    expect(mockedTrackEvent).toHaveBeenCalledWith('artwork_scan_result', { status: 'success', page_count: 2 });
  });

  it('ios: asks for camera permission first and stops with Settings copy when it can no longer ask', async () => {
    setPlatform('ios');
    mockedImagePicker.getCameraPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: false,
    } as ImagePicker.CameraPermissionResponse);
    const { screen, onError } = renderButton();

    await press(screen);

    expect(mockedImagePicker.requestCameraPermissionsAsync).not.toHaveBeenCalled();
    expect(mockedScan).not.toHaveBeenCalled();
    expect(onError).toHaveBeenLastCalledWith(
      'Camera permission is required to scan artwork. Enable it in Settings.',
    );
  });

  it('ios: a refused (but re-askable) request shows the short permission copy', async () => {
    setPlatform('ios');
    mockedImagePicker.getCameraPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: true,
    } as ImagePicker.CameraPermissionResponse);
    mockedImagePicker.requestCameraPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: true,
    } as ImagePicker.CameraPermissionResponse);
    const { screen, onError } = renderButton();

    await press(screen);

    expect(mockedScan).not.toHaveBeenCalled();
    expect(onError).toHaveBeenLastCalledWith('Camera permission is required to scan artwork.');
  });

  it('ios: states the page cap before the scanner opens, then clears it on success', async () => {
    setPlatform('ios');
    mockedImagePicker.getCameraPermissionsAsync.mockResolvedValue({
      granted: true,
      canAskAgain: true,
    } as ImagePicker.CameraPermissionResponse);
    const order: string[] = [];
    const onNotice = jest.fn((message: string) => order.push(`notice:${message}`));
    mockedScan.mockImplementationOnce(async () => {
      order.push('scan');
      return success(['a']);
    });
    const { screen } = renderButton({ onNotice, remainingSlots: 4 });

    await press(screen);

    expect(order).toEqual([
      'notice:Scan up to 4 pieces. Extra pages are left out.',
      'scan',
      'notice:',
    ]);
  });

  it('ios: waits for the system dialog to settle after a fresh permission grant', async () => {
    setPlatform('ios');
    mockedImagePicker.getCameraPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: true,
    } as ImagePicker.CameraPermissionResponse);
    mockedImagePicker.requestCameraPermissionsAsync.mockResolvedValue({
      granted: true,
      canAskAgain: true,
    } as ImagePicker.CameraPermissionResponse);
    mockedScan.mockResolvedValueOnce(success(['a']));
    const { screen } = renderButton();

    fireEvent.press(screen.getByTestId('new-memory-scan-artwork'));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(mockedScan).not.toHaveBeenCalled();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(300);
    });
    expect(mockedScan).toHaveBeenCalledTimes(1);
  });

  it('reports pages the scanner returned beyond the cap and pages that failed validation', async () => {
    mockedScan.mockResolvedValueOnce(
      success(['a'], { droppedCount: 2, rejectedCount: 1, validationError: 'File is too large.' }),
    );
    const { screen, onScanned, onNotice } = renderButton();

    await press(screen);

    expect(onScanned).toHaveBeenCalledWith([page('a')]);
    expect(onNotice).toHaveBeenLastCalledWith(
      "A memory holds up to 10 pieces, so 2 extra pages were left out. 1 page couldn't be added. File is too large.",
    );
  });

  it('shows the validation message as an error when every page was rejected', async () => {
    mockedScan.mockResolvedValueOnce(
      success([], { rejectedCount: 2, validationError: 'File is too large.' }),
    );
    const { screen, onScanned, onError } = renderButton();

    await press(screen);

    expect(onScanned).not.toHaveBeenCalled();
    expect(onError).toHaveBeenLastCalledWith('File is too large.');
  });

  it('cancel adds nothing and reports a cancel event', async () => {
    mockedScan.mockResolvedValueOnce({
      status: 'cancel',
      attachments: [],
      droppedCount: 0,
      rejectedCount: 0,
      validationError: null,
    });
    const { screen, onScanned } = renderButton();

    await press(screen);

    expect(onScanned).not.toHaveBeenCalled();
    expect(mockedTrackEvent).toHaveBeenCalledWith('artwork_scan_result', { status: 'cancel', page_count: 0 });
  });

  it.each([
    ['scanner_unavailable', /try again/i],
    ['scanner_busy', /already open/i],
    ['scanner_failed', /try again/i],
  ])('maps %s to inline copy and keeps the button retryable', async (code, copy) => {
    mockedScan.mockRejectedValueOnce(scanError(code));
    mockedScan.mockResolvedValueOnce(success(['a']));
    const { screen, onError, onScanned } = renderButton();

    await press(screen);

    expect(onError).toHaveBeenLastCalledWith(expect.stringMatching(copy));
    expect(mockedTrackEvent).toHaveBeenCalledWith('artwork_scan_result', { status: 'error', page_count: 0 });

    // Not cached as permanent: a second tap scans again.
    await press(screen);
    expect(mockedScan).toHaveBeenCalledTimes(2);
    expect(onScanned).toHaveBeenCalledTimes(1);
  });

  it('refuses a second tap while a scan is in flight', async () => {
    let resolveScan: ((value: ReturnType<typeof success>) => void) | undefined;
    mockedScan.mockImplementationOnce(() => new Promise((resolve) => { resolveScan = resolve; }));
    const { screen } = renderButton();

    await press(screen);
    await press(screen);
    expect(mockedScan).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveScan?.(success(['a']));
    });
    mockedScan.mockResolvedValueOnce(success(['b']));
    await press(screen);
    expect(mockedScan).toHaveBeenCalledTimes(2);
  });

  it('releases the guard when the app returns to active and no result arrives within the grace period', async () => {
    let appStateListener: ((state: string) => void) | undefined;
    const remove = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_event: string, listener: (state: string) => void) => {
      appStateListener = listener;
      return { remove };
    }) as never);
    mockedScan.mockImplementationOnce(() => new Promise(() => undefined)); // lost activity result
    const { screen } = renderButton();

    await press(screen);
    await press(screen);
    expect(mockedScan).toHaveBeenCalledTimes(1);

    act(() => {
      appStateListener?.('active');
    });
    // Still inside the grace period: the result may yet arrive.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ARTWORK_SCAN_RESULT_GRACE_MS - 100);
    });
    await press(screen);
    expect(mockedScan).toHaveBeenCalledTimes(1);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(200);
    });
    mockedScan.mockResolvedValueOnce(success(['a']));
    await press(screen);
    expect(mockedScan).toHaveBeenCalledTimes(2);
  });

  it('unsubscribes from AppState on unmount', () => {
    const remove = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove } as never);
    const { screen } = renderButton();

    screen.unmount();

    expect(remove).toHaveBeenCalled();
  });

  it('deletes the pages instead of delivering them when unmounted mid-scan', async () => {
    let resolveScan: ((value: ReturnType<typeof success>) => void) | undefined;
    mockedScan.mockImplementationOnce(() => new Promise((resolve) => { resolveScan = resolve; }));
    const { screen, onScanned } = renderButton();

    await press(screen);
    screen.unmount();
    await act(async () => {
      resolveScan?.(success(['a', 'b']));
    });

    expect(onScanned).not.toHaveBeenCalled();
    expect(mockedDeleteFile).toHaveBeenCalledWith('file:///documents/artwork-scans/a.jpg');
    expect(mockedDeleteFile).toHaveBeenCalledWith('file:///documents/artwork-scans/b.jpg');
  });

  it('with no slots left it says so and never opens the scanner', async () => {
    const { screen, onError } = renderButton({ remainingSlots: 0 });

    await press(screen);

    expect(mockedScan).not.toHaveBeenCalled();
    expect(onError).toHaveBeenLastCalledWith('A memory holds up to 10 pieces of artwork.');
  });
});

describe('ArtworkScanButton first-time intro', () => {
  const grantedCamera = {
    granted: true,
    canAskAgain: true,
  } as ImagePicker.CameraPermissionResponse;

  beforeEach(async () => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    jest.useFakeTimers();
    setPlatform('android');
    mockedIsAvailable.mockReturnValue(true);
    mockedScan.mockReset();
    mockedImagePicker.getCameraPermissionsAsync.mockResolvedValue(grantedCamera);
    await AsyncStorage.clear();
  });

  afterEach(() => {
    jest.useRealTimers();
    setPlatform(originalPlatform as 'ios' | 'android');
  });

  const INTRO = 'new-memory-scan-artwork-intro';

  it('the first tap shows the intro, marks it seen, and neither scans nor reports a scan result', async () => {
    const { screen, onError } = renderButton();

    await press(screen);

    expect(screen.getByText('Let’s hang it on the wall')).toBeTruthy();
    expect(screen.getByText('NEW · ARTWORK')).toBeTruthy();
    expect(mockedScan).not.toHaveBeenCalled();
    expect(mockedImagePicker.getCameraPermissionsAsync).not.toHaveBeenCalled();
    expect(mockedTrackEvent).not.toHaveBeenCalled();
    expect(onError).toHaveBeenLastCalledWith('');
    expect(await AsyncStorage.getItem(ARTWORK_INTRO_SEEN_STORAGE_KEY)).not.toBeNull();
  });

  it('does not show the intro when there is no room for a scan anyway', async () => {
    const { screen, onError } = renderButton({ remainingSlots: 0 });

    await press(screen);

    expect(screen.queryByText('Let’s hang it on the wall')).toBeNull();
    expect(onError).toHaveBeenLastCalledWith('A memory holds up to 10 pieces of artwork.');
    expect(await AsyncStorage.getItem(ARTWORK_INTRO_SEEN_STORAGE_KEY)).toBeNull();
  });

  it('android: Start scanning closes the sheet and then scans', async () => {
    mockedScan.mockResolvedValueOnce(success(['a']));
    const { screen, onScanned } = renderButton({ remainingSlots: 6 });
    await press(screen);

    await act(async () => {
      fireEvent.press(screen.getByTestId(`${INTRO}-start`));
    });

    expect(screen.queryByText('Let’s hang it on the wall')).toBeNull();
    expect(mockedScan).toHaveBeenCalledWith({ remainingSlots: 6 });
    expect(onScanned).toHaveBeenCalledWith([page('a')]);
    expect(mockedTrackEvent).toHaveBeenCalledTimes(1);
    expect(mockedTrackEvent).toHaveBeenCalledWith('artwork_scan_result', { status: 'success', page_count: 1 });
  });

  it('ios: the scanner (and its permission check) waits for the sheet to fully dismiss', async () => {
    setPlatform('ios');
    mockedImagePicker.getCameraPermissionsAsync.mockResolvedValue(grantedCamera);
    mockedScan.mockResolvedValueOnce(success(['a']));
    const { screen, onNotice } = renderButton({ remainingSlots: 3 });
    await press(screen);

    await act(async () => {
      fireEvent.press(screen.getByTestId(`${INTRO}-start`));
    });
    // Sheet told to close, but the Modal hasn't reported dismissal yet.
    expect(mockedScan).not.toHaveBeenCalled();
    expect(mockedImagePicker.getCameraPermissionsAsync).not.toHaveBeenCalled();

    await act(async () => {
      screen.UNSAFE_getByType(Modal).props.onDismiss();
    });

    expect(mockedScan).toHaveBeenCalledWith({ remainingSlots: 3 });
    expect(onNotice).toHaveBeenCalledWith('Scan up to 3 pieces. Extra pages are left out.');
  });

  it('ios: scans anyway if the Modal never reports its dismissal', async () => {
    setPlatform('ios');
    mockedImagePicker.getCameraPermissionsAsync.mockResolvedValue(grantedCamera);
    mockedScan.mockResolvedValueOnce(success(['a']));
    const { screen } = renderButton();
    await press(screen);

    await act(async () => {
      fireEvent.press(screen.getByTestId(`${INTRO}-start`));
    });
    expect(mockedScan).not.toHaveBeenCalled();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(ARTWORK_INTRO_DISMISS_TIMEOUT_MS + 10);
    });
    expect(mockedScan).toHaveBeenCalledTimes(1);

    // A late real callback must not start a second scan.
    await act(async () => {
      screen.UNSAFE_getByType(Modal).props.onDismiss();
    });
    expect(mockedScan).toHaveBeenCalledTimes(1);
  });

  it('dismissing the sheet any other way never scans, and the next tap scans directly', async () => {
    mockedScan.mockResolvedValueOnce(success(['a']));
    const { screen, onScanned } = renderButton();
    await press(screen);

    await act(async () => {
      // Hardware back / swipe-back closes through the Modal's onRequestClose.
      screen.UNSAFE_getByType(Modal).props.onRequestClose();
    });

    expect(screen.queryByText('Let’s hang it on the wall')).toBeNull();
    expect(mockedScan).not.toHaveBeenCalled();
    expect(mockedTrackEvent).not.toHaveBeenCalled();

    await press(screen);
    expect(screen.queryByText('Let’s hang it on the wall')).toBeNull();
    expect(mockedScan).toHaveBeenCalledTimes(1);
    expect(onScanned).toHaveBeenCalledWith([page('a')]);
  });

  it('the backdrop also dismisses without scanning', async () => {
    const { screen } = renderButton();
    await press(screen);

    await act(async () => {
      fireEvent.press(screen.getByTestId(`${INTRO}-backdrop`, { includeHiddenElements: true }));
    });

    expect(mockedScan).not.toHaveBeenCalled();
    expect(screen.queryByText('Let’s hang it on the wall')).toBeNull();
  });

  it('a second tap while the intro is up does nothing extra', async () => {
    const { screen } = renderButton();

    await press(screen);
    await press(screen);

    expect(screen.getAllByText('Let’s hang it on the wall')).toHaveLength(1);
    expect(mockedScan).not.toHaveBeenCalled();
  });

  it('a returning user scans directly with no sheet', async () => {
    await AsyncStorage.setItem(ARTWORK_INTRO_SEEN_STORAGE_KEY, '1');
    mockedScan.mockResolvedValueOnce(success(['a']));
    const { screen } = renderButton();

    await press(screen);

    expect(screen.queryByText('Let’s hang it on the wall')).toBeNull();
    expect(mockedScan).toHaveBeenCalledTimes(1);
  });

  it('a storage read error goes straight to the scan', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('storage down'));
    mockedScan.mockResolvedValueOnce(success(['a']));
    const { screen, onScanned } = renderButton();

    await press(screen);

    expect(screen.queryByText('Let’s hang it on the wall')).toBeNull();
    expect(mockedScan).toHaveBeenCalledTimes(1);
    expect(onScanned).toHaveBeenCalledWith([page('a')]);
  });

  it('a storage write error still shows the intro', async () => {
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('storage down'));
    const { screen } = renderButton();

    await press(screen);

    expect(screen.getByText('Let’s hang it on the wall')).toBeTruthy();
    expect(mockedScan).not.toHaveBeenCalled();
  });

  it('releases the guard when it unmounts with the sheet open', async () => {
    const { screen } = renderButton();
    await press(screen);

    screen.unmount();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ARTWORK_INTRO_DISMISS_TIMEOUT_MS + 10);
    });

    expect(mockedScan).not.toHaveBeenCalled();
  });
});

describe('ArtworkScanNotice', () => {
  it('renders the message and nothing for an empty one', () => {
    const shown = render(<ArtworkScanNotice message="Two pages were left out." testID="notice" />);
    expect(shown.getByTestId('notice')).toBeTruthy();

    const hidden = render(<ArtworkScanNotice message="" testID="notice-empty" />);
    expect(hidden.queryByTestId('notice-empty')).toBeNull();
  });
});
