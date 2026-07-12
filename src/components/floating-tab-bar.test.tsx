import { render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

jest.mock('expo-symbols', () => ({
  SymbolView: () => null,
}));

jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');

  return {
    __esModule: true,
    default: { View },
    FadeIn: { duration: () => ({}) },
  };
});

// The native Reanimated module cannot run in Jest; load the component after its test double.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { FloatingTabBar } = require('./floating-tab-bar') as typeof import('./floating-tab-bar');

const routes = ['timeline', 'calendar', 'family', 'settings'].map((name) => ({
  key: `${name}-key`,
  name,
}));

const safeAreaMetrics = {
  frame: { height: 844, width: 390, x: 0, y: 0 },
  insets: { bottom: 34, left: 0, right: 0, top: 47 },
};

function tabBarProps(index: number) {
  return {
    state: { index, routes } as never,
    navigation: { emit: jest.fn(), navigate: jest.fn() } as never,
    descriptors: {} as never,
    insets: { bottom: 0, left: 0, right: 0, top: 0 },
  };
}

describe('FloatingTabBar', () => {
  it('renders selection styling from the current router state, never a retained animation value', () => {
    const screen = render(
      <SafeAreaProvider initialMetrics={safeAreaMetrics}>
        <FloatingTabBar {...tabBarProps(0)} />
      </SafeAreaProvider>,
    );

    expect(screen.getByText('Timeline')).toBeTruthy();
    expect(screen.queryByText('Calendar')).toBeNull();
    expect(screen.getByTestId('tab-timeline').props.accessibilityState).toEqual({ selected: true });
    expect(StyleSheet.flatten(screen.getByTestId('tab-pill-timeline').props.style)).toMatchObject({
      borderRadius: 17,
      overflow: 'hidden',
    });

    screen.rerender(
      <SafeAreaProvider initialMetrics={safeAreaMetrics}>
        <FloatingTabBar {...tabBarProps(1)} />
      </SafeAreaProvider>,
    );

    expect(screen.queryByText('Timeline')).toBeNull();
    expect(screen.getByText('Calendar')).toBeTruthy();
    expect(screen.getByTestId('tab-timeline').props.accessibilityState).toEqual({ selected: false });
    expect(screen.getByTestId('tab-calendar').props.accessibilityState).toEqual({ selected: true });
    expect(StyleSheet.flatten(screen.getByTestId('tab-pill-timeline').props.style)).toMatchObject({
      borderRadius: 0,
    });
    expect(StyleSheet.flatten(screen.getByTestId('tab-pill-calendar').props.style)).toMatchObject({
      borderRadius: 17,
      overflow: 'hidden',
    });
  });
});
