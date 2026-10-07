import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { KeepsakesTab } from '@/components/keepsakes/keepsakes-tab';
import { trackEvent } from '@/services/analytics';
import { getLocalTodayIso } from '@/utils/portrait-versions';

/**
 * Keepsakes tab (docs/plans/keepsakes-redesign.md D1): the header, the
 * "needs you" line, the "Make something" storefront and "Your keepsakes"
 * library all live in `KeepsakesTab`. See docs/features/keepsakes.md.
 *
 * Tab screens never unmount, so "today" (which decides the books' scope
 * options and what a previous-year holiday card means) is recomputed on every
 * focus, and the books poll and films refetch only run while this tab is
 * focused.
 */
export default function KeepsakesScreen() {
  const [todayIso, setTodayIso] = useState(() => getLocalTodayIso());
  const [isFocused, setIsFocused] = useState(false);

  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      setTodayIso((previous) => {
        const next = getLocalTodayIso();
        return previous === next ? previous : next;
      });
      trackEvent('keepsakes_opened', {});
      return () => setIsFocused(false);
    }, []),
  );

  return <KeepsakesTab isFocused={isFocused} todayIso={todayIso} />;
}
