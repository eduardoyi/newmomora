import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

import { isVoiceInputAvailable } from '@/utils/voice-input';

jest.mock('expo-modules-core', () => ({
  ...jest.requireActual<typeof import('expo-modules-core')>('expo-modules-core'),
  requireOptionalNativeModule: jest.fn(),
}));

const mockedRequireOptionalNativeModule = requireOptionalNativeModule as jest.MockedFunction<
  typeof requireOptionalNativeModule
>;

describe('isVoiceInputAvailable', () => {
  const originalPlatform = Platform.OS;

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
    jest.clearAllMocks();
  });

  it('returns false on web', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });

    expect(isVoiceInputAvailable()).toBe(false);
    expect(mockedRequireOptionalNativeModule).not.toHaveBeenCalled();
  });

  it('returns true when expo-audio native module is installed', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    mockedRequireOptionalNativeModule.mockReturnValue({} as never);

    expect(isVoiceInputAvailable()).toBe(true);
    expect(mockedRequireOptionalNativeModule).toHaveBeenCalledWith('ExpoAudio');
  });

  it('returns false when expo-audio native module is missing', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    mockedRequireOptionalNativeModule.mockReturnValue(null);

    expect(isVoiceInputAvailable()).toBe(false);
  });
});
