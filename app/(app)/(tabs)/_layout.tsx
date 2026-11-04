import { Tabs } from 'expo-router';

import { FloatingTabBar } from '@/components/floating-tab-bar';

export default function TabLayout() {
  return (
    <Tabs
      tabBar={(props) => <FloatingTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        // Tabs never unmount, so a hidden tab used to re-render on every
        // query/context change (family, memories, profile...) while nobody
        // could see it. Frozen tabs (react-freeze, via react-native-screens'
        // DelayedFreeze -- one extra render after blur, so blur-time state
        // like the Timeline's video-pause flag still lands) defer those
        // renders and catch up on refocus. Hooks/subscriptions stay live.
        // docs/plans/performance-optimizations.md.
        freezeOnBlur: true,
      }}
    >
      <Tabs.Screen name="timeline" />
      <Tabs.Screen name="keepsakes" />
      <Tabs.Screen name="family" />
      <Tabs.Screen name="settings" />
    </Tabs>
  );
}
