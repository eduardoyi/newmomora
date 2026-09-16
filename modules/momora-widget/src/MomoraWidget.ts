import { requireOptionalNativeModule } from 'expo-modules-core';

export interface MomoraWidgetNativeModule {
  getCapabilities: () => {
    supported: boolean;
    enabled: boolean;
    platform?: 'ios' | 'android' | 'web' | 'unknown';
    sharedDirectory?: string;
    supportsSystemSmall?: boolean;
    supportsAndroidTall?: boolean;
  };
  readManifest: () => Promise<string | null>;
  publishManifest: (manifestJson: string, filesJson: string) => Promise<void>;
  clearManifest: (scopeJson?: string, generationId?: string) => Promise<boolean | void>;
  reload: () => void | Promise<void>;
}

/**
 * The native cache is optional because Expo Go, web, and old binaries do not
 * contain the local module.  Keeping this lookup optional makes every caller
 * fail closed to the neutral card instead of crashing during app startup.
 */
export const momoraWidgetNativeModule = requireOptionalNativeModule<MomoraWidgetNativeModule>(
  'MomoraWidget',
);

export function getMomoraWidgetNativeModule(): MomoraWidgetNativeModule | null {
  return momoraWidgetNativeModule;
}

export function getMomoraWidgetCapabilities(): ReturnType<
  MomoraWidgetNativeModule['getCapabilities']
> | null {
  try {
    return momoraWidgetNativeModule?.getCapabilities() ?? null;
  } catch {
    return null;
  }
}
