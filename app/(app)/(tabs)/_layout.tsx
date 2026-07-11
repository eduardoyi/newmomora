import { Tabs } from 'expo-router';

import { FloatingTabBar } from '@/components/floating-tab-bar';

export default function TabLayout() {
  return (
    <Tabs
      tabBar={(props) => <FloatingTabBar {...props} />}
      screenOptions={{
        headerShown: false,
      }}
    >
      <Tabs.Screen name="timeline" />
      <Tabs.Screen name="calendar" />
      <Tabs.Screen name="family" />
      <Tabs.Screen name="settings" />
    </Tabs>
  );
}
