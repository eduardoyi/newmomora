import type { ReactElement } from 'react';
import { useCallback } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';

import { getAdjacentTabRoute, getTabSwipeDirection } from '@/utils/tab-swipe-navigation';

type TabSwipeLayoutProps = {
  routeName: string;
  onNavigate: (routeName: string) => void;
  children: ReactElement;
};

export function TabSwipeLayout({ routeName, onNavigate, children }: TabSwipeLayoutProps) {
  const navigateToAdjacentTab = useCallback(
    (direction: 'next' | 'prev') => {
      const nextRoute = getAdjacentTabRoute(routeName, direction);
      if (nextRoute) {
        onNavigate(nextRoute);
      }
    },
    [onNavigate, routeName],
  );

  const handleSwipeEnd = useCallback(
    (translationX: number, velocityX: number) => {
      const direction = getTabSwipeDirection(translationX, velocityX);
      if (direction) {
        navigateToAdjacentTab(direction);
      }
    },
    [navigateToAdjacentTab],
  );

  if (Platform.OS === 'web') {
    return children;
  }

  const pan = Gesture.Pan()
    .activeOffsetX([-24, 24])
    .failOffsetY([-18, 18])
    .onEnd((event) => {
      runOnJS(handleSwipeEnd)(event.translationX, event.velocityX);
    });

  return (
    <GestureDetector gesture={pan}>
      <View style={styles.container}>{children}</View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
