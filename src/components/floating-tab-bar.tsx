import { useLayoutEffect } from 'react';
import type { BottomTabBarProps } from 'expo-router/build/react-navigation/bottom-tabs/types';
import { SymbolView } from 'expo-symbols';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fonts } from '@/constants/theme';
import { getTabTransitionKey, getTabTransitionStartProgress } from '@/utils/tab-transition';

type TabMeta = {
  label: string;
  symbolActive: React.ComponentProps<typeof SymbolView>['name'];
  symbolInactive: React.ComponentProps<typeof SymbolView>['name'];
};

const TAB_META: Record<string, TabMeta> = {
  timeline: {
    label: 'Timeline',
    symbolActive:   { ios: 'clock.fill',    android: 'schedule' },
    symbolInactive: { ios: 'clock',         android: 'schedule' },
  },
  calendar: {
    label: 'Calendar',
    symbolActive:   { ios: 'calendar',      android: 'calendar_today' },
    symbolInactive: { ios: 'calendar',      android: 'calendar_today' },
  },
  family: {
    label: 'Family',
    symbolActive:   { ios: 'person.2.fill', android: 'group' },
    symbolInactive: { ios: 'person.2',      android: 'group' },
  },
  settings: {
    label: 'Settings',
    symbolActive:   { ios: 'gearshape.fill', android: 'settings' },
    symbolInactive: { ios: 'gearshape',      android: 'settings' },
  },
};

const TIMING = { duration: 280, easing: Easing.out(Easing.cubic) };

function AnimatedTabItem({
  route,
  isActive,
  onPress,
}: {
  route: { key: string; name: string };
  isActive: boolean;
  onPress: () => void;
}) {
  const meta = TAB_META[route.name];
  // A newly selected tab expands from 0, while the previously selected tab
  // collapses from 1. The item key below makes this value fresh per transition.
  const progress = useSharedValue(getTabTransitionStartProgress(isActive));

  useLayoutEffect(() => {
    progress.value = withTiming(isActive ? 1 : 0, TIMING);
  }, [isActive, progress]);

  const pillStyle = useAnimatedStyle(() => ({
    paddingHorizontal: interpolate(progress.value, [0, 1], [8, 14]),
    backgroundColor: interpolateColor(progress.value, [0, 1], ['rgba(214,62,120,0)', colors.primary]),
  }));

  const labelWrapperStyle = useAnimatedStyle(() => ({
    maxWidth: interpolate(progress.value, [0, 1], [0, 100]),
    opacity: interpolate(progress.value, [0, 0.5, 1], [0, 0, 1]),
    marginLeft: interpolate(progress.value, [0, 1], [0, 6]),
  }));

  const iconColor = isActive ? colors.white : colors.ink2;
  const symbol = isActive ? meta?.symbolActive : meta?.symbolInactive;

  return (
    <Pressable
      onPress={onPress}
      style={styles.tab}
      accessibilityRole="button"
      accessibilityState={{ selected: isActive }}
      testID={`tab-${route.name}`}
    >
      <Animated.View style={[styles.tabPill, pillStyle]}>
        {symbol && (
          <SymbolView
            name={symbol}
            size={18}
            tintColor={iconColor}
            fallback={
              <Text style={[styles.tabIconFallback, { color: iconColor }]}>
                {route.name === 'timeline' ? '◷' :
                 route.name === 'calendar' ? '⊟' :
                 route.name === 'family'   ? '◈' : '✦'}
              </Text>
            }
          />
        )}
        <Animated.View style={[styles.labelWrapper, labelWrapperStyle]}>
          <Text style={styles.tabLabel} numberOfLines={1}>
            {meta?.label ?? route.name}
          </Text>
        </Animated.View>
      </Animated.View>
    </Pressable>
  );
}

export function FloatingTabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const bottom = Platform.OS === 'android' ? Math.max(28, insets.bottom + 8) : 28;

  return (
    <View style={[styles.wrapper, { bottom }]} pointerEvents="box-none">
      <View style={styles.container}>
        <View style={styles.inner}>
          {state.routes.map((route, index) => {
            const isActive = state.index === index;

            const onPress = () => {
              const event = navigation.emit({
                type: 'tabPress',
                target: route.key,
                canPreventDefault: true,
              });
              if (!isActive && !event.defaultPrevented) {
                navigation.navigate(route.name);
              }
            };

            return (
              <AnimatedTabItem
                // Recreate the two transitioning items when the selected route changes.
                // A shared value belongs to its mounted view; retaining it after a native
                // tab transition can leave its last animated frame on screen. Starting a
                // fresh item from the opposite state keeps the expand/collapse animation
                // while ensuring it always has a deterministic end state.
                key={getTabTransitionKey(route.key, isActive)}
                route={route}
                isActive={isActive}
                onPress={onPress}
              />
            );
          })}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    left: 16,
    right: 16,
  },
  container: {
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#28201400',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.08,
    shadowRadius: 28,
    elevation: 8,
  },
  inner: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  tab: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: 999,
  },
  labelWrapper: {
    overflow: 'hidden',
  },
  tabIconFallback: {
    fontSize: 15,
  },
  tabLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    lineHeight: 18,
    color: colors.white,
  },
});
