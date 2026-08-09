import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, StyleSheet, Text } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fonts, spacing } from '@/constants/theme';
import { useIsOnline } from '@/lib/connectivity';

const BACK_ONLINE_DISPLAY_MS = 2000;
// The viewer is full-screen and its controls cannot be obscured while either
// OfflineBanner phase is mounted. This is deliberately a conservative content
// height (text line + vertical breathing room), excluding the safe inset.
export const OFFLINE_BANNER_CONTENT_CLEARANCE = 24;

type BannerPhase = 'hidden' | 'offline' | 'back-online';
const OfflineBannerPhaseContext = createContext<BannerPhase>('hidden');

export function useOfflineBannerVisible(): boolean {
  return useContext(OfflineBannerPhaseContext) !== 'hidden';
}

export function OfflineBannerProvider({ children }: { children: ReactNode }) {
  const isOnline = useIsOnline();
  const [phase, setPhase] = useState<BannerPhase>('hidden');
  const wasOfflineRef = useRef(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isOnline) {
      wasOfflineRef.current = true;
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (phaseTimerRef.current) clearTimeout(phaseTimerRef.current);
      hideTimerRef.current = null;
      phaseTimerRef.current = setTimeout(() => { setPhase('offline'); phaseTimerRef.current = null; }, 0);
      AccessibilityInfo.announceForAccessibility("You're offline — showing what's saved.");
      return;
    }
    if (!wasOfflineRef.current) return;
    wasOfflineRef.current = false;
    phaseTimerRef.current = setTimeout(() => { setPhase('back-online'); phaseTimerRef.current = null; }, 0);
    AccessibilityInfo.announceForAccessibility('Back online.');
    hideTimerRef.current = setTimeout(() => {
      setPhase('hidden');
      hideTimerRef.current = null;
    }, BACK_ONLINE_DISPLAY_MS);
  }, [isOnline]);

  useEffect(() => () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (phaseTimerRef.current) clearTimeout(phaseTimerRef.current);
  }, []);
  const value = useMemo(() => phase, [phase]);
  return <OfflineBannerPhaseContext.Provider value={value}>{children}</OfflineBannerPhaseContext.Provider>;
}

// Mounted once around the whole (app) Stack (app/(app)/_layout.tsx), NOT
// just the tabs -- so a pushed screen (e.g. memory detail) stays covered
// too (docs/plans/offline-awareness-and-share-cards.md O2). Modal screens
// (new-memory, edit) visually cover a layout-level banner on iOS
// (`presentation: 'modal'`) and rely on inline errors instead (O6/S4) --
// that's an intentional scope boundary, not an oversight.
//
// Renders as an absolute overlay pinned to the top rather than pushing tab
// content down: the calendar tab has its own fixed, safe-area-owning header
// and the timeline tab's header lives inside a SafeAreaView at the top of
// its scrolling content -- both assume THEY are flush with the physical top
// edge. Inserting this banner into normal layout flow above them would
// double-count the top safe-area inset every time it toggles visible.
// Overlaying avoids that: nothing beneath reflows when the banner shows or
// hides (no layout jump), it just draws on top for its brief lifetime.
export function OfflineBanner() {
  const insets = useSafeAreaInsets();
  const phase = useContext(OfflineBannerPhaseContext);

  if (phase === 'hidden') {
    return null;
  }

  const isOffline = phase === 'offline';

  return (
    <Animated.View
      entering={FadeIn}
      exiting={FadeOut}
      // Non-interactive strip -- never blocks a tap on whatever it's
      // temporarily covering (e.g. the calendar's month trigger).
      pointerEvents="none"
      style={[
        styles.container,
        { paddingTop: insets.top },
        isOffline ? styles.offline : styles.backOnline,
      ]}
      testID="offline-banner"
    >
      <Text accessibilityLiveRegion="polite" style={styles.text}>
        {isOffline ? "You're offline — showing what's saved." : 'Back online'}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    alignItems: 'center',
    paddingBottom: spacing.xs,
  },
  offline: {
    backgroundColor: colors.ink2,
  },
  backOnline: {
    backgroundColor: colors.success,
  },
  text: {
    fontFamily: fonts.sansMedium,
    fontSize: 12.5,
    color: colors.white,
    paddingHorizontal: spacing.md,
  },
});
