import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { AuthProvider } from '@/hooks/use-auth';
import { FamilyProvider } from '@/hooks/use-family';
import { PendingMemoryUploadsProvider } from '@/hooks/use-pending-memory-uploads';
import { queryClient } from '@/lib/query-client';

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <FamilyProvider>
          <PendingMemoryUploadsProvider>{children}</PendingMemoryUploadsProvider>
        </FamilyProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
