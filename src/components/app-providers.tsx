import { focusManager, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { KeyboardProvider } from 'react-native-keyboard-controller';

import { AuthProvider } from '@/hooks/use-auth';
import { FamilyProvider } from '@/hooks/use-family';
import { PendingMemoryUploadsProvider } from '@/hooks/use-pending-memory-uploads';
import { queryClient } from '@/lib/query-client';

export function AppProviders({ children }: { children: ReactNode }) {
  useEffect(() => {
    focusManager.setFocused(AppState.currentState === 'active');
    const subscription = AppState.addEventListener('change', (status) => {
      focusManager.setFocused(status === 'active');
    });

    return () => {
      subscription.remove();
      focusManager.setFocused(undefined);
    };
  }, []);

  return (
    <KeyboardProvider preload={false}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <FamilyProvider>
            <PendingMemoryUploadsProvider>{children}</PendingMemoryUploadsProvider>
          </FamilyProvider>
        </AuthProvider>
      </QueryClientProvider>
    </KeyboardProvider>
  );
}
