import { router, type Href } from 'expo-router';

import { timelineRoute } from '@/lib/routes';

export function navigateBack(fallback: Href = timelineRoute): void {
  if (router.canGoBack()) {
    router.back();
    return;
  }

  router.replace(fallback);
}
