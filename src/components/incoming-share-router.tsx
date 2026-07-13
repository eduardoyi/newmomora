import { getSharedPayloads } from 'expo-sharing';
import { usePathname, useRouter, useSegments } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { newMemoryRoute } from '@/lib/routes';
import { canEditFamilyContent } from '@/utils/roles';

/**
 * Cold-start fallback for native gallery shares.
 *
 * The native share extension persists its payload before opening Momora, but
 * the initial deep link can be lost while Expo Router is booting. Once normal
 * auth/family routing has settled, this component checks the persisted payload
 * and opens the composer. The composer remains responsible for consuming and
 * clearing the payload.
 */
export function IncomingShareRouter() {
  const router = useRouter();
  const pathname = usePathname();
  const segments = useSegments();
  const { session, isLoading: isAuthLoading } = useAuth();
  const { familyId, role, isLoading: isFamilyLoading } = useFamily();
  const hasRoutedRef = useRef(false);
  const isOnAppRoute = (segments as string[]).includes('(app)');

  const routePendingShare = useCallback(() => {
    if (pathname.endsWith('/new-memory')) {
      // The composer owns payload consumption. Reset the latch while it is
      // open so a later share can use this fallback again.
      hasRoutedRef.current = false;
      return;
    }

    if (
      hasRoutedRef.current ||
      isAuthLoading ||
      isFamilyLoading ||
      !session ||
      !familyId ||
      !canEditFamilyContent(role) ||
      !isOnAppRoute
    ) {
      return;
    }

    try {
      if (getSharedPayloads().length === 0) {
        hasRoutedRef.current = false;
        return;
      }
    } catch {
      // A missing/misconfigured native app group should not disrupt normal
      // app startup. The composer surfaces resolution errors when routed by
      // the native deep link itself.
      return;
    }

    hasRoutedRef.current = true;
    router.push(newMemoryRoute);
  }, [familyId, isAuthLoading, isFamilyLoading, isOnAppRoute, pathname, role, router, session]);

  useEffect(() => {
    routePendingShare();

    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') {
        routePendingShare();
      }
    });

    return () => subscription.remove();
  }, [routePendingShare]);

  return null;
}
