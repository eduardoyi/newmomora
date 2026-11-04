import { Alert, Linking } from 'react-native';

import {
  getOrRequestNativePermission,
  getSoftPermissionDeniedText,
  runAfterNativeChooserDismisses,
  showPermissionSettingsPrompt,
  waitForNativePresentationToSettle,
} from './native-permissions';

describe('native permissions', () => {
  it('uses an existing grant without opening another permission prompt', async () => {
    const getPermission = jest.fn().mockResolvedValue({ granted: true, canAskAgain: true });
    const requestPermission = jest.fn();

    await expect(
      getOrRequestNativePermission(getPermission, requestPermission),
    ).resolves.toEqual({
      permission: { granted: true, canAskAgain: true },
      didRequest: false,
    });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('requests an undetermined permission once', async () => {
    const getPermission = jest.fn().mockResolvedValue({ granted: false, canAskAgain: true });
    const requestPermission = jest.fn().mockResolvedValue({ granted: true, canAskAgain: true });

    await expect(
      getOrRequestNativePermission(getPermission, requestPermission),
    ).resolves.toEqual({
      permission: { granted: true, canAskAgain: true },
      didRequest: true,
    });
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('does not request again when the user must enable access in Settings', async () => {
    const getPermission = jest.fn().mockResolvedValue({ granted: false, canAskAgain: false });
    const requestPermission = jest.fn();

    await expect(
      getOrRequestNativePermission(getPermission, requestPermission),
    ).resolves.toEqual({
      permission: { granted: false, canAskAgain: false },
      didRequest: false,
    });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('waits before presenting native UI after another prompt or chooser', async () => {
    jest.useFakeTimers();
    const action = jest.fn();
    let hasSettled = false;

    const settled = waitForNativePresentationToSettle().then(() => {
      hasSettled = true;
    });
    runAfterNativeChooserDismisses(action);

    await jest.advanceTimersByTimeAsync(299);
    expect(action).not.toHaveBeenCalled();
    expect(hasSettled).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    await settled;
    expect(action).toHaveBeenCalledTimes(1);
    expect(hasSettled).toBe(true);

    jest.useRealTimers();
  });

  describe('permission copy', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it.each([
      ['camera', 'Turn on camera access', 'your camera'],
      ['microphone', 'Turn on microphone access', 'your microphone'],
      ['photos', 'Turn on photo access', 'access to your photos'],
    ] as const)('shows a Settings prompt for %s', (kind, title, thing) => {
      const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
      const settingsSpy = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);

      showPermissionSettingsPrompt(kind, 'to do the thing');

      expect(alertSpy).toHaveBeenCalledTimes(1);
      const [alertTitle, body, buttons] = alertSpy.mock.calls[0];
      expect(alertTitle).toBe(title);
      expect(body).toBe(`Momora needs ${thing} to do the thing. You can turn it on in Settings.`);
      expect(buttons).toEqual([
        { text: 'Not now', style: 'cancel' },
        { text: 'Open Settings', onPress: expect.any(Function) },
      ]);
      expect(settingsSpy).not.toHaveBeenCalled();

      buttons?.find((button) => button.text === 'Open Settings')?.onPress?.();
      expect(settingsSpy).toHaveBeenCalledTimes(1);
    });

    it('builds the inline text for a soft denial', () => {
      expect(getSoftPermissionDeniedText('camera', 'to take a profile photo')).toBe(
        'Momora needs your camera to take a profile photo. Tap again to allow it.',
      );
      expect(getSoftPermissionDeniedText('photos', 'to add them to this memory')).toBe(
        'Momora needs access to your photos to add them to this memory. Tap again to allow it.',
      );
      expect(getSoftPermissionDeniedText('microphone', 'to record voice memories')).toBe(
        'Momora needs your microphone to record voice memories. Tap again to allow it.',
      );
    });
  });
});
