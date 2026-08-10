/**
 * Gallery import is deliberately opt-in at the client boundary. A native binary
 * may contain expo-media-library before the server-side admission/Play rollout
 * is enabled, but it must expose no entry point unless this flag is explicitly
 * set for the update channel.
 */
export const isGalleryImportFeatureEnabled = process.env.EXPO_PUBLIC_GALLERY_IMPORT_ENABLED === 'true';

/**
 * Fixture media is for Jest/Maestro development-client runs only. `__DEV__` is
 * compiled false in production bundles, so a mistakenly-set public variable
 * cannot replace a real person's library in an App Store/Play build.
 */
export const isGalleryImportE2eAdapterEnabled = __DEV__
  && process.env.EXPO_PUBLIC_E2E_GALLERY_IMPORT_ADAPTER === 'true';
