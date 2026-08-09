import { render, screen, waitFor } from '@testing-library/react-native';
import { focusManager } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { AppState, Text } from 'react-native';

import { AppProviders } from '@/components/app-providers';
import { startConnectivityMonitoring } from '@/lib/connectivity';

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use ESM imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('@/hooks/use-auth', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/hooks/use-family', () => ({
  FamilyProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/hooks/use-billing', () => ({
  BillingProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/hooks/use-pending-memory-uploads', () => ({
  PendingMemoryUploadsProvider: ({ children }: { children: ReactNode }) => children,
}));

jest.mock('@/lib/connectivity', () => ({
  startConnectivityMonitoring: jest.fn(() => jest.fn()),
}));
jest.mock('@/services/looking-back', () => ({
  clearAllLookingBackPendingViews: jest.fn(async () => undefined),
}));

const mockedStartConnectivityMonitoring = startConnectivityMonitoring as jest.MockedFunction<
  typeof startConnectivityMonitoring
>;

describe('AppProviders', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedStartConnectivityMonitoring.mockImplementation(() => jest.fn());
  });

  it('syncs TanStack Query focus with the native app lifecycle', () => {
    let handleAppStateChange: ((status: 'active' | 'background') => void) | undefined;
    const remove = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
      handleAppStateChange = listener as (status: 'active' | 'background') => void;
      return { remove };
    });
    const setFocused = jest.spyOn(focusManager, 'setFocused');

    const view = render(
      <AppProviders><Text>Momora</Text></AppProviders>,
    );

    expect(setFocused).toHaveBeenCalledWith(AppState.currentState === 'active');
    handleAppStateChange?.('background');
    expect(setFocused).toHaveBeenLastCalledWith(false);
    handleAppStateChange?.('active');
    expect(setFocused).toHaveBeenLastCalledWith(true);

    view.unmount();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(setFocused).toHaveBeenLastCalledWith(undefined);
  });

  it('starts connectivity monitoring on mount and tears it down on unmount', () => {
    const cleanup = jest.fn();
    mockedStartConnectivityMonitoring.mockReturnValue(cleanup);

    const view = render(<AppProviders><Text>Momora</Text></AppProviders>);

    expect(mockedStartConnectivityMonitoring).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();

    view.unmount();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('holds children behind the persisted-cache restore gate until restore settles', async () => {
    render(<AppProviders><Text>Momora</Text></AppProviders>);

    // PersistQueryClientProvider's isRestoring starts true and only flips
    // false once persistQueryClientRestore's promise resolves (at least one
    // microtask away) -- children (and therefore AuthProvider/FamilyProvider
    // etc.) must not be mounted yet on this synchronous first render. This
    // is the empty-state-flash guard from
    // docs/plans/offline-awareness-and-share-cards.md O4.
    expect(screen.queryByText('Momora')).toBeNull();

    await waitFor(() => {
      expect(screen.getByText('Momora')).toBeTruthy();
    });
  });
});
