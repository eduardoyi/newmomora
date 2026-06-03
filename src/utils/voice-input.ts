import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export function isVoiceInputAvailable(): boolean {
  if (Platform.OS === 'web') {
    return false;
  }

  // expo-audio registers via expo-modules-core (JSI), not React Native NativeModules.
  return requireOptionalNativeModule('ExpoAudio') != null;
}
