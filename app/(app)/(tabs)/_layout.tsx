import { Tabs } from 'expo-router';

import { FloatingTabBar } from '@/components/floating-tab-bar';
import { TabSwipeLayout } from '@/components/tab-swipe-layout';

export default function TabLayout() {
  return (
    <Tabs
      tabBar={(props) => <FloatingTabBar {...props} />}
      screenLayout={({ route, navigation, children }) => (
        <TabSwipeLayout
          routeName={route.name}
          onNavigate={(nextRoute) => navigation.navigate(nextRoute)}
        >
          {children}
        </TabSwipeLayout>
      )}
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
