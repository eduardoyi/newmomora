import { focusManager } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { KeyboardProvider } from 'react-native-keyboard-controller';

import { AuthProvider } from '@/hooks/use-auth';
import { BillingProvider } from '@/hooks/use-billing';
import { FamilyProvider } from '@/hooks/use-family';
import { PendingMemoryUploadsProvider } from '@/hooks/use-pending-memory-uploads';
import { startConnectivityMonitoring } from '@/lib/connectivity';
import { PersistedQueryProvider } from '@/lib/query-persistence';

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

  // Reflects device connectivity into react-query's onlineManager for the
  // whole app session -- see src/lib/connectivity.ts. Everything that reads
  // online state (the offline banner, O3's reconnect refetch, O6's
  // fail-fast mutations) depends on this being wired before those consumers
  // mount, same lifecycle slot as the focusManager wiring above.
  useEffect(() => startConnectivityMonitoring(), []);

  return (
    <KeyboardProvider preload={false}>
      <PersistedQueryProvider>
        <AuthProvider>
          <FamilyProvider>
            <BillingProvider>
              <PendingMemoryUploadsProvider>{children}</PendingMemoryUploadsProvider>
            </BillingProvider>
          </FamilyProvider>
        </AuthProvider>
      </PersistedQueryProvider>
    </KeyboardProvider>
  );
}
