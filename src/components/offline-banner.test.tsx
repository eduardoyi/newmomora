import { onlineManager } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { OfflineBanner } from '@/components/offline-banner';

function renderBanner() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <OfflineBanner />
    </SafeAreaProvider>,
  );
}

describe('OfflineBanner', () => {
  beforeEach(() => {
    onlineManager.setOnline(true);
    jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    onlineManager.setOnline(true);
  });

  it('renders nothing while online and never went offline', () => {
    renderBanner();
    expect(screen.queryByTestId('offline-banner')).toBeNull();
  });

  it('shows the offline message when connectivity drops', () => {
    renderBanner();

    act(() => {
      onlineManager.setOnline(false);
    });

    expect(screen.getByTestId('offline-banner')).toBeTruthy();
    expect(screen.getByText("You're offline — showing what's saved.")).toBeTruthy();
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(
      "You're offline — showing what's saved.",
    );
  });

  it('shows "Back online" briefly after reconnecting, then hides', () => {
    renderBanner();

    act(() => {
      onlineManager.setOnline(false);
    });
    act(() => {
      onlineManager.setOnline(true);
    });

    expect(screen.getByText('Back online')).toBeTruthy();
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('Back online.');

    act(() => {
      jest.advanceTimersByTime(2000);
    });

    expect(screen.queryByTestId('offline-banner')).toBeNull();
  });

  it('does not show "Back online" if it was never offline this mount', () => {
    renderBanner();

    act(() => {
      onlineManager.setOnline(true);
    });

    expect(screen.queryByTestId('offline-banner')).toBeNull();
  });

  it('cancels the pending hide timer if connectivity drops again mid-pulse', () => {
    renderBanner();

    act(() => {
      onlineManager.setOnline(false);
    });
    act(() => {
      onlineManager.setOnline(true);
    });
    expect(screen.getByText('Back online')).toBeTruthy();

    act(() => {
      onlineManager.setOnline(false);
    });
    expect(screen.getByText("You're offline — showing what's saved.")).toBeTruthy();

    // The stale "Back online" hide timer must not fire and hide the banner
    // out from under the (now genuinely offline) message.
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(screen.getByText("You're offline — showing what's saved.")).toBeTruthy();
  });
});
