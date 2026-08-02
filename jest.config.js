module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  testMatch: ['**/*.(test|integration.test).(ts|tsx)'],
  testPathIgnorePatterns: ['/node_modules/', '/supabase/functions/', '/supabase/scripts/', '/cloudflare/memory-illustration-worker/test/', '/cloudflare/momora-export-worker/test/'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^react-native-purchases$': '<rootDir>/__mocks__/react-native-purchases.ts',
    '^posthog-react-native$': '<rootDir>/__mocks__/posthog-react-native.ts',
  },
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|lucide-react-native|react-native-svg|@supabase/.*)',
  ],
};
