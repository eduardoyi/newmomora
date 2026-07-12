import {
  getOrRequestNativePermission,
  runAfterNativeChooserDismisses,
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
});
