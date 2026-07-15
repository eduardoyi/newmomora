import '@testing-library/jest-native/extend-expect';

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

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
  Heart: () => null,
  MessageCircle: () => null,
  Send: () => null,
}));

// Native IME-inset controller. Its maintained Jest mock maps keyboard-aware
// containers to React Native views while preserving their props for assertions.
jest.mock('react-native-keyboard-controller', () =>
  // Jest evaluates mock factories before imports, so the maintained mock must
  // be loaded here rather than through a top-level import.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('react-native-keyboard-controller/jest'),
);
