// "Leave this Keepsakes product page" (docs/plans/keepsakes-redesign.md D3/D4),
// shared by the holiday-card and Memory Book pages.
//
//   leave()                -> router.back(), or, when there is no history (a
//                             cold-start deep link), replace with the
//                             Keepsakes tab.
//   leaveAfterModalDismiss -> the same, but only after a Modal that is
//                             closing has finished its slide-out. Popping the
//                             stack in the same tick can leave an
//                             `overFullScreen` modal stuck on screen, and the
//                             greeting sheet does not expose its dismiss
//                             callback, so a short timer (a bit longer than the
//                             ~300 ms slide) is used on both platforms.
//
// A pending timer is cancelled on unmount so a screen that was already left
// never navigates twice.
import { router } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';

import { keepsakesTabRoute } from '@/lib/routes';

export const MODAL_DISMISS_DELAY_MS = 450;

export function leaveKeepsakesProductPage(): void {
  if (router.canGoBack()) {
    router.back();
  } else {
    router.replace(keepsakesTabRoute);
  }
}

export function useLeaveKeepsakesPage() {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const leave = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    leaveKeepsakesProductPage();
  }, []);

  const leaveAfterModalDismiss = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      leaveKeepsakesProductPage();
    }, MODAL_DISMISS_DELAY_MS);
  }, []);

  return { leave, leaveAfterModalDismiss };
}
