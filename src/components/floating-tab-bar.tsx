import type { BottomTabBarProps } from 'expo-router/build/react-navigation/bottom-tabs/types';
import { SymbolView } from 'expo-symbols';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fonts } from '@/constants/theme';

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

const LABEL_ENTERING = FadeIn.duration(160);

function TabItem({
  route,
  isActive,
  onPress,
}: {
  route: { key: string; name: string };
  isActive: boolean;
  onPress: () => void;
}) {
  const meta = TAB_META[route.name];

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
      <View
        style={[styles.tabPill, isActive && styles.activeTabPill]}
        testID={`tab-pill-${route.name}`}
      >
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
        {isActive && (
          <Animated.View entering={LABEL_ENTERING} style={styles.labelWrapper}>
            <Text style={styles.tabLabel} numberOfLines={1}>
              {meta?.label ?? route.name}
            </Text>
          </Animated.View>
        )}
      </View>
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
              <TabItem
                key={`${route.key}-${isActive ? 'active' : 'inactive'}`}
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
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: 0,
  },
  activeTabPill: {
    paddingHorizontal: 14,
    borderRadius: 17,
    backgroundColor: colors.primary,
    overflow: 'hidden',
  },
  labelWrapper: {
    marginLeft: 6,
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
