import '@testing-library/jest-native/extend-expect';

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

// No PostHog API key by default -- `src/services/analytics.ts` must stay on
// its no-op path so tests don't accidentally depend on (or assert against) a
// live-looking client. Tests exercising the keyed path set this explicitly
// and call `jest.resetModules()` before re-requiring the module.
delete process.env.EXPO_PUBLIC_POSTHOG_API_KEY;

// Native gesture handlers. The maintained setup swaps the native module for a
// JS mock, which is also what `fireGestureHandler` (jest-utils) drives.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('react-native-gesture-handler/jestSetup');

// Reanimated 4 initializes react-native-worklets' native module the moment its
// entrypoint is imported, which throws under Jest -- and the library's own
// `react-native-reanimated/mock` entry re-imports that same entrypoint, so it
// can't be used either. Mock the surface the app actually touches. Worklets
// stay ordinary callable functions, so gesture callbacks still run on the JS
// thread, and `useAnimatedStyle` resolves to a plain style object each render,
// which keeps animated transforms assertable in tests.
jest.mock('react-native-reanimated', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Animated: RNAnimated, Image, Text, View } = require('react-native');

  // Layout-animation presets (`FadeIn`) are only ever passed through to a
  // component prop in tests, so a self-returning chainable is enough.
  const layoutAnimation: Record<string, unknown> = {
    build: () => () => ({ animations: {}, initialValues: {} }),
  };
  for (const method of ['delay', 'duration', 'easing', 'randomDelay', 'reduceMotion', 'springify', 'withInitialValues']) {
    layoutAnimation[method] = () => layoutAnimation;
  }

  // Identity has to survive re-renders the way the real hook does -- handing
  // back a fresh object would silently reset every value a gesture just wrote.
  function useSharedValue<Value>(initial: Value) {
    const ref = React.useRef<{ value: Value } | null>(null);
    if (ref.current === null) {
      let current = initial;
      ref.current = {
        get value() {
          return current;
        },
        set value(next: Value) {
          current = next;
        },
        get: () => current,
        set: (next: Value) => {
          current = next;
        },
      };
    }

    return ref.current;
  }

  return {
    __esModule: true,
    default: {
      createAnimatedComponent: <Component,>(component: Component) => component,
      FlatList: RNAnimated.FlatList,
      Image,
      ScrollView: RNAnimated.ScrollView,
      Text,
      View,
    },
    FadeIn: layoutAnimation,
    FadeOut: layoutAnimation,
    runOnJS: <Fn,>(fn: Fn) => fn,
    runOnUI: <Fn,>(fn: Fn) => fn,
    cancelAnimation: () => undefined,
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useReducedMotion: () => false,
    useEvent: () => () => undefined,
    useSharedValue,
    withRepeat: (animation: unknown) => animation,
    withSpring: (toValue: unknown) => toValue,
    withTiming: jest.fn((toValue: unknown) => toValue),
  };
});

// Native-only module; individual tests override the mock as needed.
jest.mock('react-native-compressor', () => ({
  Video: {
    compress: jest.fn(async (fileUri: string) => fileUri),
  },
}));

// Native-only module. Default returns a distinguishable "stripped:"-prefixed
// URI (not the original) so tests exercising the upload pipeline can assert
// a re-encode happened without mocking this module individually. Individual
// tests override this mock as needed (e.g. to assert compress/format args
// or simulate a failure).
jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: jest.fn(async (uri: string) => ({ uri: `stripped:${uri}`, width: 0, height: 0 })),
  SaveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
}));

// lucide-react-native publishes ESM-only icon entrypoints. Icons are visual
// decoration in Jest; interaction/accessibility assertions live on their
// surrounding Pressables.
jest.mock('lucide-react-native', () => ({
  ArrowRight: () => null,
  Check: () => null,
  Clock: () => null,
  Heart: () => null,
  Image: () => null,
  MessageCircle: () => null,
  Mic: () => null,
  Moon: () => null,
  Send: () => null,
  Sparkles: () => null,
  Square: () => null,
  Sun: () => null,
  Type: () => null,
  X: () => null,
}));

// Native IME-inset controller. Its maintained Jest mock maps keyboard-aware
// containers to React Native views while preserving their props for assertions.
jest.mock('react-native-keyboard-controller', () =>
  // Jest evaluates mock factories before imports, so the maintained mock must
  // be loaded here rather than through a top-level import.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('react-native-keyboard-controller/jest'),
);
