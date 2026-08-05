import NetInfo from '@react-native-community/netinfo';
import { onlineManager } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';

import { startConnectivityMonitoring, useIsOnline } from '@/lib/connectivity';

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn() },
}));

const mockedAddEventListener = NetInfo.addEventListener as jest.MockedFunction<
  typeof NetInfo.addEventListener
>;

describe('connectivity', () => {
  afterEach(() => {
    jest.clearAllMocks();
    // Restore onlineManager to its default (online) state so tests don't
    // leak state into each other via the shared singleton.
    onlineManager.setOnline(true);
  });

  describe('startConnectivityMonitoring', () => {
    it('reflects NetInfo state into onlineManager', () => {
      let listener: ((state: unknown) => void) | undefined;
      mockedAddEventListener.mockImplementation((cb) => {
        listener = cb as (state: unknown) => void;
        return jest.fn();
      });

      startConnectivityMonitoring();
      expect(listener).toBeDefined();

      listener?.({ isConnected: false, isInternetReachable: false });
      expect(onlineManager.isOnline()).toBe(false);

      listener?.({ isConnected: true, isInternetReachable: true });
      expect(onlineManager.isOnline()).toBe(true);
    });

    it('treats a still-probing isInternetReachable (null) as online', () => {
      let listener: ((state: unknown) => void) | undefined;
      mockedAddEventListener.mockImplementation((cb) => {
        listener = cb as (state: unknown) => void;
        return jest.fn();
      });

      startConnectivityMonitoring();
      listener?.({ isConnected: true, isInternetReachable: null });

      expect(onlineManager.isOnline()).toBe(true);
    });

    it('treats a confirmed unreachable connection as offline', () => {
      let listener: ((state: unknown) => void) | undefined;
      mockedAddEventListener.mockImplementation((cb) => {
        listener = cb as (state: unknown) => void;
        return jest.fn();
      });

      startConnectivityMonitoring();
      listener?.({ isConnected: true, isInternetReachable: false });

      expect(onlineManager.isOnline()).toBe(false);
    });

    it('returns NetInfo unsubscribe as its own cleanup', () => {
      const unsubscribe = jest.fn();
      mockedAddEventListener.mockReturnValue(unsubscribe);

      const cleanup = startConnectivityMonitoring();
      cleanup();

      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
  });

  describe('useIsOnline', () => {
    it('reflects onlineManager and re-renders on change', () => {
      mockedAddEventListener.mockReturnValue(jest.fn());
      onlineManager.setOnline(true);

      const { result } = renderHook(() => useIsOnline());
      expect(result.current).toBe(true);

      act(() => {
        onlineManager.setOnline(false);
      });
      expect(result.current).toBe(false);
    });
  });
});
