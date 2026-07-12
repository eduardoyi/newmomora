import { render } from '@testing-library/react-native';
import { focusManager } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { AppState, Text } from 'react-native';

import { AppProviders } from '@/components/app-providers';

jest.mock('@/hooks/use-auth', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/hooks/use-family', () => ({
  FamilyProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/hooks/use-pending-memory-uploads', () => ({
  PendingMemoryUploadsProvider: ({ children }: { children: ReactNode }) => children,
}));

describe('AppProviders', () => {
  it('syncs TanStack Query focus with the native app lifecycle', () => {
    let handleAppStateChange: ((status: 'active' | 'background') => void) | undefined;
    const remove = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
      handleAppStateChange = listener as (status: 'active' | 'background') => void;
      return { remove };
    });
    const setFocused = jest.spyOn(focusManager, 'setFocused');

    const screen = render(
      <AppProviders><Text>Momora</Text></AppProviders>,
    );

    expect(setFocused).toHaveBeenCalledWith(AppState.currentState === 'active');
    handleAppStateChange?.('background');
    expect(setFocused).toHaveBeenLastCalledWith(false);
    handleAppStateChange?.('active');
    expect(setFocused).toHaveBeenLastCalledWith(true);

    screen.unmount();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(setFocused).toHaveBeenLastCalledWith(undefined);
  });
});
